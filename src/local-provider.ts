import { browserModelRuntime } from "./browser-model-runtime.ts";
import {
  BROWSER_MODELS,
  describeBrowserModel,
  getBrowserModel,
} from "./browser-models.ts";
import type { LocalModelDef, LocalModelRuntime } from "./local-model.ts";
import type { ProviderDef } from "./providers.ts";
import { webLLMRuntime } from "./webllm-runtime.ts";
import {
  WEBLLM_MODELS,
  describeWebLLMModel,
  getWebLLMModel,
} from "./webllm-models.ts";

export interface LocalProviderBinding {
  models: readonly LocalModelDef[];
  runtime: LocalModelRuntime;
  getModel(id: string): LocalModelDef | undefined;
  describeModel(model: LocalModelDef, cached?: boolean): string;
}

const WEBLLM: LocalProviderBinding = {
  models: WEBLLM_MODELS,
  runtime: webLLMRuntime,
  getModel: getWebLLMModel,
  describeModel: (model, cached) =>
    describeWebLLMModel(
      getWebLLMModel(model.id)!,
      cached,
    ),
};

const WLLAMA: LocalProviderBinding = {
  models: BROWSER_MODELS,
  runtime: browserModelRuntime,
  getModel: getBrowserModel,
  describeModel: (model, cached) =>
    describeBrowserModel(
      getBrowserModel(model.id)!,
      cached,
    ),
};

export function getLocalProviderBinding(
  provider: Pick<ProviderDef, "api" | "transport"> | null | undefined,
): LocalProviderBinding | undefined {
  if (provider?.transport !== "browser") return undefined;
  if (provider.api === "browser-webllm") return WEBLLM;
  if (provider.api === "browser-wllama") return WLLAMA;
  return undefined;
}
