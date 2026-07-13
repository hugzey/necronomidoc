import type { LlmClient } from "./client.js";
import { AnthropicLlmClient, DEFAULT_ENRICH_MODEL } from "./providers/anthropic.js";
import { BedrockLlmClient } from "./providers/bedrock.js";
import { DEFAULT_OPENAI_BASE_URL, OpenAiCompatLlmClient } from "./providers/openai.js";

/**
 * Provider selection (decision 0016). Three real client implementations —
 * `anthropic`, `openai` (any OpenAI-compatible endpoint), `bedrock` — plus
 * convenience aliases (`openrouter`, `azure`, `ollama`) that pre-fill the
 * OpenAI-compatible client's base URL and key lookup. Selection is explicit
 * (`--provider` / NECRONOMIDOC_LLM_PROVIDER) or auto-detected from which
 * credentials are present; ambiguity is an error, never a guess.
 */
export const LLM_PROVIDERS = [
  "anthropic",
  "openai",
  "openrouter",
  "azure",
  "ollama",
  "bedrock",
] as const;
export type LlmProviderId = (typeof LLM_PROVIDERS)[number];

/** Configuration problem the operator can fix — the CLI prints it verbatim. */
export class LlmConfigError extends Error {
  override readonly name = "LlmConfigError";
}

export interface ResolveLlmClientOptions {
  /** Provider id; falls back to NECRONOMIDOC_LLM_PROVIDER, then auto-detect. */
  provider?: string;
  /** Model id; falls back to NECRONOMIDOC_LLM_MODEL / NECRONOMIDOC_ENRICH_MODEL. */
  model?: string;
  /** API key; falls back to NECRONOMIDOC_LLM_API_KEY, then the provider's own env var. */
  apiKey?: string;
  /** OpenAI-compatible base URL; falls back to NECRONOMIDOC_LLM_BASE_URL. */
  baseUrl?: string;
  /** Environment to read (tests); defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** Per-flavor defaults for providers served by the OpenAI-compatible client. */
const OPENAI_FLAVORS: Record<
  Exclude<LlmProviderId, "anthropic" | "bedrock">,
  { defaultBaseUrl?: string; keyEnvs: string[]; requiresKey: boolean }
> = {
  openai: { defaultBaseUrl: DEFAULT_OPENAI_BASE_URL, keyEnvs: ["OPENAI_API_KEY"], requiresKey: true },
  openrouter: {
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    keyEnvs: ["OPENROUTER_API_KEY"],
    requiresKey: true,
  },
  // Azure has no single default host — the resource endpoint is per-account.
  azure: { keyEnvs: ["AZURE_OPENAI_API_KEY", "AZURE_AI_API_KEY"], requiresKey: true },
  ollama: { defaultBaseUrl: "http://localhost:11434/v1", keyEnvs: [], requiresKey: false },
};

const CONFIG_HINT = [
  "Configure an LLM provider for `enrich`:",
  "  anthropic   set ANTHROPIC_API_KEY",
  "  openai      set OPENAI_API_KEY (any OpenAI-compatible endpoint via --base-url / NECRONOMIDOC_LLM_BASE_URL)",
  "  openrouter  set OPENROUTER_API_KEY",
  "  azure       set AZURE_OPENAI_API_KEY + --base-url https://<resource>.openai.azure.com/openai/v1",
  "  ollama      --provider ollama --model <local model> (no key)",
  "  bedrock     --provider bedrock --model <bedrock model id> (AWS credential chain)",
  "Pick explicitly with --provider or NECRONOMIDOC_LLM_PROVIDER.",
  "Or skip API keys entirely: `enrich --export-tasks` + a local coding agent + `enrich --import-results` (see docs/enrichment.md).",
].join("\n");

/** Auto-detect a provider from which credentials the environment carries. */
function detectProvider(env: Record<string, string | undefined>): LlmProviderId {
  const candidates: LlmProviderId[] = [];
  if (env["ANTHROPIC_API_KEY"]) candidates.push("anthropic");
  if (env["OPENAI_API_KEY"] || env["NECRONOMIDOC_LLM_BASE_URL"]) candidates.push("openai");
  if (env["OPENROUTER_API_KEY"]) candidates.push("openrouter");
  if (env["AZURE_OPENAI_API_KEY"] || env["AZURE_AI_API_KEY"]) candidates.push("azure");
  // Bedrock is never auto-detected: AWS credentials are ambient on far too
  // many machines to imply "use Bedrock for LLM calls".
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new LlmConfigError(`No LLM provider configured.\n${CONFIG_HINT}`);
  }
  throw new LlmConfigError(
    `Credentials for multiple providers found (${candidates.join(", ")}) — choose one with --provider or NECRONOMIDOC_LLM_PROVIDER.`,
  );
}

