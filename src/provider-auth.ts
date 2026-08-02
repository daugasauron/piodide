import type { ProviderDef } from "./providers.ts";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ApiKeyVerification = "verified" | "quota-exhausted" | "not-supported";

const GLM_GENERAL_PROVIDERS = new Set(["zhipu"]);
const GLM_CODING_PROVIDERS = new Set(["zhipu-coding", "zhipu-coding-cn"]);
const WRAPPING_PAIRS = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"],
] as const;

function unwrapApiKey(value: string): string {
  let unwrapped = value;
  for (let pass = 0; pass < 3 && unwrapped.length >= 2; pass++) {
    const pair = WRAPPING_PAIRS.find(
      ([start, end]) => unwrapped.startsWith(start) && unwrapped.endsWith(end),
    );
    if (!pair) break;
    unwrapped = unwrapped.slice(pair[0].length, -pair[1].length).trim();
  }
  return unwrapped;
}

export function normalizeApiKey(value: string): string {
  // NFKC repairs full-width ASCII copied from styled mobile text. Unicode Cf
  // covers every invisible formatting/bidi mark, not only the common zero-width
  // characters. Neither transformation changes an ordinary ASCII API key.
  let normalized = value.normalize("NFKC").replace(/\p{Cf}+/gu, "").trim();
  normalized = unwrapApiKey(normalized);
  normalized = normalized.replace(/^Bearer\s+/i, "").trim();
  normalized = unwrapApiKey(normalized);
  return normalized.replace(/[\s\p{Cf}]+/gu, "");
}

export function apiKeyHint(value: string): string {
  const visible = value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
  return `${visible} · ${value.length} chars`;
}

function validateGlmApiKey(provider: Pick<ProviderDef, "label">, apiKey: string): void {
  // Z.AI accepts the raw id.secret form or a three-segment JWT. Both are
  // base64url-compatible ASCII and must retain their literal period separators.
  if (/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}$/.test(apiKey)) return;
  throw new Error(
    `${provider.label} API key has an invalid format after paste cleanup; ` +
      "expected ASCII id.secret (or a three-part JWT)",
  );
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

function responseCode(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      code?: unknown;
      error?: { code?: unknown };
    };
    const code = parsed.error?.code ?? parsed.code;
    return code === undefined || code === null ? "" : String(code);
  } catch {
    return "";
  }
}

export async function verifyApiKey(
  provider: Pick<ProviderDef, "name" | "label" | "baseUrl"> &
    Partial<Pick<ProviderDef, "defaultModel">>,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<ApiKeyVerification> {
  const general = GLM_GENERAL_PROVIDERS.has(provider.name);
  const coding = GLM_CODING_PROVIDERS.has(provider.name);
  if (!general && !coding) return "not-supported";
  validateGlmApiKey(provider, apiKey);

  let response: Response;
  try {
    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    response = coding
      ? await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: provider.defaultModel ?? "glm-5.2",
            messages: [{ role: "user", content: "Reply OK." }],
            max_tokens: 1,
            stream: false,
          }),
        })
      : await fetchImpl(`${baseUrl}/models`, {
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

  const text = await response.text().catch(() => "");
  if (coding && response.status === 429 && responseCode(text) === "1310") {
    return "quota-exhausted";
  }
  const detail = responseMessage(text);
  const suffix = detail ? `: ${detail}` : "";
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${provider.label} rejected this API key${suffix}`);
  }
  throw new Error(
    `${provider.label} key check returned HTTP ${response.status}${suffix}`,
  );
}
