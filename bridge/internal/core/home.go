// Package core is the platform-independent part of the Torbit Outlook bridge:
// config and state files, request signing, MIME rebuild, delivery, the sweep
// loop, enrollment and diagnostics. Windows specifics (CNG, Outlook COM, the
// service) live in internal/platform behind the interfaces in platform.go.
//
// Never log keys, credentials, message bodies or MIME bytes.
package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

// Home returns the per-user bridge directory (TORBIT_BRIDGE_HOME, else
// %LOCALAPPDATA%\Torbit\Bridge) and creates it.
func Home() (string, error) {
	dir := os.Getenv("TORBIT_BRIDGE_HOME")
	if dir == "" {
		local := os.Getenv("LOCALAPPDATA")
		if local == "" {
			if runtime.GOOS == "windows" {
				return "", errors.New("LOCALAPPDATA is not set")
			}
			c, err := os.UserConfigDir()
			if err != nil {
				return "", err
			}
			local = c
		}
		dir = filepath.Join(local, "Torbit", "Bridge")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

// Config is config.json. It holds no secrets: the private key stays in the key
// store and the enrollment credential is never saved.
type Config struct {
	Server      string `json:"server"`
	WorkspaceID string `json:"workspace_id"`
	DeviceID    string `json:"device_id"`
	Address     string `json:"address"`
	DeviceName  string `json:"device_name"`
	KeyName     string `json:"key_name"`
	KeyProvider string `json:"key_provider"`
	EnrolledAt  string `json:"enrolled_at"`
}

var ErrNotEnrolled = errors.New("this computer is not enrolled; run: torbit-bridge setup")

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	// Rename replaces the target in one step, so a crash never leaves it missing.
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func readJSON(path string, v any) (bool, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	// PowerShell 5.1 wrote files with a UTF-8 BOM in some setups.
	if len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
		b = b[3:]
	}
	if err := json.Unmarshal(b, v); err != nil {
		return true, fmt.Errorf("%s is not valid JSON: %w", filepath.Base(path), err)
	}
	return true, nil
}

// ReadConfig returns nil, nil when the computer is not enrolled.
func ReadConfig() (*Config, error) {
	home, err := Home()
	if err != nil {
		return nil, err
	}
	var c Config
	ok, err := readJSON(filepath.Join(home, "config.json"), &c)
	if err != nil || !ok {
		return nil, err
	}
	return &c, nil
}

func WriteConfig(c *Config) error {
	home, err := Home()
	if err != nil {
		return err
	}
	return writeJSON(filepath.Join(home, "config.json"), c)
}

// ---- log

var logMu sync.Mutex

// Logf appends an event line to bridge.log. Callers pass events and ids only.
func Logf(format string, args ...any) {
	line := fmt.Sprintf("%s %s\n", time.Now().UTC().Format(time.RFC3339Nano), fmt.Sprintf(format, args...))
	home, err := Home()
	if err != nil {
		return
	}
	logMu.Lock()
	defer logMu.Unlock()
	f, err := os.OpenFile(filepath.Join(home, "bridge.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	f.WriteString(line)
}
