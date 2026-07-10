# 0004 — Intermediate doc-enrichment layer (human-curated or LLM) between extraction and presentation

- **Status:** Accepted
- **Date:** 2026-07-10
- **Decider:** Luke (project owner)

## Context

The MCP's core purpose (requirement 10) is per-file and per-function *purpose* documentation. Doc comments in real repos are sparse and shift over time. We asked whether an LLM summarization pass should run during ingestion. The owner's direction: maintain an **intermediate layer for doc enrichment which can be LLM- or human-curated**, to cover sparse documentation that may shift later.

## Decision

Introduce an **enrichment layer** as a first-class stage between extraction and presentation:

- Extraction adapters emit **facts only** (signatures, doc comments as written, file/line locations, exports, references) into the IR.
- Enrichment is a separate, versioned set of **overlay documents** keyed by stable symbol/file identifiers (`repo → file path → symbol path`), each entry carrying:
  - `summary` (and optional `purpose`, `scope`, `notes`)
  - `provenance`: `human` | `llm` | `heuristic`
  - `sourceContentHash`: hash of the code entity the enrichment described when written — lets the pipeline flag enrichment as **stale** when the underlying code changes, without discarding it.
- Merge order at build time: human > llm > heuristic > raw extraction. The merged result is what the site and MCP serve; provenance and staleness are preserved in output so consumers (and LLM agents) can weigh confidence.
- Storage: enrichment overlays are plain JSON/YAML files in the data dir, editable by hand and writable by an (optional, later) LLM pass — the same format for both, which is what makes the layer curator-agnostic.
- Slice 1 ships the layer with heuristic + human sources; the LLM writer is a later slice that simply becomes another producer of overlay entries (content-hash-cached).

## Consequences

- The IR stays a pure, reproducible function of the source code; opinionated/derived content lives where it can be reviewed, versioned, and regenerated independently.
- Human curation has a clear home from day one (edit overlay files; later, possibly a UI).
- Staleness is detectable and surfaced rather than silently wrong.
- Slightly more moving parts than baking summaries into extraction, but this is exactly the flexibility the owner asked for.
