//go:build windows

package platform

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	ServiceName        = "TorbitBridge"
	ServiceDisplayName = "Torbit Outlook Bridge"
	serviceDescription = "Delivers mail from classic Outlook to Torbit/Orbit over HTTPS, signed with this PC's device key."
	// ExitAlreadyRunning is the worker's exit code when another bridge already
	// runs in the user's session (for example a manual `run`).
	ExitAlreadyRunning = 3
)

var ErrNotElevated = errors.New("administrator rights are needed")

func IsWindowsService() bool { ok, _ := svc.IsWindowsService(); return ok }

// InstallDir is where the service binary lives. It must not be writable by
// standard users: the service runs as SYSTEM.
func InstallDir() string {
	pf := os.Getenv("ProgramW6432")
	if pf == "" {
		pf = os.Getenv("ProgramFiles")
	}
	return filepath.Join(pf, "Torbit", "Bridge")
}

func InstalledExe() string { return filepath.Join(InstallDir(), "torbit-bridge.exe") }

// ServiceLogPath is the service's own log (supervisor events only).
func ServiceLogPath() string {
	pd := os.Getenv("ProgramData")
	if pd == "" {
		pd = `C:\ProgramData`
	}
	return filepath.Join(pd, "Torbit", "Bridge", "service.log")
}

type InstallOptions struct {
	User     string // DOMAIN\name or SID; empty = the current user
	Interval time.Duration
	NoStart  bool
	Log      io.Writer
}

func serviceArgs(sid string, interval time.Duration) []string {
	return []string{"service", "--user", sid, "--interval", strconv.Itoa(int(interval.Seconds()))}
}

// InstallService copies this binary to Program Files, registers the service
// (automatic, delayed start, restart on failure) and starts it. Safe to repeat.
func InstallService(o InstallOptions) error {
	if !IsElevated() {
		return ErrNotElevated
	}
	say := func(f string, a ...any) { fmt.Fprintf(o.Log, f+"\n", a...) }
	sid, name, err := resolveInstallUser(o.User)
	if err != nil {
		return err
	}
	if o.Interval <= 0 {
		o.Interval = time.Minute
	}
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()

	s, err := m.OpenService(ServiceName)
	exists := err == nil
	if exists {
		defer s.Close()
		stopAndWait(s, 30*time.Second)
	}
	if err := os.MkdirAll(InstallDir(), 0o755); err != nil {
		return err
	}
	if err := copySelfTo(InstalledExe()); err != nil {
		return err
	}
	say("Binary: %s", InstalledExe())

	cfg := mgr.Config{
		DisplayName: ServiceDisplayName, Description: serviceDescription,
		StartType: mgr.StartAutomatic, DelayedAutoStart: true,
		BinaryPathName: windows.ComposeCommandLine(append([]string{InstalledExe()}, serviceArgs(sid, o.Interval)...)),
	}
	if exists {
		if err := s.UpdateConfig(cfg); err != nil {
			return fmt.Errorf("update service: %w", err)
		}
		say("Service %s updated.", ServiceName)
	} else {
		s, err = m.CreateService(ServiceName, InstalledExe(), cfg, serviceArgs(sid, o.Interval)...)
		if err != nil {
			return fmt.Errorf("create service: %w", err)
		}
		defer s.Close()
		say("Service %s created.", ServiceName)
	}
	_ = s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
		{Type: mgr.ServiceRestart, Delay: time.Minute},
	}, 86400)
	say("Delivers mail for %s.", name)

	removeLegacyTasks(say)
	if o.NoStart {
		say("Not started (--no-start). Start it with: torbit-bridge start")
		return nil
	}
	if err := s.Start(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return fmt.Errorf("start service: %w", err)
	}
	say("Service started.")
	return nil
}

func resolveInstallUser(user string) (sid, name string, err error) {
	if user == "" {
		return CurrentUser()
	}
	return ResolveUser(user)
}

