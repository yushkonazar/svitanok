# Release compatibility contract

Each brain build writes `brain/dist/release-manifest.json`. It binds one immutable
brain artifact to its repository SHA and SHA-256 digests of the Worker config,
tool schema, instruction sources and ordered D1 migration set. The manifest is
evidence for a release/smoke check; it does not pretend that a D1 migration has
already reached production.

## Migration rule

Every migration starts with `-- release-phase: expand` or
`-- release-phase: contract`; the build manifest records that declaration.
Every normal release is **expand-only**: adding nullable columns, new tables,
indexes and backward-compatible code paths is allowed. A changed
`contract` migration makes `migrate.yml` fail unless a maintainer manually
enters `allow-contract` and supplies restore-drill evidence. Removing a column,
renaming a contract or making an old value unreadable requires that separate
contract release after a documented soak period and a backup/restore drill. The
Worker must tolerate both schema versions during that period.

## One-time VPS bootstrap

This repository does not apply the bootstrap to production. An operator must do
it once on the VPS, review the paths and preserve the old service until `/ready`
is green:

1. Keep the existing clone at `/opt/svitanok-brain`; create directories owned by
   user `brain`: `/opt/svitanok-brain-releases` and
   `/opt/svitanok-brain-shared/data`.
2. Move the existing brain environment file to
   `/opt/svitanok-brain-shared/brain.env` with mode `0600`.
3. Install [svitanok-brain.service](../brain/svitanok-brain.service) as
   `/etc/systemd/system/svitanok-brain.service`, run `systemctl daemon-reload`,
   and create `/opt/svitanok-brain-current` as a symlink to the known-good
   release. The service user needs write access only to the two release/shared
   directories and permission to restart this one unit.
4. Verify `curl -sf http://127.0.0.1:8788/ready`, then create the marker file
   `/opt/svitanok-brain-shared/release-layout-v1`.

Until that marker exists, `deploy-host.yml` fails before it changes the live
service. This is intentional: a partially converted VPS is less safe than the
current known-good deployment.

## Release and rollback

`deploy-host.yml` runs `.github/scripts/deploy-brain-release.sh` from the exact
target commit. It creates/reuses `git worktree` release
`/opt/svitanok-brain-releases/<sha>`, builds it there, verifies its manifest,
then swaps `/opt/svitanok-brain-current` with an atomic rename and restarts the
service. `/ready` must include the full expected SHA. Otherwise the script puts
the previous symlink back and restarts the previous release before failing.

No release directory is pruned automatically. Cleanup is a separate operational
action after a rollback checkpoint and backup/restore evidence.

## Clean restore drill

Run `BACKUP_ENC_KEY=... npm run restore:drill -- --file <backup.enc>` before a
contract migration or at the scheduled recovery check. The command decrypts
the selected backup, applies all current migrations to a fresh in-memory SQLite
database, restores the document, rebuilds FTS and semantically compares every
backed-up row. It cannot reach Cloudflare, write KV, or apply a remote restore;
its successful output is suitable evidence for the `restore_evidence` workflow
input. A production restoration remains a separately authorized operational
action.
