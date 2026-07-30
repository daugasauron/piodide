import assert from "node:assert/strict";
import { test } from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import {
  BROWSER_MODELS,
  describeBrowserModel,
  estimateWebGpuKvCacheBytes,
  formatContextSize,
  getBrowserModel,
} from "../src/browser-models.ts";
import {
  browserModelRuntime,
  drainWllamaResponseTail,
  hasWllamaWebGpuFeatures,
  knownWllamaCacheState,
  repairKnownWllamaCacheEntries,
} from "../src/browser-model-runtime.ts";
import {
  getLoadedModelInfo,
  getProvider,
  PROVIDERS,
} from "../src/providers.ts";
import {
  WEBLLM_MODELS,
  describeWebLLMModel,
  getWebLLMModel,
} from "../src/webllm-models.ts";
import { createBrowserChatRequest } from "../src/browser-model-stream.ts";
import { makeModel } from "../src/model.ts";

test("Wllama provider is local, keyless, renamed, and keeps its aliases", async () => {
  const provider = getProvider("wllama");
  assert.ok(provider);
  assert.equal(provider, getProvider("browser"));
  assert.equal(provider, getProvider("wasm"));
  assert.equal(provider.name, "wllama");
  assert.match(provider.label, /Wllama/);
  assert.equal(provider.transport, "browser");
  assert.equal(provider.auth, "none");
  assert.equal(provider.api, "browser-wllama");

  const modelIds = await provider.loadModels();
  assert.deepEqual(modelIds, BROWSER_MODELS.map((model) => model.id));
  assert.equal(provider.defaultModel, BROWSER_MODELS[0].id);
  assert.equal(provider.defaultModel, "qwen3-8b-q4km");

  for (const model of BROWSER_MODELS) {
    assert.equal(getBrowserModel(model.id), model);
    assert.match(
      model.sourceUrl,
      /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//,
    );
    assert.ok(model.bytes > 0);
    assert.match(describeBrowserModel(model), /download required/);

    const info = getLoadedModelInfo(provider.name, model.id);
    assert.ok(info);
    assert.equal(info.api, "browser-wllama");
    assert.equal(info.contextWindow, model.contextWindow);
    assert.equal(info.maxTokens, model.maxTokens);
    assert.equal(info.reasoning, model.thinking === true);
    assert.deepEqual(info.input, ["text"]);
  }
});

test("Qwen3 8B exposes a binary thinking toggle and changes its request preset", async () => {
  const provider = getProvider("wllama");
  assert.ok(provider);
  await provider.loadModels();
  const descriptor = getBrowserModel("qwen3-8b-q4km");
  const info = getLoadedModelInfo(provider.name, "qwen3-8b-q4km");
  assert.ok(descriptor);
  assert.ok(info);

  const model = makeModel({
    baseUrl: provider.baseUrl,
    modelId: descriptor.id,
    api: provider.api,
    provider: provider.name,
    info,
  });
  assert.deepEqual(getSupportedThinkingLevels(model), ["off", "high"]);

  const context = {
    messages: [{ role: "user" as const, content: "Solve it", timestamp: 1 }],
  };
  const off = createBrowserChatRequest(model, descriptor, context, undefined);
  assert.equal(off.chat_template_kwargs?.enable_thinking, false);
  assert.equal(off.temperature, descriptor.generation.temperature);
  assert.equal(off.top_p, descriptor.generation.topP);

  const high = createBrowserChatRequest(model, descriptor, context, "high");
  assert.equal(high.chat_template_kwargs?.enable_thinking, true);
  assert.equal(high.temperature, descriptor.thinkingGeneration?.temperature);
  assert.equal(high.top_p, descriptor.thinkingGeneration?.topP);
  assert.equal(high.top_k, descriptor.thinkingGeneration?.topK);
});

test("Wllama models expose validated per-model context and KV-cache sizes", async () => {
  for (const descriptor of BROWSER_MODELS) {
    assert.deepEqual(descriptor.contextOptions, [4_096, 8_192, 16_384, 32_768]);
    assert.ok(descriptor.contextOptions.includes(descriptor.load.contextSize));
    assert.equal(browserModelRuntime.contextSize(descriptor.id), descriptor.load.contextSize);
  }

  const descriptor = getBrowserModel("qwen3-8b-q4km");
  assert.ok(descriptor);
  assert.equal(formatContextSize(4_096), "4K");
  assert.equal(formatContextSize(32_768), "32K");
  assert.equal(estimateWebGpuKvCacheBytes(descriptor, 8_192), 641_728_512);

  const alternateContext = descriptor.contextOptions.find(
    (contextSize) => contextSize !== descriptor.load.contextSize,
  )!;
  assert.equal(
    await browserModelRuntime.setContextSize(descriptor.id, alternateContext),
    true,
  );
  assert.equal(browserModelRuntime.contextSize(descriptor.id), alternateContext);
  assert.equal(
    await browserModelRuntime.setContextSize(descriptor.id, alternateContext),
    false,
  );
  await assert.rejects(
    browserModelRuntime.setContextSize(descriptor.id, 12_345),
    /Unsupported context size/,
  );

  // Restore the singleton so this test cannot influence later runtime users.
  await browserModelRuntime.setContextSize(descriptor.id, descriptor.load.contextSize);
});

