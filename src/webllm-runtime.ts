import type {
  AppConfig,
  ChatCompletionChunk,
  ChatCompletionRequestStreaming,
  ModelRecord,
  WebWorkerMLCEngine,
} from "@mlc-ai/web-llm";

import type { LocalModelStatus } from "./local-model.ts";
import {
  REPLACED_WEBLLM_MODEL_IDS,
  WEBLLM_MODELS,
  type WebLLMModelDef,
  getWebLLMModel,
} from "./webllm-models.ts";

type WebLLMModule = typeof import("@mlc-ai/web-llm");
type StatusListener = (status: LocalModelStatus) => void;

export type WebLLMChatRequest = Omit<ChatCompletionRequestStreaming, "stream">;

type WebLLMLocalFile = Pick<
  File,
  "name" | "size" | "slice" | "stream" | "text"
>;

interface WebLLMCacheEntry {
  scope: "webllm/model" | "webllm/config" | "webllm/wasm";
  url: string;
  file: WebLLMLocalFile;
  contentType: string;
}

export interface WebLLMLocalImportPlan {
  entries: readonly WebLLMCacheEntry[];
  bytes: number;
  selectedFiles: number;
  ignoredFiles: number;
}

class WebLLMRuntime {
  private modulePromise: Promise<WebLLMModule> | null = null;
  private engine: WebWorkerMLCEngine | null = null;
  private worker: Worker | null = null;
  private loadedModelId: string | null = null;
  private loadedContextSize: number | null = null;
  private loading: {
    modelId: string;
    contextSize: number;
    promise: Promise<void>;
  } | null = null;
  private contextSizeByModel = new Map<string, number>();
  private listeners = new Set<StatusListener>();
  private currentStatus: LocalModelStatus = { phase: "idle" };

