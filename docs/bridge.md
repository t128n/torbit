# Outlook bridge

The bridge is `torbit-bridge.exe`, one executable (TypeScript compiled with Bun)
that runs on a user's Windows PC. It reads mail from classic desktop Outlook
through COM and delivers each message to Orbit over HTTPS, signed with a key
that stays on the PC. Mail then shows up in that user's personal Orbit mailbox.
It needs no Microsoft 365 app registration, no installer and no runtime other
than Windows itself (it talks to Outlook through the Windows PowerShell that
ships with Windows).

The message format and signature are in [bridge-signing.md](bridge-signing.md).

Requirements: Windows 10/11 or Windows Server 2016+ (x86-64), classic Outlook
(not "new Outlook") signed in to the mailbox, and an Orbit account that is a
member of the workspace.

## Quick start (user)

1. Ask the Orbit administrator to [turn the feature on](#turn-it-on-administrator)
   and for the server URL and your workspace id.
2. Get a session token: sign in to Orbit, then copy the value of the
   `__Host-orbit_session` cookie (or use an API token).
3. Open a terminal **as yourself** (not as administrator), in the `bridge`
   folder of the release zip, and run:

```text
.\torbit-bridge.exe setup
```

`setup` enrolls the PC, checks Outlook, registers the logon task and ends with
the same report as `doctor`. No administrator rights and no UAC prompt are
needed. Keep Outlook open and signed in; the bridge reads it while you are
signed in to Windows.

## Turn it on (administrator)

The feature is off by default. To turn it on, set the registry file path in
`torbit.env` and run `install.ps1` again:

```text
ORBIT_MAIL_BRIDGE_REGISTRY_PATH=C:\ProgramData\Torbit\config\bridge-registry.json
```

Mail must also be on for the instance. `install.ps1` creates the directory and
gives it the same ACL as the data directory (SYSTEM and Administrators, plus the
service account if you pass `-Account`). The service writes the file, so the
ACL is on the directory. A missing file means no devices. Back the file up with
the app key: it lists the enrolled devices and their public keys. Restart the
service after you change the setting.

## How it runs

`install` copies the program to `%LOCALAPPDATA%\Torbit\Bridge\bin\torbit-bridge.exe`
and registers a Task Scheduler task named **Torbit Bridge** for the current user:
it starts 15 seconds after that user signs in, runs `torbit-bridge run --background`
in the user's own session (not elevated, the same way Outlook runs), has no time
limit, allows one instance and is restarted up to three times if it crashes.
Classic Outlook only works inside a signed-in user's own session, which is why this
is a logon task and not a Windows service. When the user signs out the worker ends;
at the next sign-in it starts again. The task is per user, so no administrator
rights are needed to install, upgrade or remove it. It starts the program without a
console window.

The key and the device config belong to the user who enrolled, so the task delivers
for exactly one Windows user: the one who ran `install`. On a shared PC, install it
for the person whose mailbox it is.

## Commands

```text
torbit-bridge <command> [flags]       torbit-bridge <command> -h   for flags
```

| Command | What it does |
|---|---|
| `setup` | Guided first run: enroll, check Outlook, register the logon task, run `doctor`. |
| `doctor` | Checks everything and says how to fix each problem. Exit code 1 on a failure. |
| `install` | Copies the program to `%LOCALAPPDATA%\Torbit\Bridge\bin`, registers the logon task and starts it. Safe to repeat. |
| `uninstall` | Stops and removes the logon task and the installed copy. `--purge` also deletes the local key, config and state. |
| `upgrade` | Updates to the latest release (`--check` only looks; `--version X` picks one). |
| `revoke` | Revokes the device in Orbit, then deletes the local key, config and state. |
| `status` | Device, key, last run, counts, logon task state, version. |
| `run` | Delivers mail in the foreground. The logon task runs this for you. |
| `backfill` | Delivers inbox mail since a date, once. |
| `start` / `stop` | Start the task now / stop the running bridge until the next sign-in. |
| `logs` | Shows the end of `bridge.log`. |
| `version` | Prints the version. |

None of the commands need administrator rights; run them from a normal terminal as
the user whose Outlook is read.

### setup

```text
torbit-bridge setup [--server https://orbit.example.com] [--workspace <id>] [--no-task] [--force] [--interval 60]
```

Missing values are asked for; the token is typed without echo. For scripts, pass
`--session-token` / `--api-token` or set `TORBIT_SESSION_TOKEN` /
`TORBIT_API_TOKEN` (a flag shows up in the process list; the variable does not).
Enrollment makes a key pair on the PC (in the TPM when one is available),
registers the public key, and stores the device id and server in
`%LOCALAPPDATA%\Torbit\Bridge\config.json`. The token is used once and never
saved. `--force` replaces an existing enrollment. With `--force`, items that were
skipped because the old device was rejected (HTTP 401 or 404) are forgotten, so
the next sweep sends them again; items skipped as too large (413) or for another
reason stay skipped.

### doctor

Run it first when something is wrong. It checks: the bridge folder, enrollment,
that the signing key exists and produces a signature that verifies, that Orbit
answers (through your proxy settings) and that the PC clock is within the 5
minutes Orbit allows, items waiting or skipped, the last run, that classic
Outlook answers, and the logon task (registered, enabled, installed copy runs and
has this version, worker running; also a leftover service from the Go version).
Each warning or failure has a hint.

### run

```text
torbit-bridge run [--interval 60] [--background]
```

Stays running. It sweeps the Outlook inbox (the Inbox folder only, not
subfolders, Sent or Junk) by received time every `--interval` seconds (default
60). The first sweep starts at the enrollment time. Each item is delivered once:
the entry ids are kept in `state.json` next to `config.json`, so restarts and
overlapping sweeps do not repeat mail. Deleting or moving a mail in Outlook is
not sent to Orbit.

When Orbit or the network is not reachable (HTTP 503 and similar), the bridge
retries with a growing wait, then tries again at the next sweep. If Orbit
answers 401 or 413 (or another 4xx), the item is recorded as skipped and not
sent again. Attachments are read from Outlook one item at a time, only when the
item is sent; an item that Outlook reports as larger than 2 MiB is skipped
(413, too large) without reading its attachments. Only one `run` can be active
per Windows session, so a manual `run` next to the logon task stops with "already
running" (stop the task's worker first with `torbit-bridge stop`). The log is `bridge.log` in `%LOCALAPPDATA%\Torbit\Bridge`; it has
events and ids only, never message text.

### backfill

```text
torbit-bridge backfill --since 2026-01-01
```

Delivers inbox items received since the date, once. Items already delivered or
skipped (by `run` or an earlier backfill) are not sent again.

### revoke

```text
torbit-bridge revoke [--session-token <t> | --api-token <t>] [--local-only]
```

Marks this device as revoked in Orbit (this needs your Orbit credential, as for
`enroll`), then deletes the local key, `config.json` and `state.json`. Orbit
refuses all later deliveries from the device. If the server call fails, nothing
is removed locally. Use `--local-only` to remove only the local data, for example
when the device is already revoked in Orbit. To stop a lost PC, revoke its
device in Orbit. `revoke` leaves the logon task installed; remove it with
`uninstall`.

### upgrade

```text
torbit-bridge upgrade [--check] [--version <v>]
```

Looks up the newest GitHub release of this project, downloads
`torbit-bridge-windows-x86_64-<version>.exe`, checks its SHA-256 against the
release's `SHA256SUMS`, runs it once to make sure it starts and reports the
expected version, and only then stops the worker, swaps the installed copy (and
the copy you ran), and starts the task again. Enrollment, key and state are
untouched. If anything fails before the swap, nothing changes. It
downloads through your proxy settings. To go back, `upgrade --version <older>`.

### uninstall

```text
torbit-bridge uninstall [--purge]
```

Removes the logon task and the installed copy. The device stays enrolled unless you pass `--purge` (local
data only; it does not tell Orbit, so use `revoke` first to also remove the
device in Orbit).

## Moving from an earlier bridge

The PowerShell bridge (`bridge.ps1`) and the short-lived Go bridge used the same
`config.json`, `state.json` and key store entry, so an enrolled PC needs no
re-enrollment (the server must be the build with the `torbit-bridge-v1` wire format;
a bridge folder still named `Worbit\Bridge` has to be moved to
`%LOCALAPPDATA%\Torbit\Bridge`) and delivered mail is not sent again. Copy
`torbit-bridge.exe` over and run `torbit-bridge install`. Then:

- The Go version ran as a Windows service named `TorbitBridge`. Remove it once, from
  an administrator prompt: `sc.exe stop TorbitBridge & sc.exe delete TorbitBridge`
  (`install` and `doctor` tell you when it is still there, and delete the old
  `%ProgramFiles%\Torbit\Bridge` copy by hand if you want it gone). Both versions use the
  same run lock, so they never deliver at the same time.
- The old PowerShell bridge's logon task was also called "Torbit Bridge"; `install`
  replaces it with the new one.

Differences from the PowerShell bridge: the bridge no longer listens for Outlook's
new-mail event, it sweeps every 60 seconds instead (set `--interval` to change
that); and it follows the proxy configured in Windows settings or `HTTPS_PROXY`,
not a PAC script or sign-in with the Windows account (see [Proxy](#proxy)).

## Manual COM verification checklist

Automated tests use a fake Outlook. Check the real thing once on each PC
configuration before you roll out:

1. Classic Outlook is installed, open and signed in.
2. `setup` finishes and `status` shows the device and key location.
3. Send yourself a plain text mail and a mail with an attachment. Run `torbit-bridge run` (or wait a minute with the logon task running).
   Both appear in the Orbit mailbox, with the attachment intact.
4. Run `torbit-bridge run` again. No duplicates appear.
5. Run `backfill` with a date a few days back. Older mail appears once.
6. Stop the Orbit service, run `run`, start the Orbit service, run `run`. The mail
   arrives once after Orbit is back.
7. Run `install`, sign out and in again (or `torbit-bridge start`). `doctor` shows the
   logon task and a running worker, and a new mail arrives without a console window.
8. Close Outlook and run `run`. The error text says what to do.
9. `revoke`. A later `run` fails with a message to enroll again.

## When Outlook automation is blocked (for IT)

If `run` or `backfill` prints that Windows or your administrator blocked the
bridge from using Outlook, the COM call was refused. Common causes: a policy
that blocks programmatic access, a security product that blocks scripts from
automating Outlook, or Outlook running at a different privilege level than the
program (one elevated, one not). Run both as the same normal user. Allow
`torbit-bridge.exe` and Windows PowerShell (which the bridge starts to reach
Outlook) to use Outlook automation for the users who need the bridge. The helper
needs PowerShell's FullLanguage mode: with AppLocker or WDAC in "constrained
language" mode, Outlook's COM object cannot be created and `doctor` reports that
Outlook is blocked. The
error `Outlook (classic desktop version) is not installed` means new Outlook or
no Outlook; the bridge does not support those.

## Proxy

The bridge uses `HTTPS_PROXY` / `NO_PROXY` when set, otherwise the manual proxy
the signed-in user has configured in Windows (Settings, Network, Proxy; the
`ProxyServer` and `ProxyOverride` values). It does not run PAC/WPAD scripts and
cannot sign in to an authenticating proxy with your Windows account; for those,
ask for a proxy exception for the Orbit host, or set `HTTPS_PROXY` for the user
(`setx HTTPS_PROXY http://user:pass@proxy:8080`, then `torbit-bridge stop` and
`torbit-bridge start`). If Orbit is not reachable, `doctor` says so with the error. Server URLs
must use HTTPS; plain HTTP works only for `localhost`.
