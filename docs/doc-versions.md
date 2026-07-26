# Documentation versions & metadata

Every repo's published documentation carries a version journal and the full
metadata of the generation run that produced it. On any doc page, the **(i)**
button at the top right opens a right-hand drawer with two sections:

- **Metadata** — everything involved in generating the current docs: where
  the source came from (URL or path), the ref and commit built, what
  triggered the build (`cli`, `enrich`, `rest`, `github`, `ado`, `generic`,
  `external-ir`), which extraction adapters ran, when it was generated and
  last rebuilt, file/symbol counts, source-snapshot count, enrichment
  coverage (human / llm / heuristic, plus stale counts), and the state
  hashes.
- **Version history** — the journal of documentation states, newest first,
  clearly separated from the metadata above. Each entry shows its version
  number, when it appeared, the commit and trigger, counts, and its state
  hash; the current version is highlighted. **Select a version to preview
  it** — its docs and source open read-only, with a banner back to the live
  docs (see [previewing a past version](#previewing-a-past-version)).

## How versioning works

The journal lives at `<dataDir>/repos/<slug>/versions.json` (served at
`/data/repos/<slug>/versions.json`) and is written inside the same atomic
per-repo swap as the doc model.

Every publish computes a **docs hash** over the merged documentation state —
extracted facts, enrichment overlays, subsystems, and core-doc content, with
volatile fields (timestamps, commit identity) excluded. Then:

- **hash changed** → a new version entry is prepended (`version` increments);
- **hash unchanged** → no new version; the current entry records the rebuild
  (`lastRebuiltAt`, `rebuilds`).

So versions track *documentation changes*, not build activity: a webhook
storm that rebuilds identical docs five times is one version with five
rebuilds, while a push that changes a doc comment is a new version. The
journal keeps the most recent 50 versions.

Two hashes are recorded per entry:

| Hash | Covers | Changes when |
|---|---|---|
| `docsHash` | The published documentation state (facts + enrichment + subsystems + core docs) | Anything a reader sees changes |
| `contentHash` | The extracted files only (`repoContentHash`) | The documented code itself changes |

A version where `docsHash` moved but `contentHash` didn't means the change
was pure enrichment/curation (e.g. `necronomidoc enrich` wrote new
summaries).

## Previewing a past version

Selecting a version in the drawer opens it in **read-only historical mode**
(`?docv=N` in the URL). The whole doc surface is served from that version's
retained content — the file inventory, each file's symbols and enrichment, and
the source viewer all reflect the code as it was in that version, not today's.
A banner names the version and links back to the live docs, and every
in-page link (files, cross-references, symbols, source lines) keeps the
preview sticky so you can browse the old state coherently. A file that didn't
exist yet in that version shows a short notice instead.

This works because each new version's published state is **archived** under
`repos/<slug>/versions/<version>/` (its doc model, source snapshots, and core
docs) at publish time, carried across the atomic swap. Archives are served
like every other manifest (source as `text/plain`) under the same auth gate.

**Retention.** Full content is kept for the **last 10 versions** — source
copies are heavy, so older versions keep their metadata in the journal (up to
50) but become non-previewable; the drawer marks them "not retained". The
current version is always previewable (it is the live state). Bump the cap by
changing `ARCHIVE_KEEP` if you want deeper history at the cost of disk.

## What "who and where from" means here

The journal records the machine-verifiable provenance the pipeline has:
source URL/path, ref, commit SHA, trigger, and adapters. Webhook payloads'
pusher/author identity is deliberately not recorded — the ingest layer
normalizes triggers down to provider + ref + commit (see
[automated ingestion](ops-ingestion.md)), and a commit SHA is a stronger
audit anchor than a display name. To see *who* made a change, follow the
commit into the source repo.

## Limits

- Content is retained for the last 10 versions only; older versions are
  metadata-only and not previewable. Full point-in-time recovery of *every*
  past build remains a data-dir snapshot concern
  ([backup & restore](deploy/backup-restore.md)).
- Repos built before this feature have no journal until their next build; the
  archive begins at that build.
- The drawer needs a running server (no journal in static exports).
- The per-build *attempt* log (including failures, which never publish and
  therefore never version) is separate: `/api/status` and the
  [build status page](ops-ingestion.md).
