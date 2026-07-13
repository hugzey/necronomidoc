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
  /**
   * `invalid` = explicitly wrong input (e.g. a bad provider name) that must
   * always surface; `incomplete` = credentials/model simply not set up yet,
   * which dry runs are allowed to proceed without.
   */
  readonly kind: "invalid" | "incomplete";

  constructor(message: string, kind: "invalid" | "incomplete" = "incomplete") {
    super(message);
    this.kind = kind;
  }
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
  "`enrich` needs a model to write with — an API key is only one way to provide it. Pick ONE of:",
  "",
  "  with an API key:",
  "    anthropic   set ANTHROPIC_API_KEY",
  "    openai      set OPENAI_API_KEY (any OpenAI-compatible endpoint via --base-url / NECRONOMIDOC_LLM_BASE_URL)",
  "    openrouter  set OPENROUTER_API_KEY",
  "    azure       set AZURE_OPENAI_API_KEY + --base-url https://<resource>.openai.azure.com/openai/v1",
  "",
  "  without any API key:",
  "    agent mode  `enrich <target> --export-tasks tasks.json`, have your coding agent",
  "                (Claude Code, Codex CLI, …) complete it, then `enrich <target> --import-results`",
  "    ollama      --provider ollama --model <local model> (local server)",
  "    bedrock     --provider bedrock --model <bedrock model id> (AWS credential chain)",
  "",
  "  or preview only: --dry-run plans the run without touching any model.",
  "",
  "Pick a provider explicitly with --provider or NECRONOMIDOC_LLM_PROVIDER.",
  'Docs: docs/enrichment.md — "Choosing a provider" and "Agent-based enrichment (no API key)".',
].join("\n");

/** Auto-detect a provider from which credentials the environment carries. */
function detectProvider(env: Record<string, string | undefined>): LlmProviderId {
  const candidates: LlmProviderId[] = [];
  if (env["ANTHROPIC_API_KEY"]) candidates.push("anthropic");
  if (env["OPENAI_API_KEY"]) candidates.push("openai");
  if (env["OPENROUTER_API_KEY"]) candidates.push("openrouter");
  if (env["AZURE_OPENAI_API_KEY"] || env["AZURE_AI_API_KEY"]) candidates.push("azure");
  // Bedrock is never auto-detected: AWS credentials are ambient on far too
  // many machines to imply "use Bedrock for LLM calls".
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    // A base URL alone (keyless local endpoint: vLLM, LM Studio, …) implies
    // the OpenAI-compatible client — but it is not a credential, so it never
    // creates ambiguity when a real key is present.
    if (env["NECRONOMIDOC_LLM_BASE_URL"]) return "openai";
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
        "invalid",
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
  // A custom OpenAI-compatible endpoint (vLLM, LM Studio, a gateway) may be
  // keyless; only the real OpenAI API unconditionally needs a key.
  const keyRequired =
    flavor.requiresKey && (provider !== "openai" || baseUrl === DEFAULT_OPENAI_BASE_URL);
  if (!key && keyRequired) {
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
