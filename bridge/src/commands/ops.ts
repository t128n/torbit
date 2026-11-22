import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { enroll, revoke } from "../core/enroll.ts";
import { home, logf } from "../core/home.ts";
import { NOT_ENROLLED, readConfig } from "../core/state.ts";
import { Engine, getStatus } from "../core/sweep.ts";
import { errText } from "../core/util.ts";
import { CRED_FLAGS, fail, type FlagValues, intervalFlag, out, parseFlags, resolveCredential, ask } from "../cli.ts";
import { version } from "../version.ts";
import { hideConsole } from "../platform/windows/runlock.ts";
import { isWindows } from "../platform/index.ts";
import { queryTask } from "../platform/windows/scheduler.ts";
import { allChecks, printChecks } from "./checks.ts";
import type { Command, Ctx } from "./context.ts";

export const cmdVersion: Command = async (args) => {
  const v = parseFlags("version", { short: { type: "boolean", description: "print only the version number" } }, args);
  if (typeof v === "number") return v;
  out(v.short ? version : `torbit-bridge ${version} (${process.platform}/${process.arch})`);
  return 0;
};

export const cmdDoctor: Command = async (args, ctx) => {
  const v = parseFlags("doctor", {}, args);
  if (typeof v === "number") return v;
  out(`torbit-bridge ${version} on ${process.platform}/${process.arch}\n`);
  return printChecks(await allChecks(ctx, true));
};

export const cmdStatus: Command = async (args, { platform }) => {
  const v = parseFlags("status", {}, args);
  if (typeof v === "number") return v;
  const s = await getStatus(platform.keys());
  if (!s.enrolled) {
    out("Not enrolled. Run: torbit-bridge setup");
    return 0;
  }
  let task = "not installed";
  if (platform.supported) {
    const t = queryTask();
    if (t.installed) task = t.enabled ? "installed (runs at sign-in)" : "installed, disabled";
  } else task = "Windows only";
  out(`Device:    ${s.deviceId}\nServer:    ${s.server}\nAddress:   ${s.address}\nKey:       ${s.keyProvider} (${s.keyPresent ? "present" : "MISSING; enroll again"})\nLast run:  ${s.lastRun || "never"}`);
  out(`Delivered: ${s.delivered}   Skipped: ${s.skipped}   Waiting to retry: ${s.pending}\nLogon task: ${task}\nVersion:   ${version}`);
  return 0;
};

export const cmdLogs: Command = async (args) => {
  const v = parseFlags("logs", { n: { type: "string", arg: "lines", description: "number of lines (default 40)" } }, args);
  if (typeof v === "number") return v;
  const path = join(home(), "bridge.log");
  if (!existsSync(path)) return fail(`no log yet at ${path}`);
  const n = Math.max(1, Number(v.n ?? 40) || 40);
  out(readFileSync(path, "utf8").replace(/[\r\n]+$/, "").split("\n").slice(-n).join("\n"));
  return 0;
};

/** Enrolls this PC: asks for what is missing, makes the key, registers the public key. */
export async function doEnroll(ctx: Ctx, v: FlagValues) {
  const server = String(v.server ?? "") || (await ask("Orbit server URL (https://...)"));
  const workspaceId = String(v.workspace ?? "") || (await ask("Workspace id"));
  const credential = await resolveCredential(v, "Orbit session token (value of the __Host-orbit_session cookie)");
  return enroll(ctx.http, ctx.platform.keys(), { server, workspaceId, name: String(v.name ?? ""), credential, force: !!v.force });
}

export const ENROLL_FLAGS = {
  server: { type: "string", arg: "url", description: "Orbit server URL (https://...)" },
  workspace: { type: "string", arg: "id", description: "workspace id" },
  name: { type: "string", arg: "name", description: "device name (default: the computer name)" },
  ...CRED_FLAGS,
} as const;

