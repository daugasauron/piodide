import assert from "node:assert/strict";
import test from "node:test";
import { normalizeApiKey, verifyApiKey } from "../src/provider-auth.ts";

const glmGeneral = {
  name: "zhipu",
  label: "智谱 GLM (通用)",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
};

const openRouter = {
  name: "openrouter",
  label: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1/",
};

test("API key normalization removes common copy/paste artifacts", () => {
  assert.equal(normalizeApiKey("  Bearer abc.def  \n"), "abc.def");
  assert.equal(normalizeApiKey('"abc.def"'), "abc.def");
  assert.equal(normalizeApiKey("abc\u200B.def"), "abc.def");
});

test("general GLM API keys are verified without making a completion request", async () => {
  let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
  const result = await verifyApiKey(glmGeneral, "test.key", async (input, init) => {
    request = { input, init };
    return new Response('{"object":"list","data":[]}', { status: 200 });
  });

  assert.equal(result, "verified");
  assert.equal(
    String(request?.input),
    "https://open.bigmodel.cn/api/paas/v4/models",
  );
  assert.equal(
    new Headers(request?.init?.headers).get("Authorization"),
    "Bearer test.key",
  );
});

test("general GLM rejects invalid keys during login", async () => {
  await assert.rejects(
    verifyApiKey(glmGeneral, "invalid.key", async () =>
      new Response(
        '{"error":{"code":"401","message":"token expired or incorrect"}}',
        { status: 401 },
      ),
    ),
    /智谱 GLM \(通用\) rejected this API key: token expired or incorrect/,
  );
});

test("OpenRouter keys are verified without spending model credits", async () => {
  let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
  const result = await verifyApiKey(openRouter, "sk-or-v1-test", async (input, init) => {
    request = { input, init };
    return Response.json({ data: { label: "test" } });
  });

  assert.equal(result, "verified");
  assert.equal(String(request?.input), "https://openrouter.ai/api/v1/key");
  assert.equal(
    new Headers(request?.init?.headers).get("Authorization"),
    "Bearer sk-or-v1-test",
  );
});

test("OpenRouter rejects invalid keys during login", async () => {
  await assert.rejects(
    verifyApiKey(openRouter, "invalid", async () =>
      Response.json({ error: { message: "User not found" } }, { status: 401 }),
    ),
    /OpenRouter rejected this API key: User not found/,
  );
});

test("Coding Plan keys skip the incompatible models endpoint", async () => {
  for (const provider of [
    {
      name: "zhipu-coding",
      label: "Z.AI GLM Coding",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
    },
    {
      name: "zhipu-coding-cn",
      label: "智谱 GLM Coding (中国)",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    },
  ]) {
    const result = await verifyApiKey(provider, "coding.plan-key", async () => {
      throw new Error("Coding Plan login must not call /models");
    });
    assert.equal(result, "not-supported");
  }
});

test("GLM login rejects a copied key ID without its secret", async () => {
  await assert.rejects(
    verifyApiKey(
      {
        name: "zhipu-coding",
        label: "Z.AI GLM Coding",
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
      },
      "copied-key-id",
      async () => {
        throw new Error("fetch should not run");
      },
    ),
    /copy the full id\.secret value, including the dot/,
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
