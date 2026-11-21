package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"

	"github.com/t128n/torbit/bridge/internal/core"
	"github.com/t128n/torbit/bridge/internal/platform"
)

var plat = platform.New()

func httpClient() *core.HTTP { return &core.HTTP{Platform: plat} }

func newFlags(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	return fs
}

func parse(fs *flag.FlagSet, args []string) (int, bool) {
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0, false
		}
		return 2, false
	}
	return 0, true
}

// duration accepts seconds ("60") or a Go duration ("1m30s").
type duration struct{ d time.Duration }

func (v *duration) String() string { return v.d.String() }
func (v *duration) Set(s string) error {
	if n, err := strconv.Atoi(s); err == nil {
		v.d = time.Duration(n) * time.Second
		return nil
	}
	d, err := time.ParseDuration(s)
	v.d = d
	return err
}

// ---- credentials and prompts

var stdin = bufio.NewReader(os.Stdin)

func interactive() bool { return term.IsTerminal(int(os.Stdin.Fd())) }

func ask(prompt, def string) (string, error) {
	if !interactive() {
		return "", fmt.Errorf("%s is required (no terminal to ask on)", strings.TrimSuffix(prompt, ":"))
	}
	if def != "" {
		fmt.Printf("%s [%s]: ", prompt, def)
	} else {
		fmt.Printf("%s: ", prompt)
	}
	line, err := stdin.ReadString('\n')
	if err != nil && line == "" {
		return "", err
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return def, nil
	}
	return line, nil
}

func askSecret(prompt string) (string, error) {
	if !interactive() {
		return "", errors.New("a credential is required: use --session-token/--api-token or TORBIT_SESSION_TOKEN/TORBIT_API_TOKEN")
	}
	fmt.Printf("%s: ", prompt)
	b, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	return strings.TrimSpace(string(b)), err
}

type credFlags struct{ session, api *string }

func addCredFlags(fs *flag.FlagSet) credFlags {
	return credFlags{
		fs.String("session-token", "", "Orbit session token (the __Host-orbit_session cookie value); or set TORBIT_SESSION_TOKEN"),
		fs.String("api-token", "", "Orbit API token; or set TORBIT_API_TOKEN"),
	}
}

func (c credFlags) resolve(prompt string) (core.Credential, error) {
	switch {
	case *c.api != "":
		return core.Credential{Kind: "api", Value: *c.api}, nil
	case *c.session != "":
		return core.Credential{Kind: "session", Value: *c.session}, nil
	case os.Getenv("TORBIT_API_TOKEN") != "":
		return core.Credential{Kind: "api", Value: os.Getenv("TORBIT_API_TOKEN")}, nil
	case os.Getenv("TORBIT_SESSION_TOKEN") != "":
		return core.Credential{Kind: "session", Value: os.Getenv("TORBIT_SESSION_TOKEN")}, nil
	}
	v, err := askSecret(prompt)
	return core.Credential{Kind: "session", Value: v}, err
}

// ---- version, status, logs

