import type {
  ChatCompletionChunk,
  ChatCompletionParams,
} from "@wllama/wllama/esm/types/oai-compat.js";
import type { Wllama } from "@wllama/wllama/esm/wllama.js";

import { BROWSER_MODELS, getBrowserModel } from "./browser-models.ts";
import type { LocalModelStatus } from "./local-model.ts";

type WllamaModule = typeof import("@wllama/wllama/esm/index.js");
type WllamaCacheManager = InstanceType<WllamaModule["CacheManager"]>;
interface RuntimeAssets {
  primaryWasmUrl: string;
  compatWorkerCode: string;
  compatWasmUrl: string;
}

interface WllamaCacheMetadata {
  originalURL: string;
  originalSize: number;
  etag: string;
  sha256?: string;
  mmprojURL?: string;
}

interface WllamaCacheEntry {
  name: string;
  size: number;
  metadata: WllamaCacheMetadata;
}

interface WllamaCacheInspector {
  getNameFromURL(url: string): Promise<string>;
  getMetadata(name: string): Promise<WllamaCacheMetadata | null>;
  getSize(name: string): Promise<number>;
}

interface WebGpuFeatureSet {
  has(feature: string): boolean;
}

interface NavigatorWithWebGpu {
  gpu?: {
    requestAdapter(): Promise<{ features: WebGpuFeatureSet } | null>;
  };
}

interface WllamaWebGpuSupport {
  webGpu: boolean;
  shaderF16: boolean;
}

interface WllamaResultChunk {
  has_more: boolean;
  is_error: boolean;
  data_json: string;
}

interface WllamaInternal {
  proxy: {
    wllamaAction<T>(action: string, request: { _name: string }): Promise<T>;
  };
  jsonDecode(value: string): unknown;
}

interface WllamaInternalPrototype {
  __piodideDrainPatched?: boolean;
  getResponse(
    this: WllamaInternal,
    options: {
      abortSignal?: AbortSignal;
      onData?: (chunk: unknown) => void;
    },
    isStream: boolean,
  ): Promise<unknown>;
}

const WASM32_MODEL_LIMIT = 4 * 1024 ** 3;
const CHROME_WEBGPU_LAUNCH =
  "On Linux/NVIDIA, fully quit Chrome and relaunch it with " +
  "`npm run chrome:webgpu`.";

export type KnownWllamaCacheState = "missing" | "complete" | "incomplete";

export function knownWllamaCacheState(
  expectedBytes: number,
  metadata: WllamaCacheMetadata | null,
  storedBytes: number,
): KnownWllamaCacheState {
  if (storedBytes < 0 && !metadata) return "missing";
  return storedBytes === expectedBytes ? "complete" : "incomplete";
}

/**
 * Wllama 3.5.1 can store a Hugging Face blob in Chrome's experimental
 * cross-origin content-addressed store while keeping only its URL metadata in
 * OPFS. Its list() implementation enumerates OPFS data files only, so that
 * valid combination disappears from the list and ModelManager reports
 * "Model file not found". Reconstruct those known entries from public cache
 * methods; open() can then retrieve the blob by the SHA stored in metadata.
 */
export async function repairKnownWllamaCacheEntries(
  entries: WllamaCacheEntry[],
  inspector: WllamaCacheInspector,
  sourceUrls: readonly string[],
): Promise<WllamaCacheEntry[]> {
  const repaired = [...entries];
  for (const sourceUrl of sourceUrls) {
    if (repaired.some((entry) => entry.metadata.originalURL === sourceUrl)) {
      continue;
    }
    const name = await inspector.getNameFromURL(sourceUrl);
    const metadata = await inspector.getMetadata(name);
    if (!metadata || metadata.originalURL !== sourceUrl) continue;
    const size = await inspector.getSize(name);
    if (size <= 0) continue;

    const existing = repaired.find((entry) => entry.name === name);
    if (existing) {
      existing.size = size;
      existing.metadata = metadata;
    } else {
      repaired.push({ name, size, metadata });
    }
  }
  return repaired;
}

