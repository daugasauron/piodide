import type { LocalModelDef } from "./local-model.ts";
import { formatModelBytes } from "./browser-models.ts";

export interface WebLLMModelDef extends LocalModelDef {
  vramRequiredBytes: number;
  localFiles: {
    modelType: string;
    hiddenSize: number;
    layers: number;
    vocabSize: number;
    parameterBytes: number;
    shardCount: number;
    wasmBytes: number;
  };
  generation: {
    temperature: number;
    topP: number;
  };
}

export const REPLACED_WEBLLM_MODEL_IDS: Readonly<Record<string, string>> = {
  "Qwen3.5-4B-q4f16_1-MLC": "Qwen3.5-4B-q4f32_1-MLC",
  "Qwen3.5-9B-q4f16_1-MLC": "Qwen3.5-9B-q4f32_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f16_1-MLC":
    "Hermes-3-Llama-3.1-8B-q4f32_1-MLC",
  "Hermes-3-Llama-3.2-3B-q4f16_1-MLC":
    "Hermes-3-Llama-3.2-3B-q4f32_1-MLC",
};

export const WEBLLM_MODELS: readonly WebLLMModelDef[] = [
  {
    id: "Qwen3.5-4B-q4f16_1-MLC",
    label: "Qwen3.5 4B",
    bytes: 2_390_497_405,
    vramRequiredBytes: 3_867_820_000,
    quantization: "q4f16",
    contextWindow: 4_096,
    maxTokens: 1_024,
    tools: true,
    license: "Apache-2.0",
    localFiles: {
      modelType: "qwen3_5",
      hiddenSize: 2_560,
      layers: 32,
      vocabSize: 248_320,
      parameterBytes: 2_367_120_384,
      shardCount: 78,
      wasmBytes: 6_502_002,
    },
    generation: {
      temperature: 0.2,
      topP: 0.9,
    },
  },
  {
    id: "Qwen3.5-9B-q4f16_1-MLC",
    label: "Qwen3.5 9B",
    bytes: 5_061_443_935,
    vramRequiredBytes: 6_433_010_000,
    quantization: "q4f16",
    contextWindow: 4_096,
    maxTokens: 1_024,
    tools: true,
    license: "Apache-2.0",
    localFiles: {
      modelType: "qwen3_5",
      hiddenSize: 4_096,
      layers: 32,
      vocabSize: 248_320,
      parameterBytes: 5_038_043_136,
      shardCount: 127,
      wasmBytes: 6_528_086,
    },
    generation: {
      temperature: 0.2,
      topP: 0.9,
    },
  },
  {
    id: "Qwen3.5-2B-q4f16_1-MLC",
    label: "Qwen3.5 2B",
    bytes: 1_082_564_401,
    vramRequiredBytes: 2_245_440_000,
    quantization: "q4f16",
    contextWindow: 4_096,
    maxTokens: 1_024,
    tools: true,
    license: "Apache-2.0",
    localFiles: {
      modelType: "qwen3_5",
      hiddenSize: 2_048,
      layers: 24,
      vocabSize: 248_320,
      parameterBytes: 1_059_316_480,
      shardCount: 31,
      wasmBytes: 6_217_509,
    },
    generation: {
      temperature: 0.2,
      topP: 0.9,
    },
  },
  {
    id: "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
    label: "Hermes 3 Llama 3.1 8B",
    bytes: 4_526_847_881,
    vramRequiredBytes: 5_413_000_000,
    quantization: "q4f16",
    contextWindow: 8_192,
    maxTokens: 1_024,
    tools: true,
    license: "Llama 3.1",
    localFiles: {
      modelType: "llama",
      hiddenSize: 4_096,
      layers: 32,
      vocabSize: 128_256,
      parameterBytes: 4_517_404_672,
      shardCount: 108,
      wasmBytes: 6_119_548,
    },
    generation: {
      temperature: 0.2,
      topP: 0.9,
    },
  },
  {
    id: "Hermes-3-Llama-3.2-3B-q4f16_1-MLC",
    label: "Hermes 3 Llama 3.2 3B",
    bytes: 1_816_806_576,
    vramRequiredBytes: 2_263_690_000,
    quantization: "q4f16",
    contextWindow: 4_096,
    maxTokens: 1_024,
    tools: false,
    license: "Llama 3.2",
    localFiles: {
      modelType: "llama",
      hiddenSize: 3_072,
      layers: 28,
      vocabSize: 128_256,
      parameterBytes: 1_807_423_488,
      shardCount: 58,
      wasmBytes: 5_957_281,
    },
    generation: {
      temperature: 0.2,
      topP: 0.9,
    },
  },
];

const BY_ID = new Map(WEBLLM_MODELS.map((model) => [model.id, model]));

export function getWebLLMModel(id: string): WebLLMModelDef | undefined {
  return BY_ID.get(id);
}

export function describeWebLLMModel(model: WebLLMModelDef, cached = false): string {
  return [
    model.quantization,
    formatModelBytes(model.bytes),
    `${formatModelBytes(model.vramRequiredBytes)} VRAM`,
    model.tools ? "tools" : "text only",
    cached ? "cached" : "download required",
  ].join(" · ");
}
