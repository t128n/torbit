# Patch series

## Model

`torbit` pins an upstream tag and applies an ordered series. Patches are
generated from the authoring fork `t128n/orbit`; they are never edited by
hand.

```text
patches/
├── series
├── 0001-feat-windows-native-service.patch
├── 0002-feat-github-enterprise-host.patch
└── ... (see `patches/README.md`)
```

`series` controls order and can carry comments:

```text
0001-feat-windows-native-service.patch
0002-feat-github-enterprise-host.patch
```

Polling is not part of the series.

## Verify

```powershell
./scripts/verify.ps1
```

This copies the real index to a temporary file, runs `git read-tree HEAD`, and
applies each patch with `git apply --cached`. The working tree and real index
are untouched. A failure names the first patch that no longer applies.

## Apply

```powershell
./scripts/apply.ps1
./scripts/apply.ps1 -Reverse
```

`apply.ps1` verifies the whole series first, then applies each patch to the
working tree. `.work/orbit` is disposable; `bootstrap.ps1` resets it.

## Rebase onto a new upstream tag

In the authoring fork:

```bash
git fetch upstream --tags
git switch -c rebase/v0.4.0 upstream/v0.4.0
git cherry-pick <feature commits>
# or: git am -3 <../torbit/patches/*.patch>
```

Resolve conflicts with `git rerere` enabled. Build and test on Windows, then
export:

```bash
git format-patch upstream/v0.4.0..HEAD --output-directory ../torbit/patches
```

Rename the files to the `NNNN-type-slug.patch` convention and update `series`.
Update `upstream.lock` and `VERSION` in the same commit.

## Do not add migrations

A custom migration makes `schema_migrations` newer than stock Orbit, so an
official binary refuses to open the database (`SchemaNewer`, `UnknownMigration`,
or `ChecksumMismatch`).

Torbit-only schema must be created by code in an unmanaged `torbit_*` table.
The GitHub host binding already uses `torbit_github_host_binding`. Keep the
prefix so an upstream feature cannot collide with it.

## Keep the series small

- One feature per patch.
- New code in new modules; touch `app.rs`, `lib.rs`, `router.rs`, and
  `integration_routes.rs` as little as possible.
- Do not patch generated files, lockfiles by hand, or `.ai/lessons.md`.
- Delete a patch when upstream accepts the feature.

## Upstream status

| Patch | Issue | State |
|---|---|---|
| Native Windows Service | coollabsio/orbit#81 | local, upstreamable |
| GitHub Enterprise host | coollabsio/orbit#82 | local, upstreamable |
| Outlook bridge, unofficial-fork notice | none | local only |
| Mail frame COOP and CSP frame-src exemption | t128n/torbit#23, t128n/torbit#29 | local, upstreamable |
| Pele diagrams | t128n/torbit#25 | local, upstreamable |
