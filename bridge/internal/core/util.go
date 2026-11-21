package core

import (
	"crypto/rand"
	"fmt"
	"math/big"
	"os"
)

func osHostname() (string, error) {
	if n := os.Getenv("COMPUTERNAME"); n != "" {
		return n, nil
	}
	return os.Hostname()
}

func newUUID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func bigInt(b []byte) *big.Int { return new(big.Int).SetBytes(b) }
