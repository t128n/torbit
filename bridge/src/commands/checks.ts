import { existsSync } from "node:fs";
import { type Check, diagnose, worst } from "../core/doctor.ts";
import { installedExe } from "../core/home.ts";
import { errText } from "../core/util.ts";
import { out } from "../cli.ts";
import { version } from "../version.ts";
import { legacyServiceInstalled, queryTask, run, TASK_NAME } from "../platform/windows/scheduler.ts";
import type { Ctx } from "./context.ts";

export async function checkOutlook({ platform }: Ctx): Promise<Check> {
  if (!platform.supported) return { name: "Outlook", level: "warn", detail: "not checked (Outlook automation is Windows only)" };
  let adapter;
  try {
    adapter = await platform.newOutlook({ timeoutMs: 60_000 });
    const items = await adapter.list(new Date(Date.now() - 24 * 3600_000));
    return { name: "Outlook", level: "ok", detail: `classic Outlook answered; ${items.length} inbox item(s) in the last 24 hours` };
  } catch (e) {
    const msg = errText(e);
    if (msg.includes("did not answer in time")) {
      return { name: "Outlook", level: "warn", detail: "Outlook did not answer in 60 seconds", hint: "A dialog in Outlook may be waiting for an answer (profile, sign-in or a security prompt)." };
    }
    return { name: "Outlook", level: "fail", detail: msg,
      hint: "Start classic Outlook, signed in, as the same non-elevated user that runs the bridge. See docs/bridge.md (Outlook automation blocked)." };
  } finally {
    adapter?.close();
  }
}

/** The logon task: registered, enabled, pointing at an installed copy of this version, and running. */
export function checkTask({ platform }: Ctx): Check[] {
  if (!platform.supported) return [];
  const out: Check[] = [];
  const task = queryTask();
  if (!task.installed) {
    out.push({ name: "Logon task", level: "warn", detail: "not installed", hint: "Install it so the bridge starts when you sign in: torbit-bridge install" });
  } else {
    const c: Check = { name: "Logon task", level: "ok", detail: `"${TASK_NAME}" runs at sign-in` };
    if (!task.enabled) {
      c.level = "warn";
      c.detail = `"${TASK_NAME}" is disabled`;
      c.hint = "Enable it in Task Scheduler, or run: torbit-bridge install";
    }
    out.push(c);

    const exe = installedExe();
    if (!existsSync(exe)) {
      out.push({ name: "Task binary", level: "fail", detail: exe + " is missing", hint: "Run: torbit-bridge install" });
    } else {
      const r = run([exe, "version", "--short"]);
      const got = r.out.trim();
      if (r.code !== 0) out.push({ name: "Task binary", level: "fail", detail: `${exe} does not run: ${r.err.trim()}`, hint: "Run: torbit-bridge install" });
      else if (got !== version) out.push({ name: "Task binary", level: "warn", detail: `installed version ${got}, this is ${version}`, hint: "Update the installed copy: torbit-bridge install (or torbit-bridge upgrade)" });
      else out.push({ name: "Task binary", level: "ok", detail: `${exe} (${got})` });
    }

    const release = platform.runLock();
    if (release) {
      release();
      out.push({ name: "Worker", level: "warn", detail: "not running right now", hint: "Start it: torbit-bridge start (it also starts at every sign-in)" });
    } else {
      out.push({ name: "Worker", level: "ok", detail: "running" });
    }
  }
  if (legacyServiceInstalled()) {
    out.push({ name: "Old service", level: "warn", detail: `the Windows service "TorbitBridge" from the Go version is still installed`,
      hint: "Remove it from an administrator prompt: sc.exe stop TorbitBridge & sc.exe delete TorbitBridge" });
  }
  return out;
}

export function printChecks(checks: Check[]): number {
  const marks = { ok: "[ ok ]", warn: "[warn]", fail: "[FAIL]" } as const;
  for (const c of checks) {
    out(`${marks[c.level]} ${c.name.padEnd(14)} ${c.detail}`);
    if (c.level !== "ok" && c.hint) out(`       ${"".padEnd(14)} -> ${c.hint}`);
  }
  out();
  switch (worst(checks)) {
    case "ok":
      out("Everything looks good.");
      return 0;
    case "warn":
      out("Works, with warnings.");
      return 0;
  }
  out("Problems found. Fix the failures above, then run doctor again.");
  return 1;
}

export async function allChecks(ctx: Ctx, includeOutlook: boolean): Promise<Check[]> {
  const checks = await diagnose(ctx.http, ctx.platform.keys());
  if (includeOutlook) checks.push(await checkOutlook(ctx));
  return [...checks, ...checkTask(ctx)];
}
