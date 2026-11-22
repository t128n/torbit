# torbit-bridge

TypeScript source of the Outlook bridge, compiled with [Bun](https://bun.sh) into one `torbit-bridge.exe`.
User documentation: [docs/bridge.md](../docs/bridge.md); wire format: [docs/bridge-signing.md](../docs/bridge-signing.md).

```text
src/main.ts, src/cli.ts           CLI entry: setup doctor install uninstall upgrade run backfill status revoke start stop logs version
src/commands/                     the commands (lifecycle: setup/install/uninstall/upgrade; ops: run/backfill/status/...; checks: doctor)
src/core/                         portable: config/state, signing, MIME rebuild, delivery, sweep, enroll/revoke, doctor, update
src/platform/windows/             CNG key (bun:ffi -> ncrypt.dll), Outlook (PowerShell COM helper), Task Scheduler (schtasks), proxy, run lock
src/platform/fileKeys.ts          other OS: development stub (file key, no Outlook, no task scheduler)
```

```bash
cd bridge
bun install
bun test                  # runs anywhere; includes tests/bridge-vectors.json
bun run typecheck
bun run build             # dist/torbit-bridge.exe; cross-compiles from Linux/macOS too
bun src/main.ts doctor    # run from source (Windows: needs classic Outlook for the Outlook check)
```

The Windows-only parts (CNG, Outlook, Task Scheduler) cannot run in Linux CI. `bun test` covers their pure
logic (task XML, proxy parsing, error mapping); CI runs `scripts/smoke.ts` against the built exe on a Windows
runner (CNG key, enrollment against a fake Orbit, logon task register/remove). The Outlook helper needs a real
PC: run `torbit-bridge doctor` and the checklist in docs/bridge.md before a release.
