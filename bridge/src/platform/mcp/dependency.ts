import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareVersions } from "../../core/update.ts";
import { errText, sleep } from "../../core/util.ts";
import { queryNamedTask, run, startNamedTask } from "../windows/scheduler.ts";
import type { McpFetch } from "./client.ts";

/** The daemon the bridge drives classic Outlook through. */
export const MCP_NAME = "msoutlook-mcp";
/** v0.2.0 added transport headers, Content-ID/MIME type and attachment bytes. */
export const MCP_MIN_VERSION = "0.2.0";
/** The daemon's own logon task; the bridge never removes it. */
export const MCP_TASK_NAME = "MSOutlook MCP";

export interface McpPaths {
  home: string;
  configDir: string;
  stateDir: string;
  configFile: string;
  tokenFile: string;
  installDir: string;
  installedExe: string;
}

const first = (...values: (string | undefined)[]): string | undefined =>
  values.find((v) => v !== undefined && v !== "");

/**
 * The daemon's own files. Windows keeps everything under %LOCALAPPDATA%\msoutlook-mcp;
 * elsewhere config and state follow XDG. MSOUTLOOK_MCP_HOME overrides both with one directory.
 */
export function mcpPaths(env: Record<string, string | undefined> = process.env, platform = process.platform): McpPaths {
  const override = first(env.MSOUTLOOK_MCP_HOME);
  let home: string;
  let configDir: string;
  let stateDir: string;

  if (platform === "win32") {
    home = override ?? join(first(env.LOCALAPPDATA, env.APPDATA, homedir())!, MCP_NAME);
    configDir = home;
    stateDir = home;
  } else if (override) {
    home = override;
    configDir = override;
    stateDir = override;
  } else {
    const configBase = first(env.XDG_CONFIG_HOME, join(homedir(), ".config"))!;
    const stateBase = first(env.XDG_STATE_HOME, join(homedir(), ".local", "state"))!;
    configDir = join(configBase, MCP_NAME);
    stateDir = join(stateBase, MCP_NAME);
    home = configDir;
  }

  const installDir = platform === "win32" ? home : join(stateDir, "install");
  return {
    home,
    configDir,
    stateDir,
    configFile: join(configDir, "config.json"),
    tokenFile: join(configDir, "token"),
    installDir,
    installedExe: join(installDir, platform === "win32" ? `${MCP_NAME}.exe` : MCP_NAME),
  };
}

export interface McpSettings {
  paths: McpPaths;
  port: number;
  token: string;
  mcpURL: string;
  healthURL: string;
}

export const healthURLFor = (port: number): string => `http://127.0.0.1:${port}/health`;

const asPort = (value: unknown): number | undefined => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 65_535 ? n : undefined;
};

/** The `port` from the daemon's config.json, or undefined when it has not been set up. */
export function readMcpPort(configFile: string): number | undefined {
  if (!existsSync(configFile)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configFile, "utf8"));
  } catch (e) {
    throw new Error(`${configFile} is not valid JSON: ${errText(e)}. Run: msoutlook-mcp setup`);
  }
  const config = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const port = asPort(config.port);
  if (port === undefined) throw new Error(`${configFile} has no usable "port". Run: msoutlook-mcp setup`);
  return port;
}

export function readMcpToken(tokenFile: string): string | undefined {
  if (!existsSync(tokenFile)) return undefined;
  const token = readFileSync(tokenFile, "utf8").replace(/^\uFEFF/, "").trim();
  return token || undefined;
}

/** Port and token for a configured daemon; a clear install hint when either is missing. */
export function readMcpSettings(
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
): McpSettings {
  const paths = mcpPaths(env, platform);
  const port = readMcpPort(paths.configFile);
  if (port === undefined) {
    throw new Error(
      `${MCP_NAME} is not installed or has not been set up yet (${paths.configFile} is missing). ` +
        `Install ${MCP_NAME} ${MCP_MIN_VERSION} or later, run "msoutlook-mcp setup" (keep sending off) and ` +
        `"msoutlook-mcp install", then try again.`,
    );
  }
  const token = readMcpToken(paths.tokenFile);
  if (!token) {
    throw new Error(
      `${MCP_NAME} has no access token at ${paths.tokenFile}. Run "msoutlook-mcp setup" (or setup --rotate-token), ` +
        `then "msoutlook-mcp install".`,
    );
  }
  const origin = `http://127.0.0.1:${port}`;
  return { paths, port, token, mcpURL: `${origin}/mcp`, healthURL: healthURLFor(port) };
}

