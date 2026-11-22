# Outlook bridge

The bridge is `torbit-bridge.exe`, one executable (TypeScript compiled with Bun)
that runs on a user's Windows PC. It reads mail from classic desktop Outlook
through the local [`msoutlook-mcp`](https://github.com/t128n/msoutlook-mcp)
daemon and delivers each message to Orbit over HTTPS, signed with a key that
stays on the PC. Mail then shows up in that user's personal Orbit mailbox. It
needs no Microsoft 365 app registration and no installer for itself.

The message format and signature are in [bridge-signing.md](bridge-signing.md).

Requirements: Windows 10/11 or Windows Server 2016+ (x86-64), classic Outlook
(not "new Outlook") signed in to the mailbox, an Orbit account that is a member
of the workspace, and **`msoutlook-mcp` 0.2.0 or later installed, its daemon
running and its logon task enabled** (it holds the Outlook session the bridge
reads). Classic Outlook must be signed in and open for both.

## Install the dependency first

The bridge does not drive Outlook itself. `msoutlook-mcp` owns the single COM
session, and both the bridge and any agent client read the same mailbox through
it. Install and verify it **before** `torbit-bridge setup`:

1. Install `msoutlook-mcp` 0.2.0 or later from its release (copy
   `msoutlook-mcp.exe` somewhere permanent, or use its zip).
2. Run `msoutlook-mcp setup`. Leave sending off and do not change the allowlist;
   the bridge only reads mail. Accept its logon task.
3. Run `msoutlook-mcp install` so its daemon starts at sign-in.
4. Check it is up, from the same user session:

```powershell
Invoke-RestMethod http://127.0.0.1:28471/health
```

The answer must have `"status": "connected"`. `waiting_for_outlook` means
Outlook is closed or still starting; `error` means COM is blocked (see
[When Outlook automation is blocked](#when-outlook-automation-is-blocked-for-it)).
If `setup` picked another port, read it from
`%LOCALAPPDATA%\msoutlook-mcp\config.json`. `MSOUTLOOK_MCP_HOME` is honoured when
set. `msoutlook-mcp doctor` prints the same checks with the fix for each.

`torbit-bridge setup` verifies the dependency and stops before enrolling when it
is missing. The bridge never installs, upgrades or configures `msoutlook-mcp`;
`upgrade` only tells you when its version is too old.

## Quick start (user)

1. Ask the Orbit administrator to [turn the feature on](#turn-it-on-administrator)
   and for the server URL and your workspace id.
2. Install and verify `msoutlook-mcp` as described above.
3. Get a session token: sign in to Orbit, then copy the value of the
   `__Host-orbit_session` cookie (or use an API token).
4. Open a terminal **as yourself** (not as administrator), in the `bridge`
   folder of the release zip, and run:

```text
.\torbit-bridge.exe setup
```

`setup` checks `msoutlook-mcp`, enrolls the PC, checks Outlook, registers the
logon task and ends with the same report as `doctor`. No administrator rights
and no UAC prompt are needed. Keep Outlook open and signed in (minimize it);
the bridge reads it while you are signed in to Windows.

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

Two per-user Task Scheduler tasks, both in the signed-in user's own session
(not elevated, the same way Outlook runs):

- **MSOutlook MCP** belongs to `msoutlook-mcp`. It starts that daemon 15 seconds
  after sign-in and keeps the Outlook connection.
- **Torbit Bridge** belongs to this bridge. `install` copies the program to
  `%LOCALAPPDATA%\Torbit\Bridge\bin\torbit-bridge.exe`, then registers the task
  for the current user. It starts 15 seconds after that user signs in, runs
  `torbit-bridge run --background`, has no time limit, allows one instance and
  is restarted up to three times if it crashes.

Classic Outlook only works inside a signed-in user's own session, which is why
both are logon tasks and not Windows services. When the user signs out both end;
at the next sign-in both start again. `torbit-bridge install` ensures the
`msoutlook-mcp` task is registered and starts it as well; `uninstall` removes
only **Torbit Bridge** and leaves `msoutlook-mcp` installed.

The key and the device config belong to the user who enrolled, so the task delivers
for exactly one Windows user: the one who ran `install`. On a shared PC, install it
for the person whose mailbox it is.

## Commands

```text
torbit-bridge <command> [flags]       torbit-bridge <command> -h   for flags
```

| Command | What it does |
|---|---|
| `setup` | Guided first run: verify `msoutlook-mcp`, enroll, check Outlook, register the logon task, run `doctor`. |
| `doctor` | Checks everything, including `msoutlook-mcp`, and says how to fix each problem. Exit code 1 on a failure. |
| `install` | Copies the program to `%LOCALAPPDATA%\Torbit\Bridge\bin`, registers the logon task, ensures the `msoutlook-mcp` task is running, and starts ours. Safe to repeat. |
| `uninstall` | Stops and removes our logon task and installed copy; leaves `msoutlook-mcp` installed. `--purge` also deletes the local key, config and state. |
| `upgrade` | Updates torbit-bridge to the latest release (`--check` only looks; `--version X` picks one). Never upgrades `msoutlook-mcp`. |
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
minutes Orbit allows, items waiting or skipped, the last run, `msoutlook-mcp`
(installed, token readable, daemon answering `/health`, state `connected`,
version at least 0.2.0, its logon task registered), that classic Outlook answers
through it, and our logon task (registered, enabled, installed copy runs and has
this version, worker running; also a leftover service from the Go version).
Each warning or failure has a hint.

If `msoutlook-mcp` is absent, stopped or too old, `doctor` fails with the exact
command to fix it. Version 0.1.x has no transport-header or attachment-byte
tools, so the bridge cannot work with it.

### run

```text
torbit-bridge run [--interval 60] [--background]
```

Stays running. It sweeps the Inbox (the Inbox folder only, not subfolders, Sent
or Junk) by received time every `--interval` seconds (default 60). The first
sweep starts at the enrollment time. Each item is delivered once: the entry ids
are kept in `state.json` next to `config.json`, so restarts and overlapping
sweeps do not repeat mail. Deleting or moving a mail in Outlook is not sent to
Orbit.

Each item is read with one `read_mail` call that returns the body, the raw
transport headers (so `Message-ID`, `From`, `References` and `In-Reply-To`
survive) and attachment bytes. The bridge caps the whole item at 2 MiB, the same
limit Orbit enforces. If `msoutlook-mcp` reports any attachment as skipped
(`too_large`, `total_cap` or `unavailable`), the whole item is recorded as
skipped with 413 rather than delivering a partial message.

When Orbit or the network is not reachable (HTTP 503 and similar), the bridge
retries with a growing wait, then tries again at the next sweep. If Orbit
answers 401 or 413 (or another 4xx), the item is recorded as skipped and not
sent again. If `msoutlook-mcp` is stopped or Outlook is closed, reading an item
is retried; when attempts run out the rest of the sweep waits for the next one.
A daemon that is running but in its `error` state, or that rejects the token
(HTTP 401), fails the whole sweep with a hint and marks nothing skipped, so mail
is not lost silently. Only one `run` can be active per Windows session, so a
manual `run` next to the logon task stops with "already running" (stop the
task's worker first with `torbit-bridge stop`). The log is `bridge.log` in
`%LOCALAPPDATA%\Torbit\Bridge`; it has events and ids only, never message text.

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
It checks the installed `msoutlook-mcp` version and warns when the daemon is
missing, older than 0.2.0 or running a different build from its installed exe,
but it never downloads or upgrades `msoutlook-mcp` (that daemon also serves
agent clients). Update it separately with its own release.

### uninstall

```text
torbit-bridge uninstall [--purge]
```

Removes our logon task and the installed copy. It leaves `msoutlook-mcp`
installed, configured and running; remove that separately with
`msoutlook-mcp uninstall` if you no longer need it. The device stays enrolled
unless you pass `--purge` (local data only; it does not tell Orbit, so use
`revoke` first to also remove the device in Orbit).

## Moving from an earlier bridge

**`torbit-bridge upgrade` alone is not enough.** This bridge reads Outlook
through `msoutlook-mcp`, so install and verify the dependency first (see
[Install the dependency first](#install-the-dependency-first)): 0.2.0 or later,
`setup` done, daemon running, `/health` reporting `connected`. Then update the
bridge as before.

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

## Manual verification checklist

Automated tests use a fake MCP endpoint. Check the real thing once on each PC
configuration before you roll out:

1. `msoutlook-mcp` 0.2.0+ is installed and its logon task enabled; its
   `/health` says `connected`; classic Outlook is open, signed in and minimized.
2. `torbit-bridge setup` finishes and `status` shows the device and key location.
3. Send yourself a plain text mail, a mail with a normal attachment, and an HTML
   mail with an inline `cid:` image. Run `torbit-bridge run` (or wait a minute
   with the logon task running). All arrive in the Orbit mailbox: body intact,
   inline image shown inline, attachment bytes identical.
4. Reply to one of those mails from another account. In Orbit, the reply keeps
   its `References` and `In-Reply-To` headers and threads with the original.
5. Run `torbit-bridge run` again. No duplicates appear.
6. Run `backfill` with a date a few days back. Older mail appears once.
7. Move more than 1000 inbox mails into a test window (or use a mailbox that
   already has them) and let a sweep drain it. Every item is delivered exactly
   once, including a block that shares one `ReceivedTime`.
8. Close Outlook, run `run` (or wait for a sweep). The item stays pending and
   is delivered after Outlook is opened and minimized again.
9. Stop `msoutlook-mcp` (stop its task or `msoutlook-mcp uninstall` is not
   needed: end the task). `doctor` says it is not running and gives the start
   command; a sweep waits rather than skipping mail.
10. Run `install`, sign out and in again (or `torbit-bridge start`). `doctor` shows
    both logon tasks and a running worker, and a new mail arrives without a
    console window.
11. `revoke`. A later `run` fails with a message to enroll again.

## When Outlook automation is blocked (for IT)

COM-level failures are now surfaced by **`msoutlook-mcp doctor`**; run that
first. It reports the HRESULT and the fix, and its `Outlook Classic` check plus
PowerShell language-mode check distinguish a policy block from Outlook being
closed or not installed. Common causes: a policy that blocks programmatic
access, a security product that blocks automation, or Outlook running at a
different privilege level than the daemon (one elevated, one not). Run Outlook
and the daemon as the same normal user. Allow `msoutlook-mcp.exe` and the
PowerShell it starts to use Outlook automation for the users who need the
bridge. With AppLocker or WDAC in "constrained language" mode, Outlook's COM
object cannot be created and its doctor reports that Outlook is blocked.

`torbit-bridge doctor` keeps a short summary line: `mcp Outlook` says
`waiting_for_outlook` when Outlook is closed (open it and minimize it), and
`error` with the daemon's message when COM is blocked. The bridge's own error
text still says classic Outlook (desktop) is required and that "new Outlook" is
not supported.

## Proxy

The bridge uses `HTTPS_PROXY` / `NO_PROXY` when set, otherwise the manual proxy
the signed-in user has configured in Windows (Settings, Network, Proxy; the
`ProxyServer` and `ProxyOverride` values). It does not run PAC/WPAD scripts and
cannot sign in to an authenticating proxy with your Windows account; for those,
ask for a proxy exception for the Orbit host, or set `HTTPS_PROXY` for the user
(`setx HTTPS_PROXY http://user:pass@proxy:8080`, then `torbit-bridge stop` and
`torbit-bridge start`). If Orbit is not reachable, `doctor` says so with the error. Server URLs
must use HTTPS; plain HTTP works only for `localhost`.
