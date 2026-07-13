/** One completion request from the enrichment writer. */
export interface LlmCompleteRequest {
  system?: string;
  prompt: string;
  /** Hard cap on output tokens for this call. */
  maxOutputTokens: number;
  /**
   * JSON Schema the response must conform to. Providers with structured
   * output support enforce it server-side; others may ignore it, in which
   * case the writer's zod validation is the backstop.
   */
  jsonSchema?: Record<string, unknown>;
}

/** One completion result, with token usage for budget accounting. */
export interface LlmCompleteResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Provider-agnostic LLM client used by the overlay writer (slice 3 plan §1).
 * Keeping the surface to a single `complete` call means alternate providers
 * (or the fake used in tests) are trivial to slot in. Implementations live in
 * `providers/` (Anthropic, OpenAI-compatible, Bedrock) and are selected by
 * `resolveLlmClient` (decision 0016).
 */
export interface LlmClient {
  /** Model identifier, recorded in run reports. */
  readonly model: string;
  complete(request: LlmCompleteRequest): Promise<LlmCompleteResult>;
}
