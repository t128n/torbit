package core

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// HTTP is the client every request goes through. Tests replace Transport.
type HTTP struct {
	Platform  Platform
	Transport http.RoundTripper // nil = default transport with the Windows proxy settings
}

func (h *HTTP) client() *http.Client {
	rt := h.Transport
	if rt == nil {
		t := http.DefaultTransport.(*http.Transport).Clone()
		if h.Platform != nil {
			t.Proxy = h.Platform.Proxy()
		}
		rt = t
	}
	return &http.Client{
		Transport: rt, Timeout: 60 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// Response is a status (0 = network error) and the body text.
type Response struct {
	Status int
	Body   string
	Date   time.Time // the server's Date header, when present
	Err    error
}

func (h *HTTP) Do(method, rawURL string, headers map[string]string, contentType string, body []byte) Response {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, rawURL, rd)
	if err != nil {
		return Response{Err: err}
	}
	for k, v := range headers {
		if strings.EqualFold(k, "Cookie") {
			req.Header.Set("Cookie", v)
		} else {
			req.Header.Set(k, v)
		}
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("User-Agent", "torbit-bridge")
	resp, err := h.client().Do(req)
	if err != nil {
		return Response{Err: err}
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	d, _ := http.ParseTime(resp.Header.Get("Date"))
	return Response{Status: resp.StatusCode, Body: string(b), Date: d}
}

// AssertServerURL requires https (http only for loopback).
func AssertServerURL(server string) error {
	u, err := url.Parse(server)
	if err != nil || !u.IsAbs() || u.Host == "" {
		return errors.New("server must be a full URL such as https://torbit.example.com")
	}
	if u.Scheme == "https" {
		return nil
	}
	if u.Scheme == "http" {
		host := u.Hostname()
		if host == "localhost" {
			return nil
		}
		if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
			return nil
		}
	}
	return errors.New("server must use https (http only for localhost)")
}

// Outcome of one delivery attempt.
type Outcome string

const (
	Delivered Outcome = "Delivered"
	Retry     Outcome = "Retry"     // 5xx, 429, 408, network
	Permanent Outcome = "Permanent" // 401/404 (may mean re-enroll), 413, other 4xx
)

type SendResult struct {
	Outcome Outcome
	Status  int
	Reason  string
}

func (h *HTTP) SendMessage(cfg *Config, signer Signer, mime []byte) SendResult {
	if len(mime) > MaxBodyBytes {
		return SendResult{Permanent, 413, "Message is larger than 2 MiB."}
	}
	headers, err := RequestHeaders(cfg.DeviceID, mime, signer, "", "")
	if err != nil {
		return SendResult{Permanent, 0, "Could not sign the message: " + err.Error()}
	}
	u := strings.TrimRight(cfg.Server, "/") + "/api/v1/mail/inbound/bridge/" + cfg.DeviceID
	res := h.Do("POST", u, headers, "message/rfc822", mime)
	switch s := res.Status; {
	case s == 200:
		return SendResult{Delivered, s, ""}
	case s == 0 || s >= 500 || s == 429 || s == 408:
		return SendResult{Retry, s, "Orbit or the network is not available; try again later."}
	case s == 401 && strings.Contains(res.Body, "device_revoked"):
		return SendResult{Permanent, s, "This device was revoked in Orbit. Run: torbit-bridge setup --force"}
	case s == 401 || s == 404:
		return SendResult{Permanent, s, "Orbit rejected this device. It may be revoked; enroll again."}
	case s == 413:
		return SendResult{Permanent, s, "Message is too large for Orbit."}
	default:
		return SendResult{Permanent, s, fmt.Sprintf("Orbit answered %d.", s)}
	}
}

func (h *HTTP) SendItem(cfg *Config, signer Signer, it *Item) SendResult {
	if it.Size > MaxBodyBytes {
		// clearly over the limit: do not load attachments or build the message
		Logf("item %s -> Permanent (413, too large)", it.EntryID)
		return SendResult{Permanent, 413, "Message is larger than 2 MiB."}
	}
	mime, err := ToMIME(it)
	if err != nil {
		Logf("item %s -> Retry (could not read the item: %v)", it.EntryID, err)
		return SendResult{Retry, 0, "Could not read the item from Outlook: " + err.Error()}
	}
	r := h.SendMessage(cfg, signer, mime)
	Logf("item %s -> %s (%d)", it.EntryID, r.Outcome, r.Status)
	return r
}

// ---- enrollment

// Credential is an Orbit session token (sent as the session cookie) or an API
// token (Bearer). It is used for one call and never stored or logged.
type Credential struct {
	Kind  string // "session" | "api"
	Value string
}

func (c Credential) headers(server string) map[string]string {
	u, _ := url.Parse(server)
	h := map[string]string{"Origin": u.Scheme + "://" + u.Host, "Accept": "application/json"}
	if c.Kind == "api" {
		h["Authorization"] = "Bearer " + c.Value
	} else {
		h["Cookie"] = "__Host-orbit_session=" + c.Value
	}
	return h
}

type EnrollOptions struct {
	Server, WorkspaceID, Name, Provider string
	Credential                          Credential
	Force                               bool
}

func (h *HTTP) Enroll(keys KeyStore, o EnrollOptions) (*Config, error) {
	if err := AssertServerURL(o.Server); err != nil {
		return nil, err
	}
	name := o.Name
	if name == "" {
		name, _ = osHostname()
	}
	if name == "" {
		name = "Outlook bridge"
	}
	if r := []rune(name); len(r) > 80 {
		name = string(r[:80])
	}
	if old, err := ReadConfig(); err != nil {
		return nil, err
	} else if old != nil && !o.Force {
		return nil, errors.New("this computer is already enrolled; use --force to enroll again")
	}
	keyName := "Torbit-Bridge-" + strings.ReplaceAll(newUUID(), "-", "")
	provider, spki, err := keys.Create(keyName, o.Provider)
	if err != nil {
		return nil, fmt.Errorf("could not create the signing key in the Windows key store: %w", err)
	}
	fail := func(e error) (*Config, error) { keys.Delete(keyName, provider); return nil, e }

	payload, _ := json.Marshal(map[string]string{"name": name, "public_key": spki})
	server := strings.TrimRight(o.Server, "/")
	u := server + "/api/v1/workspaces/" + url.PathEscape(o.WorkspaceID) + "/mail/bridge/devices"
	res := h.Do("POST", u, o.Credential.headers(server), "application/json", payload)
	switch s := res.Status; {
	case s == 201:
	case s == 401 || s == 403:
		return fail(errors.New("Orbit did not accept the credential. Sign in again and use a fresh session token"))
	case s == 404:
		return fail(errors.New("Orbit answered 404. Check the workspace id and that the bridge is turned on for this server"))
	case s == 0:
		return fail(fmt.Errorf("could not reach Orbit. Check the server URL and your network or proxy (%v)", res.Err))
	default:
		return fail(fmt.Errorf("enrollment failed with status %d", s))
	}
	var dev struct{ ID, Address, Name string }
	if err := json.Unmarshal([]byte(res.Body), &dev); err != nil || dev.ID == "" {
		return fail(errors.New("Orbit answered with an unexpected enrollment response"))
	}
	cfg := &Config{Server: server, WorkspaceID: o.WorkspaceID, DeviceID: dev.ID, Address: dev.Address,
		DeviceName: dev.Name, KeyName: keyName, KeyProvider: provider, EnrolledAt: fmtTime(time.Now())}
	if err := WriteConfig(cfg); err != nil {
		return fail(err)
	}
	if o.Force {
		resetAuthSkipped()
	}
	Logf("enrolled device %s with %s", cfg.DeviceID, provider)
	return cfg, nil
}

// After a new enrollment the earlier 401/404 skips (the old device was
// rejected) are stale: forget them so the next sweep sends those items again.
func resetAuthSkipped() {
	_ = UpdateState(func(s *State) {
		var oldest time.Time
		for id, rec := range s.Items {
			if rec.Outcome != "skipped" || (rec.Status != 401 && rec.Status != 404) {
				continue
			}
			if t, ok := parseTime(rec.Received); ok && (oldest.IsZero() || t.Before(oldest)) {
				oldest = t
			}
			delete(s.Items, id)
		}
		if c, ok := parseTime(s.Cursor); ok && !oldest.IsZero() && c.After(oldest) {
			s.Cursor = fmtTime(oldest)
		}
	})
}

// Revoke marks the device revoked in Orbit (unless localOnly), then deletes the
// local key, config and state. If the server call fails nothing is removed.
func (h *HTTP) Revoke(keys KeyStore, cred *Credential, localOnly bool) error {
	cfg, err := ReadConfig()
	if err != nil {
		return err
	}
	if cfg == nil {
		return errors.New("this computer is not enrolled")
	}
	if !localOnly {
		if cred == nil || cred.Value == "" {
			return errors.New("a credential is needed to revoke the device in Orbit; use --local-only to only remove the local data")
		}
		if err := AssertServerURL(cfg.Server); err != nil {
			return err
		}
		u := strings.TrimRight(cfg.Server, "/") + "/api/v1/workspaces/" + url.PathEscape(cfg.WorkspaceID) + "/mail/bridge/devices/" + url.PathEscape(cfg.DeviceID)
		res := h.Do("DELETE", u, cred.headers(cfg.Server), "", nil)
		switch s := res.Status; {
		case s == 204 || s == 200:
		case s == 401 || s == 403:
			return errors.New("Orbit did not accept the credential. Sign in again and use a fresh session token")
		case s == 404:
			return errors.New("Orbit does not know this device. If it was already removed, run revoke with --local-only")
		case s == 0:
			return fmt.Errorf("could not reach Orbit. Check the server URL and your network or proxy (%v)", res.Err)
		default:
			return fmt.Errorf("revoke failed with status %d", s)
		}
	}
	keys.Delete(cfg.KeyName, cfg.KeyProvider)
	home, err := Home()
	if err != nil {
		return err
	}
	for _, f := range []string{"config.json", "state.json"} {
		os.Remove(filepath.Join(home, f))
	}
	Logf("revoked device %s; local key, config and state removed", cfg.DeviceID)
	return nil
}

// doLarge is Do with a 256 MiB body limit and a longer timeout, for downloads.
func (h *HTTP) doLarge(url string) Response {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return Response{Err: err}
	}
	req.Header.Set("User-Agent", "torbit-bridge")
	c := h.client()
	c.Timeout = 10 * time.Minute
	c.CheckRedirect = nil // release assets redirect to a CDN
	resp, err := c.Do(req)
	if err != nil {
		return Response{Err: err}
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 256<<20))
	return Response{Status: resp.StatusCode, Body: string(b), Err: err}
}
