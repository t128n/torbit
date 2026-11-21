// Regenerates tests/bridge-vectors.json with a throwaway P-256 key.
// Usage: node tests/generate-bridge-vectors.mjs > tests/bridge-vectors.json
// The private key is a TEST KEY. Never use it anywhere else.
import { generateKeyPairSync, createHash, createSign } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");

const DEVICE = "7c1d2e3a-4b5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER_DEVICE = "0f9e8d7c-6b5a-4c3d-9e2f-1a0b9c8d7e6f";
const NOW = 1790000000;
const mime = (s) => Buffer.from(s, "utf8");

const bodies = {
  simple: mime("From: a@example.com\r\nTo: b@example.invalid\r\nSubject: Hello\r\nMessage-ID: <1@example.com>\r\n\r\nHi there.\r\n"),
  empty: Buffer.alloc(0),
  utf8: mime("Subject: =?UTF-8?B?w5xtbGF1dA==?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nGrüße ✓\r\n"),
  binary: Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
};

const sha = (b) => createHash("sha256").update(b).digest("hex");
const signedString = (ts, nonce, dev, body) =>
  `torbit-bridge-v1\n${ts}\n${nonce}\n${dev}\n${sha(body)}`;
const sign = (str) => {
  const s = createSign("SHA256");
  s.update(str, "utf8");
  return s.sign({ key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
};
const path = (d) => `/api/v1/mail/inbound/bridge/${d}`;

function make(name, description, { body, ts = NOW, nonce, dev = DEVICE, sigOver, sentTs, sentBody, pathDev, expect }) {
  const sig = sign(signedString(ts, nonce, dev, body));
  const wireBody = sentBody ?? body;
  return {
    name,
    description,
    path: path(pathDev ?? dev),
    headers: {
      "X-Torbit-Timestamp": String(sentTs ?? ts),
      "X-Torbit-Nonce": nonce,
      "X-Torbit-Signature": sigOver ?? sig,
    },
    body_base64: wireBody.toString("base64"),
    // The string the signer signed (for the original, untampered request).
    signed_string_of_original: signedString(ts, nonce, dev, body),
    expect,
  };
}
const ok = { signature_valid: true, timestamp_in_window: true, status: 200 };
const badSig = { signature_valid: false, timestamp_in_window: true, status: 401 };
const vectors = [
  make("valid-simple", "Plain ASCII MIME body.", { body: bodies.simple, nonce: "AAECAwQFBgcICQoLDA0ODw", expect: ok }),
  make("valid-empty-body", "Empty body hashes to the SHA-256 of zero bytes.", { body: bodies.empty, nonce: "n-empty_0001", expect: ok }),
  make("valid-utf8", "UTF-8 body with non-ASCII bytes.", { body: bodies.utf8, nonce: "n-utf8_0002", expect: ok }),
  make("valid-binary", "Body with all 256 byte values.", { body: bodies.binary, nonce: "n-binary_0003", expect: ok }),
  make("valid-window-edge-past", "Timestamp exactly 300 s before server time is accepted.", { body: bodies.simple, ts: NOW - 300, nonce: "n-edge-past", expect: ok }),
  make("valid-window-edge-future", "Timestamp exactly 300 s after server time is accepted.", { body: bodies.simple, ts: NOW + 300, nonce: "n-edge-future", expect: ok }),
  make("invalid-tampered-body", "Body changed after signing.", {
    body: bodies.simple,
    nonce: "n-tamper-0004",
    sentBody: mime("From: a@example.com\r\nTo: b@example.invalid\r\nSubject: Hello\r\nMessage-ID: <1@example.com>\r\n\r\nHi there!\r\n"),
    expect: badSig,
  }),
  make("invalid-wrong-device-id", "Signed for one device id, delivered to the path of another. Verified with the key registered for the path device.", {
    body: bodies.simple, nonce: "n-wrongdev-05", pathDev: OTHER_DEVICE, expect: badSig,
  }),
  make("invalid-wrong-timestamp", "Timestamp header changed after signing (still inside the window).", {
    body: bodies.simple, nonce: "n-wrongts-006", sentTs: NOW + 1, expect: badSig,
  }),
  make("invalid-wrong-nonce", "Nonce header differs from the nonce that was signed.", {
    body: bodies.simple, nonce: "n-wrongnonce7",
    sigOver: sign(signedString(NOW, "n-someother-07", DEVICE, bodies.simple)), expect: badSig,
  }),
  make("invalid-signature-garbage", "Well-formed 64-byte signature that was never produced by the key.", {
    body: bodies.simple, nonce: "n-garbage-008", sigOver: Buffer.alloc(64, 7).toString("base64"), expect: badSig,
  }),
  make("invalid-expired", "Correctly signed, but 301 s in the past.", {
    body: bodies.simple, ts: NOW - 301, nonce: "n-expired-009",
    expect: { signature_valid: true, timestamp_in_window: false, status: 401 },
  }),
  make("invalid-future", "Correctly signed, but 301 s in the future.", {
    body: bodies.simple, ts: NOW + 301, nonce: "n-future-0010",
    expect: { signature_valid: true, timestamp_in_window: false, status: 401 },
  }),
];

console.log(JSON.stringify({
  format: "torbit-bridge-v1",
  note: "TEST VECTORS. The private key is a throwaway and must never be used outside tests.",
  algorithm: "ECDSA P-256 / SHA-256, signature IEEE-P1363 r||s (64 bytes), standard base64 with padding",
  now_unix: NOW,
  window_seconds: 300,
  device_id: DEVICE,
  public_key_spki_base64: spki,
  private_key_pkcs8_base64: pkcs8,
  stateful_cases_not_in_vectors: ["unknown device (404)", "revoked device (401)", "repeated nonce (401)", "body over 2 MiB (413)", "feature off (404)", "storage/quota/db failure (503)"],
  vectors,
}, null, 2));
