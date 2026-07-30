import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import vm from "node:vm";

type FetchEvent = {
  request: Request;
  respondWith(response: Promise<Response>): void;
};

const source = readFileSync(
  new URL("../public/coi-serviceworker.js", import.meta.url),
  "utf8",
);

let fetchCalls = 0;
let fetchImpl: (request: Request) => Promise<Response>;
let onFetch: (event: FetchEvent) => void;

beforeEach(() => {
  fetchCalls = 0;
  fetchImpl = async () => new Response("ok");
  const listeners = new Map<string, (event: FetchEvent) => void>();
  const worker = {
    location: { origin: "https://piodide.test" },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener(type: string, listener: (event: FetchEvent) => void) {
      listeners.set(type, listener);
    },
  };
  vm.runInNewContext(source, {
    self: worker,
    URL,
    Headers,
    Response,
    fetch: (request: Request) => {
      fetchCalls++;
      return fetchImpl(request);
    },
  });
  onFetch = listeners.get("fetch")!;
});

afterEach(() => {
  fetchImpl = async () => new Response("ok");
});

test("COI service worker bypasses cross-origin response streams", () => {
  let intercepted = false;
  onFetch({
    request: new Request("http://127.0.0.1:1456/codex/responses"),
    respondWith() {
      intercepted = true;
    },
  });

  assert.equal(intercepted, false);
  assert.equal(fetchCalls, 0);
});

test("COI service worker adds isolation headers to same-origin responses", async () => {
  let intercepted: Promise<Response> | undefined;
  onFetch({
    request: new Request("https://piodide.test/assets/runner.worker.js"),
    respondWith(response) {
      intercepted = response;
    },
  });

  assert.ok(intercepted);
  const response = await intercepted;
  assert.equal(fetchCalls, 1);
  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(response.headers.get("cross-origin-embedder-policy"), "credentialless");
  assert.equal(await response.text(), "ok");
});

test("COI service worker does not duplicate a failed request", async () => {
  fetchImpl = async () => {
    throw new Error("network failed");
  };
  let intercepted: Promise<Response> | undefined;
  onFetch({
    request: new Request("https://piodide.test/assets/runner.worker.js"),
    respondWith(response) {
      intercepted = response;
    },
  });

  assert.ok(intercepted);
  await assert.rejects(intercepted, /network failed/);
  assert.equal(fetchCalls, 1);
});
