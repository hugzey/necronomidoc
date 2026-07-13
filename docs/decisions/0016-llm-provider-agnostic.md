# 0016 — Provider-agnostic enrichment: multi-provider clients + agent task export/import

**Status:** Accepted (amends [0011](0011-llm-overlay-writer.md))

## Context

Decision 0011 deliberately kept the overlay writer behind a one-method
`LlmClient` interface, but shipped only an Anthropic implementation and the
CLI hard-required `ANTHROPIC_API_KEY`. Teams run on many providers — Azure AI,
AWS Bedrock, OpenRouter, local models — and a growing group has **no**
provider API key at all: they pay for a CLI coding agent (Claude Code, Codex
CLI, …) with its own subscription-backed model access. Both groups should be
able to fill documentation gaps without infrastructure workarounds.

## Decision

1. **Three client implementations, one interface.** `AnthropicLlmClient`
   (unchanged, official SDK), `OpenAiCompatLlmClient` (zero-dependency
   `fetch` against the de-facto standard `POST {base}/chat/completions` API —
   covers OpenAI, OpenRouter, Azure AI/OpenAI v1 endpoints, Ollama, vLLM,
   LM Studio, LiteLLM, Groq, Together, …), and `BedrockLlmClient` over AWS
   Bedrock's model-agnostic **Converse** API (any Bedrock model, standard AWS
   credential chain, SDK lazily imported). The writer, caching, budget, and
   validation logic remain provider-independent.
2. **Explicit selection with safe auto-detect.** `--provider` /
   `NECRONOMIDOC_LLM_PROVIDER` wins; otherwise `resolveLlmClient` detects the
   provider from which credential is present (`ANTHROPIC_API_KEY`,
   `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `AZURE_OPENAI_API_KEY`).
   Ambiguity or absence is an actionable error, never a guess, and **Bedrock
   is never auto-detected** — AWS credentials are too ambient to imply intent.
   Generic overrides (`NECRONOMIDOC_LLM_MODEL`, `_BASE_URL`, `_API_KEY`) work
   for every provider; `NECRONOMIDOC_ENRICH_MODEL` stays as an alias.
3. **Structured output degrades gracefully.** Providers that enforce a JSON
   schema server-side (Anthropic `output_config`, OpenAI-compatible
   `response_format`) get it; endpoints that reject it get the schema embedded
   in the prompt, with the writer's zod validation as the unchanged backstop.
   The OpenAI client self-downgrades once per process on the two known
   compat splits (`max_tokens` vs `max_completion_tokens`, `response_format`).
4. **Agent mode: task export/import as a first-class transport.**
   `enrich --export-tasks tasks.json` writes the *exact* planned prompts
   (same plan, same hash-cache and human-curation skips, byte-identical
   prompt builders) plus per-task apply metadata (target ids + content
   hashes) and embedded instructions for the agent. The agent completes the
   tasks offline and writes a results file;
   `enrich --import-results results.json --tasks tasks.json` validates every
   result against its task (zod schemas, echoed symbol ids — hallucinated ids
   are dropped exactly as in live runs) and publishes through the same
   overlay/core-doc/subsystem persistence paths. Export-time hashes stamp the
   overlays, so code changed between export and import surfaces as *stale*
   through the normal staleness workflow rather than a special case.

## Consequences

- No provider lock-in: an operator points `enrich` at whatever endpoint their
  org already pays for, in one flag or env var; self-hosted models work the
  same way as SaaS ones.
- API keys are now optional for enrichment: the task-file loop makes the
  human's coding agent the model, which also gives an auditable artifact
  (task + results files) of exactly what the LLM was asked and answered.
- The `@aws-sdk/client-bedrock-runtime` dependency is imported lazily, so
  non-Bedrock users never load it at runtime.
- Two files define the agent contract (`EnrichmentTaskFile`,
  `EnrichmentResultsFile`, both zod-validated with a `formatVersion`); future
  changes must bump the version rather than mutate the shape.