// The logon-task autostart of the PowerShell bridge would start a second
// bridge next to the service.
func removeLegacyTasks(say func(string, ...any)) {
	for _, t := range []string{"Torbit Bridge"} {
		if exec.Command("schtasks", "/Query", "/TN", t).Run() == nil {
			if exec.Command("schtasks", "/Delete", "/TN", t, "/F").Run() == nil {
				say("Removed the old logon task %q (the service replaces it).", t)
			}
		}
	}
}

func copySelfTo(dst string) error {
	src, err := os.Executable()
	if err != nil {
		return err
	}
	if a, e1 := filepath.EvalSymlinks(src); e1 == nil {
		if b, e2 := filepath.EvalSymlinks(dst); e2 == nil && a == b {
			return nil
		}
	}
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return ReplaceFile(dst, b)
}

// ReplaceFile swaps in new contents even when the old file is a running
// program: Windows lets a running executable be renamed, not overwritten.
func ReplaceFile(dst string, data []byte) error {
	tmp := dst + ".new"
	if err := os.WriteFile(tmp, data, 0o755); err != nil {
		return err
	}
	old := dst + ".old"
	os.Remove(old)
	if _, err := os.Stat(dst); err == nil {
		if err := os.Rename(dst, old); err != nil {
			os.Remove(tmp)
			return err
		}
	}
	if err := os.Rename(tmp, dst); err != nil {
		os.Rename(old, dst) // put the old one back
		return err
	}
	os.Remove(old) // fails while it still runs; the next upgrade removes it
	return nil
}

