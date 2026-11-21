# Changelog

## Unreleased

- Rewrite the Outlook bridge in Go (`bridge/`, `torbit-bridge.exe`) with native
  Windows service support, replacing `bridge.ps1` and `TorbitBridge.psm1`. New
  commands: `setup` (guided enroll + Outlook check + service install), `doctor`,
  `install`, `uninstall`, `upgrade` (checksum-verified self-update from the
  release), `start`, `stop`, `logs`; `enroll`, `run`, `backfill`, `status` and
  `revoke` stay. The service starts the worker in the signed-in user's session,
  because classic Outlook cannot be automated from session 0, and replaces the
  logon scheduled task. It keeps the same `config.json`, `state.json`, CNG key
  and wire format, so enrolled PCs need no re-enrollment.
- The bridge sweeps every 60 seconds instead of listening for Outlook's new-mail
  event, and follows `HTTPS_PROXY` or the manual Windows proxy (no PAC scripts).
- Releases carry `torbit-bridge-windows-x86_64-<version>.exe` and its checksum in
  `SHA256SUMS`; `scripts/build-bridge.ps1` builds it, and CI tests the Go code.

## 0.4.1+3

- Rename the project from worbit to torbit ("Torben's Orbit"). Release artifacts are
  now `torbit-windows-x86_64-<version>.zip`, the tag prefix is `torbit-v`, and the
  Outlook bridge module is `TorbitBridge.psm1`. Existing installs keep working:
  see `docs/upgrade.md`.
- Rename the unmanaged `worbit_github_host_binding` table to
  `torbit_github_host_binding`. Patch 0002 renames an existing table in one
  transaction at startup, keeping the row and the immutable host binding, and
  creates the new table on fresh databases. Take a backup first: a worbit build
  does not find the renamed table.
- `install.ps1` keeps an existing `Worbit` install and data folder, moves
  `worbit.env` to `torbit.env`, and uses `torbit.env.example` for new installs.
- The bridge still reads `WORBIT_BRIDGE_HOME`, `%LOCALAPPDATA%\Worbit\Bridge` and the
  `Worbit Bridge` task, and replaces the task with `Torbit Bridge`. The wire format
  (`worbit-bridge-v1`, `X-Worbit-*`) is unchanged so enrolled devices keep working.
- Add patch 0007: a dismissible notice in the web app that torbit is an unofficial
  fork not affiliated with coollabsio, with links to upstream Orbit and this repo.
- Keep attribution to coollabsio/orbit in README and NOTICE.

## 0.4.1+2

- Add the Outlook bridge: signed, per-user inbound mail intake that needs no DNS
  or MX control (patches 0005 and 0006). Devices enroll with an ECDSA P-256 key,
  and deliveries are verified, replay-protected and stored through the stock
  intake pipeline. The feature is off unless `ORBIT_MAIL_BRIDGE_REGISTRY_PATH`
  is set, and it adds no database schema change.
- Add the PowerShell bridge (`bridge/`) with enroll, run, backfill, status,
  revoke and logon autostart, plus `docs/bridge.md` and `docs/bridge-signing.md`
  with shared test vectors.
- Package the Outlook bridge (`bridge/`) and its docs (`docs/bridge.md`,
  `docs/bridge-signing.md`) in the release zip.
- `install.ps1` reads the opt-in `ORBIT_MAIL_BRIDGE_REGISTRY_PATH`, creates its
  directory and applies the data-directory ACL. The feature stays off unless
  the setting is present in `worbit.env`.
- Add `tests/packaging.tests.ps1`.

## 0.4.1+1

- Rebase the patch series onto upstream Orbit `v0.4.1`. Resolve conflicts in the
  GitHub host patch (`integration_routes.rs`, `config.rs`, deploy compose and
  operations docs) and update the proxy test for the new `issuer` field.
- Keep Windows path separators in the write-lock call-site tag, so the upstream
  `write_lock` unit test passes on Windows (patch 0001).

## 0.3.0+3

- Create the app key during install when `ORBIT_APP_KEY_FILE` is missing, using
  APIs available in the built-in Windows PowerShell 5.1. The key file is
  restricted to SYSTEM, Administrators, and the service account.
- Add `ORBIT_APP_KEY_FILE` to the env file when neither that setting nor
  `ORBIT_APP_KEY` is present.
- Document trying Orbit in development mode before installing the service,
  including console/log behaviour and the loopback restriction.
- Run the native service install test under Windows PowerShell 5.1.

## 0.3.0+2

- Add configurable GitHub Enterprise hosts (`ORBIT_GITHUB_URL`) for GHES and
  GHEC with data residency.
- Derive REST, GraphQL, OAuth, App manifest, installation, issue and pull URLs
  from the configured host.
- Thread the host through sign-in, 2FA, integrations, link previews, CSP and
  task links.
- Bind the database to the first GitHub host. The binding lives in an unmanaged
  `worbit_github_host_binding` table, so the main Orbit schema version stays
  stock `0092`.
- Drop polling entirely. GHE deployments use inbound webhooks.

## 0.3.0+1

Initial scaffold.

- Standalone build repo pinned to Orbit `v0.3.0`.
- Native Windows Service patch (`0001`): SCM install/uninstall, service-name and
  env-file arguments, `ORBIT_LOG_FILE`, Windows backup rename fixes.
- PowerShell bootstrap/verify/apply/build/package scripts.
- Windows install/uninstall helpers with ACLs and a recorded env file.
- CI: Windows build, binary smoke test, native service install/start/stop test,
  patch verification against upstream tags, release packaging.
