// torbit-bridge delivers mail from classic desktop Outlook to Torbit/Orbit.
// It runs on a user's Windows PC, from a per-user Task Scheduler logon task or in the foreground.
import { err, out } from "./cli.ts";
import { type Command, createContext } from "./commands/context.ts";
import { cmdInstall, cmdSetup, cmdStart, cmdStop, cmdUninstall, cmdUpgrade } from "./commands/lifecycle.ts";
import { cmdBackfill, cmdDoctor, cmdLogs, cmdRevoke, cmdRun, cmdStatus, cmdVersion } from "./commands/ops.ts";
import { version } from "./version.ts";

const commands: { name: string; summary: string; run: Command }[] = [
  { name: "setup", summary: "Guided first-time setup: enroll this PC, check Outlook, install the logon task", run: cmdSetup },
  { name: "doctor", summary: "Check enrollment, key, Outlook, Orbit, clock and the logon task; say how to fix problems", run: cmdDoctor },
  { name: "install", summary: "Register the logon task that runs the bridge in the background and start it", run: cmdInstall },
  { name: "uninstall", summary: "Remove the logon task and the installed copy (--purge also removes the device key)", run: cmdUninstall },
  { name: "upgrade", summary: "Update torbit-bridge (and the installed copy) to the latest release", run: cmdUpgrade },
  { name: "revoke", summary: "Revoke this device in Orbit and delete the local key and data", run: cmdRevoke },
  { name: "status", summary: "Show the device, key, last run, counts and logon task state", run: cmdStatus },
  { name: "run", summary: "Deliver mail in the foreground (the logon task runs this for you)", run: cmdRun },
  { name: "backfill", summary: "Deliver inbox mail received since a date, once", run: cmdBackfill },
  { name: "start", summary: "Start the logon task now", run: cmdStart },
  { name: "stop", summary: "Stop the running bridge until the next sign-in", run: cmdStop },
  { name: "logs", summary: "Show the end of the bridge log", run: cmdLogs },
  { name: "version", summary: "Print the version", run: cmdVersion },
];

function usage(): void {
  out(`torbit-bridge ${version} - Outlook to Torbit/Orbit mail bridge\n\nUsage: torbit-bridge <command> [flags]\n\nCommands:`);
  for (const c of commands) out(`  ${c.name.padEnd(10)} ${c.summary}`);
  out("\nRun 'torbit-bridge <command> -h' for the flags of a command.\nFirst time on this PC: torbit-bridge setup");
}

const [name, ...rest] = process.argv.slice(2);
if (!name || name === "help" || name === "-h" || name === "--help") {
  usage();
} else if (name === "-v" || name === "--version") {
  out(version);
} else {
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) {
    err(`torbit-bridge: unknown command "${name}"\n`);
    usage();
    process.exitCode = 2;
  } else {
    try {
      process.exitCode = await cmd.run(rest, createContext());
    } catch (e) {
      err("torbit-bridge: " + (e instanceof Error ? e.message : String(e)));
      process.exitCode = 1;
    }
    process.exit(); // do not wait for stray handles (a stopped helper process, an idle stdin)
  }
}
