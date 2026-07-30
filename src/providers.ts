/**
 * Built-in provider catalogue. Each entry maps a `/provider <name>` choice to a
 * baseUrl + wire format + a sane default model. Adding a provider here is
 * enough to make `/provider <name>` work.
 */
import type { Model } from "@earendil-works/pi-ai";

export type ApiKind =
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages";

export interface ProviderDef {
  name: string;
  label: string;
  api: ApiKind;
  /** Base URL. OpenAI-style URLs include `/v1`; Anthropic's does not. */
  baseUrl: string;
  defaultModel: string;
  /** Searchable choices shown by `/model`; arbitrary IDs remain accepted. */
  loadModels: () => Promise<readonly string[]>;
  /** Shown in `/provider` listing. */
  note?: string;
  /** Extra fields merged into the chat-completions request body. */
  extraBody?: Record<string, unknown>;
  /** TEMPORARY: authenticates through the opt-in loopback Codex proxy. */
  temporaryLocalCodexProxy?: boolean;
}

export const PROVIDERS: Record<string, ProviderDef> = {
  anthropic: {
    name: "anthropic",
    label: "Anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-4-5",
    loadModels: modelCatalogue("anthropic", "claude-sonnet-4-5", () =>
      import("@earendil-works/pi-ai/providers/anthropic.models").then(
        (module) => module.ANTHROPIC_MODELS,
      ),
    ),
    note: "native Messages API",
  },
  openai: {
    name: "openai",
    label: "OpenAI",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    loadModels: modelCatalogue("openai", "gpt-4.1-mini", () =>
      import("@earendil-works/pi-ai/providers/openai.models").then((module) => module.OPENAI_MODELS),
    ),
  },
  openrouter: {
    name: "openrouter",
    label: "OpenRouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-sonnet-4.5",
    loadModels: modelCatalogue("openrouter", "anthropic/claude-sonnet-4.5", () =>
      import("@earendil-works/pi-ai/providers/openrouter.models").then(
        (module) => module.OPENROUTER_MODELS,
      ),
    ),
    note: "any model via OpenAI-compatible API",
  },
  groq: {
    name: "groq",
    label: "Groq",
    api: "openai-completions",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    loadModels: modelCatalogue("groq", "llama-3.3-70b-versatile", () =>
      import("@earendil-works/pi-ai/providers/groq.models").then((module) => module.GROQ_MODELS),
    ),
  },
  together: {
    name: "together",
    label: "Together",
    api: "openai-completions",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    loadModels: modelCatalogue("together", "meta-llama/Llama-3.3-70B-Instruct-Turbo", () =>
      import("@earendil-works/pi-ai/providers/together.models").then(
        (module) => module.TOGETHER_MODELS,
      ),
    ),
  },
  deepseek: {
    name: "deepseek",
    label: "DeepSeek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    loadModels: modelCatalogue("deepseek", "deepseek-chat", () =>
      import("@earendil-works/pi-ai/providers/deepseek.models").then(
        (module) => module.DEEPSEEK_MODELS,
      ),
    ),
  },
  mistral: {
    name: "mistral",
    label: "Mistral",
    api: "openai-completions",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
    loadModels: modelCatalogue("mistral", "mistral-small-latest", () =>
      import("@earendil-works/pi-ai/providers/mistral.models").then(
        (module) => module.MISTRAL_MODELS,
      ),
    ),
  },
  moonshot: {
    name: "moonshot",
    label: "Moonshot (Kimi)",
    api: "openai-completions",
    // International endpoint. A key created on platform.moonshot.ai is
    // rejected with HTTP 401 by the China endpoint (api.moonshot.cn), and the
    // .cn model IDs (e.g. kimi-k2-0905-preview) are not permissioned on .ai.
    baseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k3",
    loadModels: modelCatalogue("moonshot", "kimi-k3", () =>
      import("@earendil-works/pi-ai/providers/moonshotai.models").then(
        (module) => module.MOONSHOTAI_MODELS,
      ),
    ),
    note: "api.moonshot.ai (intl); /model kimi-k3, kimi-k2.6, kimi-k2.7-code",
  },
  zhipu: {
    name: "zhipu",
    label: "智谱 GLM (通用)",
    api: "openai-completions",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-5.2",
    loadModels: modelCatalogue("zhipu", "glm-5.2", () =>
      import("@earendil-works/pi-ai/providers/zai.models").then((module) => module.ZAI_MODELS),
    ),
    note: "bigmodel.cn 通用端点（按量付费，需余额）",
  },
  "zhipu-coding": {
    name: "zhipu-coding",
    label: "智谱 GLM (Coding 套餐)",
    api: "openai-completions",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    defaultModel: "glm-5.2",
    loadModels: modelCatalogue("zhipu-coding", "glm-5.2", () =>
      import("@earendil-works/pi-ai/providers/zai.models").then((module) => module.ZAI_MODELS),
    ),
    note: "GLM Coding Plan 订阅专用端点",
  },
  // TEMPORARY: delete this entry with scripts/local-codex-proxy.mjs when the
  // browser can use subscription auth through a supported mechanism.
  "codex-local": {
    name: "codex-local",
    label: "OpenAI Codex subscription (temporary local proxy)",
    api: "openai-codex-responses",
    baseUrl: "http://127.0.0.1:1456",
    defaultModel: "gpt-5.6-sol",
    loadModels: modelCatalogue("codex-local", "gpt-5.6-sol", () =>
      import("@earendil-works/pi-ai/providers/openai-codex.models").then(
        (module) => module.OPENAI_CODEX_MODELS,
      ),
    ),
    note: "temporary loopback proxy; start it with npm run codex-proxy",
    temporaryLocalCodexProxy: true,
  },
  local: {
    name: "local",
    label: "Local",
    api: "openai-completions",
    baseUrl: "http://localhost:8080/v1",
    defaultModel: "local-model",
    loadModels: async () => ["local-model"],
    note: "llama.cpp / Ollama (OpenAI-compatible)",
  },
};

