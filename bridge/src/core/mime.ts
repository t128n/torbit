import { sha256Hex } from "./util.ts";
import type { Attachment, Item } from "./types.ts";

// The rebuild is byte-compatible with the PowerShell and Go bridges: same item in, same bytes out,
// pure 7-bit ASCII with CRLF. That keeps the server's raw-message dedupe working for mail an
// earlier bridge already delivered.

const CRLF = "\r\n";

const DROPPED_HEADERS = new Set([
  "content-type", "content-transfer-encoding", "mime-version", "content-disposition",
  "content-id", "content-description", "content-length", "content-language",
]);

const RE_FIELD_NAME = /^[\x21-\x39\x3B-\x7E]+$/;
const RE_MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

const plainASCII = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
};

function base64Lines(b: Uint8Array): string {
  const enc = Buffer.from(b).toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < enc.length; i += 76) lines.push(enc.slice(i, i + 76));
  return lines.join(CRLF);
}

/** An RFC 2047 encoded word for text that is not plain ASCII. */
const headerText = (s: string): string => (plainASCII(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/** name="ascii", plus RFC 2231 name*=UTF-8''.. for other values. */
function headerParam(name: string, value: string): string {
  let pct = "";
  for (const b of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(b);
    pct += /[0-9A-Za-z.\-_]/.test(ch) ? ch : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  let fb = "";
  for (let i = 0; i < value.length; i++) { // per UTF-16 unit, as PowerShell did
    const u = value.charCodeAt(i);
    fb += u >= 0x20 && u <= 0x7e ? String.fromCharCode(u) : "_";
  }
  const fallback = fb.replaceAll("\\", "_").replaceAll('"', "'");
  return plainASCII(value) ? `${name}="${fallback}"` : `${name}="${fallback}"; ${name}*=UTF-8''${pct}`;
}

interface Entity { headers: string; body: string }

function multipart(subtype: string, boundary: string, parts: Entity[]): Entity {
  const ps = parts.map((e) => e.headers + CRLF + CRLF + e.body);
  const body = `--${boundary}${CRLF}${ps.join(`${CRLF}--${boundary}${CRLF}`)}${CRLF}--${boundary}--`;
  return { headers: `Content-Type: multipart/${subtype}; boundary="${boundary}"`, body };
}

const textEntity = (subtype: string, text: string): Entity => ({
  headers: `Content-Type: text/${subtype}; charset=utf-8${CRLF}Content-Transfer-Encoding: base64`,
  body: base64Lines(Buffer.from(text, "utf8")),
});

function attachmentEntity(a: Attachment, asInline: boolean): Entity {
  const name = a.fileName || "attachment";
  const typ = a.mimeType && RE_MIME_TYPE.test(a.mimeType) ? a.mimeType : "application/octet-stream";
  const h = [
    `Content-Type: ${typ}; ${headerParam("name", name)}`,
    `Content-Disposition: ${asInline ? "inline" : "attachment"}; ${headerParam("filename", name)}`,
    "Content-Transfer-Encoding: base64",
  ];
  if (a.contentId) h.push(`Content-ID: <${a.contentId.replace(/^<+|>+$/g, "")}>`);
  return { headers: h.join(CRLF), body: base64Lines(a.bytes) };
}

/** Keeps the original transport header lines (folding included), drops content-structure headers, encodes non-ASCII text. */
function keptTransportHeaders(raw: string): string[] {
  const kept: string[] = [];
  if (!raw) return kept;
  let skip = false;
  for (const line of raw.split(/\r\n|\n|\r/)) {
    if (line === "") break;
    if (line[0] === " " || line[0] === "\t") {
      if (!skip && kept.length > 0) {
        const text = line.replace(/^[ \t]+/, "");
        kept.push(line.slice(0, line.length - text.length) + headerText(text));
      }
      continue;
    }
    const idx = line.indexOf(":");
    if (idx < 1) { skip = true; continue; }
    const rawName = line.slice(0, idx);
    if (!RE_FIELD_NAME.test(rawName) || DROPPED_HEADERS.has(rawName.trim().toLowerCase())) { skip = true; continue; }
    skip = false;
    const value = line.slice(idx + 1);
    kept.push(plainASCII(value) ? line : `${rawName}: ${headerText(value.replace(/^[ \t]+/, ""))}`);
  }
  return kept;
}

const hasHeader = (lines: string[], name: string): boolean => {
  const p = name.toLowerCase() + ":";
  return lines.some((l) => l.toLowerCase().startsWith(p));
};

/** "Mon, 02 Jan 2006 15:04:05 +0000" */
const mimeDate = (d: Date): string => d.toUTCString().replace("GMT", "+0000");

const rfc3339 = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** Builds the RFC 5322 message for an item. */
export function toMIME(it: Item): Uint8Array {
  const lines = keptTransportHeaders(it.transportHeaders);
  const received = Number.isNaN(it.receivedTime.getTime()) ? new Date() : it.receivedTime;
  const seed = it.entryId || `${it.subject}|${rfc3339(received)}`;
  const seedHash = sha256Hex(seed);

  if (!hasHeader(lines, "Date")) lines.push("Date: " + mimeDate(received));
  if (!hasHeader(lines, "Message-ID")) lines.push(`Message-ID: <${seedHash.slice(0, 32)}@torbit-bridge.invalid>`);
  if (!hasHeader(lines, "Subject")) lines.push("Subject: " + headerText(it.subject));
  if (!hasHeader(lines, "From")) {
    const addr = it.senderEmail || "unknown@torbit-bridge.invalid";
    let from = addr;
    if (it.senderName) {
      const name = it.senderName.replaceAll("\\", "").replaceAll('"', "");
      from = `${headerText(`"${name}"`)} <${addr}>`;
    }
    lines.push("From: " + from);
  }
  if (!hasHeader(lines, "To") && it.to) lines.push("To: " + headerText(it.to));
  lines.push("MIME-Version: 1.0");

  const hasHTML = it.htmlBody !== "";
  const hasText = it.body !== "";
  let root: Entity;
  if (hasHTML && hasText) {
    root = multipart("alternative", "=_torbit_a_" + seedHash.slice(0, 24), [textEntity("plain", it.body), textEntity("html", it.htmlBody)]);
  } else if (hasHTML) {
    root = textEntity("html", it.htmlBody);
  } else {
    root = textEntity("plain", it.body);
  }
  const inline: Attachment[] = [];
  const regular: Attachment[] = [];
  for (const a of it.attachments) (hasHTML && a.isInline && a.contentId ? inline : regular).push(a);
  if (inline.length > 0) {
    root = multipart("related", "=_torbit_r_" + seedHash.slice(0, 24), [root, ...inline.map((a) => attachmentEntity(a, true))]);
  }
  if (regular.length > 0) {
    root = multipart("mixed", "=_torbit_m_" + seedHash.slice(0, 24), [root, ...regular.map((a) => attachmentEntity(a, a.isInline))]);
  }
  return Buffer.from(lines.join(CRLF) + CRLF + root.headers + CRLF + CRLF + root.body + CRLF, "latin1");
}
