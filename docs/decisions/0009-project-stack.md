# 0009 — Project-wide stack: TypeScript everywhere; frontend is React + Vite + React Router

- **Status:** Accepted
- **Date:** 2026-07-10
- **Decider:** Luke (project owner)

## Context

Mid-design, the owner set a binding constraint: **this project must be TypeScript + React + Vite + React Router, unless it is using a modified existing doc system off the shelf.**

## Decision

- **TypeScript** for all code: server, extraction adapters, site, shared schema packages. Single language keeps the central-pull server's toolchain footprint minimal ([0003](0003-central-server-pull-ingestion.md)) and lets Zod schemas serve as the single source of truth ([0006](0006-intermediate-representation.md)).
- **Frontend:** React + Vite + React Router 7. The chosen doc UI, Fumadocs, runs on exactly this stack ([0005](0005-doc-ui-framework.md)) — so we satisfy the constraint *and* still get an off-the-shelf doc system; if Fumadocs is ever dropped, the replacement must still be React + Vite + React Router.
- **Server:** Node.js + TypeScript, Hono (fetch-portable, serves static + MCP + ingestion API per [0008](0008-mcp-serving.md)).
- Monorepo (npm/pnpm workspaces) so schema, adapters, server, and site share types.

## Consequences

- No framework lock to Next.js or any meta-framework; builds are Vite-fast and the output is a true SPA.
- Contributors need only Node + one repo to work on any part of the system.
