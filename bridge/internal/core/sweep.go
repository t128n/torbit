package core

import (
	"context"
	"sort"
	"time"
)

var (
	retryDelays   = []time.Duration{5 * time.Second, 15 * time.Second, 45 * time.Second}
	cursorOverlap = 10 * time.Minute
)

const maxAttempts = 4

// Engine delivers Outlook items to Orbit.
type Engine struct {
	HTTP    *HTTP
	Config  *Config
	Signer  Signer
	Adapter Adapter
	// Sleep is a test seam; it must return early when ctx ends.
	Sleep func(ctx context.Context, d time.Duration)
}

func defaultSleep(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

type SweepResult struct{ Seen, Delivered, Skipped, Pending int }

// Sweep delivers every Inbox item received at or after since that is not yet
// in the state. 5xx and network errors are retried with backoff; when attempts
// run out the rest of the sweep waits for the next one. 401/404/413 and other
// 4xx are recorded as skipped and never sent again.
func (e *Engine) Sweep(ctx context.Context, since time.Time, trackPending bool) (SweepResult, error) {
	sleep := e.Sleep
	if sleep == nil {
		sleep = defaultSleep
	}
	since = since.UTC()
	st, err := ReadState()
	if err != nil {
		return SweepResult{}, err
	}
	known := st.Items
	all, release, err := e.Adapter.Inbox(since)
	if err != nil {
		return SweepResult{}, err
	}
	defer release()
	var items []Item
	for _, it := range all {
		if !it.ReceivedTime.UTC().Before(since) {
			items = append(items, it)
		}
	}
	res := SweepResult{Seen: len(items)}
	var unresolved []Item
	halted := false
	for i := range items {
		it := &items[i]
		if _, ok := known[it.EntryID]; ok {
			continue
		}
		if halted || ctx.Err() != nil {
			unresolved = append(unresolved, *it)
			continue
		}
		var r SendResult
		for attempt := 1; ; attempt++ {
			r = e.HTTP.SendItem(e.Config, e.Signer, it)
			if r.Outcome != Retry || attempt >= maxAttempts {
				break
			}
			d := retryDelays[min(attempt-1, len(retryDelays)-1)]
			sleep(ctx, d)
			if ctx.Err() != nil {
				break
			}
		}
		if r.Outcome == Retry {
			halted = true
			unresolved = append(unresolved, *it)
			continue
		}
		rec := ItemRecord{Status: r.Status, At: fmtTime(time.Now())}
		if r.Outcome == Delivered {
			rec.Outcome = "delivered"
			res.Delivered++
		} else {
			rec.Outcome = "skipped"
			rec.Received = fmtTime(it.ReceivedTime) // lets enroll --force resend after an auth failure
			res.Skipped++
		}
		id := it.EntryID
		if err := UpdateState(func(s *State) { s.Items[id] = rec }); err != nil {
			return res, err
		}
		known[id] = rec
	}
	res.Pending = len(unresolved)
	if trackPending {
		ids := make([]string, 0, len(unresolved))
		for _, u := range unresolved {
			ids = append(ids, u.EntryID)
		}
		var cursor time.Time
		switch {
		case len(unresolved) > 0:
			cursor = minTime(unresolved)
		case len(items) > 0:
			cursor = maxTime(items)
		}
		now := fmtTime(time.Now())
		err := UpdateState(func(s *State) {
			s.Pending = ids
			s.LastRun, s.LastSweep = now, now
			if !cursor.IsZero() {
				s.Cursor = fmtTime(cursor)
			}
		})
		if err != nil {
			return res, err
		}
	}
	Logf("sweep: seen %d, delivered %d, skipped %d, pending %d", res.Seen, res.Delivered, res.Skipped, res.Pending)
	return res, nil
}

func minTime(items []Item) time.Time {
	ts := times(items)
	return ts[0]
}
func maxTime(items []Item) time.Time {
	ts := times(items)
	return ts[len(ts)-1]
}
func times(items []Item) []time.Time {
	ts := make([]time.Time, len(items))
	for i, it := range items {
		ts[i] = it.ReceivedTime.UTC()
	}
	sort.Slice(ts, func(a, b int) bool { return ts[a].Before(ts[b]) })
	return ts
}

// RunOnce sweeps from the stored cursor (minus an overlap for clock skew;
// dedupe makes the overlap harmless). The first sweep starts at the enrollment
// time: older mail is the job of backfill.
func (e *Engine) RunOnce(ctx context.Context) (SweepResult, error) {
	st, err := ReadState()
	if err != nil {
		return SweepResult{}, err
	}
	var since time.Time
	if c, ok := parseTime(st.Cursor); ok {
		since = c.Add(-cursorOverlap)
	} else if t, ok := parseTime(e.Config.EnrolledAt); ok {
		since = t
	} else {
		since = time.Now().Add(-time.Hour)
	}
	return e.Sweep(ctx, since, true)
}

// Run sweeps now and then every interval until ctx ends. A failing sweep
// (Outlook closed, Orbit down) is logged and tried again at the next wake-up.
func (e *Engine) Run(ctx context.Context, interval time.Duration) {
	for {
		if _, err := e.RunOnce(ctx); err != nil {
			Logf("sweep failed: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

// Backfill delivers inbox items received since a date, once. It shares the
// dedupe record with Run and does not move the run cursor.
func (e *Engine) Backfill(ctx context.Context, since time.Time) (SweepResult, error) {
	return e.Sweep(ctx, since, false)
}

// ---- status

type Status struct {
	Enrolled                    bool
	DeviceID, Server, Address   string
	KeyProvider                 string
	KeyPresent                  bool
	LastRun                     string
	Delivered, Skipped, Pending int
}

func GetStatus(keys KeyStore) (Status, error) {
	cfg, err := ReadConfig()
	if err != nil || cfg == nil {
		return Status{}, err
	}
	st, err := ReadState()
	if err != nil {
		return Status{}, err
	}
	s := Status{Enrolled: true, DeviceID: cfg.DeviceID, Server: cfg.Server, Address: cfg.Address,
		KeyProvider: cfg.KeyProvider, LastRun: st.LastRun, Pending: len(st.Pending)}
	if _, err := keys.PublicKey(cfg.KeyName, cfg.KeyProvider); err == nil {
		s.KeyPresent = true
	}
	for _, r := range st.Items {
		switch r.Outcome {
		case "delivered":
			s.Delivered++
		case "skipped":
			s.Skipped++
		}
	}
	return s, nil
}