func cmdVersion(args []string) int {
	fs := newFlags("version")
	short := fs.Bool("short", false, "print only the version number")
	if code, ok := parse(fs, args); !ok {
		return code
	}
	if *short {
		fmt.Println(version)
	} else {
		fmt.Printf("torbit-bridge %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
	}
	return 0
}

func cmdStatus(args []string) int {
	fs := newFlags("status")
	if code, ok := parse(fs, args); !ok {
		return code
	}
	s, err := core.GetStatus(plat.Keys())
	if err != nil {
		return errf("%v", err)
	}
	if !s.Enrolled {
		fmt.Println("Not enrolled. Run: torbit-bridge setup")
		return 0
	}
	key := "MISSING; enroll again"
	if s.KeyPresent {
		key = "present"
	}
	last := "never"
	if s.LastRun != "" {
		last = s.LastRun
	}
	svc := "not installed"
	if info, _ := platform.QueryService(); info.Installed {
		svc = info.State + " (" + info.StartType + " start)"
	}
	fmt.Printf("Device:    %s\nServer:    %s\nAddress:   %s\nKey:       %s (%s)\nLast run:  %s\n", s.DeviceID, s.Server, s.Address, s.KeyProvider, key, last)
	fmt.Printf("Delivered: %d   Skipped: %d   Waiting to retry: %d\nService:   %s\nVersion:   %s\n", s.Delivered, s.Skipped, s.Pending, svc, version)
	return 0
}

func cmdLogs(args []string) int {
	fs := newFlags("logs")
	n := fs.Int("n", 40, "number of lines")
	svc := fs.Bool("service", false, "show the service supervisor log instead")
	if code, ok := parse(fs, args); !ok {
		return code
	}
	path := platform.ServiceLogPath()
	if !*svc {
		home, err := core.Home()
		if err != nil {
			return errf("%v", err)
		}
		path = filepath.Join(home, "bridge.log")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return errf("no log yet at %s", path)
	}
	lines := strings.Split(strings.TrimRight(string(b), "\r\n"), "\n")
	if len(lines) > *n {
		lines = lines[len(lines)-*n:]
	}
	fmt.Println(strings.Join(lines, "\n"))
	return 0
}

// ---- enroll, revoke

func doEnroll(server, workspace, name string, cred credFlags, force bool) (*core.Config, error) {
	var err error
	if server == "" {
		if server, err = ask("Orbit server URL (https://...)", ""); err != nil {
			return nil, err
		}
	}
	if workspace == "" {
		if workspace, err = ask("Workspace id", ""); err != nil {
			return nil, err
		}
	}
	c, err := cred.resolve("Orbit session token (value of the __Host-orbit_session cookie)")
	if err != nil {
		return nil, err
	}
	return httpClient().Enroll(plat.Keys(), core.EnrollOptions{Server: server, WorkspaceID: workspace, Name: name, Credential: c, Force: force})
}

func cmdEnroll(args []string) int {
	fs := newFlags("enroll")
	server := fs.String("server", "", "Orbit server URL (https://...)")
	workspace := fs.String("workspace", "", "workspace id")
	name := fs.String("name", "", "device name (default: the computer name)")
	force := fs.Bool("force", false, "replace an existing enrollment")
	cred := addCredFlags(fs)
	if code, ok := parse(fs, args); !ok {
		return code
	}
	cfg, err := doEnroll(*server, *workspace, *name, cred, *force)
	if err != nil {
		return errf("%v", err)
	}
	fmt.Printf("Enrolled. Device %s delivers to %s. Key stored in: %s.\n", cfg.DeviceID, cfg.Address, cfg.KeyProvider)
	return 0
}

func cmdRevoke(args []string) int {
	fs := newFlags("revoke")
	local := fs.Bool("local-only", false, "only remove the local key and data (the device is already revoked in Orbit)")
	cred := addCredFlags(fs)
	if code, ok := parse(fs, args); !ok {
		return code
	}
	var c *core.Credential
	if !*local {
		v, err := cred.resolve("Orbit session token (value of the __Host-orbit_session cookie)")
		if err != nil {
			return errf("%v", err)
		}
		c = &v
	}
	if err := httpClient().Revoke(plat.Keys(), c, *local); err != nil {
		return errf("%v", err)
	}
	fmt.Println("Device revoked. The local key, config and state are removed.")
	fmt.Println("The service (if installed) keeps running but has nothing to deliver; remove it with: torbit-bridge uninstall")
	return 0
}

// ---- run, backfill

func loadEngine(needOutlook bool) (*core.Engine, func(), error) {
	cfg, err := core.ReadConfig()
	if err != nil {
		return nil, nil, err
	}
	if cfg == nil {
		return nil, nil, core.ErrNotEnrolled
	}
	signer, err := plat.Keys().Open(cfg.KeyName, cfg.KeyProvider)
	if err != nil {
		return nil, nil, fmt.Errorf("the device key is missing or unusable (%v); run: torbit-bridge setup --force", err)
	}
	ad, err := plat.NewOutlook()
	if err != nil {
		signer.Close()
		return nil, nil, err
	}
	return &core.Engine{HTTP: httpClient(), Config: cfg, Signer: signer, Adapter: ad}, func() { ad.Close(); signer.Close() }, nil
}

func cmdRun(args []string) int {
	fs := newFlags("run")
	interval := &duration{time.Minute}
	fs.Var(interval, "interval", "time between sweeps (seconds or 1m30s)")
	fromService := fs.Bool("from-service", false, "started by the service")
	if code, ok := parse(fs, args); !ok {
		return code
	}
	release, err := plat.RunLock()
	if err != nil {
		fmt.Fprintln(os.Stderr, "torbit-bridge:", err)
		if errors.Is(err, platform.ErrAlreadyRunning) {
			return platform.ExitAlreadyRunning
		}
		return 1
	}
	defer release()
	e, closeAll, err := loadEngine(true)
	if err != nil {
		core.Logf("run could not start: %v", err)
		return errf("%v", err)
	}
	defer closeAll()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	core.Logf("run started (version %s, interval %s, service %v)", version, interval.d, *fromService)
	e.Run(ctx, interval.d)
	core.Logf("run stopped")
	return 0
}

func cmdBackfill(args []string) int {
	fs := newFlags("backfill")
	since := fs.String("since", "", "deliver items received since this date (2026-01-01 or 2026-01-01T09:00)")
	if code, ok := parse(fs, args); !ok {
		return code
	}
	if *since == "" {
		return errf("backfill needs a start date, for example: --since 2026-01-01")
	}
	t, err := time.ParseInLocation("2006-01-02", *since, time.Local)
	if err != nil {
		if t, err = time.ParseInLocation("2006-01-02T15:04", *since, time.Local); err != nil {
			return errf("cannot read the date %q; use 2026-01-01 or 2026-01-01T09:00", *since)
		}
	}
	e, closeAll, err := loadEngine(true)
	if err != nil {
		return errf("%v", err)
	}
	defer closeAll()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	r, err := e.Backfill(ctx, t)
	if err != nil {
		return errf("%v", err)
	}
	fmt.Printf("Backfill: %d delivered, %d skipped (rejected by Orbit), %d not delivered yet.\n", r.Delivered, r.Skipped, r.Pending)
	if r.Pending > 0 {
		fmt.Println("Orbit was not reachable for some items. Run backfill again later; delivered items are not sent twice.")
	}
	return 0
}

// ---- doctor

func cmdDoctor(args []string) int {
	fs := newFlags("doctor")
	if code, ok := parse(fs, args); !ok {
		return code
	}
	return printChecks(runDoctor(true))
}

func runDoctor(includeOutlook bool) []core.Check {
	fmt.Printf("torbit-bridge %s on %s/%s\n\n", version, runtime.GOOS, runtime.GOARCH)
	checks := core.Diagnose(httpClient(), plat.Keys())
	if includeOutlook {
		checks = append(checks, checkOutlook())
	}
	return append(checks, checkService()...)
}

func printChecks(checks []core.Check) int {
	worst := core.OK
	for _, c := range checks {
		mark := map[core.Level]string{core.OK: "[ ok ]", core.Warn: "[warn]", core.Fail: "[FAIL]"}[c.Level]
		fmt.Printf("%s %-14s %s\n", mark, c.Name, c.Detail)
		if c.Level != core.OK && c.Hint != "" {
			fmt.Printf("       %-14s -> %s\n", "", c.Hint)
		}
		if c.Level > worst {
			worst = c.Level
		}
	}
	fmt.Println()
	switch worst {
	case core.OK:
		fmt.Println("Everything looks good.")
		return 0
	case core.Warn:
		fmt.Println("Works, with warnings.")
		return 0
	}
	fmt.Println("Problems found. Fix the failures above, then run doctor again.")
	return 1
}

func checkOutlook() core.Check {
	c := core.Check{Name: "Outlook"}
	if !platform.Supported {
		c.Level, c.Detail = core.Warn, "not checked (Outlook automation is Windows only)"
		return c
	}
	type result struct {
		n   int
		err error
	}
	ch := make(chan result, 1)
	go func() {
		ad, err := plat.NewOutlook()
		if err != nil {
			ch <- result{0, err}
			return
		}
		defer ad.Close()
		items, release, err := ad.Inbox(time.Now().Add(-24 * time.Hour))
		if err == nil {
			defer release()
		}
		ch <- result{len(items), err}
	}()
	select {
	case r := <-ch:
		if r.err != nil {
			c.Level, c.Detail = core.Fail, r.err.Error()
			c.Hint = "Start classic Outlook, signed in, as the same non-elevated user that runs the bridge. See docs/bridge.md (Outlook automation blocked)."
			return c
		}
		c.Level, c.Detail = core.OK, fmt.Sprintf("classic Outlook answered; %d inbox item(s) in the last 24 hours", r.n)
	case <-time.After(60 * time.Second):
		c.Level, c.Detail = core.Warn, "Outlook did not answer in 60 seconds"
		c.Hint = "A dialog in Outlook may be waiting for an answer (profile, sign-in or a security prompt)."
	}
	return c
}

func checkService() []core.Check {
	var out []core.Check
	if !platform.Supported {
		return out
	}
	info, err := platform.QueryService()
	if err != nil {
		return append(out, core.Check{Name: "Service", Level: core.Warn, Detail: "cannot query the service manager: " + err.Error()})
	}
	if !info.Installed {
		return append(out, core.Check{Name: "Service", Level: core.Warn, Detail: "not installed",
			Hint: "Install it so the bridge starts with Windows: torbit-bridge install"})
	}
	c := core.Check{Name: "Service", Level: core.OK, Detail: fmt.Sprintf("%s, %s start", info.State, info.StartType)}
	if info.State != "running" {
		c.Level, c.Hint = core.Warn, "Start it: torbit-bridge start"
	}
	if info.StartType != "automatic" {
		c.Level, c.Hint = core.Warn, "Run torbit-bridge install again to set automatic start."
	}
	out = append(out, c)
	if v, err := exec.Command(info.Path, "version", "--short").Output(); err != nil {
		out = append(out, core.Check{Name: "Service binary", Level: core.Fail, Detail: info.Path + " does not run: " + err.Error(), Hint: "Run: torbit-bridge install"})
	} else if got := strings.TrimSpace(string(v)); got != version {
		out = append(out, core.Check{Name: "Service binary", Level: core.Warn, Detail: fmt.Sprintf("installed version %s, this is %s", got, version),
			Hint: "Update the installed copy: torbit-bridge install (or torbit-bridge upgrade)"})
	} else {
		out = append(out, core.Check{Name: "Service binary", Level: core.OK, Detail: info.Path + " (" + got + ")"})
	}
	if sid, _, err := platform.CurrentUser(); err == nil && info.User != "" && !strings.EqualFold(sid, info.User) {
		out = append(out, core.Check{Name: "Service user", Level: core.Warn, Detail: "the service delivers for another Windows user than the one running doctor",
			Hint: "Enrollment and the key belong to one user. Run doctor as that user, or install again as this user."})
	}
	return out
}

// ---- elevation helper

// elevate reruns this command with administrator rights (one UAC prompt) and
// prints what the elevated process said.
func elevate(args []string) int {
	tmp, err := os.CreateTemp("", "torbit-bridge-*.out")
	if err != nil {
		return errf("%v", err)
	}
	tmp.Close()
	defer os.Remove(tmp.Name())
	fmt.Println("Administrator rights are needed; confirm the Windows prompt...")
	code, err := platform.RelaunchElevated(append(args, "--relay", tmp.Name()))
	if b, rerr := os.ReadFile(tmp.Name()); rerr == nil {
		os.Stdout.Write(b)
	}
	if err != nil {
		return errf("could not start the elevated process: %v", err)
	}
	return code
}

func needAdmin(args []string) (int, bool) {
	if !platform.Supported {
		return errf("the Windows service is only available on Windows"), true
	}
	if platform.IsElevated() {
		return 0, false
	}
	return elevate(args), true
}

// ---- install, uninstall, start, stop, service

func cmdInstall(args []string) int {
	fs := newFlags("install")
	user := fs.String("user", "", "Windows user whose Outlook the bridge reads (DOMAIN\\name or SID; default: you)")
	interval := &duration{time.Minute}
	fs.Var(interval, "interval", "time between sweeps (seconds or 1m30s)")
	noStart := fs.Bool("no-start", false, "install but do not start")
	if code, ok := parse(fs, args); !ok {
		return code
	}
	if !platform.Supported {
		return errf("the Windows service is only available on Windows")
	}
	if !platform.IsElevated() {
		// Fix the user now: after the UAC prompt "you" may be a different account.
		u := *user
		if u == "" {
			sid, _, err := platform.CurrentUser()
			if err != nil {
				return errf("%v", err)
			}
			u = sid
		}
		re := []string{"install", "--user", u, "--interval", strconv.Itoa(int(interval.d.Seconds()))}
		if *noStart {
			re = append(re, "--no-start")
		}
		return elevate(re)
	}
	if err := platform.InstallService(platform.InstallOptions{User: *user, Interval: interval.d, NoStart: *noStart, Log: os.Stdout}); err != nil {
		return errf("%v", err)
	}
	return 0
}

func cmdUninstall(args []string) int {
	fs := newFlags("uninstall")
	purge := fs.Bool("purge", false, "also delete the device key, config and state on this PC (does not revoke it in Orbit)")
	if code, ok := parse(fs, args); !ok {
		return code
	}
	if code, done := needAdmin(args); done {
		return code
	}
	if err := platform.UninstallService(os.Stdout); err != nil {
		return errf("%v", err)
	}
	if *purge {
		// The elevated user may differ from the enrolled user; the purge has to
		// run as the enrolled user, so only do it when they are the same.
		return purgeLocal()
	}
	fmt.Println("The device stays enrolled. Re-install with: torbit-bridge install. To remove it too: torbit-bridge revoke")
	return 0
}

func purgeLocal() int {
	if err := httpClient().Revoke(plat.Keys(), nil, true); err != nil && !errors.Is(err, errNotEnrolled) && err.Error() != "this computer is not enrolled" {
		return errf("%v", err)
	}
	fmt.Println("Local device key, config and state removed. Revoke the device in Orbit as well (torbit-bridge revoke needs it enrolled), or remove it in the Orbit admin UI.")
	return 0
}

var errNotEnrolled = core.ErrNotEnrolled

func cmdStart(args []string) int { return serviceControl("start", args, true) }
func cmdStop(args []string) int  { return serviceControl("stop", args, false) }

func serviceControl(name string, args []string, start bool) int {
	fs := newFlags(name)
	if code, ok := parse(fs, args); !ok {
		return code
	}
	if code, done := needAdmin([]string{name}); done {
		return code
	}
	if err := platform.ControlService(start); err != nil {
		return errf("%v", err)
	}
	fmt.Printf("Service %s: done.\n", name)
	return 0
}

func cmdService(args []string) int {
	fs := newFlags("service")
	user := fs.String("user", "", "SID of the Windows user the worker runs for")
	interval := &duration{time.Minute}
	fs.Var(interval, "interval", "time between sweeps")
	if code, ok := parse(fs, args); !ok {
		return code
	}
	if !platform.IsWindowsService() {
		return errf("this command is for the Windows Service Control Manager; use 'run' in a terminal")
	}
	if err := platform.RunService(*user, interval.d); err != nil {
		return errf("%v", err)
	}
	return 0
}

// ---- setup

func cmdSetup(args []string) int {
	fs := newFlags("setup")
	server := fs.String("server", "", "Orbit server URL (https://...)")
	workspace := fs.String("workspace", "", "workspace id")
	name := fs.String("name", "", "device name (default: the computer name)")
	force := fs.Bool("force", false, "enroll again even if this PC is enrolled")
	noService := fs.Bool("no-service", false, "do not install the Windows service")
	interval := &duration{time.Minute}
	fs.Var(interval, "interval", "time between sweeps (seconds or 1m30s)")
	cred := addCredFlags(fs)
	if code, ok := parse(fs, args); !ok {
		return code
	}
	fmt.Println("torbit-bridge setup")

	fmt.Println("\n[1/3] Enroll this PC")
	cfg, err := core.ReadConfig()
	if err != nil {
		return errf("%v", err)
	}
	if cfg != nil && !*force {
		fmt.Printf("Already enrolled as device %s (%s). Use --force to enroll again.\n", cfg.DeviceID, cfg.Address)
	} else {
		cfg, err = doEnroll(*server, *workspace, *name, cred, *force)
		if err != nil {
			return errf("%v", err)
		}
		fmt.Printf("Enrolled. Device %s delivers to %s (key: %s).\n", cfg.DeviceID, cfg.Address, cfg.KeyProvider)
	}

	fmt.Println("\n[2/3] Check Outlook")
	oc := checkOutlook()
	fmt.Printf("%s: %s\n", oc.Level, oc.Detail)
	if oc.Hint != "" {
		fmt.Println("  ->", oc.Hint)
	}

	fmt.Println("\n[3/3] Windows service")
	switch {
	case *noService:
		fmt.Println("Skipped (--no-service). Run in a terminal with: torbit-bridge run")
	case !platform.Supported:
		fmt.Println("Skipped: the service is only available on Windows.")
	default:
		re := []string{"install", "--interval", strconv.Itoa(int(interval.d.Seconds()))}
		if code := cmdInstall(re[1:]); code != 0 {
			fmt.Println("The service was not installed. Enrollment is kept; retry with: torbit-bridge install")
			return code
		}
	}

	fmt.Println("\nSummary")
	return printChecks(runDoctorQuiet())
}

func runDoctorQuiet() []core.Check {
	checks := core.Diagnose(httpClient(), plat.Keys())
	return append(checks, checkService()...)
}
