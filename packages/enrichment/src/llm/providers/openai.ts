import {
  promptWithInlineSchema,
  type LlmClient,
  type LlmCompleteRequest,
  type LlmCompleteResult,
} from "../client.js";

/**
 * OpenAI-compatible chat-completions client (decision 0016). One fetch-based
 * implementation covers every provider that speaks the de-facto standard
 * `POST {baseUrl}/chat/completions` API: OpenAI itself, OpenRouter, Azure
 * OpenAI / Azure AI Foundry (v1 endpoint), Ollama, vLLM, LM Studio, Groq,
 * Together, LiteLLM proxies, and so on. No SDK dependency — the surface we
 * need is small and stable.
 */
export interface OpenAiCompatOptions {
  /** Model id as the endpoint knows it (e.g. `gpt-5.2`, `openrouter/auto`). */
  model: string;
  /** Bearer key. Also sent as `api-key` for Azure-style endpoints. */
  apiKey?: string;
  /** API root; `/chat/completions` is appended. Default `https://api.openai.com/v1`. */
  baseUrl?: string;
  /** Extra headers (e.g. OpenRouter attribution headers). */
  headers?: Record<string, string>;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

interface ChatCompletionResponse {
  choices?: {
    message?: { content?: string | null; refusal?: string | null };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class OpenAiCompatLlmClient implements LlmClient {
  readonly model: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  // Compat servers disagree on two request fields. We start with the most
  // widely accepted form and downgrade once per client instance when the
  // endpoint's 400 tells us to, so at most one call pays the retry.
  private useMaxCompletionTokens = false;
  private structuredOutputUnsupported = false;

  constructor(options: OpenAiCompatOptions) {
    this.model = options.model;
    const base = (options.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, "");
    this.url = `${base}/chat/completions`;
    this.headers = {
      "content-type": "application/json",
      ...(options.apiKey
        ? // Bearer is the standard; `api-key` is what Azure's classic
          // endpoints expect. Sending both lets one config cover either.
          { authorization: `Bearer ${options.apiKey}`, "api-key": options.apiKey }
        : {}),
      ...options.headers,
    };
    this.fetchImpl = options.fetch ?? fetch;
  }

  private body(request: LlmCompleteRequest): Record<string, unknown> {
    const messages: { role: string; content: string }[] = [];
    if (request.system) messages.push({ role: "system", content: request.system });
    messages.push({
      role: "user",
      content: this.structuredOutputUnsupported ? promptWithInlineSchema(request) : request.prompt,
    });
    return {
      model: this.model,
      messages,
      ...(this.useMaxCompletionTokens
        ? { max_completion_tokens: request.maxOutputTokens }
        : { max_tokens: request.maxOutputTokens }),
      ...(request.jsonSchema && !this.structuredOutputUnsupported
        ? {
            response_format: {
              type: "json_schema",
              // Not strict: OpenAI's strict mode rejects any schema whose
              // properties aren't all required, and ours legitimately carry
              // optional fields. Non-strict adherence + zod is the contract.
              json_schema: { name: "response", schema: request.jsonSchema },
            },
          }
        : {}),
    };
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResult> {
    // At most two downgrade-and-retry rounds (token param, structured
    // output): each retry flips a flag its own guard checks, so the loop
    // terminates by construction, and later calls go straight through.
    for (;;) {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(this.body(request)),
      });
      const raw = await response.text();
      if (!response.ok) {
        if (response.status === 400) {
          if (!this.useMaxCompletionTokens && raw.includes("max_completion_tokens")) {
            this.useMaxCompletionTokens = true; // newer OpenAI models reject max_tokens
            continue;
          }
          if (!this.structuredOutputUnsupported && raw.includes("response_format")) {
            this.structuredOutputUnsupported = true; // schema moves into the prompt
            continue;
          }
        }
        throw new Error(`LLM endpoint returned ${response.status}: ${truncate(raw)}`);
      }

      let parsed: ChatCompletionResponse;
      try {
        parsed = JSON.parse(raw) as ChatCompletionResponse;
      } catch {
        throw new Error(`LLM endpoint returned non-JSON response: ${truncate(raw)}`);
      }
      const choice = parsed.choices?.[0];
      if (!choice?.message) {
        throw new Error(
          `LLM endpoint response has no choices${parsed.error?.message ? ` (${parsed.error.message})` : ""}.`,
        );
      }
      if (choice.message.refusal) {
        throw new Error(`LLM declined the request: ${choice.message.refusal}`);
      }
      if (choice.finish_reason === "length") {
        throw new Error("LLM output truncated (finish_reason: length) — response discarded.");
      }
      const text = choice.message.content ?? "";
      // Some local servers omit usage; a chars/4 estimate over everything we
      // actually sent (system + user prompt) keeps the token budget guard
      // meaningful instead of silently unlimited.
      const estimate = (s: string) => Math.ceil(s.length / 4);
      return {
        text,
        inputTokens:
          parsed.usage?.prompt_tokens ?? estimate((request.system ?? "") + request.prompt),
        outputTokens: parsed.usage?.completion_tokens ?? estimate(text),
      };
    }
  }
}

function truncate(text: string): string {
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
