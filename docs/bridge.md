# Outlook bridge

The bridge is a PowerShell script that runs on a user's Windows PC. It reads
mail from classic desktop Outlook through COM and delivers each message to
Orbit over HTTPS, signed with a key that stays on the PC. Mail then shows up in
that user's personal Orbit mailbox. It needs no Microsoft 365 app registration.

The message format and signature are in [bridge-signing.md](bridge-signing.md).

Requirements: Windows PowerShell 5.1, classic Outlook (not "new Outlook")
signed in to the mailbox, and an Orbit account that is a member of the
workspace.

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

## Commands

Run them from the `bridge` folder of the release zip.

### enroll

```powershell
.\bridge.ps1 enroll -Server https://orbit.example.com -Workspace <workspace-id>
```

The script asks for your Orbit session token if you do not pass one. It makes a
key pair on the PC (in the TPM when one is available), registers the public
key, and stores the device id and server in
`%LOCALAPPDATA%\Torbit\Bridge\config.json`. Use `-Force` to replace an existing
enrollment. With `-Force`, items that were skipped because the old device was
rejected (HTTP 401 or 404) are forgotten, so the next sweep sends them again;
items skipped as too large (413) or for another reason stay skipped.

### run

```powershell
.\bridge.ps1 run [-IntervalSeconds 300]
```

Stays running. It delivers new items from the Outlook inbox (the Inbox folder
only, not subfolders, Sent or Junk) when Outlook reports new mail, and sweeps
by received time every `-IntervalSeconds` as a safety net. The first sweep
starts at the enrollment time. Each item is delivered once: the entry ids are
kept in `state.json` next to `config.json`, so restarts and overlapping sweeps
do not repeat mail. Deleting or moving a mail in Outlook is not sent to Orbit.

When Orbit or the network is not reachable (HTTP 503 and similar), the bridge
retries with a growing wait, then tries again at the next sweep. If Orbit
answers 401 or 413 (or another 4xx), the item is recorded as skipped and not
sent again. Attachments are read from Outlook one item at a time, only when the
item is sent; an item that Outlook reports as larger than 2 MiB is skipped
(413, too large) without reading its attachments. Only one `run` can be active per Windows user. The log is
`bridge.log` in `%LOCALAPPDATA%\Torbit\Bridge`; it has events and ids only,
never message text.

### install-autostart / remove-autostart

```powershell
.\bridge.ps1 install-autostart
.\bridge.ps1 remove-autostart
```

Adds or removes a scheduled task, "Torbit Bridge", that starts `run` when you
sign in. It runs in your own session, not elevated, so it can use Outlook.

### backfill

```powershell
.\bridge.ps1 backfill -Since 2026-01-01
```

Delivers inbox items received since the date, once. Items already delivered or
skipped (by `run` or an earlier backfill) are not sent again.

### status

Shows the device id, server, key location, last run, the number of delivered
and skipped items, the number waiting to retry, and whether autostart is on.

### revoke

```powershell
.\bridge.ps1 revoke [-SessionToken <token> | -ApiToken <token>] [-LocalOnly]
```

Marks this device as revoked in Orbit (this needs your Orbit credential, as for
`enroll`), then deletes the local key, `config.json`, `state.json` and the
autostart task. Orbit refuses all later deliveries from the device. If the
server call fails, nothing is removed locally. Use `-LocalOnly` to remove only
the local data, for example when the device is already revoked in Orbit. To
stop a lost PC, revoke its device in Orbit.

## Manual COM verification checklist

Automated tests use a fake Outlook. Check the real thing once on each PC
configuration before you roll out:

1. Classic Outlook is installed, open and signed in.
2. `enroll` finishes and `status` shows the device and key location.
3. Send yourself a plain text mail and a mail with an attachment. Run `run`.
   Both appear in the Orbit mailbox, with the attachment intact.
4. Run `run` again. No duplicates appear.
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
script (one elevated, one not). Run both as the same normal user. Allow
PowerShell to use Outlook automation for the users who need the bridge. The
error `Outlook (classic desktop version) is not installed` means new Outlook or
no Outlook; the bridge does not support those.

## Proxy

The bridge uses the Windows system proxy settings, and signs in to an
authenticating proxy with the current Windows user. There is no proxy setting
of its own. If Orbit is not reachable, the message says to check the server URL
and your network or proxy. Server URLs must use HTTPS; plain HTTP works only for
`localhost`.
