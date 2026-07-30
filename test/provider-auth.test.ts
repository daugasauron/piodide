import assert from "node:assert/strict";
import test from "node:test";
import { normalizeApiKey, verifyApiKey } from "../src/provider-auth.ts";

const glmCoding = {
  name: "zhipu-coding",
  label: "GLM Coding",
  baseUrl: "https://api.z.ai/api/coding/paas/v4/",
};

test("API key normalization removes common copy/paste artifacts", () => {
  assert.equal(normalizeApiKey("  Bearer abc.def  \n"), "abc.def");
  assert.equal(normalizeApiKey('"abc.def"'), "abc.def");
  assert.equal(normalizeApiKey("abc\u200B.def"), "abc.def");
});

test("GLM API keys are verified without making a completion request", async () => {
  let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
  const result = await verifyApiKey(glmCoding, "test-key", async (input, init) => {
    request = { input, init };
    return new Response('{"object":"list","data":[]}', { status: 200 });
  });

  assert.equal(result, "verified");
  assert.equal(
    String(request?.input),
    "https://api.z.ai/api/coding/paas/v4/models",
  );
  assert.equal(
    new Headers(request?.init?.headers).get("Authorization"),
    "Bearer test-key",
  );
});

test("GLM rejects invalid keys during login", async () => {
  await assert.rejects(
    verifyApiKey(glmCoding, "invalid", async () =>
      new Response(
        '{"error":{"code":"401","message":"token expired or incorrect"}}',
        { status: 401 },
      ),
    ),
    /GLM Coding rejected this API key: token expired or incorrect/,
  );
});

test("providers without a safe key-check endpoint remain unchanged", async () => {
  const result = await verifyApiKey(
    {
      name: "openai",
      label: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
    },
    "test-key",
    async () => {
      throw new Error("fetch should not run");
    },
  );
  assert.equal(result, "not-supported");
});
