#!/usr/bin/env node
/**
 * Local-only bridge from piodide to ChatGPT-managed Codex auth.
 *
 * OAuth credentials stay in this process and disappear when it exits. The
 * browser receives only a random, process-local capability token through a
 * URL fragment. See docs/codex-proxy.md.
 */
import { spawn } from "node:child_process";
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
export const DEFAULT_PIODIDE_URL = "http://localhost:5173/piodide/";
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
    [JWT_AUTH_CLAIM]: { chatgpt_account_id: "piodide-local-proxy" },
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

/** Put the local capability in a fragment so no web server or referrer sees it. */
export function createPiodideConnectionLocation(piodideUrl, capability) {
  const target = new URL(piodideUrl);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("PIODIDE_URL must use http or https");
  }
  const fragment = new URLSearchParams(target.hash.slice(1));
  fragment.set("codex_proxy_token", capability);
  target.hash = fragment.toString();
  return target.href;
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
  connectTarget,
  upstreamFetch = fetch,
  upstreamUrl = CODEX_UPSTREAM_URL,
  maxRequestBytes = MAX_REQUEST_BYTES,
  onShutdown = () => {},
  shutdownSignal,
}) {
  const origins = new Set(allowedOrigins);
  let connectLocation = "";
  if (connectTarget) {
    const targetOrigin = new URL(connectTarget).origin;
    if (!origins.has(targetOrigin)) {
      throw new Error(`PIODIDE_URL origin ${targetOrigin} is not in PIODIDE_ORIGINS`);
    }
    connectLocation = createPiodideConnectionLocation(connectTarget, capability);
  }
  let shutdownRequested = false;

  return createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    response.setHeader("cache-control", "no-store");

    // Top-level navigation does not carry an Origin header. This fixed
    // loopback redirect is the only unauthenticated route, and its target was
    // checked against the exact origin allowlist above.
    if (url.pathname === "/connect") {
      if (!connectLocation) {
        writeJson(response, 404, { error: "connection target is not configured" });
      } else if (request.method !== "GET") {
        writeJson(response, 405, { error: "method not allowed" });
      } else {
        response.statusCode = 302;
        response.setHeader("location", connectLocation);
        response.setHeader("referrer-policy", "no-referrer");
        response.end();
      }
      return;
    }

    const origin = typeof request.headers.origin === "string" ? request.headers.origin : "";
    if (!origins.has(origin)) {
      writeJson(response, 403, { error: "origin is not allowed by the local Codex proxy" });
      return;
    }
    const privateNetwork = request.headers["access-control-request-private-network"] === "true";
    setCors(response, origin, privateNetwork);

    const allowedPath =
      url.pathname === "/health" ||
      url.pathname === "/auth/status" ||
      url.pathname === "/shutdown" ||
      url.pathname === "/codex/responses";
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

    if (url.pathname === "/health" && request.method === "GET") {
      writeJson(response, 200, { ready: true });
      return;
    }

    if (!tokenMatches(bearerToken(request), capability)) {
      writeJson(response, 401, { error: "invalid local proxy token" });
      return;
    }

    if (url.pathname === "/auth/status" && request.method === "GET") {
      writeJson(response, 200, { authenticated: true, local: true });
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

function configuredPiodideUrl(origins) {
  const value = process.env.PIODIDE_URL?.trim() || DEFAULT_PIODIDE_URL;
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("PIODIDE_URL must use http or https");
  }
  if (!origins.includes(parsed.origin)) {
    throw new Error(`PIODIDE_URL origin ${parsed.origin} is not in PIODIDE_ORIGINS`);
  }
  return parsed.href;
}

async function openInBrowser(url) {
  const configuredBrowser = process.env.CODEX_PROXY_BROWSER?.trim();
  const candidates = configuredBrowser
    ? [{ executable: configuredBrowser, args: [url] }]
    : process.platform === "darwin"
      ? [{ executable: "open", args: [url] }]
      : process.platform === "win32"
        ? [{ executable: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] }]
        : [
            process.env.CHROME_BIN?.trim()
              ? { executable: process.env.CHROME_BIN.trim(), args: [url] }
              : null,
            { executable: "google-chrome-stable", args: [url] },
            { executable: "google-chrome", args: [url] },
            { executable: "xdg-open", args: [url] },
          ].filter(Boolean);

  let lastError;
  for (const command of candidates) {
    try {
      await new Promise((resolveOpen, rejectOpen) => {
        const child = spawn(command.executable, command.args, { stdio: "ignore" });
        child.once("error", rejectOpen);
        child.once("close", (code) => {
          if (code === 0) resolveOpen();
          else rejectOpen(new Error(`${command.executable} exited with code ${code}`));
        });
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw (
    lastError ??
    new Error("no browser command is available")
  );
}

function openOrShow(url, description, autoOpen) {
  if (!autoOpen) {
    console.log(`\n${description}:\n${url}\n`);
    return;
  }
  console.log(`${description}…`);
  void openInBrowser(url).catch((error) => {
    console.warn(`Could not open the browser (${error.message}). Open this URL:\n${url}\n`);
  });
}

async function loginWithChatGPT(models, autoOpen) {
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
          openOrShow(event.url, "Opening ChatGPT authorization", autoOpen);
        } else if (event.type === "device_code") {
          console.log(`\nEnter this device code in the browser: ${event.userCode}`);
          openOrShow(event.verificationUri, "Opening device authorization", autoOpen);
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
  const origins = configuredOrigins();
  const piodideUrl = configuredPiodideUrl(origins);
  const autoOpen = process.env.CODEX_PROXY_NO_OPEN !== "1";
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  models.setProvider(openaiCodexProvider());

  console.log("Piodide Codex subscription proxy");
  console.log("OpenAI credentials stay in this process and are removed when it exits.\n");
  await loginWithChatGPT(models, autoOpen);

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
    allowedOrigins: origins,
    connectTarget: piodideUrl,
    onShutdown: () => void shutdown(),
    shutdownSignal: shutdownController.signal,
  });
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });

  console.log(`\nProxy ready at http://${host}:${port}`);
  openOrShow(
    `http://${host}:${port}/connect`,
    `Opening Piodide at ${piodideUrl}`,
    autoOpen,
  );
  console.log("Stop with Ctrl-C or /logout in Piodide. Nothing is persisted.\n");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\nProxy failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