export interface McpHealth {
  reachable: boolean;
  status: "connected" | "waiting_for_outlook" | "error" | "unknown";
  version?: string;
  error?: string;
}

/** GET /health. Never throws: an unreachable daemon is a state the caller reports. */
export async function readHealth(
  settings: { healthURL: string },
  opts: { fetch?: McpFetch; timeoutMs?: number } = {},
): Promise<McpHealth> {
  const fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
  let res: Response;
  try {
    res = await fetchFn(settings.healthURL, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000) });
  } catch (e) {
    return { reachable: false, status: "unknown", error: errText(e) };
  }
  if (!res.ok) {
    return { reachable: true, status: "unknown", error: `/health answered HTTP ${res.status}` };
  }
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch (e) {
    return { reachable: true, status: "unknown", error: ` /health is not JSON: ${errText(e)}` };
  }
  const rawStatus = typeof body.status === "string" ? body.status : "unknown";
  const status =
    rawStatus === "connected" || rawStatus === "waiting_for_outlook" || rawStatus === "error" ? rawStatus : "unknown";
  const outlook = body.outlook && typeof body.outlook === "object" ? (body.outlook as Record<string, unknown>) : {};
  return {
    reachable: true,
    status,
    version: typeof body.version === "string" ? body.version : undefined,
    error: typeof outlook.error === "string" ? outlook.error : undefined,
  };
}

/** The version of the installed exe (not necessarily the running daemon), when it can be run. */
export function installedVersion(paths: McpPaths): string | undefined {
  if (!existsSync(paths.installedExe)) return undefined;
  const r = run([paths.installedExe, "version"]);
  const text = r.out.trim();
  return r.code === 0 && /^\d+\.\d+\.\d+/.test(text) ? text.split(/\s+/)[0] : undefined;
}

export const meetsFloor = (version: string | undefined): boolean =>
  !!version && compareVersions(version, MCP_MIN_VERSION) >= 0;

export function taskInstalled(): boolean {
  return process.platform === "win32" && queryNamedTask(MCP_TASK_NAME).installed;
}

function startTask(): void {
  startNamedTask(MCP_TASK_NAME);
}

function installTask(paths: McpPaths): void {
  const r = run([paths.installedExe, "install"]);
  if (r.code !== 0) throw new Error(`${MCP_NAME} install failed: ${(r.err || r.out).trim() || `exit ${r.code}`}`);
}

export interface DependencyState {
  ok: boolean;
  message: string;
  settings?: McpSettings;
  health?: McpHealth;
}

/**
 * Makes sure the dependency is configured and its daemon answers. It may start the daemon's
 * logon task (or register it when its exe is installed), but it never runs `setup` and never
 * changes sending or the allowlist.
 */