export function hasWllamaWebGpuFeatures(
  features: WebGpuFeatureSet | undefined,
): boolean {
  return features?.has("shader-f16") === true;
}

export async function drainWllamaResponseTail(
  readResult: () => Promise<WllamaResultChunk>,
  decode: (value: string) => unknown,
  initialResult: unknown,
  isStream: boolean,
  onData?: (chunk: unknown) => void,
  signal?: AbortSignal,
): Promise<unknown> {
  let finalResult = initialResult;
  for (;;) {
    if (signal?.aborted) {
      throw new DOMException("Browser model generation was cancelled.", "AbortError");
    }
    const result = await readResult();
    const json = result.data_json;
    if (!json) {
      if (!result.has_more) break;
      continue;
    }
    if (json === "null") continue;

    const decoded = decode(json);
    if (result.is_error) {
      const message =
        typeof decoded === "object" &&
        decoded !== null &&
        "message" in decoded &&
        typeof decoded.message === "string"
          ? decoded.message
          : "Wllama inference failed.";
      throw new Error(message);
    }
    if (isStream) {
      const chunks = Array.isArray(decoded) ? decoded : [decoded];
      for (const chunk of chunks) {
        onData?.(chunk);
        finalResult = chunk;
      }
    } else {
      finalResult = decoded;
    }

    // Wllama's native loop can report has_more=false while a second result
    // (usually the final finish_reason chunk) is already queued. Confirm the
    // queue is actually empty before returning.
  }
  return finalResult;
}

export type BrowserModelStatus = LocalModelStatus;

export type BrowserChatRequest = Omit<
  ChatCompletionParams,
  "stream" | "abortSignal"
>;

type StatusListener = (status: BrowserModelStatus) => void;

class BrowserModelRuntime {
  private modulePromise: Promise<WllamaModule> | null = null;
  private assetsPromise: Promise<RuntimeAssets> | null = null;
  private cacheManager: WllamaCacheManager | null = null;
  private engine: Wllama | null = null;
  private loadedModelId: string | null = null;
  private loadedContextSize: number | null = null;
  private loadedBackend: "wasm" | "webgpu" | null = null;
  private loading: {
    modelId: string;
    contextSize: number;
    promise: Promise<void>;
  } | null = null;
  private contextSizeByModel = new Map<string, number>();
  private listeners = new Set<StatusListener>();
  private currentStatus: BrowserModelStatus = { phase: "idle" };

