# 0007 — TypeScript/React extraction stack for the first vertical slice

- **Status:** Accepted
- **Date:** 2026-07-10
- **Decider:** Project (from the doc-extraction adapter research)

## Context

Slice 1 documents a TypeScript React frontend repo. Candidates: TypeDoc JSON, API Extractor, react-docgen(-typescript), raw ts-morph/compiler API. Key constraint: we need **per-file and per-function coverage including non-exported symbols** (MCP purpose docs), while TypeDoc's model is entry-point/export oriented and API Extractor is public-package-API oriented.

## Decision

The TypeScript adapter composes three extractors, all feeding the IR ([0006](0006-intermediate-representation.md)):

1. **ts-morph sweep (primary for coverage):** walk every source file; collect all declarations (exported or not), signatures, JSDoc/TSDoc comments, file-level module docs, imports/exports. Guarantees the file-rooted, whole-repo coverage the MCP needs.
2. **TypeDoc `--json` (secondary, richer API semantics):** typed reflection model for exported API surface (inheritance, type parameters, cross-links) where entry points are configured. Merged into the same IR entities by symbol ID; optional per repo.
3. **react-docgen-typescript (component props):** prop tables for React components (resolves imported prop types), attached to the component's IR symbol.

Operational notes: run against the cloned repo's `tsconfig`; if type resolution needs `node_modules`, install with `--ignore-scripts` inside the build sandbox; extraction never executes target-repo code.

## Consequences

- ts-morph gives us full-repo granularity TypeDoc can't; TypeDoc remains optional richness rather than a hard dependency — repos with broken entry-point config still get documented.
- Three tools to version-pin, but each is isolated inside the one TS adapter package.
- Extraction cost is static-analysis only (no target build), keeping central-pull ingestion ([0003](0003-central-server-pull-ingestion.md)) cheap.
