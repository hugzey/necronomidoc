import { describe, expect, it } from "vitest";
import { BedrockLlmClient, type BedrockConverseInput } from "./bedrock.js";

function fakeSend(output: {
  text?: string;
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}) {
  const calls: BedrockConverseInput[] = [];
  const send = async (input: BedrockConverseInput) => {
    calls.push(input);
    return {
      output: { message: { content: [{ text: output.text ?? "" }] } },
      stopReason: output.stopReason ?? "end_turn",
      usage: output.usage,
    };
  };
  return { send, calls };
}

describe("BedrockLlmClient", () => {
  it("maps the request to Converse shape and returns text + usage", async () => {
    const { send, calls } = fakeSend({
      text: '{"ok":true}',
      usage: { inputTokens: 11, outputTokens: 7 },
    });
    const client = new BedrockLlmClient({ model: "us.test.model-v1:0", send });
    const result = await client.complete({
      system: "Be terse.",
      prompt: "Summarize.",
      maxOutputTokens: 400,
    });
    expect(result).toEqual({ text: '{"ok":true}', inputTokens: 11, outputTokens: 7 });
    expect(calls[0]).toMatchObject({
      modelId: "us.test.model-v1:0",
      system: [{ text: "Be terse." }],
      inferenceConfig: { maxTokens: 400 },
    });
    expect(calls[0]!.messages[0]!.content[0]!.text).toBe("Summarize.");
  });

  it("appends the JSON schema to the prompt (Converse has no structured output)", async () => {
    const { send, calls } = fakeSend({ text: "{}" });
    const client = new BedrockLlmClient({ model: "m", send });
    await client.complete({
      prompt: "Summarize.",
      maxOutputTokens: 100,
      jsonSchema: { type: "object", required: ["file"] },
    });
    expect(calls[0]!.messages[0]!.content[0]!.text).toContain("JSON Schema");
    expect(calls[0]!.messages[0]!.content[0]!.text).toContain('"required":["file"]');
  });

  it("rejects truncated and filtered responses", async () => {
    const truncated = new BedrockLlmClient({
      model: "m",
      send: fakeSend({ text: "half", stopReason: "max_tokens" }).send,
    });
    await expect(truncated.complete({ prompt: "p", maxOutputTokens: 5 })).rejects.toThrow(
      /truncated/,
    );

    const filtered = new BedrockLlmClient({
      model: "m",
      send: fakeSend({ text: "", stopReason: "guardrail_intervened" }).send,
    });
    await expect(filtered.complete({ prompt: "p", maxOutputTokens: 5 })).rejects.toThrow(
      /declined/,
    );
  });
});
