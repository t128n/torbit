package core

import (
	"net/http"
	"net/url"
	"time"
)

// Signer signs a 32-byte SHA-256 digest and returns a 64-byte IEEE-P1363
// r||s signature (docs/bridge-signing.md).
type Signer interface {
	Sign(digest []byte) ([]byte, error)
	Close() error
}

// KeyStore holds the device key. On Windows it is CNG (TPM first, then the
// software provider); the key is non-exportable.
type KeyStore interface {
	// Create makes a signing key and returns the provider used and the public
	// key as base64 SPKI DER. provider may be empty to pick the best one.
	Create(name, provider string) (usedProvider, spkiBase64 string, err error)
	Open(name, provider string) (Signer, error)
	PublicKey(name, provider string) (spkiBase64 string, err error)
	Delete(name, provider string) error
}

// Attachment is one attachment of an Outlook item.
type Attachment struct {
	FileName  string
	MimeType  string
	ContentID string
	IsInline  bool
	Bytes     []byte
}

// Item is what an Outlook adapter returns for one inbox mail.
type Item struct {
	EntryID          string
	Subject          string
	SenderName       string
	SenderEmail      string
	To               string
	ReceivedTime     time.Time
	TransportHeaders string
	Body             string
	HTMLBody         string
	Size             int64 // whole item in bytes, attachments included; 0 = unknown
	// Attachments is used when non-nil; otherwise LoadAttachments is called at
	// most once, only when the item is actually sent.
	Attachments     []Attachment
	LoadAttachments func() ([]Attachment, error)
}

// Adapter reads the Outlook inbox (the Inbox folder only).
type Adapter interface {
	// Inbox returns inbox items received at or after since, oldest first.
	// release frees the COM objects behind the items and must be called when
	// the caller is done with them.
	Inbox(since time.Time) (items []Item, release func(), err error)
	Close() error
}

// Platform is everything the core needs from the operating system.
type Platform interface {
	Keys() KeyStore
	NewOutlook() (Adapter, error)
	// Proxy follows the Windows proxy settings of the current user.
	Proxy() func(*http.Request) (*url.URL, error)
	// RunLock allows one worker per Windows user session.
	RunLock() (release func(), err error)
}
