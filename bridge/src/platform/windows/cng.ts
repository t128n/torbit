import { createHash } from "node:crypto";
import { dlopen, FFIType, ptr } from "bun:ffi";
import type { KeyStore, Signer } from "../../core/types.ts";

// The key is a non-exportable ECDSA P-256 signing key in CNG, in the current user's key store:
// the TPM provider when there is one, else the software KSP. Provider and key names match the
// PowerShell and Go bridges, so an existing enrollment keeps working.
const TPM_PROVIDER = "Microsoft Platform Crypto Provider";
const SOFTWARE_PROVIDER = "Microsoft Software Key Storage Provider";
const NCRYPT_ALLOW_SIGNING_FLAG = 0x2;

const { ptr: P, u32, u64, i32 } = FFIType;

let lib: ReturnType<typeof load> | undefined;
function load() {
  return dlopen("ncrypt.dll", {
    NCryptOpenStorageProvider: { args: [P, P, u32], returns: i32 },
    NCryptCreatePersistedKey: { args: [u64, P, P, P, u32, u32], returns: i32 },
    NCryptOpenKey: { args: [u64, P, P, u32, u32], returns: i32 },
    NCryptSetProperty: { args: [u64, P, P, u32, u32], returns: i32 },
    NCryptFinalizeKey: { args: [u64, u32], returns: i32 },
    NCryptExportKey: { args: [u64, u64, P, P, P, u32, P, u32], returns: i32 },
    NCryptSignHash: { args: [u64, P, P, u32, P, u32, P, u32], returns: i32 },
    NCryptDeleteKey: { args: [u64, u32], returns: i32 },
    NCryptFreeObject: { args: [u64], returns: i32 },
  }).symbols;
}
const n = () => (lib ??= load());

/** A NUL-terminated UTF-16 string for a Windows API. */
function wstr(s: string): Uint16Array {
  const b = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

/** Keeps buffers reachable until the native call that was handed their addresses has returned. */
const hold = (..._buffers: unknown[]): void => {};

function check(op: string, status: number): void {
  if (status !== 0) throw new Error(`${op} failed: 0x${(status >>> 0).toString(16).toUpperCase().padStart(8, "0")}`);
}

const free = (h: bigint): void => void n().NCryptFreeObject(h);

function openProvider(name: string): bigint {
  const h = new BigUint64Array(1);
  const w = wstr(name);
  const st = n().NCryptOpenStorageProvider(ptr(h), ptr(w), 0);
  hold(h, w);
  check("NCryptOpenStorageProvider", st);
  return h[0]!;
}

function openKey(name: string, provider: string): { prov: bigint; key: bigint } {
  const prov = openProvider(provider);
  const h = new BigUint64Array(1);
  const w = wstr(name);
  const st = n().NCryptOpenKey(prov, ptr(h), ptr(w), 0, 0);
  hold(h, w);
  if (st !== 0) {
    free(prov);
    check("NCryptOpenKey", st);
  }
  return { prov, key: h[0]! };
}

function setDword(key: bigint, prop: string, value: number): void {
  const v = new Uint32Array([value]);
  const w = wstr(prop);
  const st = n().NCryptSetProperty(key, ptr(w), ptr(v), 4, 0);
  hold(v, w);
  check(`NCryptSetProperty(${prop})`, st);
}

/** Exports ECCPUBLICBLOB (8-byte header + X + Y) and wraps it as a 91-byte SubjectPublicKeyInfo. */
function publicSPKI(key: bigint): string {
  const buf = new Uint8Array(72);
  const len = new Uint32Array(1);
  const w = wstr("ECCPUBLICBLOB");
  const st = n().NCryptExportKey(key, 0n, ptr(w), null, ptr(buf), buf.length, ptr(len), 0);
  hold(buf, len, w);
  check("NCryptExportKey", st);
  if (len[0] !== 72) throw new Error("unexpected public key blob; expected P-256");
  const prefix = Uint8Array.from([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04]);
  return Buffer.concat([prefix, buf.subarray(8, 72)]).toString("base64");
}

function createIn(name: string, provider: string): string {
  const prov = openProvider(provider);
  try {
    const h = new BigUint64Array(1);
    const alg = wstr("ECDSA_P256");
    const kn = wstr(name);
    const st = n().NCryptCreatePersistedKey(prov, ptr(h), ptr(alg), ptr(kn), 0, 0);
    hold(h, alg, kn);
    check("NCryptCreatePersistedKey", st);
    const key = h[0]!;
    let ok = false;
    try {
      setDword(key, "Export Policy", 0); // none: the private key can never leave the key store
      setDword(key, "Key Usage", NCRYPT_ALLOW_SIGNING_FLAG);
      check("NCryptFinalizeKey", n().NCryptFinalizeKey(key, 0));
      const spki = publicSPKI(key);
      ok = true;
      return spki;
    } finally {
      if (ok) free(key);
      else n().NCryptDeleteKey(key, 0); // also frees the handle
    }
  } finally {
    free(prov);
  }
}

export class CngKeys implements KeyStore {
  async create(name: string, provider = "") {
    const candidates = provider ? [provider] : [TPM_PROVIDER, SOFTWARE_PROVIDER];
    let last: unknown;
    for (const p of candidates) {
      try {
        return { provider: p, spkiBase64: createIn(name, p) };
      } catch (e) {
        last = new Error(`${p}: ${(e as Error).message}`);
      }
    }
    throw last;
  }

  async open(name: string, provider: string): Promise<Signer> {
    const { prov, key } = openKey(name, provider);
    return {
      // CNG signs a hash: SHA-256 of the message, signed as IEEE-P1363 r||s.
      async sign(message) {
        const digest = createHash("sha256").update(message).digest();
        const out = new Uint8Array(64);
        const len = new Uint32Array(1);
        const st = n().NCryptSignHash(key, null, ptr(digest), digest.length, ptr(out), out.length, ptr(len), 0);
        hold(digest, out, len);
        check("NCryptSignHash", st);
        return out.subarray(0, len[0]);
      },
      close() {
        free(key);
        free(prov);
      },
    };
  }

  async publicKey(name: string, provider: string) {
    const { prov, key } = openKey(name, provider);
    try {
      return publicSPKI(key);
    } finally {
      free(key);
      free(prov);
    }
  }

  async delete(name: string, provider: string) {
    const { prov, key } = openKey(name, provider);
    try {
      check("NCryptDeleteKey", n().NCryptDeleteKey(key, 0)); // frees the key handle
    } finally {
      free(prov);
    }
  }
}
