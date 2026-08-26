import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chooseLocalModel,
  formatLocalModelStatus,
  localModelReadiness,
  orderLocalModels,
} from "../src/local-model-ux.ts";

test("local model loading status surfaces useful WebLLM milestones", () => {
  assert.equal(
    formatLocalModelStatus(
      {
        phase: "downloading",
        modelId: "Qwen3.5-2B",
        loadedBytes: 871_001_238,
        totalBytes: 1_082_564_401,
        backend: "webgpu",
        contextSize: 8_192,
        message:
          "Loading model from cache[24/31]: 813MB loaded. 80% completed, 114 secs elapsed.",
      },
      "Qwen3.5 2B",
      "long",
    ),
    "downloading Qwen3.5 2B · 80% · model shard 24/31 · 813MB loaded",
  );
  assert.equal(
    formatLocalModelStatus(
      {
        phase: "loading",
        backend: "webgpu",
        contextSize: 8_192,
        message: "Loading GPU shader modules[9/9]: 100% completed, 1 secs elapsed.",
      },
      "Qwen3.5 2B",
      "long",
    ),
    "compiling GPU shaders 9/9 · WEBGPU · 8K context",
  );
});

test("local model readiness explains GPU requirements and Wllama fallback", () => {
  const base = {
    webGpu: true,
    shaderF16: true,
    adapter: "NVIDIA GeForce RTX 5070",
    wasmFallback: false,
    crossOriginIsolated: true,
  };
  assert.deepEqual(localModelReadiness("webllm", base), {
    ready: true,
    summary: "NVIDIA GeForce RTX 5070 · WebGPU + shader-f16 ready",
    requirements: "GPU-only; choose a model whose estimated VRAM fits this adapter.",
  });
  assert.equal(
    localModelReadiness(
      "webllm",
      { ...base, shaderF16: false },
    ).ready,
    false,
  );
  assert.equal(
    localModelReadiness(
      "wllama",
      { ...base, webGpu: false, shaderF16: false, threads: 8 },
      2 * 1024 ** 3,
    ).summary,
    "WebAssembly fallback · 8 logical threads",
  );
  assert.equal(
    localModelReadiness(
      "wllama",
      { ...base, webGpu: false, shaderF16: false, threads: 8 },
      5 * 1024 ** 3,
    ).ready,
    false,
  );
});

test("local model selection remembers intent and otherwise avoids downloads", () => {
  const models = ["large", "medium", "small"];
  assert.deepEqual(
    chooseLocalModel("large", models, new Set(["small"])),
    { id: "small", source: "cached" },
  );
  assert.deepEqual(
    chooseLocalModel("large", models, new Set(["large", "small"])),
    { id: "large", source: "cached" },
  );
  assert.deepEqual(
    chooseLocalModel("large", models, new Set(["small"]), "medium"),
    { id: "medium", source: "remembered" },
  );
  assert.deepEqual(
    chooseLocalModel("large", models, new Set(), "removed"),
    { id: "large", source: "default" },
  );
});

test("local model menus keep active and cached choices easy to reach", () => {
  assert.deepEqual(
    orderLocalModels(
      ["large", "medium", "small", "tiny"],
      "medium",
      new Set(["small", "tiny"]),
    ),
    ["medium", "small", "tiny", "large"],
  );
});