func stopAndWait(s *mgr.Service, timeout time.Duration) {
	st, err := s.Query()
	if err != nil || st.State == svc.Stopped {
		return
	}
	if st.State != svc.StopPending {
		if _, err := s.Control(svc.Stop); err != nil {
			return
		}
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if st, err := s.Query(); err != nil || st.State == svc.Stopped {
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// UninstallService stops and deletes the service and the binary in Program Files.
func UninstallService(log io.Writer) error {
	if !IsElevated() {
		return ErrNotElevated
	}
	say := func(f string, a ...any) { fmt.Fprintf(log, f+"\n", a...) }
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	if s, err := m.OpenService(ServiceName); err == nil {
		stopAndWait(s, 30*time.Second)
		err := s.Delete()
		s.Close()
		if err != nil {
			return fmt.Errorf("delete service: %w", err)
		}
		say("Service %s removed.", ServiceName)
	} else {
		say("Service %s was not installed.", ServiceName)
	}
	removeLegacyTasks(say)
	if err := os.RemoveAll(InstallDir()); err != nil {
		say("Could not remove %s (%v); delete it after a restart.", InstallDir(), err)
	} else {
		os.Remove(filepath.Dir(InstallDir())) // Torbit, when empty
		say("Removed %s.", InstallDir())
	}
	return nil
}

type ServiceInfo struct {
	Installed bool
	State     string
	StartType string
	Path      string
	User      string // SID the worker runs for
}

func QueryService() (ServiceInfo, error) {
	m, err := mgr.Connect()
	if err != nil {
		return ServiceInfo{}, err
	}
	defer m.Disconnect()
	s, err := m.OpenService(ServiceName)
	if err != nil {
		return ServiceInfo{}, nil
	}
	defer s.Close()
	info := ServiceInfo{Installed: true}
	if st, err := s.Query(); err == nil {
		info.State = map[svc.State]string{svc.Stopped: "stopped", svc.StartPending: "starting", svc.StopPending: "stopping",
			svc.Running: "running", svc.Paused: "paused"}[st.State]
	}
	if c, err := s.Config(); err == nil {
		info.StartType = map[uint32]string{mgr.StartAutomatic: "automatic", mgr.StartManual: "manual", mgr.StartDisabled: "disabled"}[c.StartType]
		args, _ := windows.DecomposeCommandLine(c.BinaryPathName)
		if len(args) > 0 {
			info.Path = args[0]
		}
		for i, a := range args {
			if a == "--user" && i+1 < len(args) {
				info.User = args[i+1]
			}
		}
	}
	return info, nil
}

func ControlService(start bool) error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(ServiceName)
	if err != nil {
		return errors.New("the service is not installed; run: torbit-bridge install")
	}
	defer s.Close()
	if start {
		if err := s.Start(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
			return err
		}
		return nil
	}
	stopAndWait(s, 30*time.Second)
	return nil
}

// ---- the service itself

type supervisor struct {
	exe      string
	sid      string
	interval time.Duration
	logf     func(string, ...any)
}

// RunService blocks until the service stops. It keeps one `run` worker alive
// in the bridge user's session, and restarts it when it ends or the user signs
// in again.
func RunService(sid string, interval time.Duration) error {
	if interval <= 0 {
		interval = time.Minute
	}
	_ = os.MkdirAll(filepath.Dir(ServiceLogPath()), 0o755)
	var lf *os.File
	if f, err := os.OpenFile(ServiceLogPath(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
		lf = f
		defer f.Close()
	}
	exe, _ := os.Executable()
	sv := &supervisor{exe: exe, sid: sid, interval: interval, logf: func(f string, a ...any) {
		if lf != nil {
			fmt.Fprintf(lf, "%s %s\n", time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(f, a...))
		}
	}}
	return svc.Run(ServiceName, sv)
}

func (sv *supervisor) Execute(_ []string, req <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	const accepts = svc.AcceptStop | svc.AcceptShutdown | svc.AcceptSessionChange
	status <- svc.Status{State: svc.StartPending}
	status <- svc.Status{State: svc.Running, Accepts: accepts}
	sv.logf("service started for user %s", sv.sid)

	var w *worker
	var nextStart time.Time
	backoff := 5 * time.Second
	var startedAt time.Time
	reconcile := func() {
		if w != nil {
			if done, code := w.exited(); done {
				windows.CloseHandle(w.proc)
				lived := time.Since(startedAt)
				sv.logf("worker exited with code %d after %s", code, lived.Round(time.Second))
				w = nil
				switch {
				case code == ExitAlreadyRunning:
					backoff = time.Minute
				case lived > time.Minute:
					backoff = 5 * time.Second
				default:
					backoff = min(backoff*2, 5*time.Minute)
				}
				nextStart = time.Now().Add(backoff)
			}
		}
		if w != nil || time.Now().Before(nextStart) {
			return
		}
		s, err := findSession(sv.sid)
		if err != nil {
			nextStart = time.Now().Add(10 * time.Second) // nobody is signed in yet
			return
		}
		defer s.token.Close()
		args := "run --interval " + strconv.Itoa(int(sv.interval.Seconds())) + " --from-service"
		nw, err := startWorker(s, sv.exe, args)
		if err != nil {
			sv.logf("could not start the worker in session %d: %v", s.id, err)
			backoff = min(backoff*2, 5*time.Minute)
			nextStart = time.Now().Add(backoff)
			return
		}
		w, startedAt = nw, time.Now()
		sv.logf("worker started in session %d (pid %d)", s.id, nw.pid)
	}

	tick := time.NewTicker(10 * time.Second)
	defer tick.Stop()
	reconcile()
	for {
		select {
		case c := <-req:
			switch c.Cmd {
			case svc.Interrogate:
				status <- c.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				if w != nil {
					w.kill()
				}
				sv.logf("service stopped")
				return false, 0
			case svc.SessionChange:
				if c.EventType == windows.WTS_SESSION_LOGON || c.EventType == windows.WTS_SESSION_UNLOCK {
					nextStart = time.Time{} // a user arrived: do not wait for the backoff
				}
				reconcile()
			}
		case <-tick.C:
			reconcile()
		}
	}
}
