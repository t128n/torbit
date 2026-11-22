import { expect, test } from "bun:test";
import { toMIME } from "../src/core/mime.ts";
import { mail } from "./helpers.ts";

const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");

test("plain message", () => {
  const it = mail("E1", 0, {
    subject: "Hello", senderName: "Ann", senderEmail: "ann@example.com", to: "me@example.com",
    receivedTime: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), body: "Hi there",
  });
  const b = toMIME(it);
  const s = text(b);
  for (const want of [
    "Date: Fri, 02 Jan 2026 03:04:05 +0000\r\n", "Subject: Hello\r\n", 'From: "Ann" <ann@example.com>\r\n',
    "To: me@example.com\r\n", "MIME-Version: 1.0\r\n", "Content-Type: text/plain; charset=utf-8\r\n",
    "Content-Transfer-Encoding: base64\r\n\r\nSGkgdGhlcmU=\r\n",
  ]) expect(s).toContain(want);
  expect(s).toMatch(/Message-ID: <[0-9a-f]{32}@torbit-bridge\.invalid>/);
  for (const c of b) expect(c === 0x0d || c === 0x0a || (c >= 0x20 && c <= 0x7e)).toBe(true);
  expect(text(toMIME(it))).toBe(s); // same item, same bytes
});

test("transport headers, structure and attachments", () => {
  const it = mail("E2", 0, {
    subject: "Grüße", receivedTime: new Date(1700000000_000), body: "t", htmlBody: "<b>t</b>",
    transportHeaders: "Received: from a\r\n by b\r\nSubject: Original\r\nContent-Type: text/plain\r\nX-Note: café\r\n\r\nBody: ignored",
    attachments: [
      { fileName: "résumé.pdf", mimeType: "application/pdf", contentId: "", isInline: false, bytes: Buffer.from("PDF") },
      { fileName: "logo.png", mimeType: "image/png", contentId: "<c1>", isInline: true, bytes: Buffer.from("PNG") },
    ],
  });
  const s = text(toMIME(it));
  for (const want of [
    "Received: from a\r\n by b\r\n", "Subject: Original\r\n", "X-Note: =?UTF-8?B?", "multipart/mixed", "multipart/related", "multipart/alternative",
    `filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`, "Content-ID: <c1>", "Content-Disposition: inline;",
  ]) expect(s).toContain(want);
  expect(s).not.toContain("Content-Type: text/plain\r\nX-Note");
  expect(s).not.toContain("ignored");
});

test("html only, no sender", () => {
  const s = text(toMIME(mail("E3", 0, { body: "", htmlBody: "<p>x</p>", subject: "s" })));
  expect(s).toContain("From: unknown@torbit-bridge.invalid\r\n");
  expect(s).toContain("Content-Type: text/html; charset=utf-8");
  expect(s).not.toContain("multipart");
});
