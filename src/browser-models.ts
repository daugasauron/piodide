import type { LocalModelDef } from "./local-model.ts";

export interface BrowserGenerationSettings {
  temperature: number;
  topP: number;
  topK: number;
}

export interface BrowserModelDef extends LocalModelDef {
  sourceUrl: string;
  contextOptions: readonly number[];
  webGpuKvBytesPerToken?: number;
  load: {
    contextSize: number;
    batchSize: number;
    cacheTypeK: "f16" | "q8_0" | "q4_0";
    cacheTypeV: "f16" | "q8_0" | "q4_0";
  };
  generation: BrowserGenerationSettings;
  thinkingGeneration?: BrowserGenerationSettings;
}

export const BROWSER_MODELS: readonly BrowserModelDef[] = [
  {
    id: "qwen3-8b-q4km",
    label: "Qwen3 8B",
    sourceUrl:
      "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/7c41481f57cb95916b40956ab2f0b139b296d974/Qwen3-8B-Q4_K_M.gguf",
    bytes: 5_027_783_488,
    quantization: "Q4_K_M",
    contextWindow: 16_384,
    maxTokens: 2_048,
    tools: true,
    thinking: true,
    license: "Apache-2.0",
    contextOptions: [4_096, 8_192, 16_384, 32_768],
    // 36 layers × 8 KV heads × 128 head size × q8_0 K and V.
    // q8_0 stores 34 bytes per 32 values: 78,336 bytes/token total.
    webGpuKvBytesPerToken: 78_336,
    load: {
      contextSize: 16_384,
      batchSize: 512,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
    },
    generation: {
      temperature: 0.2,
      topP: 0.8,
      topK: 20,
    },
    thinkingGeneration: {
      temperature: 0.6,
      topP: 0.95,
      topK: 20,
    },
  },
  {
    id: "qwen3.5-0.8b-q4km",
    label: "Qwen3.5 0.8B",
    sourceUrl:
      "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/Qwen3.5-0.8B-Q4_K_M.gguf",
    bytes: 532_517_120,
    quantization: "Q4_K_M",
    contextWindow: 8_192,
    maxTokens: 2_048,
    tools: true,
    license: "Apache-2.0",
    contextOptions: [4_096, 8_192, 16_384, 32_768],
    load: {
      contextSize: 8_192,
      batchSize: 512,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
    },
    generation: {
      temperature: 0.1,
      topP: 0.9,
      topK: 40,
    },
  },
  {
    id: "qwen3.5-2b-q4km",
    label: "Qwen3.5 2B",
    sourceUrl:
      "https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/f6d5376be1edb4d416d56da11e5397a961aca8ae/Qwen3.5-2B-Q4_K_M.gguf",
    bytes: 1_280_835_840,
    quantization: "Q4_K_M",
    contextWindow: 8_192,
    maxTokens: 2_048,
    tools: true,
    license: "Apache-2.0",
    contextOptions: [4_096, 8_192, 16_384, 32_768],
    load: {
      contextSize: 8_192,
      batchSize: 512,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
    },
    generation: {
      temperature: 0.1,
      topP: 0.9,
      topK: 40,
    },
  },
];

const BY_ID = new Map(BROWSER_MODELS.map((model) => [model.id, model]));

export function getBrowserModel(id: string): BrowserModelDef | undefined {
  return BY_ID.get(id);
}

export function formatModelBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

export function formatContextSize(tokens: number): string {
  if (tokens >= 1024 && tokens % 1024 === 0) return `${tokens / 1024}K`;
  return tokens.toLocaleString("en-US");
}

export function estimateWebGpuKvCacheBytes(
  model: BrowserModelDef,
  contextSize: number,
): number | undefined {
  if (model.webGpuKvBytesPerToken === undefined) return undefined;
  return model.webGpuKvBytesPerToken * contextSize;
}

export function describeBrowserModel(model: BrowserModelDef, cached = false): string {
  return [
    model.quantization,
    formatModelBytes(model.bytes),
    `${formatContextSize(model.load.contextSize)} default context`,
    model.tools ? "tools" : "text only",
    model.thinking ? "thinking toggle" : "",
    cached ? "cached" : "download required",
  ]
    .filter(Boolean)
    .join(" · ");
}
