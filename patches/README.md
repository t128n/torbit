# Patch inventory

Base: **Orbit v0.4.1**, commit `17ed06ae5dcba8056c6fcec1ce4a40b1c978bed3`.

| Patch | Upstream | Contents |
|---|---|---|
| `0001-feat-windows-native-service.patch` | #81 | Native SCM service, `--name`/`--env-file`, `ORBIT_LOG_FILE`, Windows backup rename fixes |
| `0002-feat-github-enterprise-host.patch` | #82 | Configurable GHES/GHEC host, derived endpoints, host binding |
| `0003-feat-outbound-proxy-support.patch` | local | Reqwest system-proxy support for outbound requests |
| `0004-feat-manual-github-app-registration.patch` | local | Manual GitHub App registration API for GHES without manifest flow |
| `0005-feat-bridge-device-enrollment.patch` | local | Torbit bridge device registry, enrollment API and `.invalid` mailbox |
| `0006-feat-bridge-signed-delivery.patch` | local | Signed bridge delivery endpoint |
| `0007-feat-web-fork-notice.patch` | local | Dismissible "unofficial fork of Orbit" toast shown when the web app opens |
| `0008-fix-mail-html-frame-coop.patch` | local | Sandboxed mail view document gets `COOP: unsafe-none` and base CSP allows `frame-src 'self'` so the reading pane iframe renders |
| `0009-chore-web-pele-diagrams.patch` | local | Mermaid diagrams drawn by Pele (pele.run) instead of Mermaid.js |

Polling is not included.

## 0001 details

Code:

- `apps/server/src/windows_service.rs` — SCM dispatcher, `service install` /
  `uninstall`, control handler wired to the existing shutdown token.
- `apps/server/src/cli.rs` — `orbit service install|uninstall --name`,
  `--env-file`.
- `apps/server/src/main.rs` — early dispatch and env-file loading.
- `crates/platform/src/observability.rs` — `ORBIT_LOG_FILE` (append, falls back
  to stdout).
- `crates/platform/src/config.rs` — `ORBIT_LOG_FILE` and `ORBIT_ENV_FILE`.
- `crates/platform/src/backup.rs` — Windows restore fixes: `FILE_SHARE_DELETE`
  on the staged database handle, retry on `ERROR_SHARING_VIOLATION` from
  antivirus scanning.
- `apps/server/Cargo.toml`, `Cargo.lock` — `windows-service 0.8.1`, target-gated.

The env file is recorded in the service launch arguments, so a reboot does not
depend on machine-wide `ORBIT_*` variables:

```text
orbit.exe __service-run --name Orbit --env-file C:\ProgramData\Torbit\config\torbit.env
```

## 0002 details

Code:

- `crates/platform/src/github.rs` — `GitHubHost`, host validation and derived
  endpoints.
- `crates/platform/src/config.rs` — `ORBIT_GITHUB_URL`.
- `apps/server/src/sign_in_providers.rs`, `auth_routes/`, `repositories/` —
  GitHub OAuth and 2FA use the configured host.
- `apps/server/src/integration_routes.rs` — App manifest, installation and
  webhook URLs use the configured host.
- `apps/server/src/task_routes.rs`, `repositories/tasks.rs` — issue/pull URLs
  use the configured host.
- `crates/platform/src/http/security.rs` — CSP `form-action` includes the host.
- `apps/server/src/github_binding.rs` — refuses to change hosts after GitHub
  data exists.

The binding table is created by code, not by a migration:

```sql
CREATE TABLE IF NOT EXISTS torbit_github_host_binding (
    singleton BIGINT PRIMARY KEY CHECK (singleton = 1),
    origin TEXT NOT NULL
);
```

That keeps `schema_migrations` at the stock Orbit version. The `torbit_` prefix
avoids a collision if upstream ever adds its own binding table.

Before the rebrand the table was `worbit_github_host_binding`. At startup, in one
write transaction, an old table is renamed with `ALTER TABLE ... RENAME TO` when
the new one does not exist (this keeps the row, so the host binding stays
immutable); otherwise the new table is created if missing. The step is
idempotent and safe on fresh installs. A worbit build cannot find the renamed
table, see `docs/upgrade.md`.

## 0003 details

- Enables Reqwest's `system-proxy` feature for the server and platform crates.
- Documents the service-process proxy configuration required for GitHub's
  outbound HTTPS requests.
- Adds `apps/server/tests/system_proxy.rs`, which verifies the GitHub OAuth
  client sends HTTPS requests through `HTTPS_PROXY`.

## 0004 details

Adds a manual GitHub App registration endpoint for situations where the manifest
flow is not available:

```
POST /api/v1/workspaces/{workspace_id}/github/manual-registration
{
    "app_id": 123456,
    "slug": "orbit-app",
    "private_key": "-----BEGIN RSA PRIVATE KEY-----\n...",
    "webhook_secret": "your-webhook-secret"
}
```

Use cases:
- GitHub Enterprise where manifest creation requires organization membership
- Personal account apps that cannot use the manifest flow
- Re-registering an existing app after credential rotation

The app must already exist on GitHub with the correct configuration:
- Permissions: `issues:read`, `pull_requests:read`
- Events: `issues`, `pull_request`
- Webhook URL: `{ORBIT_PUBLIC_ORIGIN}/api/v1/integrations/github/webhook`

