# torbit-bridge

Go source of the Outlook bridge. User documentation: [docs/bridge.md](../docs/bridge.md);
wire format: [docs/bridge-signing.md](../docs/bridge-signing.md).

```text
main.go, commands.go, upgrade.go   CLI: setup doctor install uninstall upgrade enroll revoke status run backfill start stop logs
internal/core                      portable: config/state, signing, MIME rebuild, delivery, sweep, enroll/revoke, doctor, update
internal/platform                  Windows: CNG key, Outlook COM (go-ole), service + session launcher, proxy, UAC relaunch
                                   other OS: development stubs (file key, no Outlook, no service)
```

```bash
cd bridge
go test ./...                          # runs on Linux; includes tests/bridge-vectors.json
GOOS=windows go vet ./...              # type-checks the Windows code
GOOS=windows GOARCH=amd64 go build -ldflags "-X main.version=$(cat ../VERSION)" -o dist/torbit-bridge.exe .
```

The Windows-only code (CNG, COM, service, elevation) cannot run in Linux CI. It
compiles and vets there; run `torbit-bridge doctor` and the checklist in
docs/bridge.md on a real PC before a release.
