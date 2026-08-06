import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchOpenRouterModels,
  parseOpenRouterModels,
} from "../src/openrouter-provider.ts";
import { getProvider } from "../src/providers.ts";

const livePayload = {
  data: [
    {
      id: "vendor/new-agent-model",
      context_length: 131_072,
      architecture: { input_modalities: ["text", "image"] },
      top_provider: { max_completion_tokens: 32_768 },
      supported_parameters: ["tools", "reasoning"],
      reasoning: {
        mandatory: false,
        supported_efforts: ["low", "medium", "high"],
      },
    },
    {
      id: "vendor/text-only-model",
      context_length: 8_192,
      supported_parameters: ["temperature"],
    },
  ],
};

test("OpenRouter is a first-class direct browser provider", () => {
  const provider = getProvider("openrouter");
  assert.ok(provider);
  assert.equal(provider.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(provider.defaultModel, "anthropic/claude-sonnet-4.6");
  assert.equal(provider.headers?.["X-OpenRouter-Title"], "Piodide");
  assert.match(provider.note ?? "", /tool-capable/);
});

test("OpenRouter live catalogue keeps only agent-compatible models", () => {
  const models = parseOpenRouterModels(livePayload);
  assert.equal(models.length, 1);
  assert.deepEqual(models[0], {
    id: "vendor/new-agent-model",
    info: {
      api: "openai-completions",
      contextWindow: 131_072,
      maxTokens: 32_768,
      reasoning: true,
      input: ["text", "image"],
      thinkingLevelMap: {
        off: "none",
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: null,
        max: null,
      },
      compat: { thinkingFormat: "openrouter" },
    },
  });
});

test("OpenRouter model discovery uses its public models endpoint", async () => {
  let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
  const models = await fetchOpenRouterModels(
    "https://openrouter.ai/api/v1/",
    async (input, init) => {
      request = { input, init };
      return Response.json(livePayload);
    },
  );

  assert.equal(String(request?.input), "https://openrouter.ai/api/v1/models");
  assert.equal(new Headers(request?.init?.headers).get("Accept"), "application/json");
  assert.deepEqual(models.map((model) => model.id), ["vendor/new-agent-model"]);
});
