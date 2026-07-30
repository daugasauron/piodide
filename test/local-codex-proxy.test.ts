import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import type { Model } from "@earendil-works/pi-ai";

import {
  createCapabilityToken,
  createLocalCodexProxyServer,
  extractAccountId,
} from "../scripts/local-codex-proxy.mjs";
import { getProvider, type ApiKind } from "../src/providers.ts";
import { streamDispatch } from "../src/stream.ts";

const ORIGIN = "https://piodide.test";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

function jwt(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })}.signature`;
}

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("temporary local Codex proxy", () => {
  it("registers an explicitly temporary Codex provider", async () => {
    const provider = getProvider("codex-local");
    assert.ok(provider);
    assert.equal(provider.temporaryLocalCodexProxy, true);
    assert.equal(provider.api, "openai-codex-responses");
    assert.equal(provider.baseUrl, "http://127.0.0.1:1456");
    assert.ok((await provider.loadModels()).includes("gpt-5.6-sol"));
  });

  it("creates a JWT-shaped capability without an OpenAI credential", () => {
    const capability = createCapabilityToken();
    assert.equal(capability.split(".").length, 3);
    assert.equal(extractAccountId(capability), "temporary-local-proxy");
  });

  it("rejects foreign origins and invalid capabilities", async () => {
    const capability = createCapabilityToken();
    const server = createLocalCodexProxyServer({
      capability,
      allowedOrigins: [ORIGIN],
      getAccessToken: async () => jwt("account-real"),
    });
    const base = await listen(server);

    const foreign = await fetch(`${base}/auth/status`, {
      headers: { Origin: "https://evil.test", Authorization: `Bearer ${capability}` },
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);

    const invalid = await fetch(`${base}/auth/status`, {
      headers: { Origin: ORIGIN, Authorization: "Bearer wrong" },
    });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.headers.get("access-control-allow-origin"), ORIGIN);
  });

  it("answers private-network CORS preflights only for allowed origins", async () => {
    const server = createLocalCodexProxyServer({
      capability: createCapabilityToken(),
      allowedOrigins: [ORIGIN],
      getAccessToken: async () => jwt("account-real"),
    });
    const base = await listen(server);
    const response = await fetch(`${base}/codex/responses`, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization, chatgpt-account-id, content-type, openai-beta, originator, user-agent",
        "Access-Control-Request-Private-Network": "true",
      },
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(response.headers.get("access-control-allow-private-network"), "true");
    const allowedHeaders = response.headers.get("access-control-allow-headers") ?? "";
    for (const name of [
      "authorization",
      "chatgpt-account-id",
      "content-type",
      "openai-beta",
      "originator",
      "user-agent",
    ]) {
      assert.match(allowedHeaders, new RegExp(`(?:^|, )${name}(?:,|$)`));
    }
  });

  it("runs the shutdown hook once after acknowledging the request", async () => {
    const capability = createCapabilityToken();
    let shutdowns = 0;
    const server = createLocalCodexProxyServer({
      capability,
      allowedOrigins: [ORIGIN],
      getAccessToken: async () => jwt("account-real"),
      onShutdown: () => {
        shutdowns++;
      },
    });
    const base = await listen(server);
    const request = () =>
      fetch(`${base}/shutdown`, {
        method: "POST",
        headers: { Origin: ORIGIN, Authorization: `Bearer ${capability}` },
      });

    const first = await request();
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { stopping: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdowns, 1);

    assert.equal((await request()).status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdowns, 1);
  });

  it("replaces local credentials and streams only to the fixed Codex endpoint", async () => {
    const capability = createCapabilityToken();
    const realAccessToken = jwt("account-real");
    let observedUrl = "";
    let observedInit: RequestInit | undefined;
    const server = createLocalCodexProxyServer({
      capability,
      allowedOrigins: [ORIGIN],
      getAccessToken: async () => realAccessToken,
      upstreamFetch: async (url: string | URL | Request, init?: RequestInit) => {
        observedUrl = String(url);
        observedInit = init;
        return new Response('data: {"type":"response.completed"}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream", "x-request-id": "request-1" },
        });
      },
    });
    const base = await listen(server);
    const response = await fetch(`${base}/codex/responses`, {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        Authorization: `Bearer ${capability}`,
        "Content-Type": "application/json",
        "ChatGPT-Account-ID": "attacker-controlled",
      },
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true }),
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'data: {"type":"response.completed"}\n\n');
    assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal(response.headers.get("x-request-id"), "request-1");
    assert.equal(observedUrl, "https://chatgpt.com/backend-api/codex/responses");

    const headers = observedInit?.headers as Headers;
    assert.equal(headers.get("authorization"), `Bearer ${realAccessToken}`);
    assert.equal(headers.get("chatgpt-account-id"), "account-real");
    assert.notEqual(headers.get("authorization"), `Bearer ${capability}`);
    assert.equal(
      Buffer.from(observedInit?.body as Buffer).toString("utf8"),
      JSON.stringify({ model: "gpt-5.6-sol", stream: true }),
    );
  });

  it("streams end-to-end through the app's Codex dispatch", async () => {
    const capability = createCapabilityToken();
    const realAccessToken = jwt("account-real");
    let observedBody: Record<string, unknown> | undefined;
    let observedHeaders: Headers | undefined;
    const server = createLocalCodexProxyServer({
      capability,
      allowedOrigins: [ORIGIN],
      getAccessToken: async () => realAccessToken,
      upstreamFetch: async (_url, init) => {
        observedHeaders = init?.headers as Headers;
        const raw = Buffer.from(init?.body as Buffer);
        const decoded =
          observedHeaders.get("content-encoding") === "zstd"
            ? zstdDecompressSync(raw)
            : raw;
        observedBody = JSON.parse(decoded.toString("utf8"));
        return new Response(
          [
            'data: {"type":"response.created","response":{"id":"response-1","model":"gpt-5.6-sol","status":"in_progress","output":[]}}',
            "",
            'data: {"type":"response.completed","response":{"id":"response-1","model":"gpt-5.6-sol","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"input_tokens_details":{"cached_tokens":0}}}}',
            "",
            "",
          ].join("\n"),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const baseUrl = await listen(server);
    const model: Model<ApiKind> = {
      id: "gpt-5.6-sol",
      name: "gpt-5.6-sol",
      api: "openai-codex-responses",
      provider: "codex-local",
      baseUrl,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 272_000,
      maxTokens: 128_000,
    };
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (input, init = {}) =>
      nativeFetch(input, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          Origin: ORIGIN,
        },
      });

    const events: string[] = [];
    try {
      const stream = await streamDispatch(
        model,
        { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
        { apiKey: capability },
      );
      for await (const event of stream) {
        events.push(event.type === "done" ? `${event.type}:${event.reason}` : event.type);
      }
    } finally {
      globalThis.fetch = nativeFetch;
    }

    assert.deepEqual(events, ["start", "done:stop"]);
    assert.equal(observedBody?.model, "gpt-5.6-sol");
    assert.equal(observedHeaders?.get("authorization"), `Bearer ${realAccessToken}`);
    assert.equal(observedHeaders?.get("chatgpt-account-id"), "account-real");
  });

  it("bounds request bodies before contacting the upstream", async () => {
    let upstreamCalled = false;
    const capability = createCapabilityToken();
    const server = createLocalCodexProxyServer({
      capability,
      allowedOrigins: [ORIGIN],
      maxRequestBytes: 4,
      getAccessToken: async () => jwt("account-real"),
      upstreamFetch: async () => {
        upstreamCalled = true;
        return new Response();
      },
    });
    const base = await listen(server);
    const response = await fetch(`${base}/codex/responses`, {
      method: "POST",
      headers: { Origin: ORIGIN, Authorization: `Bearer ${capability}` },
      body: "12345",
    });

    assert.equal(response.status, 413);
    assert.equal(upstreamCalled, false);
  });

  it("cancels an active upstream stream when the proxy shuts down", async () => {
    const capability = createCapabilityToken();
    const shutdown = new AbortController();
    let upstreamStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      upstreamStarted = resolve;
    });
    let upstreamAborted = false;
    const server = createLocalCodexProxyServer({
      capability,
      allowedOrigins: [ORIGIN],
      shutdownSignal: shutdown.signal,
      getAccessToken: async () => jwt("account-real"),
      upstreamFetch: async (_url, init) => {
        upstreamStarted();
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              upstreamAborted = true;
              reject(init.signal?.reason);
            },
            { once: true },
          );
        });
        return new Response();
      },
    });
    const base = await listen(server);
    const response = fetch(`${base}/codex/responses`, {
      method: "POST",
      headers: { Origin: ORIGIN, Authorization: `Bearer ${capability}` },
      body: "{}",
    });

    await started;
    shutdown.abort();
    await assert.rejects(response, /fetch failed/);
    assert.equal(upstreamAborted, true);
  });
});
