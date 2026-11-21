# Upgrade and rollback

## Upgrading from worbit (rename to torbit)

The project was renamed from `worbit` to `torbit` in `0.4.1+3`. Existing installs
keep working without manual steps, and nothing is renamed on disk that holds
state you need:

| What | After the upgrade |
|---|---|
| Service name | unchanged (`Orbit`) |
| `ORBIT_*` settings | unchanged |
| `C:\Program Files\Worbit` and `C:\ProgramData\Worbit` | kept: `install.ps1` and `uninstall.ps1` use an existing `Worbit` folder and only default to `Torbit` on a new install |
| `config\worbit.env` | renamed to `config\torbit.env` by `install.ps1` when it runs (pass `-EnvFile` to override) |
| Database table `worbit_github_host_binding` | renamed to `torbit_github_host_binding` at the first start of the new build, in one transaction. The row, and so the immutable GitHub host binding, is kept. Safe to run again and on fresh installs |
| Bridge (`%LOCALAPPDATA%\Worbit\Bridge`, `WORBIT_BRIDGE_HOME`, scheduled task `Worbit Bridge`) | still read when the Torbit names are not in use; `bridge.ps1` autostart replaces the old task with `Torbit Bridge` |
| Bridge wire format (`worbit-bridge-v1`, `X-Worbit-*` headers) | unchanged on purpose: renaming it would break every enrolled device |
| Release zip, tag | now `torbit-windows-x86_64-<version>.zip` and `torbit-v<version>`; the old GitHub URL redirects |

Before you start the new build:

1. Take a verified backup (below). The table rename is part of the first start.
2. Know that **a rollback to a worbit build will not find the renamed table**.
   `ensure_schema` in that build creates an empty `worbit_github_host_binding`,
   which then binds the host again (to the default host when GitHub data exists, else the configured one), and that
   fails if the database already holds GitHub data for another host. Roll back
   by restoring the pre-upgrade backup, not only the old executable.

The first web page load after the upgrade shows a dismissible notice that torbit
is an unofficial fork of Orbit; the dismissal is remembered in the browser.


## Before upgrading

1. Read the upstream release notes for the tag in `upstream.lock`.
2. Create and verify a backup:

```powershell
Stop-Service Orbit
& "C:\Program Files\Worbit\orbit.exe" backup create
& "C:\Program Files\Worbit\orbit.exe" backup verify <id>
```

3. Copy the current `C:\Program Files\Worbit\orbit.exe` to a rollback path.
4. Keep `C:\ProgramData\Worbit\config\worbit.env` and the app key.

Use the service account's environment file when running CLI commands:

```powershell
$env:ORBIT_ENV_FILE = "C:\ProgramData\Worbit\config\worbit.env"
```

## Replace the binary

The service registration already points at `C:\Program Files\Worbit\orbit.exe`;
replacing that file keeps the launch arguments and env-file path.

```powershell
Stop-Service Orbit
Copy-Item .\orbit.exe "C:\Program Files\Worbit\orbit.exe" -Force
Start-Service Orbit
```

Migrations run at startup. If the process exits, read
`C:\ProgramData\Worbit\logs\orbit.log` before retrying.

If the install path or service name changes, rerun `install.ps1` instead:

```powershell
./install.ps1 -EnvFile C:\ProgramData\Worbit\config\worbit.env
```

## Verify

```powershell
Get-Service Orbit
Invoke-WebRequest http://127.0.0.1:8080/health/ready
Get-Content C:\ProgramData\Worbit\logs\orbit.log -Tail 100
```

Then check the UI, an existing task, and a GitHub link.

## Rollback

1. Stop the service.
2. Restore the pre-upgrade backup with the matching binary:

```powershell
& "C:\Program Files\Worbit\orbit.exe" backup restore <id>
```

3. Put the saved `orbit.exe` back.
4. Start the service.

An older binary cannot read a database migrated by a newer one. Restore the
backup taken before the upgrade, not just the old executable. Data written after
the upgrade is lost unless it is exported separately.

## App key

A restored database needs the same `ORBIT_APP_KEY`. Without it, saved secrets
(SMTP password, GitHub App keys, import tokens) cannot be decrypted. Keep the
key outside the database backup.
