//go:build windows

// Package platform is the Windows layer: the CNG device key, Outlook COM, the
// proxy settings, the run lock, and the service with its install helpers.
package platform

import (
	"errors"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/t128n/torbit/bridge/internal/core"
)

const Supported = true

type Platform struct{}

func New() core.Platform { return Platform{} }

func (Platform) Keys() core.KeyStore               { return cngKeys{} }
func (Platform) NewOutlook() (core.Adapter, error) { return newOutlook() }

// RunLock allows one worker per Windows user session: the service worker and
// a manual `run` must not both deliver.
func (Platform) RunLock() (func(), error) {
	name, _ := windows.UTF16PtrFromString(`Local\TorbitBridgeRun`)
	h, err := windows.CreateMutex(nil, true, name)
	if err != nil {
		if h != 0 {
			windows.CloseHandle(h)
		}
		if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
			return nil, ErrAlreadyRunning
		}
		return nil, err
	}
	return func() { windows.ReleaseMutex(h); windows.CloseHandle(h) }, nil
}

var ErrAlreadyRunning = errors.New("the bridge is already running for this user")

// Proxy: HTTPS_PROXY and friends first, then the proxy the current user has set
// in Windows (Internet Settings). PAC scripts and proxy sign-in with the
// Windows account are not supported.
func (Platform) Proxy() func(*http.Request) (*url.URL, error) {
	return func(r *http.Request) (*url.URL, error) {
		if u, err := http.ProxyFromEnvironment(r); u != nil || err != nil {
			return u, err
		}
		return registryProxy(r.URL)
	}
}

func registryProxy(target *url.URL) (*url.URL, error) {
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Internet Settings`, registry.QUERY_VALUE)
	if err != nil {
		return nil, nil
	}
	defer k.Close()
	if on, _, err := k.GetIntegerValue("ProxyEnable"); err != nil || on == 0 {
		return nil, nil
	}
	server, _, err := k.GetStringValue("ProxyServer")
	if err != nil || server == "" {
		return nil, nil
	}
	override, _, _ := k.GetStringValue("ProxyOverride")
	if bypassed(target.Hostname(), override) {
		return nil, nil
	}
	chosen := server
	if strings.Contains(server, "=") { // per-scheme list: http=h:80;https=h:443
		chosen = ""
		for _, part := range strings.Split(server, ";") {
			if k, v, ok := strings.Cut(part, "="); ok && strings.EqualFold(k, target.Scheme) {
				chosen = v
			}
		}
		if chosen == "" {
			return nil, nil
		}
	}
	if !strings.Contains(chosen, "://") {
		chosen = "http://" + chosen
	}
	return url.Parse(chosen)
}

func bypassed(host, override string) bool {
	for _, p := range strings.FieldsFunc(override, func(r rune) bool { return r == ';' || r == ',' }) {
		p = strings.TrimSpace(strings.ToLower(p))
		h := strings.ToLower(host)
		switch {
		case p == "<local>":
			if !strings.Contains(h, ".") {
				return true
			}
		case strings.HasPrefix(p, "*"):
			if strings.HasSuffix(h, strings.TrimPrefix(p, "*")) {
				return true
			}
		case strings.HasSuffix(p, "*"):
			if strings.HasPrefix(h, strings.TrimSuffix(p, "*")) {
				return true
			}
		case p == h:
			return true
		}
	}
	return false
}

// ---- identity and elevation

func IsElevated() bool { return windows.GetCurrentProcessToken().IsElevated() }

// CurrentUser returns the SID string and DOMAIN\name of this process's user.
func CurrentUser() (sid, name string, err error) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return "", "", err
	}
	sid = u.User.Sid.String()
	acct, dom, _, err := u.User.Sid.LookupAccount("")
	if err != nil {
		return sid, sid, nil
	}
	return sid, dom + `\` + acct, nil
}

// ResolveUser accepts DOMAIN\name, name or a SID string.
func ResolveUser(user string) (sid, name string, err error) {
	if s, e := windows.StringToSid(user); e == nil {
		acct, dom, _, e2 := s.LookupAccount("")
		if e2 != nil {
			return s.String(), s.String(), nil
		}
		return s.String(), dom + `\` + acct, nil
	}
	s, dom, _, err := windows.LookupSID("", user)
	if err != nil {
		return "", "", errors.New("unknown Windows user " + strconv.Quote(user))
	}
	acct, _, _, _ := s.LookupAccount("")
	return s.String(), dom + `\` + acct, nil
}

// RelaunchElevated runs this program again with the given arguments after a
// UAC prompt, waits for it and returns its exit code. The child's output goes
// to relayFile (it has no console of its own), which the caller prints.
func RelaunchElevated(args []string) (int, error) {
	exe, err := os.Executable()
	if err != nil {
		return 1, err
	}
	return shellExecuteRunAs(exe, windows.ComposeCommandLine(args))
}
