package core

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// ItemRecord is the dedupe record for one Outlook entry id. Only ids,
// outcomes and times are stored; never subjects, addresses or bodies.
type ItemRecord struct {
	Outcome  string `json:"outcome"` // delivered | skipped
	Status   int    `json:"status"`
	At       string `json:"at"`
	Received string `json:"received,omitempty"`
}

// State is state.json. The layout matches the PowerShell bridge so an
// existing enrollment keeps its delivered ids when the Go bridge takes over.
type State struct {
	Version   int                   `json:"version"`
	Cursor    string                `json:"cursor,omitempty"`
	LastRun   string                `json:"last_run,omitempty"`
	LastSweep string                `json:"last_sweep,omitempty"`
	Items     map[string]ItemRecord `json:"items"`
	Pending   []string              `json:"pending"`
}

// UnmarshalJSON accepts what PowerShell's ConvertTo-Json produced: null or a
// bare string where an array of one was meant.
func (s *State) UnmarshalJSON(b []byte) error {
	type plain State
	aux := struct {
		*plain
		Pending json.RawMessage `json:"pending"`
	}{plain: (*plain)(s)}
	if err := json.Unmarshal(b, &aux); err != nil {
		return err
	}
	s.Pending = nil
	var list []string
	if err := json.Unmarshal(aux.Pending, &list); err == nil {
		s.Pending = list
	} else {
		var one string
		if json.Unmarshal(aux.Pending, &one) == nil && one != "" {
			s.Pending = []string{one}
		}
	}
	if s.Items == nil {
		s.Items = map[string]ItemRecord{}
	}
	if s.Version == 0 {
		s.Version = 1
	}
	return nil
}

var stateMu sync.Mutex

func statePath() (string, error) {
	home, err := Home()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "state.json"), nil
}

func newState() *State {
	return &State{Version: 1, Items: map[string]ItemRecord{}, Pending: []string{}}
}

func ReadState() (*State, error) {
	p, err := statePath()
	if err != nil {
		return nil, err
	}
	s := newState()
	if _, err := readJSON(p, s); err != nil {
		return nil, err
	}
	return s, nil
}

// UpdateState is a read-modify-write under an in-process mutex and a lock file,
// so a running service worker and a manual backfill do not overwrite each
// other's records.
func UpdateState(mutate func(*State)) error {
	stateMu.Lock()
	defer stateMu.Unlock()
	p, err := statePath()
	if err != nil {
		return err
	}
	unlock, err := lockFile(p + ".lock")
	if err != nil {
		return err
	}
	defer unlock()
	s, err := ReadState()
	if err != nil {
		return err
	}
	mutate(s)
	if s.Pending == nil {
		s.Pending = []string{}
	}
	return writeJSON(p, s)
}

func lockFile(path string) (func(), error) {
	deadline := time.Now().Add(10 * time.Second)
	for {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			f.Close()
			return func() { os.Remove(path) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if st, serr := os.Stat(path); serr == nil && time.Since(st.ModTime()) > 30*time.Second {
			os.Remove(path) // stale: its owner died
			continue
		}
		if time.Now().After(deadline) {
			return nil, errors.New("state.json is locked by another bridge process")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func parseTime(v string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.0000000Z07:00", "2006-01-02T15:04:05"} {
		if t, err := time.ParseInLocation(layout, v, time.UTC); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

func fmtTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.0000000Z") }