export const cmdRevoke: Command = async (args, { http, platform }) => {
  const v = parseFlags("revoke", {
    "local-only": { type: "boolean", description: "only remove the local key and data (the device is already revoked in Orbit)" },
    ...CRED_FLAGS,
  }, args);
  if (typeof v === "number") return v;
  try {
    const cred = v["local-only"] ? undefined : await resolveCredential(v, "Orbit session token (value of the __Host-orbit_session cookie)");
    await revoke(http, platform.keys(), cred, !!v["local-only"]);
  } catch (e) {
    return fail(errText(e));
  }
  out("Device revoked. The local key, config and state are removed.");
  out("The logon task (if installed) keeps running but has nothing to deliver; remove it with: torbit-bridge uninstall");
  return 0;
};

async function loadEngine(ctx: Ctx): Promise<{ engine: Engine; close: () => void }> {
  const cfg = readConfig();
  if (!cfg) throw new Error(NOT_ENROLLED);
  let signer;
  try {
    signer = await ctx.platform.keys().open(cfg.key_name, cfg.key_provider);
  } catch (e) {
    throw new Error(`the device key is missing or unusable (${errText(e)}); run: torbit-bridge setup --force`);
  }
  let adapter;
  try {
    adapter = await ctx.platform.newOutlook();
  } catch (e) {
    signer.close();
    throw e;
  }
  return { engine: new Engine(ctx.http, cfg, signer, adapter), close: () => { adapter.close(); signer.close(); } };
}

function abortOnInterrupt(): AbortController {
  const ac = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(sig, () => ac.abort());
  return ac;
}

/** What the logon task runs. */
export const cmdRun: Command = async (args, ctx) => {
  const v = parseFlags("run", {
    interval: { type: "string", arg: "seconds", description: "time between sweeps (seconds or 1m30s; default 60)" },
    background: { type: "boolean", description: "detach from the console (used by the logon task)" },
  }, args);
  if (typeof v === "number") return v;
  let intervalMs: number;
  try {
    intervalMs = intervalFlag(v);
  } catch (e) {
    return fail(errText(e));
  }
  if (v.background && isWindows) hideConsole();

  const release = ctx.platform.runLock();
  if (!release) {
    const msg = "the bridge is already running for this Windows session";
    logf("run not started: " + msg);
    if (v.background) return 0; // nothing to retry: the running copy does the work
    return fail(msg);
  }
  let engine: Engine, close: () => void;
  try {
    ({ engine, close } = await loadEngine(ctx));
  } catch (e) {
    logf(`run could not start: ${errText(e)}`);
    release();
    return fail(errText(e));
  }
  const ac = abortOnInterrupt();
  logf(`run started (version ${version}, interval ${intervalMs / 1000}s, background ${!!v.background})`);
  try {
    await engine.run(intervalMs, ac.signal);
  } finally {
    logf("run stopped");
    close();
    release();
  }
  return 0;
};

export const cmdBackfill: Command = async (args, ctx) => {
  const v = parseFlags("backfill", { since: { type: "string", arg: "date", description: "deliver items received since this date (2026-01-01 or 2026-01-01T09:00)" } }, args);
  if (typeof v === "number") return v;
  if (!v.since) return fail("backfill needs a start date, for example: --since 2026-01-01");
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(String(v.since));
  const since = m ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0)) : undefined; // local time
  if (!since || Number.isNaN(since.getTime())) return fail(`cannot read the date "${v.since}"; use 2026-01-01 or 2026-01-01T09:00`);
  let loaded;
  try {
    loaded = await loadEngine(ctx);
  } catch (e) {
    return fail(errText(e));
  }
  const ac = abortOnInterrupt();
  try {
    const r = await loaded.engine.backfill(since, ac.signal);
    out(`Backfill: ${r.delivered} delivered, ${r.skipped} skipped (rejected by Orbit), ${r.pending} not delivered yet.`);
    if (r.pending > 0) out("Orbit was not reachable for some items. Run backfill again later; delivered items are not sent twice.");
    return 0;
  } catch (e) {
    return fail(errText(e));
  } finally {
    loaded.close();
  }
};
