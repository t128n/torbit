package core

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strconv"
	"time"
)

// SignatureFormat and the header names are the wire contract; they keep the
// pre-rebrand "worbit" spelling on purpose so enrolled devices keep working.
const (
	SignatureFormat = "worbit-bridge-v1"
	HeaderTimestamp = "X-Worbit-Timestamp"
	HeaderNonce     = "X-Worbit-Nonce"
	HeaderSignature = "X-Worbit-Signature"
	MaxBodyBytes    = 2097152
)

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// NewNonce is 16 random bytes as unpadded base64url (22 characters).
func NewNonce() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// SignedString is the five LF-joined lines of docs/bridge-signing.md.
func SignedString(timestamp, nonce, deviceID string, body []byte) string {
	return SignatureFormat + "\n" + timestamp + "\n" + nonce + "\n" + deviceID + "\n" + sha256Hex(body)
}

// RequestHeaders returns the three X-Worbit-* headers for a body. An empty
// timestamp or nonce is generated.
func RequestHeaders(deviceID string, body []byte, signer Signer, timestamp, nonce string) (map[string]string, error) {
	if timestamp == "" {
		timestamp = strconv.FormatInt(time.Now().Unix(), 10)
	}
	if nonce == "" {
		n, err := NewNonce()
		if err != nil {
			return nil, err
		}
		nonce = n
	}
	digest := sha256.Sum256([]byte(SignedString(timestamp, nonce, deviceID, body)))
	sig, err := signer.Sign(digest[:])
	if err != nil {
		return nil, err
	}
	if len(sig) != 64 {
		return nil, errors.New("signer did not return a 64-byte IEEE-P1363 signature")
	}
	return map[string]string{
		HeaderTimestamp: timestamp,
		HeaderNonce:     nonce,
		HeaderSignature: base64.StdEncoding.EncodeToString(sig),
	}, nil
}
