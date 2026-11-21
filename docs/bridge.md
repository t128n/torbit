# Outlook bridge

The bridge is `torbit-bridge.exe`, a small Go program that runs on a user's
Windows PC. It reads mail from classic desktop Outlook through COM and delivers
each message to Orbit over HTTPS, signed with a key that stays on the PC. Mail
then shows up in that user's personal Orbit mailbox. It needs no Microsoft 365
app registration and no runtime other than Windows itself.

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

`setup` enrolls the PC, checks Outlook, installs the Windows service (one UAC
prompt) and ends with the same report as `doctor`. Keep Outlook open and
signed in; the bridge reads it while you are signed in to Windows.

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

`install` registers the Windows service **TorbitBridge** (automatic, delayed
start, restarted on failure). A service lives in session 0 and classic Outlook
only works inside a signed-in user's own session, so the service does not read
Outlook itself. It watches the Windows sessions and keeps one worker
(`torbit-bridge run`) running **as that user, in that user's session, not
elevated**, the same way Outlook runs. When the user signs out the worker ends;
when they sign in (or unlock) it starts again. The service binary is copied to
`%ProgramFiles%\Torbit\Bridge\torbit-bridge.exe`, where standard users cannot
change it, because the service runs as SYSTEM.

The key and the device config belong to the user who enrolled, so the service
delivers for exactly one Windows user: the one who ran `install` (or
`--user`). On a shared PC, install it for the person whose mailbox it is.

## Commands

```text
torbit-bridge <command> [flags]       torbit-bridge <command> -h   for flags
```

| Command | What it does |
|---|---|
| `setup` | Guided first run: enroll, check Outlook, install the service, run `doctor`. |
| `doctor` | Checks everything and says how to fix each problem. Exit code 1 on a failure. |
| `install` | Copies the binary to Program Files, registers and starts the service. Safe to repeat. |
| `uninstall` | Stops and removes the service and the installed binary. `--purge` also deletes the local key, config and state. |
| `upgrade` | Updates to the latest release (`--check` only looks; `--version X` picks one). |
| `enroll` | Registers this PC as a device (what `setup` does first). |
| `revoke` | Revokes the device in Orbit, then deletes the local key, config and state. |
| `status` | Device, key, last run, counts, service state, version. |
| `run` | Delivers mail in the foreground. The service runs this for you. |
| `backfill` | Delivers inbox mail since a date, once. |
| `start` / `stop` | Start or stop the service. |
| `logs` | Shows the end of `bridge.log` (`--service` for the service log). |
| `version` | Prints the version. |

`install`, `uninstall`, `start`, `stop` and `upgrade` need administrator
rights. Run from a normal terminal, they ask for them with one UAC prompt and
print what the elevated process did.

### setup / enroll

```text
torbit-bridge setup [--server https://orbit.example.com] [--workspace <id>] [--no-service] [--force]
torbit-bridge enroll --server https://orbit.example.com --workspace <id>
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
Outlook answers, and the service (installed, running, automatic start, binary
version, right user). Each warning or failure has a hint.

### run

```text
torbit-bridge run [--interval 60]
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
per Windows session, so a manual `run` next to the service stops with "already
running". The log is `bridge.log` in `%LOCALAPPDATA%\Torbit\Bridge`; it has
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
device in Orbit. `revoke` leaves the service installed; remove it with
`uninstall`.

### upgrade

```text
torbit-bridge upgrade [--check] [--version <v>]
```

Looks up the newest GitHub release of this project, downloads
`torbit-bridge-windows-x86_64-<version>.exe`, checks its SHA-256 against the
release's `SHA256SUMS`, runs it once to make sure it starts and reports the
expected version, and only then stops the service, swaps the binary in Program
Files (and the copy you ran), and starts the service again. Enrollment, key and
state are untouched. If anything fails before the swap, nothing changes. It
downloads through your proxy settings. To go back, `upgrade --version <older>`.

### uninstall

```text
torbit-bridge uninstall [--purge]
```

Removes the service, the Program Files copy and any logon task left by the old
PowerShell bridge. The device stays enrolled unless you pass `--purge` (local
data only; it does not tell Orbit, so use `revoke` first to also remove the
device in Orbit).

## Moving from the PowerShell bridge

Earlier versions were `bridge.ps1`. The Go bridge reads the same
`config.json`, `state.json` and key store entry, so an enrolled PC
needs no re-enrollment (the server must be the build with the `torbit-bridge-v1`
wire format; a bridge folder still named `Worbit\Bridge` has to be moved to
`%LOCALAPPDATA%\Torbit\Bridge`) and delivered mail is not sent again: copy
`torbit-bridge.exe` over, run `torbit-bridge install`, which also removes the
old "Torbit Bridge" logon task. Differences: the bridge no longer listens for
Outlook's new-mail event, it sweeps every 60 seconds instead (set `--interval`
to change that); and it follows the proxy configured in Windows settings or
`HTTPS_PROXY`, not a PAC script or sign-in with the Windows account (see
[Proxy](#proxy)).

## Manual COM verification checklist

Automated tests use a fake Outlook. Check the real thing once on each PC
configuration before you roll out:

1. Classic Outlook is installed, open and signed in.
2. `enroll` finishes and `status` shows the device and key location.
3. Send yourself a plain text mail and a mail with an attachment. Run `torbit-bridge run` (or wait a minute with the service running).
   Both appear in the Orbit mailbox, with the attachment intact.
4. Run `torbit-bridge run` again. No duplicates appear.
5. Run `backfill` with a date a few days back. Older mail appears once.
6. Stop the Orbit service, run `run`, start the service, run `run`. The mail
   arrives once after the service is back.
7. Close Outlook and run `run`. The error text says what to do.
8. `revoke`. A later `run` fails with a message to enroll again.

## When Outlook automation is blocked (for IT)

If `run` or `backfill` prints that Windows or your administrator blocked the
bridge from using Outlook, the COM call was refused. Common causes: a policy
that blocks programmatic access, a security product that blocks scripts from
automating Outlook, or Outlook running at a different privilege level than the
program (one elevated, one not). Run both as the same normal user. Allow
`torbit-bridge.exe` to use Outlook automation for the users who need the bridge. The
error `Outlook (classic desktop version) is not installed` means new Outlook or
no Outlook; the bridge does not support those.

## Proxy

The bridge uses `HTTPS_PROXY` / `NO_PROXY` when set, otherwise the manual proxy
the signed-in user has configured in Windows (Settings, Network, Proxy; the
`ProxyServer` and `ProxyOverride` values). It does not run PAC/WPAD scripts and
cannot sign in to an authenticating proxy with your Windows account; for those,
ask for a proxy exception for the Orbit host, or set `HTTPS_PROXY` for the user
(`setx HTTPS_PROXY http://user:pass@proxy:8080`, then restart the service
worker). If Orbit is not reachable, `doctor` says so with the error. Server URLs
must use HTTPS; plain HTTP works only for `localhost`.