  get status(): BrowserModelStatus {
    return { ...this.currentStatus };
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  contextSize(modelId: string): number {
    const model = getBrowserModel(modelId);
    if (!model) throw new Error(`Unknown browser model: ${modelId}`);
    return this.contextSizeByModel.get(modelId) ?? model.load.contextSize;
  }

  async setContextSize(modelId: string, contextSize: number): Promise<boolean> {
    const model = getBrowserModel(modelId);
    if (!model) throw new Error(`Unknown browser model: ${modelId}`);
    if (!model.contextOptions.includes(contextSize)) {
      throw new Error(
        `Unsupported context size for ${modelId}: ${contextSize}. ` +
          `Choose one of ${model.contextOptions.join(", ")}.`,
      );
    }
    if (this.contextSize(modelId) === contextSize) return false;

    // Do not alter the allocation underneath a load already in progress.
    // Finish it first, then unload it before remembering the new size.
    if (this.loading?.modelId === modelId) {
      await this.loading.promise.catch(() => {});
    }
    if (this.loadedModelId === modelId) await this.unload();
    this.contextSizeByModel.set(modelId, contextSize);
    return true;
  }

  async isCached(modelId: string): Promise<boolean> {
    return (await this.cachedModelIds()).has(modelId);
  }

  async cachedModelIds(): Promise<Set<string>> {
    const entries = await (await this.getCacheManager()).list();
    const completeUrls = new Set(
      entries
        .filter(
          (entry) =>
            entry.size > 0 &&
            entry.size === entry.metadata.originalSize,
        )
        .map((entry) => entry.metadata.originalURL),
    );
    return new Set(
      BROWSER_MODELS
        .filter((model) => completeUrls.has(model.sourceUrl))
        .map((model) => model.id),
    );
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
    const model = getBrowserModel(modelId);
    if (!model) throw new Error(`Unknown browser model: ${modelId}`);
    const contextSize = this.contextSize(modelId);
    if (
      this.loadedModelId === modelId &&
      this.loadedContextSize === contextSize &&
      this.engine?.isModelLoaded()
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
        this.engine?.isModelLoaded()
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
    request: BrowserChatRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk> {
    await this.ensureLoaded(modelId, signal);
    const engine = this.engine;
    if (!engine) throw new Error("Browser model failed to initialize.");

    this.setStatus({
      phase: "generating",
      modelId,
      backend: this.currentStatus.backend,
      threads: this.currentStatus.threads,
      contextSize: this.loadedContextSize ?? this.contextSize(modelId),
    });
    try {
      const chunks: ChatCompletionChunk[] = [];
      let settled = false;
      let completionError: unknown;
      let wake: (() => void) | null = null;
      const notify = () => {
        const listener = wake;
        wake = null;
        listener?.();
      };
      const completion = engine.createChatCompletion({
        ...request,
        stream: true,
        abortSignal: signal,
        onData: (chunk) => {
          chunks.push(chunk);
          notify();
        },
      }).then(
        () => {
          settled = true;
          notify();
        },
        (error: unknown) => {
          completionError = error;
          settled = true;
          notify();
        },
      );

      // Wllama 3.5.1's AsyncIterable wrapper can observe an empty native
      // result queue between WebGPU callbacks and end the stream too early.
      // Its callback overload awaits the native completion, so bridge that
      // overload ourselves and do not let one request leak its tail into the
      // next request.
      while (!settled || chunks.length > 0) {
        const chunk = chunks.shift();
        if (chunk) {
          yield chunk;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      await completion;
      if (completionError) throw completionError;
      this.setReadyStatus(modelId, engine);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        await this.unload();
        throw new DOMException("Browser model generation was cancelled.", "AbortError");
      }
      this.setStatus({
        phase: "error",
        modelId,
        contextSize: this.loadedContextSize ?? this.contextSize(modelId),
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async unload(): Promise<void> {
    const engine = this.engine;
    if (!engine) {
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
    this.loadedModelId = null;
    this.loadedContextSize = null;
    this.loadedBackend = null;
    await engine.exit();
    this.setStatus({ phase: "idle" });
  }

  async removeCached(modelId: string): Promise<void> {
    const model = getBrowserModel(modelId);
    if (!model) throw new Error(`Unknown browser model: ${modelId}`);
    if (this.loadedModelId === modelId) await this.unload();
    await (await this.getCacheManager()).delete(model.sourceUrl);
  }

  async clearCache(): Promise<void> {
    await this.unload();
    await (await this.getCacheManager()).clear();
  }

  private async loadModel(
    modelId: string,
    contextSize: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const model = getBrowserModel(modelId)!;
    this.setStatus({ phase: "preparing", modelId, contextSize });
    if (this.engine) await this.unload();

    const gpuSupport = await probeWllamaWebGpu();
    if (!gpuSupport.shaderF16 && model.bytes >= WASM32_MODEL_LIMIT) {
      const unavailable = gpuSupport.webGpu
        ? "does not expose the required shader-f16 adapter feature"
        : "is unavailable";
      const message =
        `${model.label} (${formatBytes(model.bytes)}) cannot fit in Wllama's wasm32 ` +
        `CPU backend, and WebGPU ${unavailable}. ${CHROME_WEBGPU_LAUNCH}`;
      this.setStatus({ phase: "error", modelId, contextSize, message });
      throw new Error(message);
    }

    const cached = await this.isCached(modelId);
    if (!cached) await this.assertStorageCapacity(model.bytes);
    if (signal?.aborted) throw new DOMException("Model loading was cancelled.", "AbortError");

    const [module, assets] = await Promise.all([
      this.loadModule(),
      this.loadAssets(),
    ]);
    let engine = this.createEngine(module, assets);
    this.engine = engine;

    let backend: "wasm" | "webgpu" =
      gpuSupport.shaderF16 && engine.isSupportWebGPU() ? "webgpu" : "wasm";
    this.setStatus({
      phase: cached ? "loading" : "downloading",
      modelId,
      loadedBytes: cached ? model.bytes : 0,
      totalBytes: model.bytes,
      backend,
      contextSize,
    });

    try {
      try {
        await this.loadIntoEngine(
          engine,
          modelId,
          contextSize,
          cached,
          backend,
          signal,
        );
      } catch (error) {
        if (backend !== "webgpu" || signal?.aborted || isAbortError(error)) {
          throw error;
        }
        if (model.bytes >= WASM32_MODEL_LIMIT) {
          throw new Error(
            `WebGPU initialization failed for ${model.label}, and its ` +
              `${formatBytes(model.bytes)} model cannot fit in Wllama's ` +
              `wasm32 CPU backend. ${CHROME_WEBGPU_LAUNCH}`,
            { cause: error },
          );
        }
        await engine.exit().catch(() => {});
        engine = this.createEngine(module, assets);
        this.engine = engine;
        backend = "wasm";
        this.setStatus({
          phase: "loading",
          modelId,
          loadedBytes: model.bytes,
          totalBytes: model.bytes,
          backend,
          contextSize,
          message: "WebGPU initialization failed; retrying with WebAssembly.",
        });
        await this.loadIntoEngine(
          engine,
          modelId,
          contextSize,
          true,
          backend,
          signal,
        );
      }
      this.loadedModelId = modelId;
      this.loadedContextSize = contextSize;
      this.loadedBackend = backend;
      this.setReadyStatus(modelId, engine);
    } catch (error) {
      this.engine = null;
      this.loadedModelId = null;
      this.loadedContextSize = null;
      this.loadedBackend = null;
      await engine.exit().catch(() => {});
      if (signal?.aborted || isAbortError(error)) {
        this.setStatus({ phase: "idle" });
        throw new DOMException("Browser model loading was cancelled.", "AbortError");
      }
      this.setStatus({
        phase: "error",
        modelId,
        contextSize,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private setReadyStatus(modelId: string, engine: Wllama): void {
    this.setStatus({
      phase: "ready",
      modelId,
      backend: this.loadedBackend ?? "wasm",
      threads: engine.getNumThreads(),
      contextSize: this.loadedContextSize ?? this.contextSize(modelId),
    });
  }

  private createEngine(module: WllamaModule, assets: RuntimeAssets): Wllama {
    this.cacheManager ??= this.createCacheManager(module);
    const engine = new module.Wllama(
      { default: assets.primaryWasmUrl },
      {
        cacheManager: this.cacheManager,
        suppressNativeLog: true,
        logger: module.LoggerWithoutDebug,
        parallelDownloads: 3,
      },
    );
    engine.setCompat(
      {
        worker: { code: assets.compatWorkerCode },
        wasm: assets.compatWasmUrl,
      },
      "firefox_safari",
    );
    return engine;
  }

  private async getCacheManager(): Promise<WllamaCacheManager> {
    const module = await this.loadModule();
    this.cacheManager ??= this.createCacheManager(module);
    return this.cacheManager;
  }

  private createCacheManager(module: WllamaModule): WllamaCacheManager {
    const cacheManager = new module.CacheManager();
    const nativeList = cacheManager.list.bind(cacheManager);
    const nativeDownload = cacheManager.download.bind(cacheManager);
    cacheManager.list = async () =>
      repairKnownWllamaCacheEntries(
        await nativeList(),
        cacheManager,
        BROWSER_MODELS.map((model) => model.sourceUrl),
      );
    cacheManager.download = async (url, options = {}) => {
      const model = BROWSER_MODELS.find((candidate) => candidate.sourceUrl === url);
      if (!model) return nativeDownload(url, options);

      const name = await cacheManager.getNameFromURL(url);
      let metadata = await cacheManager.getMetadata(name);
      let storedBytes = await cacheManager.getSize(name);
      let state = knownWllamaCacheState(model.bytes, metadata, storedBytes);

      if (state === "complete") {
        if (metadata?.originalURL !== url || metadata.originalSize !== model.bytes) {
          await cacheManager.writeMetadata(name, {
            ...metadata,
            ...options.metadataAdditional,
            originalURL: url,
            originalSize: model.bytes,
            etag: metadata?.etag ?? "",
          });
        }
        return;
      }

      if (state === "incomplete") {
        await cacheManager.delete(name);
        await this.downloadKnownModelToOpfs(cacheManager, model, options);
        return;
      }

      // Preserve Wllama's normal content-addressed-store reuse for a genuinely
      // missing entry, but validate the result. Its 3.5.1 implementation also
      // accepts an interrupted COS object merely because it exists.
      await nativeDownload(url, options);
      metadata = await cacheManager.getMetadata(name);
      storedBytes = await cacheManager.getSize(name);
      state = knownWllamaCacheState(model.bytes, metadata, storedBytes);
      if (state === "complete") return;

      await cacheManager.delete(name);
      await this.downloadKnownModelToOpfs(cacheManager, model, options);
    };
    return cacheManager;
  }

  private async downloadKnownModelToOpfs(
    cacheManager: WllamaCacheManager,
    model: (typeof BROWSER_MODELS)[number],
    options: NonNullable<Parameters<WllamaCacheManager["download"]>[1]>,
  ): Promise<void> {
    const response = await fetch(model.sourceUrl, {
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok || !response.body) {
      throw new Error(
        `Failed to fetch ${model.sourceUrl}: HTTP ${response.status}`,
      );
    }

    const headerBytes = Number(response.headers.get("content-length") ?? "0");
    const totalBytes = headerBytes > 0 ? headerBytes : model.bytes;
    const etag = (response.headers.get("etag") ?? "").replace(
      /[^A-Za-z0-9]/g,
      "",
    );
    let loadedBytes = 0;
    let lastProgressAt = 0;
    const progressStream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loadedBytes += chunk.byteLength;
        const now = Date.now();
        if (now - lastProgressAt > 100) {
          lastProgressAt = now;
          options.progressCallback?.({
            loaded: loadedBytes,
            total: totalBytes,
          });
        }
        controller.enqueue(chunk);
      },
      flush() {
        options.progressCallback?.({
          loaded: loadedBytes,
          total: totalBytes,
        });
      },
    });

    const name = await cacheManager.getNameFromURL(model.sourceUrl);
    await cacheManager.write(
      name,
      response.body.pipeThrough(progressStream),
      {
        ...options.metadataAdditional,
        originalURL: model.sourceUrl,
        originalSize: totalBytes,
        etag,
      },
    );
    const storedBytes = await cacheManager.getSize(name);
    if (storedBytes !== model.bytes) {
      await cacheManager.delete(name);
      throw new Error(
        `Incomplete model download: received ${formatBytes(storedBytes)} of ` +
          `${formatBytes(model.bytes)}.`,
      );
    }
  }

  private async loadIntoEngine(
    engine: Wllama,
    modelId: string,
    contextSize: number,
    cached: boolean,
    backend: "wasm" | "webgpu",
    signal?: AbortSignal,
  ): Promise<void> {
    const model = getBrowserModel(modelId)!;
    await engine.loadModelFromUrl(model.sourceUrl, {
      signal,
      progressCallback: ({ loaded, total }) => {
        this.setStatus({
          phase: cached || loaded >= total ? "loading" : "downloading",
          modelId,
          loadedBytes: loaded,
          totalBytes: total || model.bytes,
          backend,
          contextSize,
        });
      },
      n_ctx: contextSize,
      n_batch: model.load.batchSize,
      n_gpu_layers: backend === "webgpu" ? 999 : 0,
      cache_type_k: model.load.cacheTypeK,
      cache_type_v: model.load.cacheTypeV,
      flash_attn: true,
      jinja: true,
      // Parse <think> separately from final content for models whose native
      // chat template can toggle reasoning. The per-request template kwarg
      // still decides whether the model actually thinks.
      reasoning: model.thinking === true,
      warmup: true,
      no_kv_offload: false,
      // The current WebGPU context reports KV shifting as unsupported.
      ctx_shift: backend === "wasm",
      default_template_kwargs: {
        enable_thinking: false,
      },
    });
    const loaded = engine.getLoadedContextInfo();
    if (
      !engine.isModelLoaded() ||
      loaded.n_vocab <= 0 ||
      loaded.n_layer <= 0 ||
      (model.tools && !engine.getChatTemplate())
    ) {
      throw new Error(`Wllama did not finish initializing ${model.label}.`);
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

  private loadModule(): Promise<WllamaModule> {
    // v3.5.1's package root points at a missing index.js; its published ESM
    // entry is complete and is the browser build documented by the project.
    this.modulePromise ??= import("@wllama/wllama/esm/index.js").then((module) => {
      installWllamaResponseDrain(module);
      return module;
    });
    return this.modulePromise;
  }

  private loadAssets(): Promise<RuntimeAssets> {
    this.assetsPromise ??= Promise.all([
      import("@wllama/wllama/esm/wasm/wllama.wasm?url"),
      import("@wllama/wllama-compat/wasm/wllama.js?raw"),
      import("@wllama/wllama-compat/wasm/wllama.wasm?url"),
    ]).then(([primary, compatWorker, compatWasm]) => ({
      primaryWasmUrl: primary.default,
      compatWorkerCode: compatWorker.default,
      compatWasmUrl: compatWasm.default,
    }));
    return this.assetsPromise;
  }

  private setStatus(status: BrowserModelStatus): void {
    this.currentStatus = status;
    for (const listener of this.listeners) listener(this.status);
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function probeWllamaWebGpu(): Promise<WllamaWebGpuSupport> {
  const gpu = (navigator as unknown as NavigatorWithWebGpu).gpu;
  if (!gpu) return { webGpu: false, shaderF16: false };
  try {
    const adapter = await gpu.requestAdapter();
    return {
      webGpu: adapter !== null,
      shaderF16: hasWllamaWebGpuFeatures(adapter?.features),
    };
  } catch {
    return { webGpu: true, shaderF16: false };
  }
}

function installWllamaResponseDrain(module: WllamaModule): void {
  const prototype = module.Wllama.prototype as unknown as WllamaInternalPrototype;
  if (prototype.__piodideDrainPatched) return;
  const nativeGetResponse = prototype.getResponse;
  prototype.getResponse = async function (options, isStream) {
    const result = await nativeGetResponse.call(this, options, isStream);
    return drainWllamaResponseTail(
      () =>
        this.proxy.wllamaAction<WllamaResultChunk>("get_result", {
          _name: "gres_req",
        }),
      (value) => this.jsonDecode(value),
      result,
      isStream,
      options.onData,
      options.abortSignal,
    );
  };
  prototype.__piodideDrainPatched = true;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  return `${Math.ceil(bytes / 1024 ** 2)} MiB`;
}

export const browserModelRuntime = new BrowserModelRuntime();
