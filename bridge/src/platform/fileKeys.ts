import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { home } from "../core/home.ts";
import type { KeyStore, Signer } from "../core/types.ts";

/** Development key store for non-Windows hosts: a PEM file. Not secure; it exists so the bridge can be built, enrolled and tested on Linux and macOS. */
export class FileKeys implements KeyStore {
  constructor(private readonly dir = () => join(home(), "devkeys")) {}

  private path(name: string): string {
    mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
    return join(this.dir(), name + ".pem");
  }

  private load(name: string) {
    return createPrivateKey(readFileSync(this.path(name)));
  }

  private spki(name: string): string {
    return createPublicKey(this.load(name)).export({ type: "spki", format: "der" }).toString("base64");
  }

  async create(name: string) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    writeFileSync(this.path(name), privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    return { provider: "file (development only)", spkiBase64: this.spki(name) };
  }

  async open(name: string): Promise<Signer> {
    const key = this.load(name);
    return {
      sign: async (message) => new Uint8Array(sign("sha256", message, { key, dsaEncoding: "ieee-p1363" })),
      close() {},
    };
  }

  async publicKey(name: string) {
    return this.spki(name);
  }

  async delete(name: string) {
    rmSync(this.path(name));
  }
}
