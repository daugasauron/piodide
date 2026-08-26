import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { prebuiltAppConfig } from "@mlc-ai/web-llm";

import { WEBLLM_MODELS, getWebLLMModel } from "../src/webllm-models.ts";
import {
  cacheBundledWebLLMConfig,
  validateWebLLMModelFiles,
  webLLMModelIdFromCacheUrl,
  webLLMRuntime,
} from "../src/webllm-runtime.ts";

test("WebLLM cache discovery maps runtime and legacy model URLs", () => {
  assert.equal(
    webLLMModelIdFromCacheUrl(
      "https://huggingface.co/mlc-ai/Qwen3.5-2B-q4f16_1-MLC/resolve/main/tensor-cache.json",
      prebuiltAppConfig.model_list,
    ),
    "Qwen3.5-2B-q4f16_1-MLC",
  );
  assert.equal(
    webLLMModelIdFromCacheUrl(
      "https://huggingface.co/example/custom-agent-MLC/resolve/main/tensor-cache.json",
      [],
    ),
    "custom-agent-MLC",
  );
});

function localFile(
  name: string,
  size: number,
  text = "",
  prefix = new Uint8Array(),
): File {
  return {
    name,
    size,
    text: async () => text,
    slice: () => new Blob([prefix]),
    stream: () => new Blob([text || prefix]).stream(),
  } as unknown as File;
}

class MemoryCache {
  readonly values = new Map<string, { bytes: ArrayBuffer; headers: Headers }>();

  async put(request: Request, response: Response): Promise<void> {
    this.values.set(request.url, {
      bytes: await response.arrayBuffer(),
      headers: new Headers(response.headers),
    });
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const url = request instanceof Request ? request.url : String(request);
    const value = this.values.get(url);
    return value ? new Response(value.bytes.slice(0), { headers: value.headers }) : undefined;
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    const url = request instanceof Request ? request.url : String(request);
    return this.values.delete(url);
  }

  async keys(): Promise<Request[]> {
    return [...this.values.keys()].map((url) => new Request(url));
  }
}

function jsonFile(name: string, value: unknown): File {
  const text = JSON.stringify(value);
  return localFile(name, new TextEncoder().encode(text).byteLength, text);
}

function qwen2BBundle(includeWasm = true): File[] {
  const model = getWebLLMModel("Qwen3.5-2B-q4f16_1-MLC")!;
  const shards = Array.from({ length: model.localFiles.shardCount }, (_, index) => {
    const nbytes =
      index === model.localFiles.shardCount - 1
        ? model.localFiles.parameterBytes - (model.localFiles.shardCount - 1)
        : 1;
    return { dataPath: `params_shard_${index}.bin`, nbytes };
  });
  const files = [
    jsonFile("mlc-chat-config.json", {
      model_type: model.localFiles.modelType,
      quantization: `${model.quantization}_1`,
      tokenizer_files: ["tokenizer.json"],
      model_config: {
        hidden_size: model.localFiles.hiddenSize,
        num_hidden_layers: model.localFiles.layers,
        vocab_size: model.localFiles.vocabSize,
      },
    }),
    jsonFile("tensor-cache.json", {
      metadata: { ParamBytes: model.localFiles.parameterBytes },
      records: shards,
    }),
    localFile("tokenizer.json", 2, "{}"),
    ...shards.map((shard) => localFile(shard.dataPath, shard.nbytes)),
  ];
  if (includeWasm) {
    files.push(
      localFile(
        "Qwen3.5-2B-q4f16_1_cs1k-webgpu.wasm",
        model.localFiles.wasmBytes,
        "",
        new Uint8Array([0x00, 0x61, 0x73, 0x6d]),
      ),
    );
  }
  return files;
}

function qwen2BRecord() {
  return prebuiltAppConfig.model_list.find(
    (record) => record.model_id === "Qwen3.5-2B-q4f16_1-MLC",
  )!;
}

