import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

import type { ApiKind, ProviderModelInfo } from "./providers.ts";

interface OpenRouterApiModel {
  id?: unknown;
  context_length?: unknown;
  architecture?: { input_modalities?: unknown };
  top_provider?: { max_completion_tokens?: unknown };
  supported_parameters?: unknown;
  reasoning?: {
    mandatory?: unknown;
    supported_efforts?: unknown;
  } | null;
}

export interface OpenRouterLiveModel {
  id: string;
  info: ProviderModelInfo;
}

const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function thinkingLevelMap(
  reasoning: OpenRouterApiModel["reasoning"],
): ProviderModelInfo["thinkingLevelMap"] {
  if (!reasoning) return undefined;
  const supported = Array.isArray(reasoning.supported_efforts)
    ? new Set(
        reasoning.supported_efforts.filter(
          (value): value is ModelThinkingLevel =>
            typeof value === "string" &&
            THINKING_LEVELS.includes(value as ModelThinkingLevel),
        ),
      )
    : null;
  if (!supported && reasoning.mandatory !== true) return undefined;

  const result: NonNullable<ProviderModelInfo["thinkingLevelMap"]> = {};
  for (const level of THINKING_LEVELS) {
    if (level === "off") {
      result.off = reasoning.mandatory === true ? null : "none";
    } else if (supported) {
      result[level] = supported.has(level) ? level : null;
    }
  }
  return result;
}

/** Parse OpenRouter's public model response into agent-compatible metadata. */
export function parseOpenRouterModels(payload: unknown): OpenRouterLiveModel[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("OpenRouter returned an invalid model catalogue");

  const models: OpenRouterLiveModel[] = [];
  const seen = new Set<string>();
  for (const raw of data as OpenRouterApiModel[]) {
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    const contextWindow = positiveInteger(raw?.context_length);
    const maxTokens = positiveInteger(raw?.top_provider?.max_completion_tokens);
    const parameters = Array.isArray(raw?.supported_parameters)
      ? raw.supported_parameters.filter((value): value is string => typeof value === "string")
      : [];
    // Piodide is an agent, so listing completion models that reject its tool
    // schemas only leads users into avoidable request errors.
    if (!id || seen.has(id) || !contextWindow || !parameters.includes("tools")) continue;

    const modalities = Array.isArray(raw?.architecture?.input_modalities)
      ? raw.architecture.input_modalities
      : [];
    const input: Model<ApiKind>["input"] = [
      "text",
      ...(modalities.includes("image") ? (["image"] as const) : []),
    ];
    const reasoning =
      (raw.reasoning !== null && typeof raw.reasoning === "object") ||
      parameters.includes("reasoning");

    seen.add(id);
    models.push({
      id,
      info: {
        api: "openai-completions",
        contextWindow,
        maxTokens: maxTokens ?? Math.min(16_384, contextWindow),
        reasoning,
        input,
        thinkingLevelMap: reasoning ? thinkingLevelMap(raw.reasoning) : undefined,
        compat: { thinkingFormat: "openrouter" },
      },
    });
  }
  return models;
}

export async function fetchOpenRouterModels(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpenRouterLiveModel[]> {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`OpenRouter model catalogue returned HTTP ${response.status}`);
  }
  return parseOpenRouterModels(await response.json());
}
