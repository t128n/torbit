//go:build windows

package platform

import (
	"encoding/base64"
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/t128n/torbit/bridge/internal/core"
)

// The key is a non-exportable ECDSA P-256 signing key in CNG, in the current
// user's key store: the TPM provider when there is one, else the software KSP.
// Provider and key names match the PowerShell bridge, so an existing
// enrollment keeps working.
const (
	tpmProvider      = "Microsoft Platform Crypto Provider"
	softwareProvider = "Microsoft Software Key Storage Provider"
)

var (
	ncrypt               = windows.NewLazySystemDLL("ncrypt.dll")
	pOpenStorageProvider = ncrypt.NewProc("NCryptOpenStorageProvider")
	pCreatePersistedKey  = ncrypt.NewProc("NCryptCreatePersistedKey")
	pOpenKey             = ncrypt.NewProc("NCryptOpenKey")
	pSetProperty         = ncrypt.NewProc("NCryptSetProperty")
	pFinalizeKey         = ncrypt.NewProc("NCryptFinalizeKey")
	pExportKey           = ncrypt.NewProc("NCryptExportKey")
	pSignHash            = ncrypt.NewProc("NCryptSignHash")
	pDeleteKey           = ncrypt.NewProc("NCryptDeleteKey")
	pFreeObject          = ncrypt.NewProc("NCryptFreeObject")
)

const (
	ncryptAllowSigningFlag = 0x2
	secOK                  = 0
)

func secErr(op string, r uintptr) error {
	if r == secOK {
		return nil
	}
	return fmt.Errorf("%s failed: 0x%08X", op, uint32(r))
}

type provider windows.Handle

func openProvider(name string) (provider, error) {
	n, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return 0, err
	}
	var h uintptr
	r, _, _ := pOpenStorageProvider.Call(uintptr(unsafe.Pointer(&h)), uintptr(unsafe.Pointer(n)), 0)
	return provider(h), secErr("NCryptOpenStorageProvider", r)
}

func free(h uintptr) { pFreeObject.Call(h) }

type cngKeys struct{}

func (cngKeys) Create(name, prov string) (string, string, error) {
	candidates := []string{tpmProvider, softwareProvider}
	if prov != "" {
		candidates = []string{prov}
	}
	var last error
	for _, p := range candidates {
		spki, err := createIn(name, p)
		if err == nil {
			return p, spki, nil
		}
		last = fmt.Errorf("%s: %w", p, err)
	}
	return "", "", last
}

func createIn(name, provName string) (string, error) {
	prov, err := openProvider(provName)
	if err != nil {
		return "", err
	}
	defer free(uintptr(prov))
	alg, _ := windows.UTF16PtrFromString("ECDSA_P256")
	kn, _ := windows.UTF16PtrFromString(name)
	var key uintptr
	r, _, _ := pCreatePersistedKey.Call(uintptr(prov), uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(alg)), uintptr(unsafe.Pointer(kn)), 0, 0)
	if err := secErr("NCryptCreatePersistedKey", r); err != nil {
		return "", err
	}
	ok := false
	defer func() {
		if !ok {
			pDeleteKey.Call(key, 0) // also frees the handle
		} else {
			free(key)
		}
	}()
	// Export policy none (0): the private key can never leave the key store.
	var zero uint32
	pn, _ := windows.UTF16PtrFromString("Export Policy")
	r, _, _ = pSetProperty.Call(key, uintptr(unsafe.Pointer(pn)), uintptr(unsafe.Pointer(&zero)), 4, 0)
	if err := secErr("NCryptSetProperty(Export Policy)", r); err != nil {
		return "", err
	}
	usage := uint32(ncryptAllowSigningFlag)
	un, _ := windows.UTF16PtrFromString("Key Usage")
	r, _, _ = pSetProperty.Call(key, uintptr(unsafe.Pointer(un)), uintptr(unsafe.Pointer(&usage)), 4, 0)
	if err := secErr("NCryptSetProperty(Key Usage)", r); err != nil {
		return "", err
	}
	if r, _, _ = pFinalizeKey.Call(key, 0); secErr("NCryptFinalizeKey", r) != nil {
		return "", secErr("NCryptFinalizeKey", r)
	}
	spki, err := publicSPKI(key)
	ok = err == nil
	return spki, err
}

func openKey(name, provName string) (provider, uintptr, error) {
	prov, err := openProvider(provName)
	if err != nil {
		return 0, 0, err
	}
	kn, _ := windows.UTF16PtrFromString(name)
	var key uintptr
	r, _, _ := pOpenKey.Call(uintptr(prov), uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(kn)), 0, 0)
	if err := secErr("NCryptOpenKey", r); err != nil {
		free(uintptr(prov))
		return 0, 0, err
	}
	return prov, key, nil
}

// publicSPKI exports ECCPUBLICBLOB (8-byte header + X + Y) and wraps it as a
// 91-byte SubjectPublicKeyInfo.
func publicSPKI(key uintptr) (string, error) {
	bt, _ := windows.UTF16PtrFromString("ECCPUBLICBLOB")
	buf := make([]byte, 72)
	var n uint32
	r, _, _ := pExportKey.Call(key, 0, uintptr(unsafe.Pointer(bt)), 0, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), uintptr(unsafe.Pointer(&n)), 0)
	if err := secErr("NCryptExportKey", r); err != nil {
		return "", err
	}
	if n != 72 {
		return "", errors.New("unexpected public key blob; expected P-256")
	}
	prefix := []byte{0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01, 0x06, 0x08, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04}
	spki := append(prefix, buf[8:72]...)
	return base64.StdEncoding.EncodeToString(spki), nil
}

func (cngKeys) PublicKey(name, provName string) (string, error) {
	prov, key, err := openKey(name, provName)
	if err != nil {
		return "", err
	}
	defer free(uintptr(prov))
	defer free(key)
	return publicSPKI(key)
}

type cngSigner struct {
	prov provider
	key  uintptr
}

func (cngKeys) Open(name, provName string) (core.Signer, error) {
	prov, key, err := openKey(name, provName)
	if err != nil {
		return nil, err
	}
	return &cngSigner{prov, key}, nil
}

// Sign takes a SHA-256 digest; CNG returns IEEE-P1363 r||s for ECDSA.
func (s *cngSigner) Sign(digest []byte) ([]byte, error) {
	out := make([]byte, 64)
	var n uint32
	r, _, _ := pSignHash.Call(s.key, 0, uintptr(unsafe.Pointer(&digest[0])), uintptr(len(digest)),
		uintptr(unsafe.Pointer(&out[0])), uintptr(len(out)), uintptr(unsafe.Pointer(&n)), 0)
	if err := secErr("NCryptSignHash", r); err != nil {
		return nil, err
	}
	return out[:n], nil
}

func (s *cngSigner) Close() error {
	free(s.key)
	free(uintptr(s.prov))
	return nil
}

func (cngKeys) Delete(name, provName string) error {
	prov, key, err := openKey(name, provName)
	if err != nil {
		return err
	}
	defer free(uintptr(prov))
	r, _, _ := pDeleteKey.Call(key, 0) // frees the key handle
	return secErr("NCryptDeleteKey", r)
}
