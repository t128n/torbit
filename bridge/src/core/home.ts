import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sleep } from "./util.ts";

/** The per-user bridge folder (TORBIT_BRIDGE_HOME, else %LOCALAPPDATA%\Torbit\Bridge). Created on demand. */
export function home(): string {
  let dir = process.env.TORBIT_BRIDGE_HOME;
  if (!dir) {
    let local = process.env.LOCALAPPDATA;
    if (!local) {
      if (process.platform === "win32") throw new Error("LOCALAPPDATA is not set");
      local = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    }
    dir = join(local, "Torbit", "Bridge");
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Where `install` puts the executable that the logon task runs. */
export const installDir = (): string => join(home(), "bin");
export const installedExe = (): string => join(installDir(), "torbit-bridge.exe");

export function writeJSON(path: string, v: unknown): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
  // Rename replaces the target in one step, so a crash never leaves it missing.
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export function readJSON<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  let text = readFileSync(path, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // PowerShell 5.1 wrote a BOM in some setups
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`${path.split(/[\\/]/).pop()} is not valid JSON: ${(e as Error).message}`);
  }
}

/** Appends an event line to bridge.log. Callers pass events and ids only: never keys, credentials or message text. */
export function logf(message: string): void {
  try {
    appendFileSync(join(home(), "bridge.log"), `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {
    /* logging must never break delivery */
  }
}

/** A lock file created exclusively; a lock older than `staleMs` is taken over. */
export async function lockFile(path: string, waitMs = 10_000, staleMs = 30_000): Promise<() => void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
      return () => rmSync(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      const age = Date.now() - (await Bun.file(path).stat()).mtimeMs;
      if (age > staleMs) {
        rmSync(path, { force: true }); // its owner died
        continue;
      }
    } catch {
      continue; // released between the two calls
    }
    if (Date.now() > deadline) throw new Error("state.json is locked by another bridge process");
    await sleep(50);
  }
}
