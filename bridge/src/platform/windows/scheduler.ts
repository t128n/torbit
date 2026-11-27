import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The per-user logon task that keeps `torbit-bridge run` going. Task Scheduler is used through schtasks.exe. */
export const TASK_NAME = "Torbit Bridge";

/** The Windows service the Go bridge registered. It is gone from this version; `install` and `doctor` point at it. */
export const LEGACY_SERVICE = "TorbitBridge";

export interface Proc { code: number; out: string; err: string }

export function run(cmd: string[]): Proc {
  try {
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", windowsHide: true });
    return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
  } catch (e) {
    return { code: 1, out: "", err: (e as Error).message };
  }
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** DOMAIN\name of the signed-in user. */
export function currentUser(): string {
  const dom = process.env.USERDOMAIN;
  const name = process.env.USERNAME;
  if (dom && name) return `${dom}\\${name}`;
  const r = run(["whoami.exe"]);
  if (r.code === 0 && r.out.trim()) return r.out.trim();
  throw new Error("cannot tell which Windows user this is");
}

export interface TaskSpec { exe: string; args: string; user: string; workDir: string }

/** The task definition: at logon of this user, run in the user's session without elevation, no time limit, one instance. */
export function taskXml(s: TaskSpec): string {
  const user = xmlEscape(s.user);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Delivers mail from classic Outlook to Torbit/Orbit while ${user} is signed in.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${user}</UserId>
      <Delay>PT15S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(s.exe)}</Command>
      <Arguments>${xmlEscape(s.args)}</Arguments>
      <WorkingDirectory>${xmlEscape(s.workDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** Registers (or replaces) the logon task. Needs no administrator rights: the task is for the current user only. */
export function createTask(s: TaskSpec): void {
  const file = join(tmpdir(), `torbit-bridge-task-${process.pid}.xml`);
  // schtasks reads UTF-16 with a byte order mark.
  writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(s), "utf16le")]));
  try {
    const r = run(["schtasks.exe", "/Create", "/TN", TASK_NAME, "/XML", file, "/F"]);
    if (r.code !== 0) throw new Error(`schtasks could not register the task: ${(r.err || r.out).trim()}`);
  } finally {
    rmSync(file, { force: true });
  }
}

export interface TaskInfo { installed: boolean; enabled: boolean; command: string; arguments: string }

export function queryNamedTask(name: string): TaskInfo {
  const r = run(["schtasks.exe", "/Query", "/TN", name, "/XML"]);
  if (r.code !== 0) return { installed: false, enabled: false, command: "", arguments: "" };
  const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(r.out)?.[1]?.trim() ?? "";
  const settings = /<Settings>[\s\S]*?<\/Settings>/.exec(r.out)?.[0] ?? "";
  const enabled = !/<Enabled>\s*false\s*<\/Enabled>/i.test(settings);
  return { installed: true, enabled, command: tag("Command"), arguments: tag("Arguments") };
}

export const queryTask = (): TaskInfo => queryNamedTask(TASK_NAME);

export function deleteTask(): void {
  const r = run(["schtasks.exe", "/Delete", "/TN", TASK_NAME, "/F"]);
  if (r.code !== 0) throw new Error(`schtasks could not remove the task: ${(r.err || r.out).trim()}`);
}

export function startNamedTask(name: string): void {
  const r = run(["schtasks.exe", "/Run", "/TN", name]);
  if (r.code !== 0) throw new Error(`schtasks could not start "${name}": ${(r.err || r.out).trim()}`);
}

export function startTask(): void {
  startNamedTask(TASK_NAME);
}

/** Ends the running instance. A task that is not running is not an error. */
export function stopTask(): void {
  run(["schtasks.exe", "/End", "/TN", TASK_NAME]);
}

export function legacyServiceInstalled(): boolean {
  return run(["sc.exe", "query", LEGACY_SERVICE]).code === 0;
}
