import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import type { Credential } from "./core/enroll.ts";

// After a background run detaches from its console, writing to stdout/stderr must never take the bridge down.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

export const out = (s = ""): void => void process.stdout.write(s + "\n");
export const err = (s: string): void => void process.stderr.write(s + "\n");

/** Prints an error the way every command does and returns the exit code. */
export function fail(message: string): number {
  err("torbit-bridge: " + message.trim());
  return 1;
}

export const interactive = (): boolean => !!process.stdin.isTTY;

export async function ask(prompt: string, def = ""): Promise<string> {
  if (!interactive()) throw new Error(`${prompt.replace(/:$/, "")} is required (no terminal to ask on)`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(def ? `${prompt} [${def}]: ` : `${prompt}: `)).trim();
    return answer || def;
  } finally {
    rl.close();
  }
}

/** Reads a line without echo. */
export function askSecret(prompt: string): Promise<string> {
  if (!interactive()) {
    return Promise.reject(new Error("a credential is required: use --session-token/--api-token or TORBIT_SESSION_TOKEN/TORBIT_API_TOKEN"));
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt + ": ");
    stdin.setRawMode(true);
    stdin.resume();
    let buf = "";
    const finish = (fn: () => void) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      fn();
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return finish(() => resolve(buf.trim()));
        if (ch === "\u0003") return finish(() => reject(new Error("cancelled")));
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

export interface FlagSpec { type: "string" | "boolean"; description: string; arg?: string }
export type Flags = Record<string, FlagSpec>;
export type FlagValues = Record<string, string | boolean | undefined>;

export const CRED_FLAGS: Flags = {
  "session-token": { type: "string", arg: "token", description: "Orbit session token (the __Host-orbit_session cookie value); or set TORBIT_SESSION_TOKEN" },
  "api-token": { type: "string", arg: "token", description: "Orbit API token; or set TORBIT_API_TOKEN" },
};

/** Parses flags; returns the exit code instead when help was asked for or the flags are wrong. */
export function parseFlags(command: string, spec: Flags, args: string[]): FlagValues | number {
  const usage = () => {
    out(`Usage: torbit-bridge ${command} [flags]\n`);
    for (const [name, f] of Object.entries(spec)) {
      const left = `--${name}${f.type === "string" ? ` <${f.arg ?? "value"}>` : ""}`;
      out(`  ${left.padEnd(28)} ${f.description}`);
    }
  };
  try {
    const { values } = parseArgs({
      args,
      allowPositionals: false,
      options: { ...Object.fromEntries(Object.entries(spec).map(([k, f]) => [k, { type: f.type }])), help: { type: "boolean", short: "h" } },
    });
    if (values.help) {
      usage();
      return 0;
    }
    return values as FlagValues;
  } catch (e) {
    err(`torbit-bridge ${command}: ${(e as Error).message}`);
    usage();
    return 2;
  }
}

/** Accepts seconds ("60") or a duration such as "1m30s". Returns milliseconds. */
export function parseDuration(s: string): number {
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 } as const;
  let total = 0;
  let used = 0;
  for (const m of s.matchAll(re)) {
    total += Number(m[1]) * unit[m[2] as keyof typeof unit];
    used += m[0].length;
  }
  if (!used || used !== s.length) throw new Error(`cannot read the interval "${s}"; use seconds (60) or 1m30s`);
  return total;
}

export function intervalFlag(v: FlagValues): number {
  const ms = parseDuration(String(v.interval ?? "60"));
  if (ms < 5000) throw new Error("the interval must be at least 5 seconds");
  return ms;
}

export async function resolveCredential(v: FlagValues, prompt: string): Promise<Credential> {
  if (v["api-token"]) return { kind: "api", value: String(v["api-token"]) };
  if (v["session-token"]) return { kind: "session", value: String(v["session-token"]) };
  if (process.env.TORBIT_API_TOKEN) return { kind: "api", value: process.env.TORBIT_API_TOKEN };
  if (process.env.TORBIT_SESSION_TOKEN) return { kind: "session", value: process.env.TORBIT_SESSION_TOKEN };
  return { kind: "session", value: await askSecret(prompt) };
}
