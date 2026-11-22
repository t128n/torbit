import type { Check } from "./doctor.ts";

/** Signs a message with the device key: ECDSA P-256 over SHA-256(message), IEEE-P1363 r||s (64 bytes). */
export interface Signer {
  sign(message: Uint8Array): Promise<Uint8Array>;
  close(): void;
}

/** Holds the device key. On Windows it is CNG (TPM first, then the software provider); never exportable. */
export interface KeyStore {
  /** provider may be empty to pick the best one. Returns the provider used and the public key as base64 SPKI DER. */
  create(name: string, provider?: string): Promise<{ provider: string; spkiBase64: string }>;
  open(name: string, provider: string): Promise<Signer>;
  publicKey(name: string, provider: string): Promise<string>;
  delete(name: string, provider: string): Promise<void>;
}

export interface Attachment {
  fileName: string;
  mimeType: string;
  contentId: string;
  isInline: boolean;
  bytes: Uint8Array;
}

/** An inbox item as listed: enough to dedupe and to skip oversize items without reading them. */
export interface ItemRef {
  entryId: string;
  receivedTime: Date;
  /** whole item in bytes, attachments included; 0 = unknown */
  size: number;
}

/**
 * The item cannot be delivered as it is (for example an attachment the daemon refused to return).
 * It is recorded as skipped with this status; it is never retried and never sent partially.
 */
export class ItemUnusableError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ItemUnusableError";
  }
}

/** The adapter could not read an item for a global reason (daemon error, token mismatch): the sweep stops. */
export class FatalReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FatalReadError";
  }
}

/** A full inbox mail, read only when it is about to be sent. */
export interface Item extends ItemRef {
  subject: string;
  senderName: string;
  senderEmail: string;
  to: string;
  transportHeaders: string;
  body: string;
  htmlBody: string;
  attachments: Attachment[];
}

/** Reads the Outlook inbox (the Inbox folder only). */
export interface Adapter {
  /** Items received at or after `since`, oldest first. */
  list(since: Date): Promise<ItemRef[]>;
  /** The full item, attachments included. */
  read(entryId: string): Promise<Item>;
  close(): void;
}

/** What the core needs from the operating system. */
export interface Platform {
  readonly supported: boolean;
  keys(): KeyStore;
  newOutlook(opts?: { timeoutMs?: number }): Promise<Adapter>;
  /** One worker per Windows session. A release function, or undefined when another worker holds the lock. */
  runLock(): (() => void) | undefined;
  /** A proxy URL for the request, from the Windows settings, or undefined. Environment proxies are handled by fetch itself. */
  proxyFor(url: URL): string | undefined;
}

export type { Check };
