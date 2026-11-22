import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Replaces `path` with `data` even when `path` is a running program: Windows allows renaming a running
 * executable, so the old file is moved aside first and removed when it can be.
 */
export function replaceFile(path: string, data: Uint8Array): void {
  const next = path + ".new";
  const old = path + ".old";
  writeFileSync(next, data, { mode: 0o755 });
  try {
    rmSync(old, { force: true });
  } catch {
    /* an earlier .old is still in use; the rename below then fails and reports it */
  }
  try {
    if (existsSync(path)) renameSync(path, old);
    renameSync(next, path);
  } catch (e) {
    rmSync(next, { force: true });
    if (existsSync(old) && !existsSync(path)) renameSync(old, path); // put the original back
    throw e;
  }
  try {
    rmSync(old, { force: true });
  } catch {
    /* still running: the next install or upgrade removes it */
  }
}

/** Removes a file; a program that is running from it cannot be deleted on Windows, so it is renamed and deleted a moment later by cmd. */
export function removeFile(path: string): "removed" | "deferred" {
  if (!existsSync(path)) return "removed";
  try {
    rmSync(path);
    return "removed";
  } catch {
    const aside = path + ".old";
    rmSync(aside, { force: true });
    renameSync(path, aside);
    Bun.spawn(["cmd.exe", "/d", "/c", `ping -n 4 127.0.0.1 >nul & del /f /q "${aside}"`], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true }).unref();
    return "deferred";
  }
}
