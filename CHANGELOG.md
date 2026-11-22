# Changelog

## 0.4.1+6

- Replace the bridge's own PowerShell/COM Outlook helper with a client for the
  local [`msoutlook-mcp`](https://github.com/t128n/msoutlook-mcp) daemon (MCP
  Streamable HTTP). The bridge now makes one `read_mail` call per item for the
  body, transport headers, Content-ID/MIME type and attachment bytes, and drains
  `list_mail` cursor pages oldest-first. The PC has one Outlook automation stack
  instead of two, and agent clients and the bridge read the same session.
- **New runtime dependency:** `msoutlook-mcp` 0.2.0 or later must be installed,
  its daemon running and its logon task enabled. `setup` verifies it before
  enrolling, `install` ensures/starts its task, `doctor` checks it (health,
  token, state, version floor, task), and `upgrade` warns but never upgrades it.
  `uninstall` removes only the bridge's task. `setup` now has a dependency step.
- Missing, stopped or too-old `msoutlook-mcp` fails `doctor` with the fix; a
  daemon in its `error` state or a 401 fails the sweep instead of silently
  skipping mail. A skipped attachment (`too_large`/`total_cap`/`unavailable`)
  records the whole item as 413.
- Wire format, enrollment, CNG key, state and `torbit-bridge-v1` are unchanged;
  an enrolled PC needs no re-enrollment, but must install the dependency first.
  `docs/bridge.md`, `docs/deploy-windows.md`, `README.md` and `bridge/README.md`
  describe the dependency, the second logon task and offline mirroring.

## 0.4.1+5

- Rewrite the Outlook bridge in TypeScript (`bridge/`), compiled with Bun into one
  `torbit-bridge.exe`, replacing `bridge.ps1` and `TorbitBridge.psm1`. Commands:
  `setup` (guided enroll + Outlook check + logon task), `doctor`, `install`,
  `uninstall`, `upgrade` (checksum-verified self-update from the release), `run`,
  `backfill`, `status`, `revoke`, `start`, `stop`, `logs`. `install` copies the exe to
  `%LOCALAPPDATA%\Torbit\Bridge\bin` and registers a per-user Task Scheduler logon
  task ("Torbit Bridge") that runs in the signed-in user's own session, where classic
  Outlook works; no administrator rights, no UAC prompt, no Windows service.
  It keeps the same `config.json`, `state.json`, CNG key and wire format, so enrolled PCs
  need no re-enrollment. Outlook is driven through a hidden Windows PowerShell helper, so
  the exe is about 110 MB (it carries the Bun runtime). `enroll` is now `setup`
  (`setup --force` enrolls again). PCs that ran the short-lived Go service bridge: remove the old
  service once with `sc.exe stop TorbitBridge & sc.exe delete TorbitBridge` (`doctor` says so).
- **Breaking:** the bridge uses `torbit-bridge-v1` and `X-Torbit-*` (patch 0006, the
  Go bridge, vectors and docs); no `worbit` names remain in the bridge. Upgrade the
  server and all bridge PCs together; an old bridge gets 401 until upgraded. Devices
  need no re-enrollment, but a bridge folder under `%LOCALAPPDATA%\Worbit\Bridge`
  or `WORBIT_BRIDGE_HOME` is no longer read: move it to `%LOCALAPPDATA%\Torbit\Bridge`.
- The bridge sweeps every 60 seconds instead of listening for Outlook's new-mail
  event, and follows `HTTPS_PROXY` or the manual Windows proxy (no PAC scripts).
- Releases carry `torbit-bridge-windows-x86_64-<version>.exe` and its checksum in
  `SHA256SUMS`; `scripts/build-bridge.ps1` builds it, and CI tests and smoke-tests it on Windows.

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
