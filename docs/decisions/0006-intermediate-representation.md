# 0006 — Custom versioned JSON IR as the common documentation model

- **Status:** Accepted
- **Date:** 2026-07-10
- **Decider:** Project (from [research 02](../research/02-doc-extraction-adapters.md))

## Context

The adapter pattern (requirement 5.1) needs a common intermediate model that every language adapter emits and every consumer (site builder, MCP manifests, search index) reads. Candidates included adopting an existing interchange format: TypeDoc's serialized model (TS-only, churns with TypeDoc versions), API Extractor's `.api.json` (excellent design but package-API-scoped — it erases file structure, which is exactly what our per-file MCP needs), DocFX Universal Reference YAML (effectively dead outside .NET), Doxygen XML (C-family oriented, XML). No living cross-language, file-rooted interchange format exists.

## Decision

Define **our own small, versioned, file-rooted JSON IR** ("DocModel"). Principles:

- **File-rooted:** the primary tree is `repo → files[] → symbols[]`, because the MCP's unit of answer is "what is this file / this function for". (API-rooted views are derived, not primary.)
- **Facts only:** names, kinds (function/class/component/endpoint/...), signatures, doc comments as written, source locations, exports, cross-references, component props, OpenAPI operations. No derived summaries — those live in the enrichment overlay ([0004](0004-enrichment-layer.md)).
- **Stable IDs:** every entity has a deterministic ID (`repo:path#symbolPath`) used by enrichment overlays, site URLs, search, and MCP tools.
- **Versioned schema:** `schemaVersion` field; schema defined as Zod schemas in a shared TypeScript package (single source of truth → runtime validation + inferred types + JSON Schema export for non-TS adapter authors).
- **Content hashes:** per-file and per-symbol hashes to support enrichment staleness detection and incremental rebuilds.
- Adapters absorb upstream churn: e.g. the TypeScript adapter consumes TypeDoc JSON internally but the IR never exposes TypeDoc types.
- OpenAPI is "just another adapter": specs parse into the same IR (`kind: endpoint` symbols rooted at the spec file), so the site/MCP treat REST surface like code surface. Rich interactive rendering may still read the raw spec.

## Consequences

- We own a schema (design + docs burden), but consumers get stability no third-party format offers, and mining API Extractor/DocFX for design ideas keeps us from reinventing badly.
- Non-TS adapters (Python griffe, C# DocFX metadata, etc.) have a clear contract: emit DocModel JSON, validated at ingest.
- Schema evolution needs discipline: additive by default, migrations on major bumps.
