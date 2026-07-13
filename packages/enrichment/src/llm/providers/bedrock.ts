import type { LlmClient, LlmCompleteRequest, LlmCompleteResult } from "../client.js";

/**
 * AWS Bedrock client over the model-agnostic Converse API (decision 0016):
 * any Bedrock model id (Claude, Nova, Llama, Mistral, …) works with the
 * standard AWS credential chain (env vars, shared config/SSO profiles, IAM
 * roles) — no separate API key. The SDK is imported lazily so the other
 * providers never pay its startup cost.
 *
 * Converse has no cross-model structured-output mode, so `jsonSchema` is
 * appended to the prompt as text; the writer's zod validation is the backstop
 * (as the `LlmClient` contract allows).
 */
export interface BedrockClientOptions {
  /** Bedrock model or inference-profile id (e.g. `us.anthropic.claude-opus-4-8-v1:0`). */
  model: string;
  /** AWS region; defaults to the SDK chain (AWS_REGION / profile config). */
  region?: string;
  /** Injectable for tests: anything with a Converse-shaped `send`. */
  send?: (input: BedrockConverseInput) => Promise<BedrockConverseOutput>;
}

/** The subset of the Converse request/response shapes this client touches. */
export interface BedrockConverseInput {
  modelId: string;
  messages: { role: "user"; content: { text: string }[] }[];
  system?: { text: string }[];
  inferenceConfig: { maxTokens: number };
}

export interface BedrockConverseOutput {
  output?: { message?: { content?: { text?: string }[] } };
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export class BedrockLlmClient implements LlmClient {
  readonly model: string;
  private readonly region?: string;
  private send?: (input: BedrockConverseInput) => Promise<BedrockConverseOutput>;

  constructor(options: BedrockClientOptions) {
    this.model = options.model;
    this.region = options.region;
    this.send = options.send;
  }

  private async sender(): Promise<(input: BedrockConverseInput) => Promise<BedrockConverseOutput>> {
    if (this.send) return this.send;
    let sdk: typeof import("@aws-sdk/client-bedrock-runtime");
    try {
      sdk = await import("@aws-sdk/client-bedrock-runtime");
    } catch {
      throw new Error(
        "Bedrock support needs @aws-sdk/client-bedrock-runtime — install it (npm install @aws-sdk/client-bedrock-runtime) and retry.",
      );
    }
    const client = new sdk.BedrockRuntimeClient(this.region ? { region: this.region } : {});
    this.send = async (input) =>
      (await client.send(new sdk.ConverseCommand(input))) as BedrockConverseOutput;
    return this.send;
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResult> {
    const send = await this.sender();
    const prompt = request.jsonSchema
      ? `${request.prompt}\n\nRespond with a single JSON object matching this JSON Schema exactly:\n${JSON.stringify(request.jsonSchema)}`
      : request.prompt;
    const response = await send({
      modelId: this.model,
      messages: [{ role: "user", content: [{ text: prompt }] }],
      ...(request.system ? { system: [{ text: request.system }] } : {}),
      inferenceConfig: { maxTokens: request.maxOutputTokens },
    });
    if (response.stopReason === "max_tokens") {
      throw new Error("LLM output truncated (stopReason: max_tokens) — response discarded.");
    }
    if (response.stopReason === "content_filtered" || response.stopReason === "guardrail_intervened") {
      throw new Error(`LLM declined the request (stopReason: ${response.stopReason}).`);
    }
    const text = (response.output?.message?.content ?? [])
      .map((block) => block.text ?? "")
      .join("");
    return {
      text,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
    };
  }
}
