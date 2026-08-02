import assert from "node:assert/strict";
import test from "node:test";
import { apiKeyHint, normalizeApiKey, verifyApiKey } from "../src/provider-auth.ts";

const glmGeneral = {
  name: "zhipu",
  label: "智谱 GLM (通用)",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
};

test("API key normalization removes common copy/paste artifacts", () => {
  assert.equal(normalizeApiKey("  Bearer abc.def  \n"), "abc.def");
  assert.equal(normalizeApiKey('"abc.def"'), "abc.def");
  assert.equal(normalizeApiKey("abc\u200B.def"), "abc.def");
  assert.equal(normalizeApiKey("\u202A“ａｂｃ．ｄｅｆ”\u2069"), "abc.def");
  assert.equal(normalizeApiKey("Bearer `abc.def`"), "abc.def");
  assert.equal(apiKeyHint("abcd01234567wxyz"), "abcd…wxyz · 16 chars");
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

test("Coding Plan keys are verified with a one-token completion", async () => {
  for (const provider of [
    {
      name: "zhipu-coding",
      label: "Z.AI GLM Coding",
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      defaultModel: "glm-5.2",
    },
    {
      name: "zhipu-coding-cn",
      label: "智谱 GLM Coding (中国)",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      defaultModel: "glm-5.2",
    },
  ]) {
    let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    const result = await verifyApiKey(provider, "coding.plan-key", async (input, init) => {
      request = { input, init };
      return new Response('{"choices":[]}', { status: 200 });
    });
    assert.equal(result, "verified");
    assert.equal(String(request?.input), `${provider.baseUrl}/chat/completions`);
    assert.equal(request?.init?.method, "POST");
    assert.equal(
      new Headers(request?.init?.headers).get("Authorization"),
      "Bearer coding.plan-key",
    );
    assert.deepEqual(JSON.parse(String(request?.init?.body)), {
      model: "glm-5.2",
      messages: [{ role: "user", content: "Reply OK." }],
      max_tokens: 1,
      stream: false,
    });
  }
});

test("Coding Plan login accepts exhausted quota but rejects invalid keys", async () => {
  const provider = {
    name: "zhipu-coding",
    label: "Z.AI GLM Coding",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    defaultModel: "glm-5.2",
  };
  const exhausted = await verifyApiKey(provider, "valid.key", async () =>
    new Response(
      '{"code":"1310","message":"Weekly/Monthly Limit Exhausted."}',
      { status: 429 },
    ),
  );
  assert.equal(exhausted, "quota-exhausted");

  await assert.rejects(
    verifyApiKey(provider, "invalid.key", async () =>
      new Response(
        '{"error":{"code":"401","message":"token expired or incorrect"}}',
        { status: 401 },
      ),
    ),
    /Z\.AI GLM Coding rejected this API key: token expired or incorrect/,
  );
});

test("GLM login rejects malformed pasted bytes before making a request", async () => {
  await assert.rejects(
    verifyApiKey(glmGeneral, "abc.def!", async () => {
      throw new Error("fetch should not run");
    }),
    /invalid format after paste cleanup/,
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
