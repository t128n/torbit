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
`worbit.env` and run `install.ps1` again:

```text
ORBIT_MAIL_BRIDGE_REGISTRY_PATH=C:\ProgramData\Worbit\config\bridge-registry.json
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
`%LOCALAPPDATA%\Worbit\Bridge\config.json`. Use `-Force` to replace an existing
enrollment.

### run

Reads new items from the Outlook inbox and delivers them. Run it by hand or
from a scheduled task for the signed-in user. Delivery is retried later when
Orbit or the network is not reachable.

### backfill

Delivers older inbox items, starting at a date you give, once. Items already
delivered are skipped.

### status

Shows the device id, server, key location, last run and the number of items
waiting to retry.

### revoke

Marks this device as revoked on the server and deletes the local key. Orbit
refuses all later deliveries from the device. To stop a lost PC, revoke its
device in Orbit.

`run`, `backfill`, `status` and `revoke` are being added to `bridge.ps1`; check
`Get-Help .\bridge.ps1` in your release for the commands it supports.

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
