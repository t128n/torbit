import { existsSync, mkdirSync, readFileSync, realpathSync, mkdtempSync, rmSync, rmdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revoke } from "../core/enroll.ts";
import { installDir, installedExe } from "../core/home.ts";
import { readConfig } from "../core/state.ts";
import { compareVersions, assetName, latestRelease, releaseAsset, releaseVersion, verifySums } from "../core/update.ts";
import { errText } from "../core/util.ts";
import { fail, type FlagValues, intervalFlag, out, parseFlags } from "../cli.ts";
import { isCompiled, isWindows } from "../platform/index.ts";
import { removeFile, replaceFile } from "../platform/files.ts";
import { createTask, currentUser, deleteTask, legacyServiceInstalled, queryTask, run, startTask, stopTask, TASK_NAME } from "../platform/windows/scheduler.ts";
import { version } from "../version.ts";
import { allChecks, checkOutlook, printChecks } from "./checks.ts";
import type { Command, Ctx } from "./context.ts";
import { doEnroll, ENROLL_FLAGS } from "./ops.ts";

const REPO = "t128n/torbit";
const WINDOWS_ONLY = "the logon task is only available on Windows";

const samePath = (a: string, b: string): boolean => {
  try {
    return realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
};

const INTERVAL_FLAG = { interval: { type: "string", arg: "seconds", description: "time between sweeps (seconds or 1m30s; default 60)" } } as const;

function legacyNote(): void {
  if (legacyServiceInstalled()) {
    out(`Note: the Windows service "TorbitBridge" from the Go version is still installed. Remove it from an administrator prompt:`);
    out("  sc.exe stop TorbitBridge & sc.exe delete TorbitBridge");
  }
}

/** Copies this exe to the per-user folder and registers the logon task. No administrator rights are needed. */
function installTask(v: FlagValues): number {
  if (!isWindows) return fail(WINDOWS_ONLY);
  if (!isCompiled()) return fail("install copies torbit-bridge.exe; run it from the built executable, not from bun");
  let intervalMs: number;
  try {
    intervalMs = intervalFlag(v);
  } catch (e) {
    return fail(errText(e));
  }
  const dest = installedExe();
  try {
    mkdirSync(installDir(), { recursive: true });
    stopTask(); // a running worker would keep its exe locked
    if (!samePath(process.execPath, dest)) {
      replaceFile(dest, readFileSync(process.execPath));
      out("Copied the program to " + dest);
    }
    createTask({ exe: dest, args: `run --background --interval ${Math.round(intervalMs / 1000)}`, user: currentUser(), workDir: installDir() });
  } catch (e) {
    return fail(errText(e));
  }
  out(`Registered the logon task "${TASK_NAME}" for ${currentUser()} (starts at sign-in, no administrator rights needed).`);
  legacyNote();
  if (v["no-start"]) {
    out("Not started (--no-start). Start it with: torbit-bridge start");
    return 0;
  }
  try {
    startTask();
  } catch (e) {
    return fail(`installed, but the task did not start: ${errText(e)} (try: torbit-bridge start)`);
  }
  out("Started. The bridge now runs in the background and again at every sign-in.");
  return 0;
}

export const cmdInstall: Command = async (args) => {
  const v = parseFlags("install", { ...INTERVAL_FLAG, "no-start": { type: "boolean", description: "register the task but do not start it now" } }, args);
  return typeof v === "number" ? v : installTask(v);
};

export const cmdUninstall: Command = async (args, { http, platform }) => {
  const v = parseFlags("uninstall", { purge: { type: "boolean", description: "also delete the device key, config and state on this PC (does not revoke it in Orbit)" } }, args);
  if (typeof v === "number") return v;
  if (!isWindows) return fail(WINDOWS_ONLY);
  try {
    stopTask();
    if (queryTask().installed) {
      deleteTask();
      out(`Removed the logon task "${TASK_NAME}".`);
    } else {
      out("The logon task was not installed.");
    }
    const exe = installedExe();
    if (removeFile(exe) === "deferred") out("The running program is removed a moment after it exits.");
    try {
      if (existsSync(installDir()) && readdirSync(installDir()).length === 0) rmdirSync(installDir());
    } catch {
      /* not empty yet: the deferred delete is still pending */
    }
  } catch (e) {
    return fail(errText(e));
  }
  legacyNote();
  if (v.purge) {
    try {
      await revoke(http, platform.keys(), undefined, true);
      out("Local device key, config and state removed. Revoke the device in Orbit as well (torbit-bridge revoke needs it enrolled), or remove it in the Orbit admin UI.");
    } catch (e) {
      if (errText(e) !== "this computer is not enrolled") return fail(errText(e));
      out("Nothing to purge: this PC is not enrolled.");
    }
    return 0;
  }
  out("The device stays enrolled. Re-install with: torbit-bridge install. To remove it too: torbit-bridge revoke");
  return 0;
};

export const cmdStart: Command = async (args) => {
  const v = parseFlags("start", {}, args);
  if (typeof v === "number") return v;
  if (!isWindows) return fail(WINDOWS_ONLY);
  if (!queryTask().installed) return fail("the logon task is not installed; run: torbit-bridge install");
  try {
    startTask();
  } catch (e) {
    return fail(errText(e));
  }
  out("Started.");
  return 0;
};

export const cmdStop: Command = async (args) => {
  const v = parseFlags("stop", {}, args);
  if (typeof v === "number") return v;
  if (!isWindows) return fail(WINDOWS_ONLY);
  stopTask();
  out("Stopped. It starts again at the next sign-in, or with: torbit-bridge start");
  return 0;
};

export const cmdUpgrade: Command = async (args, { http, platform }) => {
  const v = parseFlags("upgrade", {
    check: { type: "boolean", description: "only report whether a newer release exists" },
    version: { type: "string", arg: "version", description: "install this version instead of the latest (also allows a downgrade)" },
    repo: { type: "string", arg: "owner/name", description: `GitHub repository that publishes the releases (default ${REPO})` },
  }, args);
  if (typeof v === "number") return v;
  if (!isWindows) return fail(`upgrade replaces the Windows binary; build from source on ${process.platform}`);
  const repo = String(v.repo ?? REPO);
  const want = String(v.version ?? "");

  let rel;
  try {
    rel = await latestRelease(http, repo, want);
  } catch (e) {
    return fail(errText(e));
  }
  const latest = releaseVersion(rel);
  out(`Installed: ${version}   Release: ${latest}`);
  if (!want && compareVersions(version, latest) >= 0) {
    out("Already up to date.");
    return 0;
  }
  if (v.check) {
    out(`A newer release is available: ${latest}. Run: torbit-bridge upgrade`);
    return 0;
  }
  if (!isCompiled()) return fail("upgrade replaces torbit-bridge.exe; run it from the built executable, not from bun");

  const asset = assetName(latest);
  const exeUrl = releaseAsset(rel, asset);
  const sumsUrl = releaseAsset(rel, "SHA256SUMS");
  if (!exeUrl || !sumsUrl) return fail(`release ${rel.tag_name} has no ${asset} or SHA256SUMS`);

  let data: Uint8Array;
  try {
    out("Downloading " + asset);
    data = await http.download(exeUrl);
    verifySums(Buffer.from(await http.download(sumsUrl)).toString("utf8"), asset, data);
  } catch (e) {
    return fail(errText(e));
  }
  out("Checksum verified.");

  // Run the download once before it replaces anything: a wrong-architecture or damaged file must not take the working bridge down.
  const dir = mkdtempSync(join(tmpdir(), "torbit-bridge-upgrade-"));
  try {
    const probe = join(dir, "torbit-bridge.exe");
    writeFileSync(probe, data, { mode: 0o755 });
    const r = run([probe, "version", "--short"]);
    if (r.code !== 0 || r.out.trim() !== latest) {
      return fail(`the downloaded file does not run or reports another version ("${r.out.trim()}"); nothing was changed`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const dest = installedExe();
  const task = queryTask();
  const lock = platform.runLock(); // held by a running worker
  lock?.();
  const wasRunning = task.installed && !lock;
  try {
    if (task.installed) {
      out("Stopping the bridge...");
      stopTask();
    }
    if (existsSync(dest)) {
      replaceFile(dest, data);
      out("Replaced " + dest);
    }
    if (!samePath(process.execPath, dest)) {
      try {
        replaceFile(process.execPath, data); // this copy too, so the next `torbit-bridge ...` from the same folder is new
        out("Replaced " + process.execPath);
      } catch (e) {
        out(`Could not update this copy (${process.execPath}): ${errText(e)}`);
      }
    }
  } catch (e) {
    if (wasRunning) try { startTask(); } catch { /* reported below */ }
    return fail(`could not replace ${dest}: ${errText(e)}`);
  }
  if (task.installed && task.enabled && wasRunning) {
    try {
      startTask();
      out("Started.");
    } catch (e) {
      return fail(`updated, but the task did not start: ${errText(e)} (try: torbit-bridge start)`);
    }
  }
  out(`Upgraded to ${latest}. Check with: torbit-bridge doctor`);
  return 0;
};

export const cmdSetup: Command = async (args, ctx) => {
  const v = parseFlags("setup", {
    ...ENROLL_FLAGS,
    force: { type: "boolean", description: "enroll again even if this PC is enrolled" },
    "no-task": { type: "boolean", description: "do not register the logon task" },
    ...INTERVAL_FLAG,
  }, args);
  if (typeof v === "number") return v;
  try {
    intervalFlag(v);
  } catch (e) {
    return fail(errText(e));
  }
  out("torbit-bridge setup");

  out("\n[1/3] Enroll this PC");
  try {
    const existing = readConfig();
    if (existing && !v.force) {
      out(`Already enrolled as device ${existing.device_id} (${existing.address}). Use --force to enroll again.`);
    } else {
      const cfg = await doEnroll(ctx, v);
      out(`Enrolled. Device ${cfg.device_id} delivers to ${cfg.address} (key: ${cfg.key_provider}).`);
    }
  } catch (e) {
    return fail(errText(e));
  }

  out("\n[2/3] Check Outlook");
  const oc = await checkOutlook(ctx);
  out(`${oc.level}: ${oc.detail}`);
  if (oc.hint) out("  -> " + oc.hint);

  out("\n[3/3] Logon task");
  if (v["no-task"]) {
    out("Skipped (--no-task). Run in a terminal with: torbit-bridge run");
  } else if (!ctx.platform.supported) {
    out("Skipped: the logon task is only available on Windows.");
  } else if (installTask(v) !== 0) {
    out("The task was not installed. Enrollment is kept; retry with: torbit-bridge install");
    return 1;
  }

  out("\nSummary");
  return printChecks(await allChecks(ctx, false));
};
