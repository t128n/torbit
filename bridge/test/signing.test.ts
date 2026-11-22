import { createPrivateKey } from "node:crypto";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { verifyP1363 } from "../src/core/doctor.ts";
import { HEADER_NONCE, HEADER_SIGNATURE, HEADER_TIMESTAMP, newNonce, requestHeaders, signedString } from "../src/core/sign.ts";
import { keySigner } from "./helpers.ts";

// The vectors are shared with the server patch (docs/bridge-signing.md).
const doc = JSON.parse(readFileSync(new URL("../../tests/bridge-vectors.json", import.meta.url), "utf8"));
const prefix = "/api/v1/mail/inbound/bridge/";

for (const v of doc.vectors) {
  test(`vector ${v.name}`, () => {
    const body = Buffer.from(v.body_base64, "base64");
    const ts = v.headers[HEADER_TIMESTAMP];
    const str = signedString(ts, v.headers[HEADER_NONCE], v.path.slice(prefix.length), body);
    const sig = Buffer.from(v.headers[HEADER_SIGNATURE], "base64");
    const ok = verifyP1363(doc.public_key_spki_base64, Buffer.from(str), sig);
    expect(ok).toBe(v.expect.signature_valid);
    if (v.expect.signature_valid) {
      expect(str).toBe(v.signed_string_of_original);
      expect(Math.abs(doc.now_unix - Number(ts)) <= doc.window_seconds).toBe(v.expect.timestamp_in_window);
    }
  });
}

test("our signer produces a signature the verifier accepts", async () => {
  const key = createPrivateKey({ key: Buffer.from(doc.private_key_pkcs8_base64, "base64"), format: "der", type: "pkcs8" });
  const dev = "7c1d2e3a-4b5f-4a6b-8c7d-9e0f1a2b3c4d";
  const h = await requestHeaders(dev, Buffer.from("hi"), keySigner(key), "1790000000", "AAECAwQFBgcICQoLDA0ODw");
  const sig = Buffer.from(h[HEADER_SIGNATURE]!, "base64");
  expect(sig.length).toBe(64);
  expect(verifyP1363(doc.public_key_spki_base64, Buffer.from(signedString("1790000000", "AAECAwQFBgcICQoLDA0ODw", dev, Buffer.from("hi"))), sig)).toBe(true);
});

test("nonce shape", () => {
  const a = newNonce();
  expect(a).toHaveLength(22);
  expect(a).not.toBe(newNonce());
  expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
});