After registration, install the app at:
`{GITHUB_HOST}/apps/{slug}/installations/new`

## 0005 details

Device enrollment for the Torbit Outlook bridge (spec #6, see `docs/bridge-spike.md` and
`docs/bridge-signing.md`). Off unless `ORBIT_MAIL_BRIDGE_REGISTRY_PATH` is set and mail is
on for the instance; then the routes answer 404.

```
POST   /api/v1/workspaces/{workspace_id}/mail/bridge/devices            {name, public_key}
GET    /api/v1/workspaces/{workspace_id}/mail/bridge/devices
DELETE /api/v1/workspaces/{workspace_id}/mail/bridge/devices/{device_id}
```

- Session auth only. A member sees and revokes their own devices; a workspace owner or
  admin can revoke any device of the workspace.
- The registry is one JSON file, written atomically; a missing file means no devices. The
  delivery endpoint (ticket #10) looks devices up with `mail_bridge::BridgeRegistry::lookup`.
- Each workspace gets a verified domain `<workspace id without hyphens>.bridge.invalid` and each
  enrolled member a personal mailbox on it (a member with a personal mailbox keeps it).
- `DnsChecker::check_domain` skips `*.invalid` domains, so the daily check never suspends it.
- Tests: `apps/server/tests/mail_bridge.rs`. The generated SDK in `packages/api` is not
  regenerated by this patch.

## Generating a patch

Use `git format-patch` from the authoring fork; do not edit the `.patch` file.

```bash
git format-patch v0.3.0..release/cx-v0.3.0 \
  --output-directory ../torbit/patches
```

Keep the subject, author, date, and body. Rename to
`NNNN-type-slug.patch` and add the name to `series`.

## Rebase notes

`verify.ps1` checks the whole series cumulatively. When a patch fails:

1. Reproduce on the authoring branch with `git am -3`.
2. Resolve conflicts with `git rerere` enabled.
3. Build and run the Windows tests.
4. Re-export the patch and rerun `verify.ps1`.

Do not add a custom migration for torbit-only schema. Create an unmanaged
`torbit_*` table at startup instead. Upstream is already past `0099` on `main`;
a custom migration makes the database unreadable by stock Orbit.

## 0007 details

`apps/web/src/app/ForkNotice.tsx` shows a toast when the web app opens: "torbit is
Torben's unofficial fork of Orbit and is not affiliated with or supported by
coollabsio." It links upstream Orbit and this repository. Dismissing it (button,
close or swipe) stores `torbit:fork-notice-dismissed:v1` in `localStorage`; with
blocked storage it shows every time. The logic is in `forkNoticeState.ts`, with
unit tests. Orbit has no About or version page, so there is nothing else to
change. The mobile app is not built by this repository, so it is not ported.

## 0008 details

`add_security_headers` set `Cross-Origin-Opener-Policy: same-origin` on every
response. Per the HTML Living Standard, a nested browsing context (an iframe)
must not load a `same-origin` response, so browsers aborted the navigation of
`/api/v1/mail/content/{token}` and the web reading pane showed a broken
document instead of the message body (torbit issue #23).

Additionally, the base Content Security Policy defined `frame-src` without
`'self'` (`frame-src blob: https://www.youtube-nocookie.com https://player.vimeo.com`),
preventing browsers from framing the app's own `/api/v1/mail/content/{token}` endpoint
(torbit issue #29).

A handler that sets its own CSP (the sandboxed mail view document, the only
one) now gets `Cross-Origin-Opener-Policy: unsafe-none` instead, like its
framing rules; its sandbox CSP keeps the frame from reaching the app. Every
other response still isolates its opener. The base CSP also includes `'self'`
in `frame-src`. Tests:
`crates/platform/src/http/security.rs`,
`crates/platform/tests/http_security.rs` and the real document in
`apps/server/tests/mail_content.rs`. The fix is generic and belongs upstream;
the authoring branch is `fix/mail-html-frame-coop` on
[`t128n/orbit`](https://github.com/t128n/orbit).

## 0009 details

Mermaid diagrams (code blocks in tasks, comments, chat and docs) are drawn by
[Pele](https://pele.run) instead of Mermaid.js: same Mermaid syntax, a tenth of
the bundle (230 kB against 1.6 MB gzip), no dependencies. Code:

- `apps/web/src/components/common/MermaidDiagram.tsx` — `render()` draws the
  SVG synchronously. Mermaid's `<style>` in the SVG lost to the production CSP
  (`style-src 'self'`), which took a copy of the rules into a constructed style
  sheet and a second drawing; Pele references `--pele-*` variables instead and
  writes no `<style>`, so all of that is gone. Its style attributes are allowed
  (`style-src-attr 'unsafe-inline'`).
- `apps/web/src/index.css` — the `--pele-*` variables mapped to the app colours
  on the root of every picture (class `pele`). The theme switches live, without
  the second render per theme Mermaid needed; the series colours (pie slices,
  git branches) keep Pele's defaults.
- `apps/web/package.json`, `bun.lock` — `pele ^1.13.0` for `mermaid ^12.2.0`.

The `mermaid` code fence, the language detection (`packages/editor`) and the
diagram types are unchanged; the drawing cache keeps a chat message that scrolls
back into view at once.
