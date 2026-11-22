import { randomBytes } from "node:crypto";
import { sha256Hex } from "./util.ts";
import type { Signer } from "./types.ts";

// The signature format and header names are the wire contract with the Orbit server patch
// (patches/0006, docs/bridge-signing.md). Both sides must change together.
export const SIGNATURE_FORMAT = "torbit-bridge-v1";
export const HEADER_TIMESTAMP = "X-Torbit-Timestamp";
export const HEADER_NONCE = "X-Torbit-Nonce";
export const HEADER_SIGNATURE = "X-Torbit-Signature";
export const MAX_BODY_BYTES = 2097152;

/** 16 random bytes as unpadded base64url (22 characters). */
export const newNonce = (): string => randomBytes(16).toString("base64url");

/** The five LF-joined lines of docs/bridge-signing.md. */
export function signedString(timestamp: string, nonce: string, deviceId: string, body: Uint8Array): string {
  return `${SIGNATURE_FORMAT}\n${timestamp}\n${nonce}\n${deviceId}\n${sha256Hex(body)}`;
}

/** The three X-Torbit-* headers for a body. An empty timestamp or nonce is generated. */
export async function requestHeaders(
  deviceId: string,
  body: Uint8Array,
  signer: Signer,
  timestamp = "",
  nonce = "",
): Promise<Record<string, string>> {
  timestamp ||= String(Math.floor(Date.now() / 1000));
  nonce ||= newNonce();
  const sig = await signer.sign(Buffer.from(signedString(timestamp, nonce, deviceId, body), "utf8"));
  if (sig.length !== 64) throw new Error("signer did not return a 64-byte IEEE-P1363 signature");
  return {
    [HEADER_TIMESTAMP]: timestamp,
    [HEADER_NONCE]: nonce,
    [HEADER_SIGNATURE]: Buffer.from(sig).toString("base64"),
  };
}