export function getProvider(name: string): ProviderDef | undefined {
  const key = name.toLowerCase();
  return PROVIDERS[key] ?? ALIASES[key];
}

// Friendly alternates so `/provider kimi` and `/provider glm` also work.
const ALIASES: Record<string, ProviderDef> = {
  kimi: PROVIDERS.moonshot,
  glm: PROVIDERS.zhipu,
  "glm-coding": PROVIDERS["zhipu-coding"],
  zhipuai: PROVIDERS.zhipu,
  bigmodel: PROVIDERS.zhipu,
  moonshotai: PROVIDERS.moonshot,
};

export interface ProviderModelInfo {
  api?: ApiKind;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevelMap?: Model<ApiKind>["thinkingLevelMap"];
  compat?: Model<ApiKind>["compat"];
}

const MODEL_INFO = new Map<string, ProviderModelInfo>();

export function getLoadedModelInfo(
  providerName: string,
  modelId: string,
): ProviderModelInfo | undefined {
  return MODEL_INFO.get(`${providerName}\0${modelId}`);
}

function modelIds(providerName: string, defaultModel: string, catalogue: object): string[] {
  for (const [id, value] of Object.entries(catalogue)) {
    const model = value as Partial<ProviderModelInfo>;
    if (
      typeof model.contextWindow === "number" &&
      typeof model.maxTokens === "number"
    ) {
      MODEL_INFO.set(`${providerName}\0${id}`, {
        api: (model as Partial<Model<ApiKind>>).api,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning === true,
        thinkingLevelMap: (model as Partial<Model<ApiKind>>).thinkingLevelMap,
        compat: (model as Partial<Model<ApiKind>>).compat,
      });
    }
  }
  return [defaultModel, ...Object.keys(catalogue).filter((id) => id !== defaultModel)];
}

function modelCatalogue(
  providerName: string,
  defaultModel: string,
  load: () => Promise<object>,
): () => Promise<readonly string[]> {
  let cached: readonly string[] | null = null;
  return async () => {
    cached ??= modelIds(providerName, defaultModel, await load());
    return cached;
  };
}
