/**
 * Builds a minimal, valid `Model` descriptor from the active provider + model.
 * The streamFns only read id/baseUrl/provider/api, so the rest are harmless
 * placeholders required by the type.
 */
import type { Model } from "@earendil-works/pi-ai";
import type { ApiKind, ProviderModelInfo } from "./providers.ts";

export interface ModelConfig {
  baseUrl: string;
  modelId: string;
  api: ApiKind;
  provider: string;
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  info?: ProviderModelInfo;
}

export function makeModel(cfg: ModelConfig): Model<ApiKind> {
  const model: Model<ApiKind> = {
    id: cfg.modelId,
    name: cfg.modelId,
    api: cfg.info?.api ?? cfg.api,
    provider: cfg.provider,
    baseUrl: cfg.baseUrl.replace(/\/+$/, ""),
    reasoning: cfg.info?.reasoning ?? false,
    thinkingLevelMap: cfg.info?.thinkingLevelMap,
    input: cfg.info?.input ?? ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: cfg.info?.contextWindow ?? 200_000,
    maxTokens: cfg.info?.maxTokens ?? 16_384,
    compat: cfg.info?.compat,
  };
  // Stash provider-specific request extras for
  // the streamFn to merge into the body. Model's type doesn't carry it, so we
  // attach it as a runtime property.
  if (cfg.extraBody) (model as unknown as { extraBody: Record<string, unknown> }).extraBody = cfg.extraBody;
  if (cfg.headers) (model as unknown as { headers: Record<string, string> }).headers = cfg.headers;
  return model;
}
