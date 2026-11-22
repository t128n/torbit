# torbit-bridge

TypeScript source of the Outlook bridge, compiled with [Bun](https://bun.sh) into one `torbit-bridge.exe`.
User documentation: [docs/bridge.md](../docs/bridge.md); wire format: [docs/bridge-signing.md](../docs/bridge-signing.md).

```text
src/main.ts, src/cli.ts           CLI entry: setup doctor install uninstall upgrade run backfill status revoke start stop logs version
src/commands/                     the commands (lifecycle: setup/install/uninstall/upgrade; ops: run/backfill/status/...; checks: doctor)
src/core/                         portable: config/state, signing, MIME rebuild, delivery, sweep, enroll/revoke, doctor, update
src/platform/windows/             CNG key (bun:ffi -> ncrypt.dll), Task Scheduler (schtasks), proxy, run lock
src/platform/mcp/                 msoutlook-mcp client: Streamable-HTTP JSON-RPC + the Adapter mapping
src/platform/fileKeys.ts          other OS: development stub (file key, no task scheduler)
```

Runtime dependency: **msoutlook-mcp 0.2.0 or later** must be installed, its daemon
running, and its logon task enabled. It owns the classic Outlook COM session the
bridge reads; the bridge never starts PowerShell or COM itself.

```bash
cd bridge
bun install
bun test                  # runs anywhere; includes tests/bridge-vectors.json
bun run typecheck
bun run build             # dist/torbit-bridge.exe; cross-compiles from Linux/macOS too
bun src/main.ts doctor    # run from source (Windows: needs classic Outlook for the Outlook check)
```

The Windows-only parts (CNG, Task Scheduler) cannot run in Linux CI. `bun test` covers their pure
logic (task XML, proxy parsing) and the msoutlook-mcp adapter against a fake MCP endpoint; CI runs
`scripts/smoke.ts` against the built exe on a Windows runner (CNG key, enrollment against a fake
Orbit, logon task register/remove). The real Outlook session needs a real PC: run
`msoutlook-mcp doctor` and `torbit-bridge doctor`, then the checklist in docs/bridge.md before a
release.
