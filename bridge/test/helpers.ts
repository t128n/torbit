import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchFn } from "../src/core/http.ts";
import type { Adapter, Item, ItemRef, KeyStore, Signer } from "../src/core/types.ts";

/** Points the bridge folder at a fresh temp dir. */
export function isolate(): string {
  const dir = mkdtempSync(join(tmpdir(), "torbit-test-"));
  process.env.TORBIT_BRIDGE_HOME = dir;
  return dir;
}

export const keySigner = (privateKey: ReturnType<typeof createPrivateKey>): Signer => ({
  sign: async (m) => new Uint8Array(sign("sha256", m, { key: privateKey, dsaEncoding: "ieee-p1363" })),
  close() {},
});

/** A software KeyStore for tests. */
export class MemKeys implements KeyStore {
  keys = new Map<string, ReturnType<typeof createPrivateKey>>();
  async create(name: string) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.keys.set(name, privateKey);
    return { provider: "mem", spkiBase64: this.spki(name) };
  }
  private spki(name: string) {
    return createPublicKey(this.keys.get(name)!).export({ type: "spki", format: "der" }).toString("base64");
  }
  async open(name: string) {
    const k = this.keys.get(name);
    if (!k) throw new Error("no such key");
    return keySigner(k);
  }
  async publicKey(name: string) {
    if (!this.keys.has(name)) throw new Error("no such key");
    return this.spki(name);
  }
  async delete(name: string) {
    this.keys.delete(name);
  }
}

/** A fetch standing in for Orbit. */
export class FakeServer {
  /** consumed per delivery; the last one repeats */
  statuses: number[] = [];
  bodies: Uint8Array[] = [];
  headers: Headers[] = [];
  other?: (url: URL, init: RequestInit) => { status: number; body?: string };

  fetch: FetchFn = async (url, init) => {
    const u = new URL(url);
    let status = 200;
    let body = "";
    if (u.pathname.includes("/mail/inbound/bridge/")) {
      this.bodies.push(new Uint8Array(init.body as Uint8Array));
      this.headers.push(new Headers(init.headers as Record<string, string>));
      if (this.statuses.length > 0) {
        status = this.statuses[0]!;
        if (this.statuses.length > 1) this.statuses.shift();
      }
    } else if (this.other) {
      ({ status, body = "" } = this.other(u, init));
    }
    if (status === 0) throw new Error("connection refused");
    return new Response(body, { status });
  };
}

export class FakeAdapter implements Adapter {
  loaded: string[] = [];
  constructor(public items: Item[]) {}
  async list(): Promise<ItemRef[]> {
    return this.items.map(({ entryId, receivedTime, size }) => ({ entryId, receivedTime, size }));
  }
  async read(id: string): Promise<Item> {
    this.loaded.push(id);
    return this.items.find((i) => i.entryId === id)!;
  }
  close() {}
}

export const mail = (id: string, ageMs: number, extra: Partial<Item> = {}): Item => ({
  entryId: id, subject: id, senderName: "", senderEmail: "", to: "", transportHeaders: "", body: "b", htmlBody: "",
  size: 0, attachments: [], receivedTime: new Date(Date.now() - ageMs), ...extra,
});