  get status(): LocalModelStatus {
    return { ...this.currentStatus };
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  contextSize(modelId: string): number {
    const model = getWebLLMModel(modelId);
    if (!model) throw new Error(`Unknown WebLLM model: ${modelId}`);
    return this.contextSizeByModel.get(modelId) ?? model.contextWindow;
  }

  async setContextSize(modelId: string, contextSize: number): Promise<boolean> {
    const model = getWebLLMModel(modelId);
    if (!model) throw new Error(`Unknown WebLLM model: ${modelId}`);
    if (!model.contextOptions.includes(contextSize)) {
      throw new Error(
        `Unsupported context size for ${modelId}: ${contextSize}. ` +
          `Choose one of ${model.contextOptions.join(", ")}.`,
      );
    }
    if (this.contextSize(modelId) === contextSize) return false;
    if (this.loading?.modelId === modelId) {
      await this.loading.promise.catch(() => {});
    }
    if (this.loadedModelId === modelId) await this.unload();
    this.contextSizeByModel.set(modelId, contextSize);
    return true;
  }

  async isCached(modelId: string): Promise<boolean> {
    if (!getWebLLMModel(modelId)) throw new Error(`Unknown WebLLM model: ${modelId}`);
    const module = await this.loadModule();
    return module.hasModelInCache(modelId, this.appConfig(module));
  }

  async cachedModelIds(): Promise<Set<string>> {
    const module = await this.loadModule();
    const appConfig = this.appConfig(module);
    const states = await Promise.all(
      WEBLLM_MODELS.map(async (model) => ({
        id: model.id,
        cached: await module.hasModelInCache(model.id, appConfig),
      })),
    );
    return new Set(states.filter((state) => state.cached).map((state) => state.id));
  }

  async storageHeadroom(): Promise<number | undefined> {
    const estimate = await navigator.storage?.estimate?.();
    if (!estimate?.quota) return undefined;
    return Math.max(0, estimate.quota - (estimate.usage ?? 0));
  }

  async requestPersistentStorage(): Promise<boolean | undefined> {
    return navigator.storage?.persist?.();
  }

  async ensureLoaded(modelId: string, signal?: AbortSignal): Promise<void> {
    if (!getWebLLMModel(modelId)) throw new Error(`Unknown WebLLM model: ${modelId}`);
    const contextSize = this.contextSize(modelId);
    if (
      this.loadedModelId === modelId &&
      this.loadedContextSize === contextSize &&
      this.engine
    ) {
      return;
    }
    if (
      this.loading?.modelId === modelId &&
      this.loading.contextSize === contextSize
    ) {
      await this.loading.promise;
      return;
    }
    if (this.loading) {
      await this.loading.promise;
      if (
        this.loadedModelId === modelId &&
        this.loadedContextSize === contextSize &&
        this.engine
      ) {
        return;
      }
    }

    const promise = this.loadModel(modelId, contextSize, signal);
    this.loading = { modelId, contextSize, promise };
    try {
      await promise;
    } finally {
      if (this.loading?.promise === promise) this.loading = null;
    }
  }

  async *streamChat(
    modelId: string,
    request: WebLLMChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    await this.ensureLoaded(modelId, signal);
    const engine = this.engine;
    if (!engine) throw new Error("WebLLM failed to initialize.");

    this.setStatus({
      phase: "generating",
      modelId,
      backend: "webgpu",
      contextSize: this.loadedContextSize ?? this.contextSize(modelId),
    });
    const interrupt = () => engine.interruptGenerate();
    signal?.addEventListener("abort", interrupt, { once: true });
    try {
      const chunks = await engine.chat.completions.create({
        ...request,
        stream: true,
      });
      for await (const chunk of chunks) {
        if (signal?.aborted) {
          throw new DOMException("WebLLM generation was cancelled.", "AbortError");
        }
        yield chunk;
      }
      this.setStatus({
        phase: "ready",
        modelId,
        backend: "webgpu",
        contextSize: this.loadedContextSize ?? this.contextSize(modelId),
      });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        this.setStatus({
          phase: "ready",
          modelId,
          backend: "webgpu",
          contextSize: this.loadedContextSize ?? this.contextSize(modelId),
        });
        throw new DOMException("WebLLM generation was cancelled.", "AbortError");
      }
      this.setStatus({
        phase: "error",
        modelId,
        backend: "webgpu",
        contextSize: this.loadedContextSize ?? this.contextSize(modelId),
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      signal?.removeEventListener("abort", interrupt);
    }
  }

  async unload(): Promise<void> {
    const engine = this.engine;
    const worker = this.worker;
    if (!engine && !worker) {
      this.loadedModelId = null;
      this.loadedContextSize = null;
      this.setStatus({ phase: "idle" });
      return;
    }

    this.setStatus({
      phase: "unloading",
      modelId: this.loadedModelId ?? undefined,
      contextSize: this.loadedContextSize ?? undefined,
    });
    this.engine = null;
    this.worker = null;
    this.loadedModelId = null;
    this.loadedContextSize = null;
    try {
      await engine?.unload();
    } finally {
      worker?.terminate();
      this.setStatus({ phase: "idle" });
    }
  }

  async removeCached(modelId: string): Promise<void> {
    if (!getWebLLMModel(modelId)) throw new Error(`Unknown WebLLM model: ${modelId}`);
    if (this.loadedModelId === modelId) await this.unload();
    const module = await this.loadModule();
    await module.deleteModelAllInfoInCache(modelId, this.appConfig(module));
  }

  async importModelFiles(modelId: string, files: readonly File[]): Promise<void> {
    const model = getWebLLMModel(modelId);
    if (!model) throw new Error(`Unknown WebLLM model: ${modelId}`);
    if (typeof caches === "undefined") {
      throw new Error("WebLLM local import requires the browser Cache API.");
    }

    const module = await this.loadModule();
    const appConfig = this.appConfig(module);
    const record = findWebLLMModelRecord(modelId, appConfig);
    const plan = await validateWebLLMModelFiles(model, record, files);
    if (this.loadedModelId === modelId) await this.unload();

    const alreadyCached = await module.hasModelInCache(modelId, appConfig);
    if (!alreadyCached) {
      await this.removeReplacedCachedModel(modelId);
      await this.assertStorageCapacity(plan.bytes);
    }

    let loadedBytes = 0;
    let lastProgressAt = 0;
    const reportProgress = () =>
      this.setStatus({
        phase: "importing",
        modelId,
        loadedBytes,
        totalBytes: plan.bytes,
        backend: "webgpu",
        contextSize: this.contextSize(modelId),
      });
    const openedCaches = new Map<string, Cache>();
    const openCache = async (scope: string): Promise<Cache> => {
      const existing = openedCaches.get(scope);
      if (existing) return existing;
      const cache = await caches.open(scope);
      openedCaches.set(scope, cache);
      return cache;
    };
    const removeEntries = async () => {
      await Promise.all(
        plan.entries.map(async (entry) => {
          const cache = await openCache(entry.scope);
          await cache.delete(entry.url);
        }),
      );
    };

    reportProgress();
    try {
      await removeEntries();
      for (const entry of plan.entries) {
        const progressStream = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            loadedBytes += chunk.byteLength;
            const now = Date.now();
            if (now - lastProgressAt > 100) {
              lastProgressAt = now;
              reportProgress();
            }
            controller.enqueue(chunk);
          },
        });
        const response = new Response(entry.file.stream().pipeThrough(progressStream), {
          headers: { "Content-Type": entry.contentType },
        });
        await (await openCache(entry.scope)).put(new Request(entry.url), response);
      }
      reportProgress();
      const retained = await Promise.all(
        plan.entries.map(async (entry) =>
          Boolean(await (await openCache(entry.scope)).match(entry.url)),
        ),
      );
      if (retained.some((value) => !value) || !(await this.isCached(modelId))) {
        throw new Error("The browser cache did not retain the complete WebLLM model.");
      }
      this.setStatus({ phase: "idle" });
    } catch (error) {
      await removeEntries().catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({
        phase: "error",
        modelId,
        backend: "webgpu",
        contextSize: this.contextSize(modelId),
        message,
      });
      throw error;
    }
  }

  async clearCache(): Promise<void> {
    await this.unload();
    const module = await this.loadModule();
    const appConfig = this.appConfig(module);
    const modelIds = new Set([
      ...WEBLLM_MODELS.map((model) => model.id),
      ...Object.values(REPLACED_WEBLLM_MODEL_IDS),
    ]);
    await Promise.all(
      [...modelIds].map((modelId) =>
        module.deleteModelAllInfoInCache(modelId, appConfig),
      ),
    );
  }

  private async loadModel(
    modelId: string,
    contextSize: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const model = getWebLLMModel(modelId)!;
    if (!("gpu" in navigator)) {
      throw new Error("WebLLM requires WebGPU. Use a browser with WebGPU enabled.");
    }
    this.setStatus({ phase: "preparing", modelId, backend: "webgpu", contextSize });
    if (this.engine || this.worker) await this.unload();

    const module = await this.loadModule();
    const appConfig = this.appConfig(module);
    const record = findWebLLMModelRecord(modelId, appConfig);
    await cacheBundledWebLLMConfig(
      model,
      record,
      new URL(
        `${import.meta.env.BASE_URL}webllm-config/${encodeURIComponent(modelId)}.json`,
        location.origin,
      ).href,
      { signal },
    );

    const cached = await module.hasModelInCache(modelId, appConfig);
    if (!cached) {
      await this.removeReplacedCachedModel(modelId);
      await this.assertStorageCapacity(model.bytes);
    }
    if (signal?.aborted) throw abortError("WebLLM model loading was cancelled.");

    const worker = new Worker(new URL("./webllm-worker.ts", import.meta.url), {
      type: "module",
      name: "piodide-webllm",
    });
    this.worker = worker;
    this.setStatus({
      phase: cached ? "loading" : "downloading",
      modelId,
      loadedBytes: cached ? model.bytes : 0,
      totalBytes: model.bytes,
      backend: "webgpu",
      contextSize,
    });

    try {
      const create = module.CreateWebWorkerMLCEngine(
        worker,
        modelId,
        {
          appConfig,
          initProgressCallback: (progress) => {
            this.setStatus({
              phase: progress.progress >= 1 ? "loading" : cached ? "loading" : "downloading",
              modelId,
              loadedBytes: Math.min(model.bytes, Math.round(model.bytes * progress.progress)),
              totalBytes: model.bytes,
              backend: "webgpu",
              contextSize,
              message: progress.text,
            });
          },
          logLevel: "WARN",
        },
        {
          context_window_size: contextSize,
        },
      );
      const engine = await abortable(create, signal, () => worker.terminate());
      if (this.worker !== worker) {
        await engine.unload().catch(() => {});
        throw abortError("WebLLM model loading was cancelled.");
      }
      this.engine = engine;
      this.loadedModelId = modelId;
      this.loadedContextSize = contextSize;
      this.setStatus({
        phase: "ready",
        modelId,
        backend: "webgpu",
        contextSize,
      });
    } catch (error) {
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      this.engine = null;
      this.loadedModelId = null;
      this.loadedContextSize = null;
      if (signal?.aborted || isAbortError(error)) {
        this.setStatus({ phase: "idle" });
        throw abortError("WebLLM model loading was cancelled.");
      }
      this.setStatus({
        phase: "error",
        modelId,
        backend: "webgpu",
        contextSize,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async assertStorageCapacity(requiredBytes: number): Promise<void> {
    const available = await this.storageHeadroom();
    if (available !== undefined && available < requiredBytes * 1.1) {
      throw new Error(
        `Not enough browser storage for this model: ${formatBytes(available)} available, ` +
          `${formatBytes(requiredBytes)} required.`,
      );
    }
  }

  private async removeReplacedCachedModel(modelId: string): Promise<void> {
    const replacedModelId = REPLACED_WEBLLM_MODEL_IDS[modelId];
    if (!replacedModelId) return;
    const module = await this.loadModule();
    const appConfig = this.appConfig(module);
    if (await module.hasModelInCache(replacedModelId, appConfig)) {
      await module.deleteModelAllInfoInCache(replacedModelId, appConfig);
    }
  }

  private loadModule(): Promise<WebLLMModule> {
    this.modulePromise ??= import("@mlc-ai/web-llm");
    return this.modulePromise;
  }

  private appConfig(module: WebLLMModule): AppConfig {
    return {
      ...module.prebuiltAppConfig,
      // WebLLM documents Cache API as its most thoroughly tested backend.
      cacheBackend: "cache",
    };
  }

  private setStatus(status: LocalModelStatus): void {
    this.currentStatus = status;
    for (const listener of this.listeners) listener(this.status);
  }
}

interface CacheBundledWebLLMConfigOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  cacheStorage?: {
    open(name: string): Promise<Pick<Cache, "match" | "put">>;
  };
}

/**
 * Seed WebLLM's config cache from a same-origin asset. Hugging Face serves the
 * tiny config through redirecting endpoints whose CORS behavior is less
 * reliable than the large model-file CDN. The model weights remain remote.
 */
export async function cacheBundledWebLLMConfig(
  model: WebLLMModelDef,
  record: ModelRecord,
  bundledUrl: string,
  options: CacheBundledWebLLMConfigOptions = {},
): Promise<void> {
  const cacheStorage = options.cacheStorage ?? caches;
  const cache = await cacheStorage.open("webllm/config");
  const configUrl = new URL(
    "mlc-chat-config.json",
    cleanWebLLMModelUrl(record.model),
  ).href;
  if (await cache.match(configUrl)) return;

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(bundledUrl, { signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) {
      throw abortError("WebLLM model loading was cancelled.");
    }
    throw new Error(
      `Could not load the bundled WebLLM config for ${model.label}: ${errorMessage(error)}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Could not load the bundled WebLLM config for ${model.label} (HTTP ${response.status}).`,
    );
  }

  const data = await response.arrayBuffer();
  if (data.byteLength > 32 * 1024 * 1024) {
    throw new Error(`The bundled WebLLM config for ${model.label} is unexpectedly large.`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = recordObject(JSON.parse(new TextDecoder().decode(data)));
  } catch {
    throw new Error(`The bundled WebLLM config for ${model.label} is not valid JSON.`);
  }
  validateModelConfig(model, parsed);

  await cache.put(
    new Request(configUrl),
    new Response(data, { headers: { "Content-Type": "application/json" } }),
  );
}

export async function validateWebLLMModelFiles(
  model: WebLLMModelDef,
  record: ModelRecord,
  files: readonly WebLLMLocalFile[],
): Promise<WebLLMLocalImportPlan> {
  if (files.length === 0) throw new Error("Select a WebLLM model directory.");

  const byName = new Map<string, WebLLMLocalFile>();
  for (const file of files) {
    const name = localFileName(file.name);
    if (byName.has(name)) {
      throw new Error(`The selected directory contains duplicate ${name} files.`);
    }
    byName.set(name, file);
  }

  const configFile = requireLocalFile(byName, "mlc-chat-config.json");
  const tensorCacheFile = requireLocalFile(byName, "tensor-cache.json");
  const config = await parseLocalJson(configFile, "mlc-chat-config.json");
  const tensorCache = await parseLocalJson(tensorCacheFile, "tensor-cache.json");
  validateModelConfig(model, config);

  const tokenizerFiles = recordArray(config.tokenizer_files);
  const tokenizerName = tokenizerFiles.includes("tokenizer.json")
    ? "tokenizer.json"
    : tokenizerFiles.includes("tokenizer.model")
      ? "tokenizer.model"
      : undefined;
  if (!tokenizerName) {
    throw new Error("The WebLLM config does not declare a supported tokenizer file.");
  }
  const tokenizerFile = requireLocalFile(byName, tokenizerName);

  const metadata = recordObject(tensorCache.metadata);
  if (metadata.ParamBytes !== model.localFiles.parameterBytes) {
    throw new Error(
      `The parameter manifest does not match ${model.label} ` +
        `(expected ${model.localFiles.parameterBytes} bytes).`,
    );
  }
  const shards = recordArray(tensorCache.records);
  if (shards.length !== model.localFiles.shardCount) {
    throw new Error(
      `The parameter manifest has ${shards.length} shards; ` +
        `${model.label} requires ${model.localFiles.shardCount}.`,
    );
  }

  const modelUrl = cleanWebLLMModelUrl(record.model);
  const entries: WebLLMCacheEntry[] = [];
  let shardBytes = 0;
  const shardNames = new Set<string>();
  for (const value of shards) {
    const shard = recordObject(value);
    const dataPath = shard.dataPath;
    const nbytes = shard.nbytes;
    if (
      typeof dataPath !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(dataPath) ||
      !Number.isSafeInteger(nbytes) ||
      (nbytes as number) <= 0
    ) {
      throw new Error("The parameter manifest contains an invalid shard entry.");
    }
    if (shardNames.has(dataPath)) {
      throw new Error(`The parameter manifest repeats ${dataPath}.`);
    }
    shardNames.add(dataPath);
    const file = requireLocalFile(byName, dataPath);
    if (file.size !== nbytes) {
      throw new Error(
        `${dataPath} is ${file.size} bytes; the manifest requires ${nbytes}.`,
      );
    }
    shardBytes += nbytes as number;
    entries.push({
      scope: "webllm/model",
      url: new URL(dataPath, modelUrl).href,
      file,
      contentType: "application/octet-stream",
    });
  }
  if (Math.abs(shardBytes - model.localFiles.parameterBytes) > 4_096) {
    throw new Error("The parameter shard sizes do not match the selected model.");
  }

  const wasmName = decodeURIComponent(
    new URL(record.model_lib).pathname.split("/").pop() ?? "",
  );
  const wasmFile = byName.get(wasmName);
  if (wasmFile) {
    if (wasmFile.size !== model.localFiles.wasmBytes) {
      throw new Error(
        `${wasmName} is ${wasmFile.size} bytes; ${model.label} requires ` +
          `${model.localFiles.wasmBytes}.`,
      );
    }
    const wasmMagic = new Uint8Array(await wasmFile.slice(0, 4).arrayBuffer());
    if (
      wasmMagic.length !== 4 ||
      wasmMagic[0] !== 0x00 ||
      wasmMagic[1] !== 0x61 ||
      wasmMagic[2] !== 0x73 ||
      wasmMagic[3] !== 0x6d
    ) {
      throw new Error(`${wasmName} is not a WebAssembly module.`);
    }
  }

  entries.push(
    {
      scope: "webllm/model",
      url: new URL(tokenizerName, modelUrl).href,
      file: tokenizerFile,
      contentType:
        tokenizerName.endsWith(".json") ? "application/json" : "application/octet-stream",
    },
    {
      scope: "webllm/config",
      url: new URL("mlc-chat-config.json", modelUrl).href,
      file: configFile,
      contentType: "application/json",
    },
    ...(wasmFile
      ? [
          {
            scope: "webllm/wasm" as const,
            url: record.model_lib,
            file: wasmFile,
            contentType: "application/wasm",
          },
        ]
      : []),
    // The manifest is stored last so WebLLM cannot consider a partial import cached.
    {
      scope: "webllm/model",
      url: new URL("tensor-cache.json", modelUrl).href,
      file: tensorCacheFile,
      contentType: "application/json",
    },
  );

  return {
    entries,
    bytes: entries.reduce((total, entry) => total + entry.file.size, 0),
    selectedFiles: files.length,
    ignoredFiles: files.length - entries.length,
  };
}

function findWebLLMModelRecord(modelId: string, appConfig: AppConfig): ModelRecord {
  const record = appConfig.model_list.find((candidate) => candidate.model_id === modelId);
  if (!record) throw new Error(`WebLLM has no prebuilt record for ${modelId}.`);
  return record;
}

function cleanWebLLMModelUrl(value: string): string {
  let url = value.endsWith("/") ? value : `${value}/`;
  if (!/.+\/resolve\/.+\//.test(url)) url += "resolve/main/";
  return new URL(url).href;
}

function localFileName(value: string): string {
  const name = value.replaceAll("\\", "/").split("/").pop() ?? "";
  if (!name || name === "." || name === ".." || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(`Unsafe local model filename: ${value}`);
  }
  return name;
}

function requireLocalFile(
  files: ReadonlyMap<string, WebLLMLocalFile>,
  name: string,
): WebLLMLocalFile {
  const file = files.get(name);
  if (!file) throw new Error(`The selected directory is missing ${name}.`);
  return file;
}

async function parseLocalJson(
  file: WebLLMLocalFile,
  label: string,
): Promise<Record<string, unknown>> {
  if (file.size > 32 * 1024 * 1024) throw new Error(`${label} is unexpectedly large.`);
  try {
    return recordObject(JSON.parse(await file.text()));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label} `)) throw error;
    throw new Error(`${label} is not valid JSON.`);
  }
}

function validateModelConfig(
  model: WebLLMModelDef,
  value: Record<string, unknown>,
): void {
  const config = recordObject(value.model_config);
  const expected = model.localFiles;
  if (
    value.model_type !== expected.modelType ||
    value.quantization !== `${model.quantization}_1` ||
    config.hidden_size !== expected.hiddenSize ||
    config.num_hidden_layers !== expected.layers ||
    config.vocab_size !== expected.vocabSize
  ) {
    throw new Error(`mlc-chat-config.json does not describe ${model.label}.`);
  }
}

function recordObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid WebLLM model metadata.");
  }
  return value as Record<string, unknown>;
}

function recordArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid WebLLM model metadata.");
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    onAbort();
    return Promise.reject(abortError("Operation cancelled."));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      onAbort();
      reject(abortError("Operation cancelled."));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  return `${Math.ceil(bytes / 1024 ** 2)} MiB`;
}

export const webLLMRuntime = new WebLLMRuntime();
