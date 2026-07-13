# 0019 — Documentation standard: one written standard, scaffolded templates, advisory doctor checks

**Status:** Accepted (slice 8)

## Context

The server can extract, enrich, and generate — but teams keep asking what
"good" source documentation looks like in the first place: which comments to
write, which supporting documents to keep, and how to make both serve two
audiences at once (humans reading the site, LLM agents consuming MCP/llms.txt
context). Without a standard, curation is ad-hoc and the LLM tiers fill gaps
that cheap human sentences would have filled better.

## Decision

1. **One written standard, shipped in this repo as
   [docs/doc-standard.md](../doc-standard.md)**, with three commitments:
   *conventional* (per-language idioms — TSDoc/JSDoc, PEP 257 docstrings,
   C# XML docs — not a bespoke syntax), *complete for humans* (the four core
   documents + purpose-first comments answer the newcomer questions), and
   *optimal for agents* (purpose-first sentences, explicit boundaries,
   stable names — the exact fields extraction, MCP tools, and generation
   prompts consume).
2. **Executable templates over prose-only rules**: `necronomidoc init-docs
   <repo>` scaffolds `.necronomidoc/docs/{overview,conventions,packages,
   architecture}.md` plus a `.necronomidoc/README.md`, each template carrying
   its section skeleton, guidance comments, and `TODO(doc):` markers.
   Templates are embedded in the server package as constants (no packaged
   asset files to lose across install layouts). Existing files are never
   overwritten without `--force` — curation beats templates.
3. **Advisory enforcement only**: `necronomidoc doctor` reports per
   registered repo which core docs are repo-curated, leftover `TODO(doc):`
   markers, a missing title heading, and an architecture doc without a
   mermaid/ASCII diagram. Findings never fail a build or change doctor's
   exit code — the heuristic floor (decision 0015) guarantees every repo is
   documented, so the standard's job is to *upgrade* docs, not gate them.

## Consequences

- The standard aligns with what the pipeline already rewards: following it
  directly improves extraction output, enrichment skip-rates (human
  provenance wins), core-doc precedence, and skill/artefact grounding.
- Advisory-only means adoption is gradual and non-blocking; a team that
  wants hard gates can grep doctor output in CI themselves. Revisit if
  demand for enforced mode is real (would need per-repo opt-in config).
- Template drift is possible (standard doc vs embedded constants live in
  two places); both change rarely and in the same PRs.
