import type { LocalModelDef } from "./local-model.ts";
import { formatModelBytes } from "./browser-models.ts";

export interface WebLLMModelDef extends LocalModelDef {
  vramRequiredBytes: number;
  generation: {
    temperature: number;
    topP: number;
  };
}

export const WEBLLM_MODELS: readonly WebLLMModelDef[] = [
  {
    id: "Hermes-3-Llama-3.1-8B-q4f32_1-MLC",
    label: "Hermes 3 Llama 3.1 8B",
    bytes: 4_526_994_912,
    vramRequiredBytes: 6_316_000_000,
    quantization: "q4f32",
    contextWindow: 8_192,
    maxTokens: 1_024,
    tools: true,
    license: "Llama 3.1",
    generation: {
      temperature: 0.2,
      topP: 0.9,
    },
  },
  {
    id: "Hermes-3-Llama-3.2-3B-q4f32_1-MLC",
    label: "Hermes 3 Llama 3.2 3B",
    bytes: 1_816_926_427,
    vramRequiredBytes: 2_951_510_000,
    quantization: "q4f32",
    contextWindow: 4_096,
    maxTokens: 1_024,
    tools: false,
    license: "Llama 3.2",
    generation: {
      temperature: 0.2,
      topP: 0.9,
    },
  },
  {
    id: "Qwen3.5-4B-q4f32_1-MLC",
    label: "Qwen3.5 4B",
    bytes: 2_390_495_095,
    vramRequiredBytes: 4_680_360_000,
    quantization: "q4f32",
    contextWindow: 4_096,
    maxTokens: 1_024,
    tools: false,
    license: "Apache-2.0",
    generation: {
      temperature: 0.2,
      topP: 0.9,
    },
  },
  {
    id: "Qwen3.5-9B-q4f32_1-MLC",
    label: "Qwen3.5 9B",
    bytes: 5_061_441_618,
    vramRequiredBytes: 7_544_740_000,
    quantization: "q4f32",
    contextWindow: 4_096,
    maxTokens: 1_024,
    tools: false,
    license: "Apache-2.0",
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