export async function ensureDependencyDaemon(opts: { fetch?: McpFetch } = {}): Promise<DependencyState> {
  let settings: McpSettings;
  try {
    settings = readMcpSettings();
  } catch (e) {
    return { ok: false, message: errText(e) };
  }

  let health = await readHealth(settings, { fetch: opts.fetch });
  if (!health.reachable) {
    // The dependency is installed: start the daemon the way its login task does, or register it once.
    try {
      if (taskInstalled()) startTask();
      else if (existsSync(settings.paths.installedExe)) installTask(settings.paths);
    } catch {
      /* reported below with the same fix */
    }
    for (let i = 0; i < 6 && !health.reachable; i++) {
      await sleep(500);
      health = await readHealth(settings, { fetch: opts.fetch });
    }
  }

  if (!health.reachable) {
    return {
      ok: false,
      settings,
      health,
      message:
        `${MCP_NAME} is set up but its daemon is not answering on http://127.0.0.1:${settings.port}/health. ` +
        `Start it (msoutlook-mcp install, or run msoutlook-mcp serve in a terminal), then try again.`,
    };
  }

  if (health.status === "error") {
    return {
      ok: false,
      settings,
      health,
      message:
        `${MCP_NAME} is running but cannot use Outlook: ${health.error ?? "unknown error"}. ` +
        `Run "msoutlook-mcp doctor" and fix what it reports.`,
    };
  }

  if (health.status === "unknown") {
    return {
      ok: false,
      settings,
      health,
      message:
        `${MCP_NAME} answered ${settings.healthURL} but its state is unreadable: ${health.error ?? "no status"}. ` +
        `Run "msoutlook-mcp doctor" and make sure the daemon is ${MCP_MIN_VERSION} or later.`,
    };
  }

  // The daemon reports its version in a current build. Fall back to the installed exe so an
  // unversioned /health cannot bypass the floor.
  const version = health.version ?? installedVersion(settings.paths);
  if (version === undefined) {
    return {
      ok: false,
      settings,
      health,
      message:
        `${MCP_NAME} did not report its version, and the bridge needs ${MCP_MIN_VERSION} or later. ` +
        `Install ${MCP_MIN_VERSION}+ and restart its daemon.`,
    };
  }
  if (!meetsFloor(version)) {
    return {
      ok: false,
      settings,
      health,
      message:
        `${MCP_NAME} ${version} is too old; the bridge needs ${MCP_MIN_VERSION} or later (the tools it uses ` +
        `are missing, not broken). Install a newer ${MCP_NAME} build, then restart its daemon.`,
    };
  }

  const state = health.status === "connected" ? "connected to Outlook" : "waiting for Outlook (closed or starting)";
  return {
    ok: true,
    settings,
    health,
    message: `${MCP_NAME} ${version} is running on 127.0.0.1:${settings.port}; ${state}.`,
  };
}

export interface TaskState {
  ok: boolean;
  message: string;
}

/**
 * Registers the dependency's logon task when it is missing (its exe is installed), and checks it
 * is enabled. `install` calls this as well as ours; the daemon may have been started by hand.
 */
export function ensureDependencyTask(): TaskState {
  if (process.platform !== "win32") return { ok: true, message: `${MCP_NAME} logon task is Windows only.` };
  const paths = mcpPaths();
  if (!taskInstalled()) {
    if (!existsSync(paths.installedExe)) {
      return {
        ok: false,
        message:
          `The "${MCP_TASK_NAME}" logon task is not registered and ${paths.installedExe} was not found. ` +
          `Run "msoutlook-mcp install" first.`,
      };
    }
    try {
      installTask(paths);
    } catch (e) {
      return { ok: false, message: errText(e) };
    }
  }
  const task = queryNamedTask(MCP_TASK_NAME);
  if (!task.installed) {
    return { ok: false, message: `The "${MCP_TASK_NAME}" logon task is not registered. Run: msoutlook-mcp install` };
  }
  if (!task.enabled) {
    return {
      ok: false,
      message: `The "${MCP_TASK_NAME}" logon task is disabled. Enable it in Task Scheduler, or run: msoutlook-mcp install`,
    };
  }
  return { ok: true, message: `The "${MCP_TASK_NAME}" logon task is registered and enabled.` };
}

/** One line for `upgrade` and `setup`; the bridge never changes the dependency itself. */
export function describeDependency(settings: McpSettings, health: McpHealth): string {
  if (!health.reachable) return `${MCP_NAME}: not running on 127.0.0.1:${settings.port} (this command does not change it).`;
  const version = health.version ?? installedVersion(settings.paths);
  if (!version) {
    return (
      `Warning: ${MCP_NAME} did not report its version; the bridge requires ${MCP_MIN_VERSION} or later. ` +
      `Install a newer release; torbit-bridge upgrade never upgrades ${MCP_NAME}.`
    );
  }
  if (!meetsFloor(version)) {
    return (
      `Warning: ${MCP_NAME} ${version} is older than the required ${MCP_MIN_VERSION}. ` +
      `Install a newer release first; torbit-bridge upgrade never upgrades ${MCP_NAME}.`
    );
  }
  const installed = installedVersion(settings.paths);
  if (installed && health.version && compareVersions(installed, health.version) !== 0) {
    return (
      `Warning: the ${MCP_NAME} daemon runs ${health.version} but ${installed} is installed. ` +
      `Restart it so both match: msoutlook-mcp install.`
    );
  }
  return `${MCP_NAME} ${version} is running (required >= ${MCP_MIN_VERSION}); this command does not upgrade it.`;
}
