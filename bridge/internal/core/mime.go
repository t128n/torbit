package core

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
)

// The rebuild is byte-compatible with the PowerShell bridge: same item in,
// same bytes out, pure 7-bit ASCII with CRLF. That keeps the server's
// raw-message dedupe working for mail an earlier bridge already delivered.

const crlf = "\r\n"

var droppedHeaders = map[string]bool{
	"content-type": true, "content-transfer-encoding": true, "mime-version": true,
	"content-disposition": true, "content-id": true, "content-description": true,
	"content-length": true, "content-language": true,
}

var (
	reFieldName = regexp.MustCompile(`^[\x21-\x39\x3B-\x7E]+$`)
	reMimeType  = regexp.MustCompile(`^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$`)
)

func plainASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7E {
			return false
		}
	}
	return true
}

func base64Lines(b []byte) string {
	enc := base64.StdEncoding.EncodeToString(b)
	var lines []string
	for i := 0; i < len(enc); i += 76 {
		end := i + 76
		if end > len(enc) {
			end = len(enc)
		}
		lines = append(lines, enc[i:end])
	}
	return strings.Join(lines, crlf)
}

// headerText is an RFC 2047 encoded word for text that is not plain ASCII.
func headerText(s string) string {
	if plainASCII(s) {
		return s
	}
	return "=?UTF-8?B?" + base64.StdEncoding.EncodeToString([]byte(s)) + "?="
}

