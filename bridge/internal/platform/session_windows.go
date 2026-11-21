//go:build windows

package platform

import (
	"errors"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Classic Outlook only works inside the signed-in user's own session, and a
// service lives in session 0. The service therefore starts the worker
// (`torbit-bridge run`) inside the user's session with that user's token.

const (
	wtsActive       = 0
	wtsDisconnected = 4
)

type session struct {
	id     uint32
	active bool
	token  windows.Token // primary, duplicated, non-elevated; caller closes
	sid    string
}

// findSession returns the session of the wanted user (any user when wantSID is
// empty), preferring an active one.
func findSession(wantSID string) (*session, error) {
	var infos *windows.WTS_SESSION_INFO
	var count uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &infos, &count); err != nil {
		return nil, err
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(infos)))
	list := unsafe.Slice(infos, count)
	var best *session
	for _, s := range list {
		if s.SessionID == 0 || (s.State != wtsActive && s.State != wtsDisconnected) {
			continue
		}
		var tok windows.Token
		if err := windows.WTSQueryUserToken(s.SessionID, &tok); err != nil {
			continue
		}
		u, err := tok.GetTokenUser()
		if err != nil {
			tok.Close()
			continue
		}
		sid := u.User.Sid.String()
		if wantSID != "" && !strings.EqualFold(sid, wantSID) {
			tok.Close()
			continue
		}
		cand := &session{id: s.SessionID, active: s.State == wtsActive, token: tok, sid: sid}
		if best == nil || (cand.active && !best.active) {
			if best != nil {
				best.token.Close()
			}
			best = cand
		} else {
			tok.Close()
		}
	}
	if best == nil {
		return nil, errors.New("no signed-in session for the bridge user")
	}
	return best, nil
}

// limitedPrimary returns a primary token for tok. A UAC administrator's session
// token can be the elevated half; Outlook runs non-elevated, so use the linked
// limited token then, so both run at the same level.
func limitedPrimary(tok windows.Token) (windows.Token, error) {
	src := tok
	var linked windows.Token
	if et, err := tok.GetLinkedToken(); err == nil {
		if !tok.IsElevated() {
			et.Close()
		} else {
			linked = et
			src = et
		}
	}
	var dup windows.Token
	err := windows.DuplicateTokenEx(src, windows.MAXIMUM_ALLOWED, nil, windows.SecurityImpersonation, windows.TokenPrimary, &dup)
	if linked != 0 {
		linked.Close()
	}
	return dup, err
}

type worker struct {
	proc      windows.Handle
	pid       uint32
	sessionID uint32
}

func startWorker(s *session, exe, args string) (*worker, error) {
	tok, err := limitedPrimary(s.token)
	if err != nil {
		return nil, err
	}
	defer tok.Close()
	var env *uint16
	if err := windows.CreateEnvironmentBlock(&env, tok, false); err != nil {
		return nil, err
	}
	defer windows.DestroyEnvironmentBlock(env)
	cmd, _ := windows.UTF16PtrFromString(windows.EscapeArg(exe) + " " + args)
	desktop, _ := windows.UTF16PtrFromString(`winsta0\default`)
	si := windows.StartupInfo{Desktop: desktop}
	si.Cb = uint32(unsafe.Sizeof(si))
	var pi windows.ProcessInformation
	flags := uint32(windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_NO_WINDOW)
	if err := windows.CreateProcessAsUser(tok, nil, cmd, nil, nil, false, flags, env, nil, &si, &pi); err != nil {
		return nil, err
	}
	windows.CloseHandle(pi.Thread)
	return &worker{proc: pi.Process, pid: pi.ProcessId, sessionID: s.id}, nil
}

// exited reports whether the worker has ended, and its exit code.
func (w *worker) exited() (bool, uint32) {
	ev, err := windows.WaitForSingleObject(w.proc, 0)
	if err != nil || ev != windows.WAIT_OBJECT_0 {
		return false, 0
	}
	var code uint32
	windows.GetExitCodeProcess(w.proc, &code)
	return true, code
}

func (w *worker) kill() {
	windows.TerminateProcess(w.proc, 1)
	windows.WaitForSingleObject(w.proc, 5000)
	windows.CloseHandle(w.proc)
}
