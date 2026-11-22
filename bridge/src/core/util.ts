import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";

export const sha256Hex = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

export function newUUID(): string {
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const computerName = (): string => process.env.COMPUTERNAME || hostname();

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The torbit state files use 7 fractional digits ("2006-01-02T15:04:05.0000000Z"). */
export function fmtTime(d: Date): string {
  return d.toISOString().replace(/\.(\d{3})Z$/, (_, ms: string) => `.${ms}0000Z`);
}

export function parseTime(v: string | undefined | null): Date | undefined {
  if (!v) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/.exec(v);
  if (!m) return undefined;
  const frac = ((m[2] ?? "") + "000").slice(0, 3);
  const d = new Date(`${m[1]}.${frac}${m[3] ?? "Z"}`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