test("bundled WebLLM configs seed the exact cache keys without a cross-origin fetch", async () => {
  const cache = new MemoryCache();
  let fetches = 0;
  const cacheStorage = {
    open: async (name: string) => {
      assert.equal(name, "webllm/config");
      return cache;
    },
  };

  for (const model of WEBLLM_MODELS) {
    const record = prebuiltAppConfig.model_list.find(
      (candidate) => candidate.model_id === model.id,
    )!;
    const config = await readFile(
      new URL(`../public/webllm-config/${model.id}.json`, import.meta.url),
    );
    const bundledUrl = `https://app.test/piodide/webllm-config/${model.id}.json`;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      assert.equal(String(input), bundledUrl);
      fetches += 1;
      return new Response(config, {
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await cacheBundledWebLLMConfig(model, record, bundledUrl, {
      cacheStorage,
      fetchImpl,
    });
    const expectedKey = `${record.model}/resolve/main/mlc-chat-config.json`;
    assert.ok(await cache.match(expectedKey));

    await cacheBundledWebLLMConfig(model, record, bundledUrl, {
      cacheStorage,
      fetchImpl,
    });
  }

  assert.equal(fetches, WEBLLM_MODELS.length);
});

test("WebLLM local import validates and maps a complete MLC directory", async () => {
  const model = getWebLLMModel("Qwen3.5-2B-q4f16_1-MLC")!;
  const files = qwen2BBundle();
  const plan = await validateWebLLMModelFiles(model, qwen2BRecord(), files);

  assert.equal(plan.selectedFiles, files.length);
  assert.equal(plan.ignoredFiles, 0);
  assert.equal(plan.entries.at(-1)?.url.endsWith("/tensor-cache.json"), true);
  assert.equal(plan.entries.at(-1)?.scope, "webllm/model");
  assert.ok(plan.entries.some((entry) => entry.scope === "webllm/wasm"));
  assert.ok(plan.bytes > model.localFiles.parameterBytes);
});

test("WebLLM local import permits the small compiled WASM to be fetched later", async () => {
  const model = getWebLLMModel("Qwen3.5-2B-q4f16_1-MLC")!;
  const plan = await validateWebLLMModelFiles(
    model,
    qwen2BRecord(),
    qwen2BBundle(false),
  );
  assert.equal(plan.entries.some((entry) => entry.scope === "webllm/wasm"), false);
});

test("WebLLM local import rejects wrong quantization and incomplete shards", async () => {
  const model = getWebLLMModel("Qwen3.5-2B-q4f16_1-MLC")!;
  const wrongConfig = qwen2BBundle();
  const configIndex = wrongConfig.findIndex((file) => file.name === "mlc-chat-config.json");
  wrongConfig[configIndex] = jsonFile("mlc-chat-config.json", {
    model_type: model.localFiles.modelType,
    quantization: "q4f32_1",
    tokenizer_files: ["tokenizer.json"],
    model_config: {
      hidden_size: model.localFiles.hiddenSize,
      num_hidden_layers: model.localFiles.layers,
      vocab_size: model.localFiles.vocabSize,
    },
  });
  await assert.rejects(
    validateWebLLMModelFiles(model, qwen2BRecord(), wrongConfig),
    /does not describe Qwen3\.5 2B/,
  );

  const incomplete = qwen2BBundle().filter(
    (file) => file.name !== "params_shard_7.bin",
  );
  await assert.rejects(
    validateWebLLMModelFiles(model, qwen2BRecord(), incomplete),
    /missing params_shard_7\.bin/,
  );
});

test("WebLLM local import populates the cache layout used by WebLLM", async () => {
  const originalCaches = globalThis.caches;
  const originalNavigator = globalThis.navigator;
  const stores = new Map<string, MemoryCache>();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: async (name: string) => {
        let cache = stores.get(name);
        if (!cache) {
          cache = new MemoryCache();
          stores.set(name, cache);
        }
        return cache;
      },
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      storage: {
        estimate: async () => ({ quota: 10 * 1024 ** 3, usage: 0 }),
      },
    },
  });

  try {
    await webLLMRuntime.importModelFiles(
      "Qwen3.5-2B-q4f16_1-MLC",
      qwen2BBundle(false),
    );
    assert.equal(await webLLMRuntime.isCached("Qwen3.5-2B-q4f16_1-MLC"), true);
    assert.ok(stores.get("webllm/model")?.values.size);
    assert.ok(stores.get("webllm/config")?.values.size);
    assert.equal(stores.get("webllm/wasm")?.values.size ?? 0, 0);
  } finally {
    await webLLMRuntime.removeCached("Qwen3.5-2B-q4f16_1-MLC").catch(() => {});
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: originalCaches,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
  }
});
