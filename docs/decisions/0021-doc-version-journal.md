# 0021 — Documentation versioning: per-repo state journal + info drawer

**Status:** Accepted

## Context

Publishes overwrite `repos/<slug>/` in place; the only history was the
rolling 20-entry build *attempt* log in `status.json` (admin-oriented,
failure-inclusive, capped short). Readers had no answer to "which state of
the docs am I looking at, generated from what, by what, when — and when did
it last change?", and generation metadata (trigger, adapters, enrichment
coverage, commit) was scattered across `status.json`, `registry.json`, and
the model itself.

## Decision

1. **A per-repo version journal, published as a manifest.**
   `repos/<slug>/versions.json` (Zod-schema'd in docmodel like every wire
   shape) is folded on each publish inside the atomic swap. Each entry
   carries the generation run's full metadata: source URL/path, ref,
   commit, trigger, adapter stack, timestamps, file/symbol counts,
   enrichment totals, snapshot count, and two hashes.
2. **Versions track documentation state, not build activity.** A publish
   computes a `docsHash` over the merged state (files + enrichment +
   subsystems + core-doc content, volatile fields excluded). Hash moved →
   prepend the next version; hash unchanged → bump `lastRebuiltAt`/
   `rebuilds` on the current entry. `contentHash` (`repoContentHash`) is
   recorded alongside so pure-curation versions are distinguishable from
   code changes. The journal keeps 50 metadata entries.
2a. **Past versions are previewable, within a retention window.** Each new
   version's published content (doc model + source snapshots + core docs) is
   archived under `repos/<slug>/versions/<N>/`, staged into the same atomic
   swap (previous archives carried forward, pruned to the newest
   `ARCHIVE_KEEP` = 10). An `archived` flag on each journal entry marks what
   is retained. The site serves a read-only historical view (`?docv=N`) that
   sources the whole doc surface — file inventory, symbols, and the source
   viewer — from the archive, with navigation kept sticky to the version.
   This supersedes the original "metadata only, no content archive" scope;
   full point-in-time recovery of *all* builds remains a data-dir snapshot
   concern (decision 0002's fs-only state).
3. **Surfaced by an (i) info drawer on every repo doc page.** Right-hand
   drawer, two clearly separated sections: current-build metadata, then
   version history. Server-published manifest + one fetch — no new API
   endpoint, works through the existing `/data` allowlist and auth gate.
4. **Provenance is what the pipeline can verify.** Trigger provider, ref,
   commit — not webhook display names. "Who" resolves through the commit in
   the source repo.

## Consequences

- Failed builds never version (they never publish) — the journal is a
  history of what readers actually saw, complementing, not replacing, the
  status log's attempt/failure view.
- Rebuild storms don't inflate history; `enrich` runs that change summaries
  correctly mint a new version with an unmoved `contentHash`.
- `docsHash` relies on deterministic model serialization (adapters sort
  files; JSON key order is construction order). A serialization change in a
  future server version may mint one spurious version per repo on first
  rebuild — harmless and self-healing.
- Old journals survive corruption defensively: an unreadable
  `versions.json` restarts history rather than failing the publish.
