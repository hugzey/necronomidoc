import { LlmConfigError, resolveLlmClient, type LlmClient } from "@necronomidoc/enrichment";

/** Provider selection flags shared by every LLM-calling command (decision 0016). */
export interface LlmFlagOptions {
  /** Provider id (anthropic | openai | openrouter | azure | ollama | bedrock); default auto-detect from env. */
  provider?: string;
  model?: string;
  /** Endpoint root for OpenAI-compatible providers. */
  baseUrl?: string;
}

/**
 * Resolve a run's LLM client from flags + environment. Dry runs plan without
 * calling the model, so missing credentials must not block them — they get a
 * stub that only fails if something does call it. Explicitly invalid input
 * (a typo'd provider name) always surfaces, or the user only learns about it
 * on the real run. Shared by `enrich`, `skills`, and `artefact`.
 */
export function llmClientFor(options: LlmFlagOptions, dryRun?: boolean): LlmClient {
  try {
    return resolveLlmClient({
      provider: options.provider,
      model: options.model,
      baseUrl: options.baseUrl,
    });
  } catch (err) {
    if (dryRun && err instanceof LlmConfigError && err.kind !== "invalid") {
      return {
        model: options.model ?? "(unconfigured)",
        complete: async () => {
          throw err;
        },
      };
    }
    throw err;
  }
}
