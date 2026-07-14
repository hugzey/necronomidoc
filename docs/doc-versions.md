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
  hash; the current version is highlighted.

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

## What "who and where from" means here

The journal records the machine-verifiable provenance the pipeline has:
source URL/path, ref, commit SHA, trigger, and adapters. Webhook payloads'
pusher/author identity is deliberately not recorded — the ingest layer
normalizes triggers down to provider + ref + commit (see
[automated ingestion](ops-ingestion.md)), and a commit SHA is a stronger
audit anchor than a display name. To see *who* made a change, follow the
commit into the source repo.

## Limits

- The journal records metadata about past versions; it does **not** archive
  the manifests themselves. You cannot browse the *content* of version 3 —
  only see when it existed and what it was built from. Point-in-time content
  recovery remains a data-dir snapshot concern
  ([backup & restore](deploy/backup-restore.md)).
- Repos built before this feature have no journal until their next build.
- The drawer needs a running server (no journal in static exports).
- The per-build *attempt* log (including failures, which never publish and
  therefore never version) is separate: `/api/status` and the
  [build status page](ops-ingestion.md).