// headerParam is name="ascii", plus RFC 2231 name*=UTF-8”.. for other values.
func headerParam(name, value string) string {
	var pct strings.Builder
	for _, b := range []byte(value) {
		if (b >= '0' && b <= '9') || (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || b == '.' || b == '-' || b == '_' {
			pct.WriteByte(b)
		} else {
			fmt.Fprintf(&pct, "%%%02X", b)
		}
	}
	var fb strings.Builder
	for _, u := range utf16.Encode([]rune(value)) { // per UTF-16 unit, as PowerShell did
		if u >= 0x20 && u <= 0x7E {
			fb.WriteByte(byte(u))
		} else {
			fb.WriteByte('_')
		}
	}
	fallback := strings.ReplaceAll(strings.ReplaceAll(fb.String(), `\`, "_"), `"`, "'")
	if plainASCII(value) {
		return fmt.Sprintf(`%s="%s"`, name, fallback)
	}
	return fmt.Sprintf(`%s="%s"; %s*=UTF-8''%s`, name, fallback, name, pct.String())
}

type entity struct{ headers, body string }

func multipart(subtype, boundary string, parts []entity) entity {
	var ps []string
	for _, e := range parts {
		ps = append(ps, e.headers+crlf+crlf+e.body)
	}
	body := "--" + boundary + crlf + strings.Join(ps, crlf+"--"+boundary+crlf) + crlf + "--" + boundary + "--"
	return entity{fmt.Sprintf(`Content-Type: multipart/%s; boundary="%s"`, subtype, boundary), body}
}

func textEntity(subtype, text string) entity {
	return entity{"Content-Type: text/" + subtype + "; charset=utf-8" + crlf + "Content-Transfer-Encoding: base64", base64Lines([]byte(text))}
}

func attachmentEntity(a Attachment, asInline bool) entity {
	name := a.FileName
	if name == "" {
		name = "attachment"
	}
	typ := a.MimeType
	if typ == "" || !reMimeType.MatchString(typ) {
		typ = "application/octet-stream"
	}
	disp := "attachment"
	if asInline {
		disp = "inline"
	}
	h := []string{
		fmt.Sprintf("Content-Type: %s; %s", typ, headerParam("name", name)),
		fmt.Sprintf("Content-Disposition: %s; %s", disp, headerParam("filename", name)),
		"Content-Transfer-Encoding: base64",
	}
	if a.ContentID != "" {
		h = append(h, "Content-ID: <"+strings.Trim(a.ContentID, "<>")+">")
	}
	return entity{strings.Join(h, crlf), base64Lines(a.Bytes)}
}

var reLineSplit = regexp.MustCompile(`\r\n|\n|\r`)

// keptTransportHeaders keeps the original transport header lines (folding
// included), drops content-structure headers and encodes non-ASCII text.
func keptTransportHeaders(raw string) []string {
	var kept []string
	if raw == "" {
		return kept
	}
	skip := false
	for _, line := range reLineSplit.Split(raw, -1) {
		if line == "" {
			break
		}
		if line[0] == ' ' || line[0] == '\t' {
			if !skip && len(kept) > 0 {
				text := strings.TrimLeft(line, " \t")
				lead := line[:len(line)-len(text)]
				kept = append(kept, lead+headerText(text))
			}
			continue
		}
		idx := strings.IndexByte(line, ':')
		if idx < 1 {
			skip = true
			continue
		}
		rawName := line[:idx]
		if !reFieldName.MatchString(rawName) {
			skip = true
			continue
		}
		if droppedHeaders[strings.ToLower(strings.TrimSpace(rawName))] {
			skip = true
			continue
		}
		skip = false
		value := line[idx+1:]
		if plainASCII(value) {
			kept = append(kept, line)
		} else {
			kept = append(kept, rawName+": "+headerText(strings.TrimLeft(value, " \t")))
		}
	}
	return kept
}

func hasHeader(lines []string, name string) bool {
	p := strings.ToLower(name) + ":"
	for _, l := range lines {
		if strings.HasPrefix(strings.ToLower(l), p) {
			return true
		}
	}
	return false
}

func mimeDate(t time.Time) string {
	return t.UTC().Format("Mon, 02 Jan 2006 15:04:05") + " +0000"
}

func itemAttachments(it *Item) ([]Attachment, error) {
	if it.Attachments != nil {
		return it.Attachments, nil
	}
	if it.LoadAttachments != nil {
		return it.LoadAttachments()
	}
	return nil, nil
}

// ToMIME builds the RFC 5322 message for an item. Attachments are loaded
// here, only when the item is sent.
func ToMIME(it *Item) ([]byte, error) {
	lines := keptTransportHeaders(it.TransportHeaders)
	seed := it.EntryID
	if seed == "" {
		seed = it.Subject + "|" + it.ReceivedTime.UTC().Format(time.RFC3339)
	}
	sum := sha256.Sum256([]byte(seed))
	seedHash := hex.EncodeToString(sum[:])
	received := time.Now().UTC()
	if !it.ReceivedTime.IsZero() {
		received = it.ReceivedTime.UTC()
	}
	if !hasHeader(lines, "Date") {
		lines = append(lines, "Date: "+mimeDate(received))
	}
	if !hasHeader(lines, "Message-ID") {
		lines = append(lines, "Message-ID: <"+seedHash[:32]+"@torbit-bridge.invalid>")
	}
	if !hasHeader(lines, "Subject") {
		lines = append(lines, "Subject: "+headerText(it.Subject))
	}
	if !hasHeader(lines, "From") {
		addr := it.SenderEmail
		if addr == "" {
			addr = "unknown@torbit-bridge.invalid"
		}
		from := addr
		if it.SenderName != "" {
			name := strings.ReplaceAll(strings.ReplaceAll(it.SenderName, `\`, ""), `"`, "")
			from = headerText(`"`+name+`"`) + " <" + addr + ">"
		}
		lines = append(lines, "From: "+from)
	}
	if !hasHeader(lines, "To") && it.To != "" {
		lines = append(lines, "To: "+headerText(it.To))
	}
	lines = append(lines, "MIME-Version: 1.0")

	atts, err := itemAttachments(it)
	if err != nil {
		return nil, err
	}
	hasHTML, hasText := it.HTMLBody != "", it.Body != ""
	var root entity
	switch {
	case hasHTML && hasText:
		root = multipart("alternative", "=_torbit_a_"+seedHash[:24], []entity{textEntity("plain", it.Body), textEntity("html", it.HTMLBody)})
	case hasHTML:
		root = textEntity("html", it.HTMLBody)
	default:
		root = textEntity("plain", it.Body)
	}
	var inline, regular []Attachment
	for _, a := range atts {
		if hasHTML && a.IsInline && a.ContentID != "" {
			inline = append(inline, a)
		} else {
			regular = append(regular, a)
		}
	}
	if len(inline) > 0 {
		ents := []entity{root}
		for _, a := range inline {
			ents = append(ents, attachmentEntity(a, true))
		}
		root = multipart("related", "=_torbit_r_"+seedHash[:24], ents)
	}
	if len(regular) > 0 {
		ents := []entity{root}
		for _, a := range regular {
			ents = append(ents, attachmentEntity(a, a.IsInline))
		}
		root = multipart("mixed", "=_torbit_m_"+seedHash[:24], ents)
	}
	msg := strings.Join(lines, crlf) + crlf + root.headers + crlf + crlf + root.body + crlf
	return []byte(msg), nil
}
