import { existsSync } from "node:fs";
import { type Check, diagnose, worst } from "../core/doctor.ts";
import { installedExe } from "../core/home.ts";
import { compareVersions } from "../core/update.ts";
import { errText } from "../core/util.ts";
import { out } from "../cli.ts";
import { version } from "../version.ts";
import { McpError } from "../platform/mcp/client.ts";
import {
  healthURLFor,
  installedVersion,
  MCP_MIN_VERSION,
  MCP_NAME,
  MCP_TASK_NAME,
  meetsFloor,
  mcpPaths,
  readHealth,
  readMcpPort,
  readMcpToken,
} from "../platform/mcp/dependency.ts";
import { legacyServiceInstalled, queryNamedTask, queryTask, run, TASK_NAME } from "../platform/windows/scheduler.ts";
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
    if (e instanceof McpError && e.retryable) {
      return { name: "Outlook", level: "warn", detail: msg,
        hint: "Start classic Outlook, signed in, and minimize it (closing it stops automation). See docs/bridge.md (When Outlook automation is blocked)." };
    }
    return { name: "Outlook", level: "fail", detail: msg,
      hint: `Run "msoutlook-mcp doctor" for the COM-level cause. See docs/bridge.md (When Outlook automation is blocked).` };
  } finally {
    adapter?.close();
  }
}

/** The daemon the bridge reads Outlook through: installed, running, connected, recent enough, its task registered. */
export async function checkMsoutlookMcp(): Promise<Check[]> {
  const checks: Check[] = [];
  const paths = mcpPaths();
  const add = (name: string, level: Check["level"], detail: string, hint?: string) =>
    checks.push({ name, level, detail, ...(hint ? { hint } : {}) });

  const addTask = (): void => {
    if (process.platform !== "win32") return;
    const task = queryNamedTask(MCP_TASK_NAME);
    if (!task.installed) {
      add("mcp task", "warn", `"${MCP_TASK_NAME}" is not registered`,
        `${MCP_NAME} starts at sign-in through that task. Run: msoutlook-mcp install`);
    } else if (!task.enabled) {
      add("mcp task", "warn", `"${MCP_TASK_NAME}" is disabled`, "Enable it in Task Scheduler, or run: msoutlook-mcp install");
    } else {
      add("mcp task", "ok", `"${MCP_TASK_NAME}" runs at sign-in`);
    }
  };

  // When /health cannot tell us the version, the installed exe still can. The floor is required either way.
  const addInstalledVersion = (): string | undefined => {
    const installed = installedVersion(paths);
    if (installed === undefined) return undefined;
    if (!meetsFloor(installed)) {
      add("mcp version", "fail", `installed build ${installed} is older than the required ${MCP_MIN_VERSION}`,
        `Install ${MCP_NAME} ${MCP_MIN_VERSION} or later, then restart the daemon.`);
    } else {
      add("mcp version", "ok", `${installed} installed`);
    }
    return installed;
  };

  let port: number | undefined;
  try {
    port = readMcpPort(paths.configFile);
  } catch (e) {
    add(MCP_NAME, "fail", errText(e), `Run: msoutlook-mcp setup (config: ${paths.configFile})`);
    addInstalledVersion();
    addTask();
    return checks;
  }
  if (port === undefined) {
    add(MCP_NAME, "fail", `not installed or not set up (${paths.configFile} is missing)`,
      `Install ${MCP_NAME} ${MCP_MIN_VERSION} or later, run "msoutlook-mcp setup" (keep sending off), then "msoutlook-mcp install".`);
    addInstalledVersion();
    addTask();
    return checks;
  }
  add(MCP_NAME, "ok", `configured on 127.0.0.1:${port} (${paths.configFile})`);

  let token: string | undefined;
  try {
    token = readMcpToken(paths.tokenFile);
  } catch {
    token = undefined;
  }
  if (!token) {
    add("mcp token", "fail", `${paths.tokenFile} is missing or empty`,
      `Run: msoutlook-mcp setup --rotate-token, then msoutlook-mcp install.`);
    addInstalledVersion();
    addTask();
    return checks;
  }
  add("mcp token", "ok", "readable");

  const health = await readHealth({ healthURL: healthURLFor(port) }, { timeoutMs: 4_000 });
  if (!health.reachable) {
    add("mcp daemon", "fail", `not answering on ${healthURLFor(port)}`,
      `Start it: msoutlook-mcp install (or run msoutlook-mcp serve in a terminal). The bridge cannot read Outlook until it runs.`);
    addInstalledVersion();
    addTask();
    return checks;
  }
  add("mcp daemon", "ok", `answering on 127.0.0.1:${port}`);

  if (health.version === undefined) {
    const installed = addInstalledVersion();
    if (!installed) {
      add("mcp version", "fail", "the daemon did not report its version, so the required 0.2.0 cannot be verified",
        `Install ${MCP_NAME} ${MCP_MIN_VERSION} or later and restart its daemon.`);
    }
  } else if (!meetsFloor(health.version)) {
    add("mcp version", "fail", `${health.version} is older than the required ${MCP_MIN_VERSION}`,
      `The tools the bridge uses do not exist in this build. Install ${MCP_NAME} ${MCP_MIN_VERSION} or later, then restart the daemon.`);
  } else {
    add("mcp version", "ok", health.version);
  }

  if (health.status === "connected") {
    add("mcp Outlook", "ok", "connected");
  } else if (health.status === "waiting_for_outlook") {
    add("mcp Outlook", "warn", "waiting for Outlook (closed or starting)",
      "Start classic Outlook, signed in, and minimize it. Do not close it; the daemon reconnects on its own.");
  } else {
    add("mcp Outlook", "fail", health.error ?? `state "${health.status}"`,
      `Run: msoutlook-mcp doctor, and fix the Outlook problem it reports.`);
  }

  const runningInstalled = installedVersion(paths);
  if (runningInstalled && health.version && compareVersions(runningInstalled, health.version) !== 0) {
    add("mcp build", "warn", `the daemon runs ${health.version} but ${runningInstalled} is installed`,
      "Restart it so both match: msoutlook-mcp install");
  }

  addTask();
  return checks;
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
  checks.push(...(await checkMsoutlookMcp()));
  if (includeOutlook) checks.push(await checkOutlook(ctx));
  return [...checks, ...checkTask(ctx)];
}
