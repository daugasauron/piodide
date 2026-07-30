import type { ProviderDef } from "./providers.ts";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ApiKeyVerification = "verified" | "not-supported";

const GLM_PROVIDERS = new Set([
  "zhipu",
  "zhipu-coding",
  "zhipu-coding-cn",
]);

export function normalizeApiKey(value: string): string {
  let normalized = value.trim().replace(/^Bearer\s+/i, "").trim();
  if (
    normalized.length >= 2 &&
    ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    normalized = normalized.slice(1, -1);
  }
  return normalized.replace(/[\s\u200B-\u200D\u2060\uFEFF]+/gu, "");
}

function responseMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const message = parsed.error?.message ?? parsed.message;
    return typeof message === "string" ? message.trim().slice(0, 240) : "";
  } catch {
    return text.trim().slice(0, 240);
  }
}

export async function verifyApiKey(
  provider: Pick<ProviderDef, "name" | "label" | "baseUrl">,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<ApiKeyVerification> {
  if (!GLM_PROVIDERS.has(provider.name)) return "not-supported";

  let response: Response;
  try {
    response = await fetchImpl(`${provider.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    throw new Error(
      `could not verify ${provider.label}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (response.ok) return "verified";

  const detail = responseMessage(await response.text().catch(() => ""));
  const suffix = detail ? `: ${detail}` : "";
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${provider.label} rejected this API key${suffix}`);
  }
  throw new Error(
    `${provider.label} key check returned HTTP ${response.status}${suffix}`,
  );
}
