# Slice 3 — Enrichment at depth: LLM overlay writer, staleness workflow, subsystem overviews

**Goal:** make the MCP genuinely useful on repos with sparse doc comments (requirement 10) by adding an LLM producer to the enrichment layer, a workflow for keeping enrichment fresh, and curated subsystem overviews for scope / separation-of-concerns answers.

Builds on the layer shipped in slice 1 ([decision 0004](../decisions/0004-enrichment-layer.md)): overlays keyed by stable IDs with provenance and `sourceContentHash`.

## Work breakdown

### 1. LLM overlay writer (3–4 days)

- New `enrichment` producer: for each file/symbol lacking a `human` overlay (or whose `llm` overlay is stale), send the code + surrounding context (imports, siblings, existing comments) to an LLM and write an overlay entry (`provenance: llm`).
- **Content-hash caching is the cost control:** a symbol is only re-summarized when its hash changes. First run on a repo is the only expensive one.
- Provider-agnostic client interface; first implementation Anthropic API (configurable model), API key via env var; hard budget caps (max files/run, max tokens/run) and a dry-run mode reporting what would be summarized.
- Batch prompts per file (summarize file purpose + each symbol in one call) to keep cost/latency sane; structured output validated against the overlay schema.
- Runs as an optional pipeline stage after extraction (`enrich: { llm: true }` per repo config) and as a CLI command (`necronomidoc enrich <repo>`).

### 2. Staleness workflow (1–2 days)

- Build report lists stale overlays (human ones especially) per rebuild; surfaced in `GET /api/status`, on the site (subtle "may be outdated" badge), and in MCP responses (`stale: true` already flows from slice 1).
- Policy per repo config: stale `llm` overlays auto-regenerate on next enrich run; stale `human` overlays never auto-overwritten — flagged for review instead.
- `necronomidoc enrich --review-stale` emits a reviewable diff-style report (old summary vs current code) to make human re-curation quick.

### 3. Subsystem overviews (2–3 days)

- Subsystem = named group of files/directories with a purpose statement, boundaries ("owns X, does not do Y"), key entry points, and relationships to other subsystems — precisely the separation-of-concerns context agents need to avoid duplicate implementations.
- Sources, same precedence as all enrichment: human overlay files (`subsystems.yaml`) > LLM-proposed (from directory structure + import graph clustering) > heuristic (top-level directories).
- Rendered as site section pages and served by `get_subsystem_overview`; `search_docs` indexes them.

### 4. MCP quality pass (1–2 days)

- Evaluate with a scripted agent harness: a set of "does something like X already exist?" questions with known answers against a dogfood repo; measure tool-call answer quality before/after LLM enrichment.
- Tune tool descriptions and response shapes based on real agent transcripts (Claude Code / Cursor).

## Acceptance criteria

1. On a repo with <20% doc-comment coverage, every file and exported symbol has a purpose summary after one enrich run; re-running with no code changes makes zero LLM calls.
2. Editing a human-curated overlay survives rebuilds and enrich runs; changing the underlying code flags it stale without overwriting it.
3. `get_subsystem_overview` answers "where does auth logic live and what shouldn't go in it?" with curated boundaries.
4. Costs visible: enrich run reports token/call counts; budget cap aborts gracefully.

## Risks

| Risk | Mitigation |
|------|-----------|
| LLM summaries wrong/confabulated | Provenance always visible; humans can override; prompts include only real code |
| Cost blowups on huge repos | Hash caching, budget caps, dry-run, per-repo opt-in |
| Import-graph clustering produces silly subsystems | Ship heuristic (directories) as floor; LLM proposals reviewed before promotion to human overlay |

**Estimated effort:** ~1.5–2 weeks.
