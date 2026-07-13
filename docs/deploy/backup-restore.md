# Backup, restore & upgrades

## What to back up

**Everything the server knows lives in the data dir** (`DOCS_DATA_DIR`, `/data` in the container). Snapshot that one directory and you can rebuild the host from nothing:

| Contents | Regenerable? |
|----------|--------------|
| `repos.json` (source registry) | no — **curated** |
| `enrichment/<repo>/` (human + LLM overlays) | no — **curated** (LLM overlays re-cost money to regenerate) |
| `repos/<slug>/` (built doc manifests) | yes — rebuild from source |
| `clones/` (shallow clones) | yes — re-fetched on next build |
| `status.json`, `queue.json`, `meta.json` | build history / queue journal / schema stamp |

## Full backup (disaster recovery)

- **EC2 / EBS:** put the data dir on its own EBS volume and schedule snapshots (Amazon Data Lifecycle Manager). Restore = attach a snapshot volume to a new instance.
- **Azure App Service:** the data dir lives on the persistent storage mount (`WEBSITES_ENABLE_APP_SERVICE_STORAGE` or an Azure Files mount) — use App Service backups or Azure Files snapshots.
- **Anywhere:** plain tar works because state is only files:

  ```bash
  tar -C "$DOCS_DATA_DIR" -czf necronomidoc-backup-$(date +%F).tar.gz .
  ```

  (For a hot backup, either pause pushes briefly or run it twice — a build finishing mid-tar can leave a partial repo entry; the atomic-swap publish keeps each repo's manifest dir internally consistent.)

### Restore

```bash
mkdir -p /var/lib/necronomidoc
tar -C /var/lib/necronomidoc -xzf necronomidoc-backup-2026-07-13.tar.gz
DOCS_DATA_DIR=/var/lib/necronomidoc node packages/cli/dist/index.js serve
```

That is the whole procedure — no schema imports, no rebuilds. The restored host serves the docs, MCP manifests, registry, and build history exactly as snapshotted (slice 6 acceptance criterion 3). Webhook/API secrets are **not** in the data dir (they are env vars by design) — restore those from your secret store.

## Curation export (versioned, git-friendly)

`necronomidoc export <dir>` copies just the hand-maintained state — `repos.json` and `enrichment/` — plus a README into a directory sized for a git repo:

```bash
node packages/cli/dist/index.js export ../docs-curation
cd ../docs-curation && git add -A && git commit -m "curation snapshot"
```

Use it to review overlay changes in PRs, share curation across hosts, or keep a lightweight recovery point when full snapshots are overkill. Restore by copying the files back into the data dir and rebuilding.

## Upgrades

1. Bump the image tag (Docker) or `git pull && npm ci && npm run build:all` (bare metal) and restart.
2. On startup the server checks the data dir's schema stamp (`meta.json`):
   - same version → serves immediately;
   - older version → migrated (or explicitly refused with instructions) — never silently misread;
   - **newer** version (i.e. you *downgraded* the binary) → refuses to start with a clear error.
3. Roll back by restoring the pre-upgrade snapshot and running the previous image.
