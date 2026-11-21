//go:build !windows

// Package platform is the operating-system layer. This file lets the bridge
// build, enroll and be tested on Linux and macOS; it is for development only:
// the key is a file, and there is no Outlook and no service.
package platform

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"

	"github.com/t128n/torbit/bridge/internal/core"
)

const Supported = false

type Platform struct{}

func New() core.Platform { return Platform{} }

func (Platform) Keys() core.KeyStore { return fileKeys{} }
func (Platform) NewOutlook() (core.Adapter, error) {
	return nil, errors.New("Outlook automation is only available on Windows")
}
func (Platform) Proxy() func(*http.Request) (*url.URL, error) { return http.ProxyFromEnvironment }
func (Platform) RunLock() (func(), error)                     { return func() {}, nil }

type fileKeys struct{}

func keyPath(name string) (string, error) {
	home, err := core.Home()
	if err != nil {
		return "", err
	}
	d := filepath.Join(home, "devkeys")
	return filepath.Join(d, name+".pem"), os.MkdirAll(d, 0o700)
}

func (fileKeys) Create(name, _ string) (string, string, error) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", "", err
	}
	der, _ := x509.MarshalECPrivateKey(k)
	p, err := keyPath(name)
	if err != nil {
		return "", "", err
	}
	if err := os.WriteFile(p, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return "", "", err
	}
	spki, _ := x509.MarshalPKIXPublicKey(&k.PublicKey)
	return "file (development only)", base64.StdEncoding.EncodeToString(spki), nil
}

func load(name string) (*ecdsa.PrivateKey, error) {
	p, err := keyPath(name)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	blk, _ := pem.Decode(b)
	if blk == nil {
		return nil, errors.New("bad key file")
	}
	return x509.ParseECPrivateKey(blk.Bytes)
}

type fileSigner struct{ k *ecdsa.PrivateKey }

func (s fileSigner) Sign(d []byte) ([]byte, error) {
	r, ss, err := ecdsa.Sign(rand.Reader, s.k, d)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 64)
	r.FillBytes(out[:32])
	ss.FillBytes(out[32:])
	return out, nil
}
func (fileSigner) Close() error { return nil }

var _ = sha256.Size

func (fileKeys) Open(name, _ string) (core.Signer, error) {
	k, err := load(name)
	if err != nil {
		return nil, err
	}
	return fileSigner{k}, nil
}

func (fileKeys) PublicKey(name, _ string) (string, error) {
	k, err := load(name)
	if err != nil {
		return "", err
	}
	spki, _ := x509.MarshalPKIXPublicKey(&k.PublicKey)
	return base64.StdEncoding.EncodeToString(spki), nil
}

func (fileKeys) Delete(name, _ string) error {
	p, err := keyPath(name)
	if err != nil {
		return err
	}
	return os.Remove(p)
}
