#!/usr/bin/env node
/**
 * TEMPORARY local-only bridge from piodide to ChatGPT-managed Codex auth.
 *
 * OAuth credentials stay in this process and disappear when it exits. The
 * browser receives only a random, process-local capability token. Remove this
 * file and the clearly marked `codex-local` integration when it is no longer
 * needed; see TEMPORARY_CODEX_PROXY.md.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import process from "node:process";

import {
  createModels,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

export const DEFAULT_PROXY_HOST = "127.0.0.1";
export const DEFAULT_PROXY_PORT = 1456;
export const CODEX_UPSTREAM_URL = "https://chatgpt.com/backend-api/codex/responses";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "https://daugasauron.github.io",
];
const ALLOWED_REQUEST_HEADERS = [
  "authorization",
  "chatgpt-account-id",
  "content-encoding",
  "content-type",
  "openai-beta",
  "originator",
  "session-id",
  "user-agent",
  "x-client-request-id",
].join(", ");

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Create a JWT-shaped local capability understood by pi-ai's Codex client. */
export function createCapabilityToken() {
  const header = base64UrlJson({ alg: "none", typ: "JWT" });
  const payload = base64UrlJson({
    [JWT_AUTH_CLAIM]: { chatgpt_account_id: "temporary-local-proxy" },
    nonce: randomBytes(24).toString("base64url"),
  });
  const signature = randomBytes(32).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export function extractAccountId(accessToken) {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));
    const accountId = payload?.[JWT_AUTH_CLAIM]?.chatgpt_account_id;
    if (typeof accountId !== "string" || accountId.length === 0) throw new Error("missing account id");
    return accountId;
  } catch {
    throw new Error("OpenAI OAuth token did not contain a ChatGPT account id");
  }
}

function tokenMatches(actual, expected) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearerToken(request) {
  const value = request.headers.authorization ?? "";
  return typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : "";
}

function writeJson(response, status, value) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function setCors(response, origin, privateNetwork = false) {
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
  if (privateNetwork) response.setHeader("access-control-allow-private-network", "true");
}

