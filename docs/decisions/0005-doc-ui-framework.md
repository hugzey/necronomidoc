# 0005 — Doc UI: Fumadocs on React Router 7 + Vite (TypeScript React SPA)

- **Status:** Accepted
- **Date:** 2026-07-10
- **Decider:** Luke (project owner), informed by [research 01](../research/01-doc-ui-frameworks.md)

## Context

Requirements 1–3: a React SPA, optionally built on an existing doc UI (Starlight, Fumadocs, etc.). The owner added a binding stack constraint: **the project must be TypeScript + React + Vite + React Router, unless it uses a modified off-the-shelf doc system.**

Research findings (mid-2026):

- **Fumadocs** (v16.x) is React-based, officially supports **React Router 7 on Vite** (in addition to Next.js), supports fully static builds (SPA mode + prerender), has a headless Source API designed for programmatic multi-source content, first-party OpenAPI rendering (`fumadocs-openapi`) and TypeScript type tables, and Orama client-side static search.
- **Docusaurus** is a mature React SPA but is webpack/Rspack-based (not Vite) and its content pipeline is plugin/filesystem-oriented — usable, but off-stack.
- **Starlight** is Astro (MPA, React only as islands) — fails both the React-SPA requirement and the stack constraint.
- **Nextra** is Next.js-locked; **VitePress** is Vue. Both disqualified.

## Decision

Build the doc site as a **Fumadocs application on React Router 7 + Vite**, in TypeScript, using:

- `fumadocs-core` Source API with a **custom content source** fed by our IR + enrichment merge output (not filesystem MDX authored by hand — content is generated).
- `fumadocs-ui` for layout/navigation/theming, customized as needed (this satisfies "modified existing doc system off the shelf" while *also* satisfying the exact stack constraint).
- `fumadocs-openapi` / embedded Scalar for OpenAPI spec pages (later slice).
- Orama (or MiniSearch) static client-side search over a build-time index — no search server.
- Static output per repo section, rebuilt by the ingestion pipeline and served by the portable server ([0002](0002-hosting-portability.md)).

Fallback if Fumadocs' React Router support proves too immature during the slice-1 spike: keep React Router 7 + Vite and use `fumadocs-core` headless (or fully custom components) — the stack constraint holds either way; only the UI-kit layer would change.

## Consequences

- One framework satisfies the SPA, React, Vite, React Router, static-hosting, OpenAPI, and programmatic-content requirements simultaneously.
- Fumadocs moves fast with a small maintainer team — pin versions, wrap its APIs behind our own thin site-build module so churn is absorbed in one place.
- Slice 1 must include a short spike validating: React Router SPA static build, custom source feeding generated content, and client-side search over generated pages.
