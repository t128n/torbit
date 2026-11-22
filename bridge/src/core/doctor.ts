import { createPublicKey, verify } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertServerURL, type Http } from "./http.ts";
import { home } from "./home.ts";
import { readConfig, readState, type Config } from "./state.ts";
import type { KeyStore } from "./types.ts";
import { errText, parseTime } from "./util.ts";

export type Level = "ok" | "warn" | "fail";

/** One doctor result. `hint` says what to do about a warning or failure. */
export interface Check { name: string; level: Level; detail: string; hint?: string }

export const worst = (checks: Check[]): Level =>
  checks.some((c) => c.level === "fail") ? "fail" : checks.some((c) => c.level === "warn") ? "warn" : "ok";

/** The platform-independent checks. The caller appends Outlook and scheduled-task checks. */
export async function diagnose(http: Http, keys: KeyStore): Promise<Check[]> {
  const out: Check[] = [];
  const add = (name: string, level: Level, detail: string, hint = "") => out.push({ name, level, detail, hint });

  let dir: string;
  try {
    dir = home();
  } catch (e) {
    add("Bridge folder", "fail", errText(e), "Set TORBIT_BRIDGE_HOME to a folder you can write to.");
    return out;
  }
  const probe = join(dir, ".doctor");
  try {
    writeFileSync(probe, "x", { mode: 0o600 });
    rmSync(probe, { force: true });
    add("Bridge folder", "ok", dir);
  } catch (e) {
    add("Bridge folder", "fail", `${dir}: ${errText(e)}`, "Make the folder writable for this Windows user.");
  }

  let cfg: Config | undefined;
  try {
    cfg = readConfig();
  } catch (e) {
    add("Enrollment", "fail", errText(e), "Delete the damaged file and run: torbit-bridge setup --force");
    return out;
  }
  if (!cfg) {
    add("Enrollment", "fail", "this computer is not enrolled", "Run: torbit-bridge setup");
    return out;
  }
  add("Enrollment", "ok", `device ${cfg.device_id} delivers to ${cfg.address}`);

  try {
    assertServerURL(cfg.server);
  } catch (e) {
    add("Server URL", "fail", `${cfg.server}: ${errText(e)}`, "Enroll again with an https URL: torbit-bridge setup --force");
  }

  out.push(await checkKey(keys, cfg));
  out.push(...(await checkServer(http, cfg)));

  let st;
  try {
    st = readState();
  } catch (e) {
    add("State", "fail", errText(e), "Move state.json aside; the bridge starts a new record (mail may be sent again).");
    return out;
  }
  const items = Object.values(st.items);
  const skipped = items.filter((r) => r.outcome === "skipped").length;
  if (skipped > 0) {
    add("Delivery", "warn", `${skipped} item(s) skipped, ${st.pending.length} waiting to retry`,
      "Skipped items were rejected by Orbit (see bridge.log). After a device re-enrollment, run: torbit-bridge setup --force");
  } else if (st.pending.length > 0) {
    add("Delivery", "warn", `${st.pending.length} item(s) waiting to retry`, "Orbit was not reachable; the next sweep retries.");
  } else {
    add("Delivery", "ok", `no items waiting; ${items.length - skipped} delivered`);
  }
  const last = parseTime(st.last_run);
  if (last) {
    const age = Math.round((Date.now() - last.getTime()) / 1000);
    if (age > 30 * 60) add("Last run", "warn", `${fmtAge(age)} ago`, "The bridge is not running. Start it: torbit-bridge install (logon task) or torbit-bridge run");
    else add("Last run", "ok", `${fmtAge(age)} ago`);
  } else {
    add("Last run", "warn", "never", "Start the bridge: torbit-bridge install (logon task) or torbit-bridge run");
  }
  return out;
}

function fmtAge(sec: number): string {
  if (sec < 120) return `${sec}s`;
  if (sec < 7200) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec / 3600)}h`;
}

/** Whether `sig` (IEEE-P1363 r||s) is a valid signature of `message` under the base64 SPKI public key. */
export function verifyP1363(spkiBase64: string, message: Uint8Array, sig: Uint8Array): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki" });
    return sig.length === 64 && verify("sha256", message, { key, dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    return false;
  }
}

async function checkKey(keys: KeyStore, cfg: Config): Promise<Check> {
  const name = "Signing key";
  let spki: string;
  try {
    spki = await keys.publicKey(cfg.key_name, cfg.key_provider);
  } catch (e) {
    return { name, level: "fail", detail: `${cfg.key_name} (${cfg.key_provider}) is missing: ${errText(e)}`,
      hint: "The key lives in the Windows key store of the user who enrolled. Run as that user, or: torbit-bridge setup --force" };
  }
  let signer;
  try {
    signer = await keys.open(cfg.key_name, cfg.key_provider);
  } catch (e) {
    return { name, level: "fail", detail: "cannot open the key: " + errText(e), hint: "Run: torbit-bridge setup --force" };
  }
  try {
    const msg = Buffer.from("torbit-bridge doctor");
    const sig = await signer.sign(msg);
    if (sig.length !== 64) throw new Error("signature is not 64 bytes");
    if (!verifyP1363(spki, msg, sig)) {
      return { name, level: "fail", detail: "the key signs, but the signature does not verify against its public key", hint: "Run: torbit-bridge setup --force" };
    }
    return { name, level: "ok", detail: `${cfg.key_provider}, signs and verifies` };
  } catch (e) {
    return { name, level: "fail", detail: `cannot sign with the key: ${errText(e)}`, hint: "The TPM may be locked or reset. Run: torbit-bridge setup --force" };
  } finally {
    signer.close();
  }
}

/** Reaches the Orbit health endpoint and compares clocks: the server rejects signatures more than 300 seconds off. */
async function checkServer(http: Http, cfg: Config): Promise<Check[]> {
  const out: Check[] = [];
  const res = await http.do("GET", cfg.server.replace(/\/+$/, "") + "/health/live");
  if (res.status === 0) {
    return [{ name: "Orbit server", level: "fail", detail: `${cfg.server} is not reachable: ${errText(res.err)}`,
      hint: "Check the server URL, your network and proxy. The bridge uses HTTPS_PROXY or the manual Windows proxy (not PAC scripts)." }];
  }
  if (res.status !== 200) {
    out.push({ name: "Orbit server", level: "warn", detail: `${cfg.server} answered ${res.status} on /health/live`, hint: "Ask the Orbit administrator whether the service is healthy." });
  } else {
    out.push({ name: "Orbit server", level: "ok", detail: `${cfg.server} is reachable` });
  }
  if (res.date) {
    const skew = Math.round((Date.now() - res.date.getTime()) / 1000);
    const abs = Math.abs(skew);
    if (abs > 240) out.push({ name: "Clock", level: "fail", detail: `this PC is ${skew}s off from the server`, hint: "Orbit rejects deliveries more than 5 minutes off. Fix the Windows time settings (w32tm /resync)." });
    else if (abs > 90) out.push({ name: "Clock", level: "warn", detail: `this PC is ${skew}s off from the server`, hint: "Resync the Windows clock: w32tm /resync" });
    else out.push({ name: "Clock", level: "ok", detail: "within 90 seconds of the server" });
  }
  return out;
}
