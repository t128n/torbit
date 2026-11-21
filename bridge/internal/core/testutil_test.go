package core

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

func isolate(t *testing.T) {
	t.Helper()
	t.Setenv("TORBIT_BRIDGE_HOME", t.TempDir())
}

// memKeys is a software KeyStore for tests.
type memKeys struct {
	mu   sync.Mutex
	keys map[string]*ecdsa.PrivateKey
}

func newMemKeys() *memKeys { return &memKeys{keys: map[string]*ecdsa.PrivateKey{}} }

type memSigner struct{ k *ecdsa.PrivateKey }

func (s memSigner) Sign(d []byte) ([]byte, error) {
	r, ss, err := ecdsa.Sign(rand.Reader, s.k, d)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 64)
	r.FillBytes(out[:32])
	ss.FillBytes(out[32:])
	return out, nil
}
func (memSigner) Close() error { return nil }

func (m *memKeys) Create(name, provider string) (string, string, error) {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	m.mu.Lock()
	m.keys[name] = k
	m.mu.Unlock()
	der, _ := x509.MarshalPKIXPublicKey(&k.PublicKey)
	return "mem", base64.StdEncoding.EncodeToString(der), nil
}
func (m *memKeys) Open(name, _ string) (Signer, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if k, ok := m.keys[name]; ok {
		return memSigner{k}, nil
	}
	return nil, errors.New("no such key")
}
func (m *memKeys) PublicKey(name, _ string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k, ok := m.keys[name]
	if !ok {
		return "", errors.New("no such key")
	}
	der, _ := x509.MarshalPKIXPublicKey(&k.PublicKey)
	return base64.StdEncoding.EncodeToString(der), nil
}
func (m *memKeys) Delete(name, _ string) error {
	m.mu.Lock()
	delete(m.keys, name)
	m.mu.Unlock()
	return nil
}

// fakeServer is an http.RoundTripper standing in for Orbit.
type fakeServer struct {
	mu       sync.Mutex
	statuses []int // consumed per delivery; the last one repeats
	bodies   [][]byte
	headers  []http.Header
	other    func(*http.Request) (int, string)
}

func (f *fakeServer) RoundTrip(r *http.Request) (*http.Response, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	status, body := 200, ""
	if strings.Contains(r.URL.Path, "/mail/inbound/bridge/") {
		b, _ := io.ReadAll(r.Body)
		f.bodies = append(f.bodies, b)
		f.headers = append(f.headers, r.Header.Clone())
		if len(f.statuses) > 0 {
			status = f.statuses[0]
			if len(f.statuses) > 1 {
				f.statuses = f.statuses[1:]
			}
		}
	} else if f.other != nil {
		status, body = f.other(r)
	}
	if status == 0 {
		return nil, errors.New("connection refused")
	}
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}, Request: r}, nil
}

type fakeAdapter struct{ items []Item }

func (a *fakeAdapter) Inbox(since time.Time) ([]Item, func(), error) { return a.items, func() {}, nil }
func (a *fakeAdapter) Close() error                                  { return nil }

type nopPlatform struct{}

func (nopPlatform) Keys() KeyStore                               { return nil }
func (nopPlatform) NewOutlook() (Adapter, error)                 { return nil, errors.New("n/a") }
func (nopPlatform) Proxy() func(*http.Request) (*url.URL, error) { return nil }
func (nopPlatform) RunLock() (func(), error)                     { return func() {}, nil }

var _ = sha256.Sum256
