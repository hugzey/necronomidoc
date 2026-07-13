import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmCompleteRequest, LlmCompleteResult } from "../client.js";

export interface AnthropicClientOptions {
  /** Model id; defaults to `claude-opus-4-8`. */
  model?: string;
  /** API key; defaults to the ANTHROPIC_API_KEY env var (SDK behavior). */
  apiKey?: string;
}

export const DEFAULT_ENRICH_MODEL = "claude-opus-4-8";

/** First-party implementation over the Anthropic API. */
export class AnthropicLlmClient implements LlmClient {
  readonly model: string;
  private readonly client: Anthropic;

  constructor(options: AnthropicClientOptions = {}) {
    this.model = options.model ?? DEFAULT_ENRICH_MODEL;
    this.client = options.apiKey ? new Anthropic({ apiKey: options.apiKey }) : new Anthropic();
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResult> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: [{ role: "user", content: request.prompt }],
      ...(request.jsonSchema
        ? { output_config: { format: { type: "json_schema" as const, schema: request.jsonSchema } } }
        : {}),
    });
    if (response.stop_reason === "refusal") {
      throw new Error("LLM declined the request (stop_reason: refusal).");
    }
    if (response.stop_reason === "max_tokens") {
      throw new Error("LLM output truncated (stop_reason: max_tokens) — response discarded.");
    }
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
    return {
      text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}
