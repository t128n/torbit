# Bridge signing format (worbit-bridge-v1)

This is the contract between the Outlook bridge (`bridge/`, Go) and the Orbit server patch.
Both sides must pass `tests/bridge-vectors.json`. The script side is checked by
`bridge/internal/core` (`go test ./...`, Go `crypto/ecdsa`).

## Request

```
POST /api/v1/mail/inbound/bridge/{device_id}
X-Worbit-Timestamp: <unix seconds>
X-Worbit-Nonce: <nonce>
X-Worbit-Signature: <base64 signature>

<raw MIME message bytes>
```

- `device_id`: the lowercase hyphenated UUID returned at enrollment. It is the only
  route parameter. It is part of the signed string.
- The body is the raw RFC 5322 message, byte for byte. No re-encoding by either side.
  The hash is taken over the exact bytes received.
- Header names are case-insensitive on the wire. Each header must appear exactly once.
- Any recipient in the envelope, headers or body is ignored for routing. The
  destination is the mailbox bound to the device.

## Fields

| Field | Format |
|---|---|
| timestamp | Decimal ASCII digits, unix seconds (UTC), no sign, no leading zeros, no spaces. |
| nonce | 8 to 64 characters from `A-Z a-z 0-9 - _`. Generate 16 random bytes and encode as unpadded base64url (22 characters). Must be unique per request. |
| device id | As in the path, compared as an exact string (lowercase). |
| body hash | Lowercase hex SHA-256 of the body bytes. The empty body is valid and hashes to `e3b0c442...b855`. |

## Signed string

Five lines joined with a single LF (`0x0A`). There is no trailing newline and no CR.
The string is encoded as UTF-8 (it is pure ASCII).

```
worbit-bridge-v1\n
<timestamp>\n
<nonce>\n
<device_id>\n
<hex sha256 of body>
```

Example (no spaces, `\n` is a real LF):

```
worbit-bridge-v1
1790000000
AAECAwQFBgcICQoLDA0ODw
7c1d2e3a-4b5f-4a6b-8c7d-9e0f1a2b3c4d
<64 hex characters>
```

The timestamp, nonce and device id in the signed string are the values as sent
in the header and path (same characters, no normalisation).

## Signature

- Key: ECDSA on NIST P-256 (`secp256r1`, `nistP256`).
- Digest: SHA-256 over the UTF-8 signed string (the bridge hashes it and signs the
  32-byte digest with CNG `NCryptSignHash`).
- Format: IEEE-P1363, `r || s`, each 32 bytes big-endian, so exactly 64 bytes.
  This is the native CNG output. It is not ASN.1 DER. A DER signature is rejected.
- Header value: standard base64 (RFC 4648 section 4) with padding. A 64-byte value
  encodes to 88 characters.
- Public key in the registry and in enrollment: SubjectPublicKeyInfo (SPKI) DER,
  base64. For P-256 this is 91 bytes. Servers must accept only uncompressed P-256 points.

## Timestamp window

Accept when `|server_now - timestamp| <= 300` seconds (inclusive at both edges).
Both past and future are bounded. Server time is unix seconds, UTC.

## Nonce rules

- The server keeps an in-memory cache of `(device_id, nonce)` pairs.
- A nonce is recorded only after the signature and timestamp checks pass, so
  forged requests cannot fill the cache.
- A pair is kept for at least 600 seconds (twice the window), then may be dropped.
- A nonce seen again for the same device within that time is a replay: 401.
- The cache lives in the server process only. A restart empties it, which reopens the
  5 minute window: a request captured before the restart can be replayed once until its
  timestamp falls outside the window. The second layer is the raw-message dedupe of the
  mail intake: a replayed message that is byte-identical to a stored one is not stored
  again (the replay answers 200 but changes nothing). Several servers behind one name each
  have their own cache.
- A delivery that is not stored (503) forgets its nonce, so the retry with the same nonce
  is accepted.