async function readBoundedBody(request, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error(`request exceeds ${maxBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function upstreamHeaders(request, accessToken, accountId) {
  const headers = new Headers({
    accept: "text/event-stream",
    authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    "content-type": request.headers["content-type"] || "application/json",
    "openai-beta": request.headers["openai-beta"] || "responses=experimental",
    originator: "piodide-local-proxy",
  });
  for (const name of ["session-id", "x-client-request-id"]) {
    const value = request.headers[name];
    if (typeof value === "string" && value.length <= 256) headers.set(name, value);
  }
  if (request.headers["content-encoding"] === "zstd") {
    headers.set("content-encoding", "zstd");
  }
  return headers;
}

/**
 * Build the isolated proxy server. Dependencies are injected so its security
 * behavior can be tested without performing OAuth or contacting OpenAI.
 */
export function createLocalCodexProxyServer({
  capability,
  getAccessToken,
  allowedOrigins = DEFAULT_ALLOWED_ORIGINS,
  upstreamFetch = fetch,
  upstreamUrl = CODEX_UPSTREAM_URL,
  maxRequestBytes = MAX_REQUEST_BYTES,
  onShutdown = () => {},
  shutdownSignal,
}) {
  const origins = new Set(allowedOrigins);
  let shutdownRequested = false;

  return createServer(async (request, response) => {
    const origin = typeof request.headers.origin === "string" ? request.headers.origin : "";
    if (!origins.has(origin)) {
      writeJson(response, 403, { error: "origin is not allowed by the temporary Codex proxy" });
      return;
    }
    const privateNetwork = request.headers["access-control-request-private-network"] === "true";
    setCors(response, origin, privateNetwork);
    response.setHeader("cache-control", "no-store");

    const url = new URL(request.url || "/", "http://127.0.0.1");
    const allowedPath = url.pathname === "/auth/status" || url.pathname === "/shutdown" || url.pathname === "/codex/responses";
    if (!allowedPath) {
      writeJson(response, 404, { error: "not found" });
      return;
    }

    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader("access-control-allow-headers", ALLOWED_REQUEST_HEADERS);
      response.setHeader("access-control-max-age", "600");
      response.end();
      return;
    }

    if (!tokenMatches(bearerToken(request), capability)) {
      writeJson(response, 401, { error: "invalid temporary proxy token" });
      return;
    }

    if (url.pathname === "/auth/status" && request.method === "GET") {
      writeJson(response, 200, { authenticated: true, temporary: true });
      return;
    }
    if (url.pathname === "/shutdown" && request.method === "POST") {
      writeJson(response, 202, { stopping: true });
      if (!shutdownRequested) {
        shutdownRequested = true;
        response.once("finish", onShutdown);
      }
      return;
    }
    if (url.pathname !== "/codex/responses" || request.method !== "POST") {
      writeJson(response, 405, { error: "method not allowed" });
      return;
    }

    const abort = new AbortController();
    const closeUpstream = () => {
      abort.abort();
      shutdownSignal?.removeEventListener("abort", stopForShutdown);
    };
    const stopForShutdown = () => {
      abort.abort();
      response.destroy();
    };
    response.once("close", closeUpstream);
    shutdownSignal?.addEventListener("abort", stopForShutdown, { once: true });
    if (shutdownSignal?.aborted) stopForShutdown();

    let body;
    try {
      body = await readBoundedBody(request, maxRequestBytes);
    } catch (error) {
      if (abort.signal.aborted) return;
      writeJson(response, error.statusCode || 400, { error: error.message });
      return;
    }

    try {
      const accessToken = await getAccessToken();
      if (!accessToken) throw new Error("Codex OAuth session is unavailable; restart the proxy");
      const accountId = extractAccountId(accessToken);
      const upstream = await upstreamFetch(upstreamUrl, {
        method: "POST",
        headers: upstreamHeaders(request, accessToken, accountId),
        body,
        redirect: "error",
        signal: abort.signal,
      });

      response.statusCode = upstream.status;
      for (const name of ["content-type", "x-request-id", "openai-processing-ms"]) {
        const value = upstream.headers.get(name);
        if (value) response.setHeader(name, value);
      }
      response.setHeader("access-control-expose-headers", "x-request-id, openai-processing-ms");
      if (!upstream.body) {
        response.end();
        return;
      }
      Readable.fromWeb(upstream.body).on("error", (error) => response.destroy(error)).pipe(response);
    } catch (error) {
      if (abort.signal.aborted) return;
      writeJson(response, 502, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function configuredOrigins() {
  const configured = process.env.PIODIDE_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return configured?.length ? configured : DEFAULT_ALLOWED_ORIGINS;
}

async function loginWithChatGPT(models) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const deviceAuth = process.env.CODEX_PROXY_DEVICE_AUTH === "1";
  try {
    await models.login("openai-codex", "oauth", {
      prompt: async (prompt) => {
        if (prompt.type === "select") return deviceAuth ? "device_code" : "browser";
        const suffix = prompt.placeholder ? ` (${prompt.placeholder})` : "";
        return readline.question(`${prompt.message}${suffix}: `, { signal: prompt.signal });
      },
      notify: (event) => {
        if (event.type === "auth_url") {
          console.log(`\nOpen this URL in your browser:\n${event.url}\n`);
        } else if (event.type === "device_code") {
          console.log(`\nOpen ${event.verificationUri} and enter code: ${event.userCode}\n`);
        } else if (event.type === "info" || event.type === "progress") {
          console.log(event.message);
        }
      },
    });
  } finally {
    readline.close();
  }
}

async function main() {
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  models.setProvider(openaiCodexProvider());

  console.log("Temporary piodide Codex proxy — credentials are memory-only.");
  console.log("Press Ctrl-C at any time to remove them and stop the proxy.\n");
  await loginWithChatGPT(models);

  const capability = createCapabilityToken();
  const host = DEFAULT_PROXY_HOST;
  const port = DEFAULT_PROXY_PORT;
  const shutdownController = new AbortController();
  let server;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const stopped = new Promise((resolveStopped) => server?.close(resolveStopped));
    shutdownController.abort();
    await models.logout("openai-codex").catch(() => {});
    await stopped;
  };
  server = createLocalCodexProxyServer({
    capability,
    getAccessToken: async () => (await models.getAuth("openai-codex"))?.auth.apiKey,
    allowedOrigins: configuredOrigins(),
    onShutdown: () => void shutdown(),
    shutdownSignal: shutdownController.signal,
  });
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });

  const encodedToken = encodeURIComponent(capability);
  console.log(`\nProxy ready at http://${host}:${port}`);
  console.log(`Allowed browser origins: ${configuredOrigins().join(", ")}`);
  console.log("\nOpen one of these URLs:");
  // Keep the capability in the URL fragment: browsers do not send fragments
  // to Vite, GitHub Pages, referrers, or any other server.
  console.log(`  Local:  http://localhost:5173/piodide/#codex_proxy_token=${encodedToken}`);
  console.log(`  Pages:  https://daugasauron.github.io/piodide/#codex_proxy_token=${encodedToken}`);
  console.log("\nOr select /provider codex-local and paste this value into /login:");
  console.log(`  ${capability}`);
  console.log("\nStop with Ctrl-C or /logout in piodide. Nothing is persisted.\n");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\nProxy failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
