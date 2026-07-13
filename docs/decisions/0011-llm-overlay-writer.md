# 0011 — LLM overlay writer: Anthropic SDK, per-file batching, hash-cached

**Status:** Accepted (slice 3) — amended by [0016](0016-llm-provider-agnostic.md): the client is now selected per provider (Anthropic / OpenAI-compatible / Bedrock) or replaced entirely by the agent task export/import loop; `ANTHROPIC_API_KEY` is no longer required.

## Context

Decision [0004](0004-enrichment-layer.md) reserved a `llm` provenance tier in
the enrichment layer. Slice 3 implements the producer: on repos with sparse doc
comments, every file and exported symbol should get a purpose summary without a
human writing it. The producer must be cheap to re-run, must never fight human
curation, and must not tie the enrichment layer to one vendor.

## Decision

1. **Provider-agnostic client interface.** The writer depends on a one-method
   `LlmClient` (`complete(request) → {text, tokens}`); the first implementation
   is `AnthropicLlmClient` over the official `@anthropic-ai/sdk`, default model
   `claude-opus-4-8` (configurable via `--model` / `NECRONOMIDOC_ENRICH_MODEL`,
   API key via `ANTHROPIC_API_KEY`). Structured output (a JSON Schema the
   response must match) is enforced server-side where the provider supports it,
   with zod validation as the backstop.
2. **One batched call per file.** The prompt carries the file source (truncated),
   its imports, and the symbols needing summaries; the response returns the file
   summary plus every symbol summary in one JSON object. This keeps cost and
   latency proportional to files, not symbols.
3. **Content-hash caching is the cost control.** Every written overlay records
   `sourceContentHash`. A target is re-summarized only when its hash changes, so
   the first run on a repo is the only expensive one and re-runs on unchanged
   code make zero calls.
4. **Precedence is enforced at load time.** `loadOverlays` resolves collisions
   by provenance (human > llm > heuristic) before directory order, so a
   server-side LLM overlay can never shadow a human overlay curated in the repo.
   Stale human overlays are flagged for review (`enrich --review-stale`), never
   overwritten; stale llm overlays regenerate on the next run.
5. **Hard budget caps.** `--max-files` and `--max-tokens` bound every run;
   hitting a cap aborts gracefully (already-generated overlays are kept) and
   `--dry-run` reports the plan without any calls. Run reports always include
   call and token counts.

## Consequences

- LLM overlays live server-side (`data/enrichment/<slug>/llm.json`), outside
  the atomically-swapped repo dir, and survive rebuilds like human curation.
- Swapping providers means implementing one interface; the writer, caching,
  and budget logic are provider-independent.
- Summaries are only as current as the last enrich run; the staleness report
  on every rebuild makes the gap visible (`stale` counts on `/api/status`).
