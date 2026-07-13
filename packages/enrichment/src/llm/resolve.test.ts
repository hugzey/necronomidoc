import { describe, expect, it } from "vitest";
import { AnthropicLlmClient } from "./providers/anthropic.js";
import { BedrockLlmClient } from "./providers/bedrock.js";
import { OpenAiCompatLlmClient } from "./providers/openai.js";
import { LlmConfigError, resolveLlmClient } from "./resolve.js";

describe("resolveLlmClient", () => {
  it("auto-detects anthropic from ANTHROPIC_API_KEY with the default model", () => {
    const client = resolveLlmClient({ env: { ANTHROPIC_API_KEY: "sk-ant-x" } });
    expect(client).toBeInstanceOf(AnthropicLlmClient);
    expect(client.model).toBe("claude-opus-4-8");
  });

  it("auto-detects openai from OPENAI_API_KEY (model required)", () => {
    const env = { OPENAI_API_KEY: "sk-x" };
    expect(() => resolveLlmClient({ env })).toThrow(/model/);
    const client = resolveLlmClient({ env, model: "gpt-test" });
    expect(client).toBeInstanceOf(OpenAiCompatLlmClient);
    expect(client.model).toBe("gpt-test");
  });

  it("auto-detects openrouter from OPENROUTER_API_KEY", () => {
    const client = resolveLlmClient({
      env: { OPENROUTER_API_KEY: "sk-or-x", NECRONOMIDOC_LLM_MODEL: "openrouter/auto" },
    });
    expect(client).toBeInstanceOf(OpenAiCompatLlmClient);
    expect(client.model).toBe("openrouter/auto");
  });

  it("errors on no configuration, with keyless alternatives and a docs pointer in the hint", () => {
    expect(() => resolveLlmClient({ env: {} })).toThrow(LlmConfigError);
    expect(() => resolveLlmClient({ env: {} })).toThrow(/export-tasks/);
    expect(() => resolveLlmClient({ env: {} })).toThrow(/without any API key/);
    expect(() => resolveLlmClient({ env: {} })).toThrow(/docs\/enrichment\.md/);
  });

  it("refuses to guess between multiple configured providers", () => {
    const env = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b" };
    expect(() => resolveLlmClient({ env })).toThrow(/multiple providers/i);
    // Explicit choice resolves the ambiguity.
    const client = resolveLlmClient({ env, provider: "anthropic" });
    expect(client).toBeInstanceOf(AnthropicLlmClient);
  });

  it("a base URL is not a credential: keyless endpoints detect as openai, but a real key wins", () => {
    // Keyless local endpoint (vLLM, LM Studio): base URL alone selects openai.
    const keyless = resolveLlmClient({
      env: { NECRONOMIDOC_LLM_BASE_URL: "http://localhost:8000/v1" },
      model: "local-model",
    });
    expect(keyless).toBeInstanceOf(OpenAiCompatLlmClient);
    // An ambient base URL must not manufacture ambiguity against a real key.
    const withKey = resolveLlmClient({
      env: { ANTHROPIC_API_KEY: "k", NECRONOMIDOC_LLM_BASE_URL: "http://localhost:8000/v1" },
    });
    expect(withKey).toBeInstanceOf(AnthropicLlmClient);
  });

  it("honors NECRONOMIDOC_LLM_PROVIDER and the legacy NECRONOMIDOC_ENRICH_MODEL", () => {
    const client = resolveLlmClient({
      env: {
        NECRONOMIDOC_LLM_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "k",
        NECRONOMIDOC_ENRICH_MODEL: "claude-sonnet-5",
      },
    });
    expect(client.model).toBe("claude-sonnet-5");
  });

  it("rejects unknown providers by name, marked invalid (never swallowed by dry runs)", () => {
    expect(() => resolveLlmClient({ provider: "skynet", env: {} })).toThrow(/Unknown LLM provider/);
    try {
      resolveLlmClient({ provider: "skynet", env: {} });
      expect.unreachable();
    } catch (err) {
      expect((err as LlmConfigError).kind).toBe("invalid");
    }
    // Merely-missing config is "incomplete" — dry runs may proceed past it.
    try {
      resolveLlmClient({ env: {} });
      expect.unreachable();
    } catch (err) {
      expect((err as LlmConfigError).kind).toBe("incomplete");
    }
  });

  it("bedrock is explicit-only and needs a model id", () => {
    // AWS creds in the env never imply bedrock.
    expect(() =>
      resolveLlmClient({ env: { AWS_ACCESS_KEY_ID: "AKIA...", AWS_SECRET_ACCESS_KEY: "x" } }),
    ).toThrow(LlmConfigError);
    expect(() => resolveLlmClient({ provider: "bedrock", env: {} })).toThrow(/model id/);
    const client = resolveLlmClient({
      provider: "bedrock",
      model: "us.anthropic.claude-opus-4-8-v1:0",
      env: {},
    });
    expect(client).toBeInstanceOf(BedrockLlmClient);
  });

  it("azure requires a base URL; ollama needs neither key nor default model guess", () => {
    expect(() =>
      resolveLlmClient({ provider: "azure", model: "gpt-test", env: { AZURE_OPENAI_API_KEY: "k" } }),
    ).toThrow(/base URL/);
    const azure = resolveLlmClient({
      provider: "azure",
      model: "gpt-test",
      baseUrl: "https://res.openai.azure.com/openai/v1",
      env: { AZURE_OPENAI_API_KEY: "k" },
    });
    expect(azure).toBeInstanceOf(OpenAiCompatLlmClient);

    const ollama = resolveLlmClient({ provider: "ollama", model: "qwen3", env: {} });
    expect(ollama).toBeInstanceOf(OpenAiCompatLlmClient);
  });
});
