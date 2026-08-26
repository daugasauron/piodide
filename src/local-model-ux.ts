import type {
  LocalModelCapabilities,
  LocalModelStatus,
} from "./local-model.ts";
import { formatContextSize, formatModelBytes } from "./browser-models.ts";

const WASM32_MODEL_LIMIT = 4 * 1024 ** 3;

export function formatLocalModelStatus(
  status: LocalModelStatus,
  modelLabel?: string,
  detail: "short" | "long" = "short",
): string {
  const label = modelLabel || status.modelId || "local model";
  const backend = status.backend ? status.backend.toUpperCase() : "";
  const context = status.contextSize
    ? `${formatContextSize(status.contextSize)} context`
    : "";
  const percent = localModelPercent(status);
  const bytes = localModelByteProgress(status);
  const message = conciseRuntimeMessage(status.message);

  switch (status.phase) {
    case "idle":
      return "idle";
    case "preparing":
      return detail === "long" ? `checking hardware and cache · ${label}` : "preparing";
    case "downloading":
      return [
        detail === "long" ? `downloading ${label}` : "downloading",
        percent,
        detail === "long" ? message || bytes : "",
      ].filter(Boolean).join(" · ");
    case "importing":
      return [
        detail === "long" ? `importing ${label}` : "importing",
        percent,
        detail === "long" ? bytes : "",
      ].filter(Boolean).join(" · ");
    case "loading":
      return [
        message || (detail === "long" ? `loading ${label}` : "loading"),
        detail === "long" ? [backend, context].filter(Boolean).join(" · ") : "",
      ].filter(Boolean).join(" · ");
    case "ready":
      return ["ready", backend, context].filter(Boolean).join(" · ");
    case "generating":
      return [
        detail === "long" ? `generating locally · ${label}` : "generating",
        backend,
        context,
      ].filter(Boolean).join(" · ");
    case "unloading":
      return detail === "long" ? `releasing ${label}` : "unloading";
    case "error":
      return detail === "long" && status.message
        ? `error · ${singleLine(status.message)}`
        : "error";
  }
}

export interface LocalModelReadiness {
  ready: boolean;
  summary: string;
  requirements: string;
}

export interface LocalModelChoice {
  id: string;
  source: "remembered" | "cached" | "default";
}

/**
 * Pick a local model without surprising the user with a download. An explicit
 * choice made earlier in this session wins; otherwise prefer the provider
 * default when it is already cached, followed by the first cached model in the
 * provider's quality order.
 */
export function chooseLocalModel(
  defaultId: string,
  modelIds: readonly string[],
  cachedIds: ReadonlySet<string>,
  rememberedId?: string,
): LocalModelChoice {
  if (rememberedId && modelIds.includes(rememberedId)) {
    return { id: rememberedId, source: "remembered" };
  }
  if (cachedIds.has(defaultId)) return { id: defaultId, source: "cached" };
  const cached = modelIds.find((id) => cachedIds.has(id));
  return cached
    ? { id: cached, source: "cached" }
    : { id: defaultId, source: "default" };
}

/** Keep the active model visible first, then cached choices, without changing
 * the provider's relative quality order inside either group. */
export function orderLocalModels(
  modelIds: readonly string[],
  activeId: string,
  cachedIds: ReadonlySet<string>,
): string[] {
  return [...modelIds]
    .map((id, index) => ({
      id,
      index,
      rank: id === activeId ? 0 : cachedIds.has(id) ? 1 : 2,
    }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ id }) => id);
}

export function localModelReadiness(
  runtime: "wllama" | "webllm",
  capabilities: LocalModelCapabilities,
  modelBytes?: number,
): LocalModelReadiness {
  const adapter = capabilities.adapter || "WebGPU adapter";
  if (runtime === "webllm") {
    if (!capabilities.webGpu) {
      return {
        ready: false,
        summary: "WebGPU unavailable",
        requirements: "WebLLM requires WebGPU and shader-f16; try current Chrome with GPU acceleration enabled.",
      };
    }
    if (!capabilities.shaderF16) {
      return {
        ready: false,
        summary: `${adapter} lacks shader-f16`,
        requirements: "The q4f16 WebLLM catalogue requires shader-f16; relaunch Chrome with the documented WebGPU flags.",
      };
    }
    return {
      ready: true,
      summary: `${adapter} · WebGPU + shader-f16 ready`,
      requirements: "GPU-only; choose a model whose estimated VRAM fits this adapter.",
    };
  }

  if (capabilities.webGpu && capabilities.shaderF16) {
    return {
      ready: true,
      summary: `${adapter} · WebGPU + shader-f16 ready`,
      requirements: "WebGPU preferred; multithreaded WebAssembly remains available for smaller GGUF models.",
    };
  }
  if (modelBytes !== undefined && modelBytes >= WASM32_MODEL_LIMIT) {
    return {
      ready: false,
      summary: "WebGPU shader-f16 unavailable",
      requirements: "This GGUF is at least 4 GiB and cannot fit Wllama's wasm32 fallback; enable WebGPU shader-f16 or choose a smaller model.",
    };
  }
  return {
    ready: true,
    summary: `WebAssembly fallback · ${capabilities.threads ?? 1} logical threads`,
    requirements: "WebGPU shader-f16 is unavailable; smaller GGUF models run on WebAssembly and will be slower.",
  };
}

function localModelPercent(status: LocalModelStatus): string {
  if (status.loadedBytes === undefined || !status.totalBytes) return "";
  return `${Math.min(100, Math.round((status.loadedBytes / status.totalBytes) * 100))}%`;
}

function localModelByteProgress(status: LocalModelStatus): string {
  if (status.loadedBytes === undefined || !status.totalBytes) return "";
  return `${formatModelBytes(status.loadedBytes)} / ${formatModelBytes(status.totalBytes)}`;
}

function conciseRuntimeMessage(message: string | undefined): string {
  if (!message) return "";
  const value = singleLine(message);
  const shader = value.match(/Loading GPU shader modules\[(\d+)\/(\d+)\]/i);
  if (shader) return `compiling GPU shaders ${shader[1]}/${shader[2]}`;
  if (/Finish loading on WebGPU/i.test(value)) return "finishing WebGPU setup";
  if (/Start to fetch params/i.test(value)) return "starting model download";
  const shards = value.match(/\[(\d+)\/(\d+)\]/);
  const loaded = value.match(/:\s*([^:]+? loaded)\./i);
  if (shards) {
    return [
      `model shard ${shards[1]}/${shards[2]}`,
      loaded?.[1],
    ].filter(Boolean).join(" · ");
  }
  return value.length <= 100 ? value : `${value.slice(0, 99)}…`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
