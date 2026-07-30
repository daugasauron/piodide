import type {
  AppConfig,
  ChatCompletionChunk,
  ChatCompletionRequestStreaming,
  WebWorkerMLCEngine,
} from "@mlc-ai/web-llm";

import type { LocalModelStatus } from "./local-model.ts";
import { WEBLLM_MODELS, getWebLLMModel } from "./webllm-models.ts";

type WebLLMModule = typeof import("@mlc-ai/web-llm");
type StatusListener = (status: LocalModelStatus) => void;

export type WebLLMChatRequest = Omit<ChatCompletionRequestStreaming, "stream">;

class WebLLMRuntime {
  private modulePromise: Promise<WebLLMModule> | null = null;
  private engine: WebWorkerMLCEngine | null = null;
  private worker: Worker | null = null;
  private loadedModelId: string | null = null;
  private loading: { modelId: string; promise: Promise<void> } | null = null;
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
    if (this.loadedModelId === modelId && this.engine) return;
    if (this.loading?.modelId === modelId) {
      await this.loading.promise;
      return;
    }
    if (this.loading) {
      await this.loading.promise;
      if (this.loadedModelId === modelId && this.engine) return;
    }

    const promise = this.loadModel(modelId, signal);
    this.loading = { modelId, promise };
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

    this.setStatus({ phase: "generating", modelId, backend: "webgpu" });
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
      this.setStatus({ phase: "ready", modelId, backend: "webgpu" });
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        this.setStatus({ phase: "ready", modelId, backend: "webgpu" });
        throw new DOMException("WebLLM generation was cancelled.", "AbortError");
      }
      this.setStatus({
        phase: "error",
        modelId,
        backend: "webgpu",
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
      this.setStatus({ phase: "idle" });
      return;
    }

    this.setStatus({ phase: "unloading", modelId: this.loadedModelId ?? undefined });
    this.engine = null;
    this.worker = null;
    this.loadedModelId = null;
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

  async clearCache(): Promise<void> {
    await this.unload();
    const module = await this.loadModule();
    const appConfig = this.appConfig(module);
    await Promise.all(
      WEBLLM_MODELS.map((model) =>
        module.deleteModelAllInfoInCache(model.id, appConfig),
      ),
    );
  }

  private async loadModel(modelId: string, signal?: AbortSignal): Promise<void> {
    const model = getWebLLMModel(modelId)!;
    if (!("gpu" in navigator)) {
      throw new Error("WebLLM requires WebGPU. Use a browser with WebGPU enabled.");
    }
    this.setStatus({ phase: "preparing", modelId, backend: "webgpu" });
    if (this.engine || this.worker) await this.unload();

    const cached = await this.isCached(modelId);
    if (!cached) await this.assertStorageCapacity(model.bytes);
    if (signal?.aborted) throw abortError("WebLLM model loading was cancelled.");

    const module = await this.loadModule();
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
    });

    try {
      const create = module.CreateWebWorkerMLCEngine(
        worker,
        modelId,
        {
          appConfig: this.appConfig(module),
          initProgressCallback: (progress) => {
            this.setStatus({
              phase: progress.progress >= 1 ? "loading" : cached ? "loading" : "downloading",
              modelId,
              loadedBytes: Math.min(model.bytes, Math.round(model.bytes * progress.progress)),
              totalBytes: model.bytes,
              backend: "webgpu",
              message: progress.text,
            });
          },
          logLevel: "WARN",
        },
        {
          context_window_size: model.contextWindow,
        },
      );
      const engine = await abortable(create, signal, () => worker.terminate());
      if (this.worker !== worker) {
        await engine.unload().catch(() => {});
        throw abortError("WebLLM model loading was cancelled.");
      }
      this.engine = engine;
      this.loadedModelId = modelId;
      this.setStatus({ phase: "ready", modelId, backend: "webgpu" });
    } catch (error) {
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      this.engine = null;
      this.loadedModelId = null;
      if (signal?.aborted || isAbortError(error)) {
        this.setStatus({ phase: "idle" });
        throw abortError("WebLLM model loading was cancelled.");
      }
      this.setStatus({
        phase: "error",
        modelId,
        backend: "webgpu",
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