/**
 * Build the `LlmClient` the current flags + environment describe, or throw
 * `LlmConfigError` with an actionable message.
 */
export function resolveLlmClient(options: ResolveLlmClientOptions = {}): LlmClient {
  const raw = options.env ?? process.env;
  // An empty exported variable means "unset", not "provider named ''".
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) if (value) env[key] = value;
  const rawProvider = options.provider ?? env["NECRONOMIDOC_LLM_PROVIDER"];
  let provider: LlmProviderId;
  if (rawProvider !== undefined) {
    const normalized = rawProvider.toLowerCase().replace(/^openai-compatible$/, "openai");
    if (!(LLM_PROVIDERS as readonly string[]).includes(normalized)) {
      throw new LlmConfigError(
        `Unknown LLM provider "${rawProvider}" (known: ${LLM_PROVIDERS.join(", ")}).`,
      );
    }
    provider = normalized as LlmProviderId;
  } else {
    provider = detectProvider(env);
  }

  const model =
    options.model ?? env["NECRONOMIDOC_LLM_MODEL"] ?? env["NECRONOMIDOC_ENRICH_MODEL"];
  const apiKey = options.apiKey ?? env["NECRONOMIDOC_LLM_API_KEY"];

  if (provider === "anthropic") {
    if (!apiKey && !env["ANTHROPIC_API_KEY"]) {
      throw new LlmConfigError("Provider anthropic needs ANTHROPIC_API_KEY.");
    }
    return new AnthropicLlmClient({ model: model ?? DEFAULT_ENRICH_MODEL, apiKey });
  }

  if (provider === "bedrock") {
    if (!model) {
      throw new LlmConfigError(
        "Provider bedrock needs a model id — pass --model (or NECRONOMIDOC_LLM_MODEL), e.g. us.anthropic.claude-opus-4-8-v1:0.",
      );
    }
    return new BedrockLlmClient({ model, region: env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"] });
  }

  const flavor = OPENAI_FLAVORS[provider];
  const baseUrl = options.baseUrl ?? env["NECRONOMIDOC_LLM_BASE_URL"] ?? flavor.defaultBaseUrl;
  if (!baseUrl) {
    throw new LlmConfigError(
      `Provider ${provider} needs a base URL — pass --base-url or set NECRONOMIDOC_LLM_BASE_URL.`,
    );
  }
  const key = apiKey ?? flavor.keyEnvs.map((name) => env[name]).find(Boolean);
  if (!key && flavor.requiresKey) {
    throw new LlmConfigError(
      `Provider ${provider} needs an API key — set ${flavor.keyEnvs[0] ?? "NECRONOMIDOC_LLM_API_KEY"} (or NECRONOMIDOC_LLM_API_KEY).`,
    );
  }
  if (!model) {
    throw new LlmConfigError(
      `Provider ${provider} needs a model id — pass --model or set NECRONOMIDOC_LLM_MODEL.`,
    );
  }
  return new OpenAiCompatLlmClient({ model, apiKey: key, baseUrl });
}