test("Wllama repairs Chrome content-addressed cache entries missing from list()", async () => {
  const sourceUrl = "https://huggingface.co/example/model/resolve/main/model.gguf";
  const metadata = {
    originalURL: sourceUrl,
    originalSize: 5_027_783_488,
    etag: "etag",
    sha256: "a".repeat(64),
  };
  const repaired = await repairKnownWllamaCacheEntries(
    [],
    {
      async getNameFromURL() {
        return "hashed-model.gguf";
      },
      async getMetadata() {
        return metadata;
      },
      async getSize() {
        return metadata.originalSize;
      },
    },
    [sourceUrl],
  );

  assert.deepEqual(repaired, [
    {
      name: "hashed-model.gguf",
      size: metadata.originalSize,
      metadata,
    },
  ]);
});

test("Wllama distinguishes interrupted model files from complete cache entries", () => {
  const completeBytes = 5_027_783_488;
  const orphanMetadata = {
    originalURL: "",
    originalSize: 3_382_738_621,
    etag: "polyfill_for_older_version",
  };
  assert.equal(
    knownWllamaCacheState(completeBytes, orphanMetadata, 3_382_738_621),
    "incomplete",
  );
  assert.equal(
    knownWllamaCacheState(completeBytes, orphanMetadata, completeBytes),
    "complete",
  );
  assert.equal(knownWllamaCacheState(completeBytes, null, -1), "missing");
});

test("Wllama WebGPU requires shader-f16, not merely navigator.gpu", () => {
  assert.equal(hasWllamaWebGpuFeatures(undefined), false);
  assert.equal(
    hasWllamaWebGpuFeatures({ has: (feature) => feature === "timestamp-query" }),
    false,
  );
  assert.equal(
    hasWllamaWebGpuFeatures({ has: (feature) => feature === "shader-f16" }),
    true,
  );
});

test("Wllama drains a queued finish chunk after native has_more becomes false", async () => {
  const results = [
    {
      has_more: false,
      is_error: false,
      data_json: JSON.stringify({ choices: [{ finish_reason: "stop" }] }),
    },
    { has_more: false, is_error: false, data_json: "" },
  ];
  const emitted: unknown[] = [];
  const final = await drainWllamaResponseTail(
    async () => results.shift()!,
    JSON.parse,
    { choices: [{ delta: { content: "hello" } }] },
    true,
    (chunk) => emitted.push(chunk),
  );

  assert.deepEqual(emitted, [{ choices: [{ finish_reason: "stop" }] }]);
  assert.deepEqual(final, { choices: [{ finish_reason: "stop" }] });
  assert.equal(results.length, 0);
});

test("WebLLM is an independent WebGPU catalogue with tool support marked", async () => {
  const provider = getProvider("webllm");
  assert.ok(provider);
  assert.equal(provider, getProvider("mlc"));
  assert.equal(provider, getProvider("webgpu"));
  assert.equal(provider.name, "webllm");
  assert.match(provider.label, /WebLLM/);
  assert.equal(provider.transport, "browser");
  assert.equal(provider.auth, "none");
  assert.equal(provider.api, "browser-webllm");

  const modelIds = await provider.loadModels();
  assert.deepEqual(modelIds, WEBLLM_MODELS.map((model) => model.id));
  assert.equal(provider.defaultModel, WEBLLM_MODELS[0].id);
  assert.equal(provider.defaultModel, "Hermes-3-Llama-3.1-8B-q4f32_1-MLC");
  assert.equal(WEBLLM_MODELS[0].tools, true);
  assert.ok(WEBLLM_MODELS.some((model) => model.tools));
  assert.ok(WEBLLM_MODELS.some((model) => !model.tools));

  for (const model of WEBLLM_MODELS) {
    assert.equal(getWebLLMModel(model.id), model);
    assert.ok(model.bytes > 0);
    assert.ok(model.vramRequiredBytes > 0);
    assert.match(describeWebLLMModel(model), /VRAM.*download required/);

    const info = getLoadedModelInfo(provider.name, model.id);
    assert.ok(info);
    assert.equal(info.api, "browser-webllm");
    assert.equal(info.contextWindow, model.contextWindow);
    assert.equal(info.maxTokens, model.maxTokens);
    assert.deepEqual(info.input, ["text"]);
  }
});

test("browser-local providers are the first choices", () => {
  assert.deepEqual(Object.keys(PROVIDERS).slice(0, 2), ["webllm", "wllama"]);
});

test("GLM Coding separates the international and China endpoints", async () => {
  const international = getProvider("glm-coding");
  const china = getProvider("glm-coding-cn");
  assert.ok(international);
  assert.ok(china);

  assert.equal(international, getProvider("zai"));
  assert.equal(international, getProvider("zai-coding"));
  assert.equal(international.baseUrl, "https://api.z.ai/api/coding/paas/v4");
  assert.equal(china.baseUrl, "https://open.bigmodel.cn/api/coding/paas/v4");
  assert.ok((await international.loadModels()).includes("glm-5.2"));
  assert.ok((await china.loadModels()).includes("glm-5.2"));
});
