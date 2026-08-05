import { test } from "node:test";
import assert from "node:assert/strict";

import type { Pyodide } from "../src/pyodide-host.ts";
import {
  parseCurlArgs,
  runCurlCommand,
} from "../src/slop-host-commands.ts";

const emptyPyodide = { FS: {} } as unknown as Pyodide;

test("curl parser accepts common curl syntax", () => {
  const parsed = parseCurlArgs([
    "curl",
    "-sS",
    "-XPOST",
    "-H",
    "Authorization: Bearer test",
    "--json",
    '{"ok":true}',
    "--max-time=2.5",
    "-w",
    "\\n%{http_code}",
    "https://example.com/api",
  ]);

  assert.ok(!("help" in parsed));
  assert.equal(parsed.method, "POST");
  assert.equal(parsed.silent, true);
  assert.equal(parsed.showError, true);
  assert.equal(parsed.timeoutMs, 2500);
  assert.equal(parsed.data[0].value, '{"ok":true}');
  assert.deepEqual(parsed.headers, [
    "Authorization: Bearer test",
    "Content-Type: application/json",
    "Accept: application/json",
  ]);
});

test("browser curl sends stdin bytes and preserves response bytes", async () => {
  const originalFetch = globalThis.fetch;
  let request: RequestInit | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    request = init;
    return new Response(new Uint8Array([0, 1, 2, 255]), {
      status: 201,
      statusText: "Created",
      headers: { "Content-Type": "application/octet-stream" },
    });
  }) as typeof fetch;
  try {
    const input = new Uint8Array([5, 0, 6]);
    const result = await runCurlCommand({
      py: emptyPyodide,
      args: [
        "curl",
        "--data-binary",
        "@-",
        "-w",
        "\\n%{http_code} %{size_download}",
        "https://example.com/upload",
      ],
      cwd: "/home/web",
      stdin: input,
    });

    assert.equal(result.exitCode, 0);
    assert.equal(request?.method, "POST");
    assert.deepEqual(new Uint8Array(request?.body as ArrayBuffer), input);
    assert.deepEqual(result.stdout?.subarray(0, 4), new Uint8Array([0, 1, 2, 255]));
    assert.equal(new TextDecoder().decode(result.stdout?.subarray(4)), "\n201 4");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("browser curl emits headers for HEAD and returns curl HTTP failure code", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ignored", {
    status: 404,
    statusText: "Not Found",
    headers: { "X-Test": "yes" },
  })) as typeof fetch;
  try {
    const head = await runCurlCommand({
      py: emptyPyodide,
      args: ["curl", "-I", "https://example.com/missing"],
      cwd: "/home/web",
    });
    assert.equal(head.exitCode, 0);
    assert.match(new TextDecoder().decode(head.stdout), /^HTTP\/1\.1 404 Not Found\r\n/);

    const failed = await runCurlCommand({
      py: emptyPyodide,
      args: ["curl", "--fail", "https://example.com/missing"],
      cwd: "/home/web",
    });
    assert.equal(failed.exitCode, 22);
    assert.equal(failed.stdout?.byteLength, 0);
    assert.match(new TextDecoder().decode(failed.stderr), /HTTP 404 Not Found/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("browser curl aborts fetch at --max-time", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    })) as typeof fetch;
  try {
    const result = await runCurlCommand({
      py: emptyPyodide,
      args: ["curl", "--max-time", "0.001", "https://example.com/slow"],
      cwd: "/home/web",
    });
    assert.equal(result.exitCode, 28);
    assert.match(new TextDecoder().decode(result.stderr), /operation timed out/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