## Verification order

The server stops at the first failure.

| # | Check | Failure | Status |
|---|---|---|---|
| 1 | Feature enabled (registry path configured and instance mail enabled) | feature off | 404 |
| 2 | `device_id` is in the registry | unknown device | 404 |
| 3 | Device is not revoked | revoked | 401, code `device_revoked` |
| 4 | Headers present once, timestamp/nonce/signature well formed | malformed | 401 |
| 5 | A body slot is free within 10 s, then the body arrives within 30 s | no slot / too slow / broken | 503 / 408 / 400 |
| 6 | Body size within limit | too large | 413 |
| 7 | Signature verifies over the signed string with the device public key | bad signature | 401 |
| 8 | Timestamp inside the window | expired or future | 401 |
| 9 | The device's member is still a full member and its mailbox is active | member removed, mailbox suspended | 401 |
| 10 | Nonce not used before for this device | replay | 401 |
| 11 | Store through the mail intake pipeline | storage, quota, database error | 503 |
| - | Stored (or already stored: duplicate raw message) | success | 200 |

Reasons are not distinguished in the response body for 401, so a caller cannot
probe which check failed. The server logs the reason without message content. The one
exception is a revoked device: its 401 body is
`{"error":"device revoked","code":"device_revoked","detail":"..."}`, so the bridge can
tell the user to enroll again. A device id from the URL is cut and cleaned before it is
logged.

Retry guidance for the bridge: 200 done. 503 and 408 retry later with backoff. 401, 413,
400 and 404 are permanent for that message (404 and 401 may also mean the device must
be re-enrolled); skip and log, do not retry forever.

## Authentication results

A bridge delivery is not checked for SPF, DKIM or DMARC: the signature proves which
device sent the request, not who wrote the message. Orbit stores the message with a
neutral verdict (`none` for all three) and adds no `Authentication-Results` header of its
own. The `Authentication-Results`, `Received-SPF` and other headers that Outlook kept
in the message's transport headers are preserved verbatim in the stored raw message. They
are the original receiving server's claims, not Orbit's verdict, and Orbit does not
evaluate them.

## Body size limit

Upstream caps non-multipart request bodies at 2 MiB
(`crates/platform/src/http/limits.rs:36`, see `docs/bridge-spike.md`). The effective
limit for a bridge delivery is therefore 2 MiB (2,097,152 bytes) unless the patch
exempts the bridge path. Because the platform layer may reject an oversized body
before the handler runs, an oversized request may get 413 before steps 2 to 7. Both
orders give 413 for oversized bodies; the order above is the handler's logical order.
The bridge must treat any message over 2 MiB as permanently undeliverable.

## Test vectors

`tests/bridge-vectors.json` contains a throwaway P-256 key (public key as SPKI
base64, private key as PKCS#8 base64 for reproducing signatures) and these cases:

- valid: ASCII, empty, UTF-8 and binary bodies; timestamps exactly at -300 s and +300 s.
- tampered body, wrong device id in path, changed timestamp header, changed nonce
  header, garbage signature: signature invalid, 401.
- correctly signed but 301 s old or 301 s in the future: 401.

Each vector gives `path`, `headers`, `body_base64`, `signed_string_of_original`
and `expect` (`signature_valid`, `timestamp_in_window`, `status`), evaluated at
`now_unix` with `window_seconds`. For the wrong-device-id case, verify against the
single registered key; the signature covers the other device id so it fails.

The vectors cover steps 5 and 6 only. State-dependent cases (unknown device, revoked,
replayed nonce, oversized body, feature off, 503) are listed in
`stateful_cases_not_in_vectors` and are covered by server tests directly.

To regenerate: `node tests/generate-bridge-vectors.mjs > tests/bridge-vectors.json`
(this creates a new key and new signatures). To verify:
`cd bridge && go test ./internal/core -run TestSigningVectors`.
