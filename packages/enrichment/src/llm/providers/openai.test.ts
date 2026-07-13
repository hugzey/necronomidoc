import { describe, expect, it } from "vitest";
import type { LlmCompleteRequest } from "../client.js";
import { OpenAiCompatLlmClient } from "./openai.js";

const REQUEST: LlmCompleteRequest = {
  system: "Be terse.",
  prompt: "Summarize.",
  maxOutputTokens: 500,
  jsonSchema: { type: "object" },
};

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Fake fetch returning queued responses; records every request body. */
function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: RecordedCall[] = [];
  const impl = (async (url: unknown, init?: { headers?: unknown; body?: unknown }) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const next = responses.shift() ?? { status: 500, body: "queue empty" };
    return {
      ok: next.status < 400,
      status: next.status,
      text: async () =>
        typeof next.body === "string" ? next.body : JSON.stringify(next.body),
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function okCompletion(content: string, extra: Record<string, unknown> = {}) {
  return {
    status: 200,
    body: {
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 34 },
      ...extra,
    },
  };
}

describe("OpenAiCompatLlmClient", () => {
  it("sends an OpenAI-shaped request and returns text + usage", async () => {
    const { impl, calls } = fakeFetch([okCompletion('{"ok":true}')]);
    const client = new OpenAiCompatLlmClient({
      model: "gpt-test",
      apiKey: "sk-x",
      baseUrl: "https://example.test/v1/",
      fetch: impl,
    });
    const result = await client.complete(REQUEST);
    expect(result).toEqual({ text: '{"ok":true}', inputTokens: 12, outputTokens: 34 });

    expect(calls[0]!.url).toBe("https://example.test/v1/chat/completions");
    expect(calls[0]!.headers["authorization"]).toBe("Bearer sk-x");
    expect(calls[0]!.headers["api-key"]).toBe("sk-x"); // Azure-style endpoints
    expect(calls[0]!.body["model"]).toBe("gpt-test");
    expect(calls[0]!.body["max_tokens"]).toBe(500);
    expect(calls[0]!.body["messages"]).toEqual([
      { role: "system", content: "Be terse." },
      { role: "user", content: "Summarize." },
    ]);
    // Never strict: strict mode rejects schemas with optional properties
    // (like ours), which would disable structured output entirely.
    expect(calls[0]!.body["response_format"]).toEqual({
      type: "json_schema",
      json_schema: { name: "response", schema: REQUEST.jsonSchema },
    });
  });

  it("falls back to max_completion_tokens when the endpoint demands it", async () => {
    const { impl, calls } = fakeFetch([
      { status: 400, body: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens'." },
      okCompletion("hi"),
      okCompletion("again"),
    ]);
    const client = new OpenAiCompatLlmClient({ model: "m", fetch: impl });
    await client.complete(REQUEST);
    expect(calls[1]!.body["max_completion_tokens"]).toBe(500);
    expect(calls[1]!.body["max_tokens"]).toBeUndefined();
    // The downgrade sticks — no retry tax on later calls.
    await client.complete(REQUEST);
    expect(calls[2]!.body["max_completion_tokens"]).toBe(500);
  });

  it("moves the schema into the prompt when response_format is rejected", async () => {
    const { impl, calls } = fakeFetch([
      { status: 400, body: "response_format is not supported" },
      okCompletion("{}"),
    ]);
    const client = new OpenAiCompatLlmClient({ model: "m", fetch: impl });
    await client.complete(REQUEST);
    expect(calls[1]!.body["response_format"]).toBeUndefined();
    const messages = calls[1]!.body["messages"] as { role: string; content: string }[];
    expect(messages[1]!.content).toContain("JSON Schema");
  });

  it("surfaces non-retryable HTTP errors with the body", async () => {
    const { impl } = fakeFetch([{ status: 401, body: "bad key" }]);
    const client = new OpenAiCompatLlmClient({ model: "m", fetch: impl });
    await expect(client.complete(REQUEST)).rejects.toThrow(/401.*bad key/s);
  });

  it("rejects truncated output instead of returning half a JSON document", async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        body: { choices: [{ message: { content: '{"tru' }, finish_reason: "length" }] },
      },
    ]);
    const client = new OpenAiCompatLlmClient({ model: "m", fetch: impl });
    await expect(client.complete(REQUEST)).rejects.toThrow(/truncated/);
  });

  it("estimates usage when the endpoint omits it (local servers)", async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { choices: [{ message: { content: "abcdefgh" }, finish_reason: "stop" }] } },
    ]);
    const client = new OpenAiCompatLlmClient({ model: "m", fetch: impl });
    const result = await client.complete(REQUEST);
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBe(2); // ceil(8 chars / 4)
  });
});
