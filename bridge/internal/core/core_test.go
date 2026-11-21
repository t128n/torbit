package core

import (
	"context"
	"crypto/ecdsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The vectors are shared with the server patch (docs/bridge-signing.md).
func TestSigningVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../tests/bridge-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		NowUnix int64  `json:"now_unix"`
		Window  int64  `json:"window_seconds"`
		PubSPKI string `json:"public_key_spki_base64"`
		PrivP8  string `json:"private_key_pkcs8_base64"`
		Vectors []struct {
			Name    string            `json:"name"`
			Path    string            `json:"path"`
			Headers map[string]string `json:"headers"`
			Body    string            `json:"body_base64"`
			Signed  string            `json:"signed_string_of_original"`
			Expect  struct {
				SignatureValid    bool `json:"signature_valid"`
				TimestampInWindow bool `json:"timestamp_in_window"`
			} `json:"expect"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	der, _ := base64.StdEncoding.DecodeString(doc.PubSPKI)
	pubAny, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		t.Fatal(err)
	}
	pub := pubAny.(*ecdsa.PublicKey)
	pk8, _ := base64.StdEncoding.DecodeString(doc.PrivP8)
	privAny, err := x509.ParsePKCS8PrivateKey(pk8)
	if err != nil {
		t.Fatal(err)
	}
	signer := memSigner{privAny.(*ecdsa.PrivateKey)}
	prefix := "/api/v1/mail/inbound/bridge/"
	for _, v := range doc.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			body, _ := base64.StdEncoding.DecodeString(v.Body)
			ts, nonce := v.Headers[HeaderTimestamp], v.Headers[HeaderNonce]
			dev := strings.TrimPrefix(v.Path, prefix)
			str := SignedString(ts, nonce, dev, body)
			sig, err := base64.StdEncoding.DecodeString(v.Headers[HeaderSignature])
			ok := err == nil && verifyP1363(doc.PubSPKI, sha256Sum(str), sig)
			if ok != v.Expect.SignatureValid {
				t.Fatalf("signature valid = %v, want %v", ok, v.Expect.SignatureValid)
			}
			if v.Expect.SignatureValid && str != v.Signed {
				t.Fatalf("signed string mismatch:\n%q\n%q", str, v.Signed)
			}
			var tsn int64
			for _, c := range ts {
				tsn = tsn*10 + int64(c-'0')
			}
			if in := abs(doc.NowUnix-tsn) <= doc.Window; in != v.Expect.TimestampInWindow && v.Expect.SignatureValid {
				t.Fatalf("window = %v, want %v", in, v.Expect.TimestampInWindow)
			}
		})
	}
	// Our own signer produces a signature the verifier accepts, with the
	// vector's deterministic inputs.
	h, err := RequestHeaders("7c1d2e3a-4b5f-4a6b-8c7d-9e0f1a2b3c4d", []byte("hi"), signer, "1790000000", "AAECAwQFBgcICQoLDA0ODw")
	if err != nil {
		t.Fatal(err)
	}
	sig, _ := base64.StdEncoding.DecodeString(h[HeaderSignature])
	if !ecdsaVerify(pub, SignedString("1790000000", "AAECAwQFBgcICQoLDA0ODw", "7c1d2e3a-4b5f-4a6b-8c7d-9e0f1a2b3c4d", []byte("hi")), sig) {
		t.Fatal("generated signature does not verify")
	}
}

func abs(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}
func sha256Sum(s string) []byte { h := sha256.Sum256([]byte(s)); return h[:] }
func ecdsaVerify(pub *ecdsa.PublicKey, s string, sig []byte) bool {
	return len(sig) == 64 && ecdsa.Verify(pub, sha256Sum(s), bigInt(sig[:32]), bigInt(sig[32:]))
}

func TestNonceShape(t *testing.T) {
	a, _ := NewNonce()
	b, _ := NewNonce()
	if len(a) != 22 || a == b || strings.ContainsAny(a, "+/=") {
		t.Fatalf("bad nonces %q %q", a, b)
	}
}

func TestMIMEPlain(t *testing.T) {
	it := &Item{EntryID: "E1", Subject: "Hello", SenderName: "Ann", SenderEmail: "ann@example.com", To: "me@example.com",
		ReceivedTime: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC), Body: "Hi there"}
	b, err := ToMIME(it)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, want := range []string{
		"Date: Fri, 02 Jan 2026 03:04:05 +0000\r\n", "Subject: Hello\r\n", `From: "Ann" <ann@example.com>` + "\r\n",
		"To: me@example.com\r\n", "MIME-Version: 1.0\r\n", "Content-Type: text/plain; charset=utf-8\r\n",
		"Content-Transfer-Encoding: base64\r\n\r\nSGkgdGhlcmU=\r\n",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q in\n%s", want, s)
		}
	}
	if !strings.Contains(s, "Message-ID: <") || !strings.Contains(s, "@torbit-bridge.invalid>") {
		t.Error("no synthetic Message-ID")
	}
	for _, c := range b {
		if c > 0x7E || (c < 0x20 && c != '\r' && c != '\n') {
			t.Fatalf("non-ASCII byte %#x", c)
		}
	}
	b2, _ := ToMIME(it)
	if string(b) != string(b2) {
		t.Error("same item must give same bytes")
	}
}

func TestMIMEHeadersAndAttachments(t *testing.T) {
	it := &Item{EntryID: "E2", Subject: "Grüße", ReceivedTime: time.Unix(1700000000, 0), Body: "t", HTMLBody: "<b>t</b>",
		TransportHeaders: "Received: from a\r\n by b\r\nSubject: Original\r\nContent-Type: text/plain\r\nX-Note: café\r\n\r\nBody: ignored",
		Attachments: []Attachment{
			{FileName: "résumé.pdf", MimeType: "application/pdf", Bytes: []byte("PDF")},
			{FileName: "logo.png", MimeType: "image/png", ContentID: "<c1>", IsInline: true, Bytes: []byte("PNG")},
		}}
	s := mustMIME(t, it)
	for _, want := range []string{
		"Received: from a\r\n by b\r\n", "Subject: Original\r\n", "X-Note: =?UTF-8?B?", "multipart/mixed", "multipart/related", "multipart/alternative",
		`filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`, "Content-ID: <c1>", "Content-Disposition: inline;",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q", want)
		}
	}
	if strings.Contains(s, "Content-Type: text/plain\r\nX-Note") || strings.Contains(s, "ignored") {
		t.Error("kept a content header or a body line from the transport headers")
	}
	// lazy attachments load once and only when sent
	calls := 0
	lazy := &Item{EntryID: "E3", Body: "x", LoadAttachments: func() ([]Attachment, error) { calls++; return nil, nil }}
	mustMIME(t, lazy)
	if calls != 1 {
		t.Fatalf("LoadAttachments called %d times", calls)
	}
}

func mustMIME(t *testing.T, it *Item) string {
	t.Helper()
	b, err := ToMIME(it)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func newEngine(t *testing.T, fs *fakeServer, items ...Item) (*Engine, *Config) {
	t.Helper()
	isolate(t)
	keys := newMemKeys()
	_, _, _ = keys.Create("k", "")
	signer, _ := keys.Open("k", "")
	cfg := &Config{Server: "https://orbit.test", DeviceID: "7c1d2e3a-4b5f-4a6b-8c7d-9e0f1a2b3c4d", KeyName: "k",
		EnrolledAt: fmtTime(time.Now().Add(-time.Hour))}
	e := &Engine{HTTP: &HTTP{Transport: fs}, Config: cfg, Signer: signer, Adapter: &fakeAdapter{items: items},
		Sleep: func(context.Context, time.Duration) {}}
	return e, cfg
}

func item(id string, age time.Duration) Item {
	return Item{EntryID: id, Subject: id, Body: "b", ReceivedTime: time.Now().Add(-age)}
}

func TestSweepDedupeAndOutcomes(t *testing.T) {
	fs := &fakeServer{}
	e, _ := newEngine(t, fs, item("a", 3*time.Minute), item("b", 2*time.Minute))
	r, err := e.RunOnce(context.Background())
	if err != nil || r.Delivered != 2 {
		t.Fatalf("%+v %v", r, err)
	}
	r, _ = e.RunOnce(context.Background())
	if r.Delivered != 0 || len(fs.bodies) != 2 {
		t.Fatalf("duplicates were sent: %+v, %d bodies", r, len(fs.bodies))
	}
	if h := fs.headers[0]; h.Get(HeaderSignature) == "" || h.Get(HeaderNonce) == "" || h.Get("Content-Type") != "message/rfc822" {
		t.Fatalf("bad headers %v", h)
	}
}

func TestSweepRetryThenPending(t *testing.T) {
	fs := &fakeServer{statuses: []int{503}}
	e, _ := newEngine(t, fs, item("a", 2*time.Minute), item("b", time.Minute))
	r, _ := e.RunOnce(context.Background())
	if r.Delivered != 0 || r.Pending != 2 || len(fs.bodies) != maxAttempts {
		t.Fatalf("%+v attempts=%d", r, len(fs.bodies))
	}
	st, _ := ReadState()
	if len(st.Pending) != 2 || len(st.Items) != 0 {
		t.Fatalf("state %+v", st)
	}
	fs.statuses = []int{200}
	r, _ = e.RunOnce(context.Background())
	if r.Delivered != 2 {
		t.Fatalf("after recovery: %+v", r)
	}
}

func TestSweepPermanentSkipsOnce(t *testing.T) {
	fs := &fakeServer{statuses: []int{401}}
	e, _ := newEngine(t, fs, item("a", time.Minute))
	r, _ := e.RunOnce(context.Background())
	if r.Skipped != 1 {
		t.Fatalf("%+v", r)
	}
	e.RunOnce(context.Background())
	if len(fs.bodies) != 1 {
		t.Fatal("a skipped item was sent again")
	}
}

func TestOversizeSkippedWithoutLoadingAttachments(t *testing.T) {
	fs := &fakeServer{}
	big := item("big", time.Minute)
	loaded := false
	big.Size = MaxBodyBytes + 1
	big.LoadAttachments = func() ([]Attachment, error) { loaded = true; return nil, nil }
	e, _ := newEngine(t, fs, big)
	r, _ := e.RunOnce(context.Background())
	if r.Skipped != 1 || loaded || len(fs.bodies) != 0 {
		t.Fatalf("%+v loaded=%v bodies=%d", r, loaded, len(fs.bodies))
	}
}

func TestBackfillDoesNotMoveCursor(t *testing.T) {
	fs := &fakeServer{}
	e, _ := newEngine(t, fs, item("old", 48*time.Hour))
	r, _ := e.Backfill(context.Background(), time.Now().Add(-72*time.Hour))
	if r.Delivered != 1 {
		t.Fatalf("%+v", r)
	}
	if st, _ := ReadState(); st.Cursor != "" {
		t.Fatal("backfill moved the cursor")
	}
}

func TestStateReadsPowerShellFiles(t *testing.T) {
	isolate(t)
	home, _ := Home()
	ps := `{"version":1,"cursor":"2026-01-02T03:04:05.0000000Z","last_run":null,"last_sweep":null,
	"items":{"ID1":{"outcome":"delivered","status":200,"at":"2026-01-02T03:04:05.0000000Z"},
	"ID2":{"outcome":"skipped","status":401,"at":"x","received":"2026-01-01T00:00:00.0000000Z"}},"pending":"ID9"}`
	os.WriteFile(filepath.Join(home, "state.json"), append([]byte{0xEF, 0xBB, 0xBF}, ps...), 0o600)
	st, err := ReadState()
	if err != nil || len(st.Items) != 2 || len(st.Pending) != 1 || st.Pending[0] != "ID9" {
		t.Fatalf("%+v %v", st, err)
	}
}

func TestEnrollAndRevoke(t *testing.T) {
	isolate(t)
	keys := newMemKeys()
	var gotCookie, gotBody string
	fs := &fakeServer{other: func(r *http.Request) (int, string) {
		if r.Method == "POST" {
			gotCookie = r.Header.Get("Cookie")
			b, _ := io.ReadAll(r.Body)
			gotBody = string(b)
			return 201, `{"id":"dev-1","address":"me@orbit.test","name":"PC"}`
		}
		return 204, ""
	}}
	h := &HTTP{Transport: fs}
	cfg, err := h.Enroll(keys, EnrollOptions{Server: "https://orbit.test/", WorkspaceID: "ws", Name: "PC", Credential: Credential{"session", "tok"}})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DeviceID != "dev-1" || cfg.Server != "https://orbit.test" || gotCookie != "__Host-orbit_session=tok" || !strings.Contains(gotBody, `"public_key"`) {
		t.Fatalf("%+v %q %q", cfg, gotCookie, gotBody)
	}
	if _, err := h.Enroll(keys, EnrollOptions{Server: "https://orbit.test", WorkspaceID: "ws", Credential: Credential{"api", "t"}}); err == nil {
		t.Fatal("second enroll without --force must fail")
	}
	if err := h.Revoke(keys, nil, false); err == nil {
		t.Fatal("revoke without credential must fail")
	}
	if err := h.Revoke(keys, &Credential{"api", "t"}, false); err != nil {
		t.Fatal(err)
	}
	if c, _ := ReadConfig(); c != nil {
		t.Fatal("config not removed")
	}
	if _, err := keys.PublicKey(cfg.KeyName, ""); err == nil {
		t.Fatal("key not removed")
	}
}

func TestEnrollFailureRemovesKey(t *testing.T) {
	isolate(t)
	keys := newMemKeys()
	h := &HTTP{Transport: &fakeServer{other: func(*http.Request) (int, string) { return 403, "" }}}
	if _, err := h.Enroll(keys, EnrollOptions{Server: "https://orbit.test", WorkspaceID: "ws", Credential: Credential{"session", "x"}}); err == nil {
		t.Fatal("want error")
	}
	if len(keys.keys) != 0 {
		t.Fatal("key left behind")
	}
	if _, err := h.Enroll(keys, EnrollOptions{Server: "http://orbit.test", WorkspaceID: "ws"}); err == nil {
		t.Fatal("plain http must be refused")
	}
	if err := AssertServerURL("http://localhost:8080"); err != nil {
		t.Fatal(err)
	}
}

func TestDoctor(t *testing.T) {
	isolate(t)
	keys := newMemKeys()
	h := &HTTP{Transport: &fakeServer{other: func(r *http.Request) (int, string) {
		if strings.HasSuffix(r.URL.Path, "/devices") {
			return 201, `{"id":"d","address":"a@b.c","name":"n"}`
		}
		return 200, "ok"
	}}}
	if cs := Diagnose(h, keys); worst(cs) != Fail {
		t.Fatal("unenrolled must fail")
	}
	if _, err := h.Enroll(keys, EnrollOptions{Server: "https://orbit.test", WorkspaceID: "w", Credential: Credential{"api", "t"}}); err != nil {
		t.Fatal(err)
	}
	cs := Diagnose(h, keys)
	for _, c := range cs {
		if c.Level == Fail {
			t.Fatalf("unexpected failure: %+v", c)
		}
	}
	cfg, _ := ReadConfig()
	keys.Delete(cfg.KeyName, "")
	if worst(Diagnose(h, keys)) != Fail {
		t.Fatal("missing key must fail")
	}
}

func worst(cs []Check) Level {
	w := OK
	for _, c := range cs {
		if c.Level > w {
			w = c.Level
		}
	}
	return w
}

func TestVersionsAndSums(t *testing.T) {
	if CompareVersions("0.4.1+3", "0.4.1+10") != -1 || CompareVersions("0.5.0", "0.4.9+9") != 1 || CompareVersions("v0.4.1+3", "0.4.1+3") != 0 || CompareVersions("dev", "0.0.1") != -1 {
		t.Fatal("version order")
	}
	data := []byte("exe")
	sum := sha256.Sum256(data)
	sums := hex.EncodeToString(sum[:]) + "  " + AssetName("1.0.0") + "\n"
	if err := VerifySums(sums, AssetName("1.0.0"), data); err != nil {
		t.Fatal(err)
	}
	if VerifySums(sums, AssetName("1.0.0"), []byte("evil")) == nil || VerifySums(sums, "other", data) == nil {
		t.Fatal("must reject a wrong hash or a missing entry")
	}
}
