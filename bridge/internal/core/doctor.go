package core

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Level int

const (
	OK Level = iota
	Warn
	Fail
)

func (l Level) String() string { return [...]string{"ok", "warn", "FAIL"}[l] }

// Check is one doctor result. Hint says what to do about a warning or failure.
type Check struct {
	Name   string
	Level  Level
	Detail string
	Hint   string
}

// Diagnose runs the platform-independent checks. Extra checks (Outlook,
// service) are appended by the caller.
func Diagnose(h *HTTP, keys KeyStore) []Check {
	var out []Check
	add := func(name string, l Level, detail, hint string) { out = append(out, Check{name, l, detail, hint}) }

	home, err := Home()
	if err != nil {
		add("Bridge folder", Fail, err.Error(), "Set TORBIT_BRIDGE_HOME to a folder you can write to.")
		return out
	}
	probe := filepath.Join(home, ".doctor")
	if err := os.WriteFile(probe, []byte("x"), 0o600); err != nil {
		add("Bridge folder", Fail, home+": "+err.Error(), "Make the folder writable for this Windows user.")
	} else {
		os.Remove(probe)
		add("Bridge folder", OK, home, "")
	}

	cfg, err := ReadConfig()
	if err != nil {
		add("Enrollment", Fail, err.Error(), "Delete the damaged file and run: torbit-bridge setup --force")
		return out
	}
	if cfg == nil {
		add("Enrollment", Fail, "this computer is not enrolled", "Run: torbit-bridge setup")
		return out
	}
	add("Enrollment", OK, fmt.Sprintf("device %s delivers to %s", cfg.DeviceID, cfg.Address), "")

	if err := AssertServerURL(cfg.Server); err != nil {
		add("Server URL", Fail, cfg.Server+": "+err.Error(), "Enroll again with an https URL: torbit-bridge setup --force")
	}

	out = append(out, checkKey(keys, cfg))
	out = append(out, checkServer(h, cfg)...)

	st, err := ReadState()
	if err != nil {
		add("State", Fail, err.Error(), "Move state.json aside; the bridge starts a new record (mail may be sent again).")
		return out
	}
	skipped := 0
	for _, r := range st.Items {
		if r.Outcome == "skipped" {
			skipped++
		}
	}
	switch {
	case skipped > 0:
		add("Delivery", Warn, fmt.Sprintf("%d item(s) skipped, %d waiting to retry", skipped, len(st.Pending)),
			"Skipped items were rejected by Orbit (see bridge.log). After a device re-enrollment, run: torbit-bridge setup --force")
	case len(st.Pending) > 0:
		add("Delivery", Warn, fmt.Sprintf("%d item(s) waiting to retry", len(st.Pending)), "Orbit was not reachable; the next sweep retries.")
	default:
		add("Delivery", OK, fmt.Sprintf("no items waiting; %d delivered", len(st.Items)-skipped), "")
	}
	if t, ok := parseTime(st.LastRun); ok {
		age := time.Since(t).Round(time.Second)
		if age > 30*time.Minute {
			add("Last run", Warn, fmt.Sprintf("%s ago", age), "The bridge is not running. Start it: torbit-bridge start (service) or torbit-bridge run")
		} else {
			add("Last run", OK, fmt.Sprintf("%s ago", age), "")
		}
	} else {
		add("Last run", Warn, "never", "Start the bridge: torbit-bridge start (service) or torbit-bridge run")
	}
	return out
}

func checkKey(keys KeyStore, cfg *Config) Check {
	c := Check{Name: "Signing key"}
	spki, err := keys.PublicKey(cfg.KeyName, cfg.KeyProvider)
	if err != nil {
		c.Level, c.Detail, c.Hint = Fail, fmt.Sprintf("%s (%s) is missing: %v", cfg.KeyName, cfg.KeyProvider, err),
			"The key lives in the Windows key store of the user who enrolled. Run as that user, or: torbit-bridge setup --force"
		return c
	}
	signer, err := keys.Open(cfg.KeyName, cfg.KeyProvider)
	if err != nil {
		c.Level, c.Detail, c.Hint = Fail, "cannot open the key: "+err.Error(), "Run: torbit-bridge setup --force"
		return c
	}
	defer signer.Close()
	digest := sha256.Sum256([]byte("torbit-bridge doctor"))
	sig, err := signer.Sign(digest[:])
	if err != nil || len(sig) != 64 {
		c.Level, c.Detail, c.Hint = Fail, fmt.Sprintf("cannot sign with the key: %v", err), "The TPM may be locked or reset. Run: torbit-bridge setup --force"
		return c
	}
	if !verifyP1363(spki, digest[:], sig) {
		c.Level, c.Detail, c.Hint = Fail, "the key signs, but the signature does not verify against its public key", "Run: torbit-bridge setup --force"
		return c
	}
	c.Level, c.Detail = OK, cfg.KeyProvider+", signs and verifies"
	return c
}

func verifyP1363(spkiB64 string, digest, sig []byte) bool {
	der, err := base64.StdEncoding.DecodeString(spkiB64)
	if err != nil {
		return false
	}
	pub, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return false
	}
	ec, ok := pub.(*ecdsa.PublicKey)
	if !ok || len(sig) != 64 {
		return false
	}
	return ecdsa.Verify(ec, digest, bigInt(sig[:32]), bigInt(sig[32:]))
}

// checkServer reaches the Orbit health endpoint and compares clocks: the
// server rejects signatures more than 300 seconds off.
func checkServer(h *HTTP, cfg *Config) []Check {
	var out []Check
	res := h.Do("GET", strings.TrimRight(cfg.Server, "/")+"/health/live", nil, "", nil)
	if res.Status == 0 {
		return append(out, Check{"Orbit server", Fail, fmt.Sprintf("%s is not reachable: %v", cfg.Server, res.Err),
			"Check the server URL, your network and proxy. The bridge uses the Windows proxy settings (not PAC scripts) or HTTPS_PROXY."})
	}
	if res.Status != 200 {
		out = append(out, Check{"Orbit server", Warn, fmt.Sprintf("%s answered %d on /health/live", cfg.Server, res.Status), "Ask the Orbit administrator whether the service is healthy."})
	} else {
		out = append(out, Check{"Orbit server", OK, cfg.Server + " is reachable", ""})
	}
	if !res.Date.IsZero() {
		skew := time.Since(res.Date)
		switch {
		case math.Abs(skew.Seconds()) > 240:
			out = append(out, Check{"Clock", Fail, fmt.Sprintf("this PC is %s off from the server", skew.Round(time.Second)),
				"Orbit rejects deliveries more than 5 minutes off. Fix the Windows time settings (w32tm /resync)."})
		case math.Abs(skew.Seconds()) > 90:
			out = append(out, Check{"Clock", Warn, fmt.Sprintf("this PC is %s off from the server", skew.Round(time.Second)), "Resync the Windows clock: w32tm /resync"})
		default:
			out = append(out, Check{"Clock", OK, "within 90 seconds of the server", ""})
		}
	}
	return out
}
