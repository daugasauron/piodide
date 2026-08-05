import { test } from "node:test";
import assert from "node:assert/strict";

import type { Pyodide } from "../src/pyodide-host.ts";
import {
  parseCurlArgs,
  runCurlCommand,
} from "../src/slop-host-commands.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class MemoryFs {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set(["/", "/home", "/home/web", "/home/web/sub"]);

  analyzePath(path: string): { exists: boolean } {
    return { exists: this.files.has(path) || this.dirs.has(path) };
  }

  isDir(mode: number): boolean {
    return mode === 0o040000;
  }

  stat(path: string): { mode: number; size: number } {
    if (this.dirs.has(path)) return { mode: 0o040000, size: 0 };
    const file = this.files.get(path);
    if (!file) throw new Error("ENOENT");
    return { mode: 0o100000, size: file.byteLength };
  }

  readFile(path: string): Uint8Array {
    const file = this.files.get(path);
    if (!file) throw new Error("ENOENT");
    return file.slice();
  }

  writeFile(path: string, value: string | Uint8Array): void {
    if (!this.dirs.has(path.slice(0, path.lastIndexOf("/")) || "/")) throw new Error("ENOENT");
    this.files.set(path, typeof value === "string" ? encoder.encode(value) : value.slice());
  }

  open(path: string, flags: string): { path: string; position: number } {
    if (!this.dirs.has(path.slice(0, path.lastIndexOf("/")) || "/")) throw new Error("ENOENT");
    if (flags === "w") this.files.set(path, new Uint8Array());
    return { path, position: flags === "a" ? (this.files.get(path)?.byteLength ?? 0) : 0 };
  }

  write(
    stream: { path: string; position: number },
    value: Uint8Array,
    offset: number,
    length: number,
  ): number {
    const current = this.files.get(stream.path) ?? new Uint8Array();
    const needed = stream.position + length;
    const next = new Uint8Array(Math.max(current.byteLength, needed));
    next.set(current);
    next.set(value.subarray(offset, offset + length), stream.position);
    stream.position += length;
    this.files.set(stream.path, next);
    return length;
  }

  close(): void {}
}

function pyodide(fs = new MemoryFs()): Pyodide {
  return { FS: fs } as unknown as Pyodide;
}

function text(value?: Uint8Array): string {
  return decoder.decode(value ?? new Uint8Array());
}

function requestBytes(init?: RequestInit): Uint8Array {
  if (!init?.body) return new Uint8Array();
  if (init.body instanceof ArrayBuffer) return new Uint8Array(init.body);
  if (ArrayBuffer.isView(init.body)) {
    return new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength);
  }
  throw new Error(`unexpected request body: ${typeof init.body}`);
}

test("curl parser accepts the documented compact syntax", () => {
  const parsed = parseCurlArgs([
    "curl",
    "-sSL",
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
  assert.equal(parsed.location, true);
  assert.equal(parsed.timeoutMs, 2500);
  assert.deepEqual(parsed.data, [{ kind: "json", value: '{"ok":true}' }]);
  assert.deepEqual(parsed.headers, ["Authorization: Bearer test"]);

  const noTimeout = parseCurlArgs(["curl", "-m0", "example.com"]);
  assert.ok(!("help" in noTimeout));
  assert.equal(noTimeout.timeoutMs, undefined);
  assert.throws(
    () => parseCurlArgs(["curl", "--connect-timeout", "1", "example.com"]),
    /unavailable in browser Fetch/,
  );
});

test("curl help and version do not perform a request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("unexpected"); }) as typeof fetch;
  try {
    const help = await runCurlCommand({ py: pyodide(), args: ["curl", "--help"], cwd: "/home/web" });
    const version = await runCurlCommand({ py: pyodide(), args: ["curl", "--version"], cwd: "/home/web" });
    assert.equal(help.exitCode, 0);
    assert.match(text(help.stdout), /not libcurl/);
    assert.match(text(version.stdout), /browser Fetch; not libcurl/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("curl matches text, binary, JSON, URL-encoding, and repeated-header semantics", async () => {
  const fs = new MemoryFs();
  fs.writeFile("/home/web/text.txt", new Uint8Array([111, 110, 101, 10, 0, 116, 119, 111, 13, 10]));
  fs.writeFile("/home/web/binary.dat", new Uint8Array([0, 1, 10, 255]));
  fs.writeFile("/home/web/headers.txt", "Content-Type:\nAccept:\nX-Empty;\nX-File: yes\n");
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(init ?? {});
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    const context = { py: pyodide(fs), cwd: "/home/web" };
    assert.equal((await runCurlCommand({ ...context, args: ["curl", "-d", "@text.txt", "https://example.com"] })).exitCode, 0);
    assert.equal((await runCurlCommand({ ...context, args: ["curl", "--data-binary", "@binary.dat", "https://example.com"] })).exitCode, 0);
    assert.equal((await runCurlCommand({
      ...context,
      args: [
        "curl", "-H", "Content-Type: custom/type", "-H", "X-Test: one", "-H", "X-Test: two",
        "--json", '{"value":', "--json", "true}", "https://example.com",
      ],
    })).exitCode, 0);
    assert.equal((await runCurlCommand({
      ...context,
      args: ["curl", "--data-urlencode", "=a b", "--data-urlencode", "field@text.txt", "https://example.com"],
    })).exitCode, 0);
    assert.equal((await runCurlCommand({
      ...context,
      args: ["curl", "-H", "@headers.txt", "--json", "{}", "https://example.com"],
    })).exitCode, 0);

    assert.equal(text(requestBytes(requests[0])), "onetwo");
    assert.equal(new Headers(requests[0].headers).get("content-type"), "application/x-www-form-urlencoded");
    assert.deepEqual(requestBytes(requests[1]), new Uint8Array([0, 1, 10, 255]));
    assert.equal(new Headers(requests[1].headers).get("content-type"), "application/x-www-form-urlencoded");
    assert.equal(text(requestBytes(requests[2])), '{"value":true}');
    assert.equal(new Headers(requests[2].headers).get("content-type"), "custom/type");
    assert.equal(new Headers(requests[2].headers).get("accept"), "application/json");
    assert.equal(new Headers(requests[2].headers).get("x-test"), "one, two");
    assert.equal(text(requestBytes(requests[3])), "a%20b&field=one%0A%00two%0D%0A");
    assert.equal(new Headers(requests[4].headers).get("content-type"), null);
    assert.equal(new Headers(requests[4].headers).get("accept"), null);
    assert.equal(new Headers(requests[4].headers).get("x-empty"), "");
    assert.equal(new Headers(requests[4].headers).get("x-file"), "yes");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("curl reads @- interactively until EOF and rejects multiple stdin consumers", async () => {
  const originalFetch = globalThis.fetch;
  let request: RequestInit | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    request = init;
    return new Response("ok");
  }) as typeof fetch;
  const input = [encoder.encode("first\n"), encoder.encode("second"), null];
  try {
    const result = await runCurlCommand({
      py: pyodide(),
      args: ["curl", "--data-binary", "@-", "https://example.com"],
      cwd: "/home/web",
      readStdin: () => input.shift() ?? null,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(text(requestBytes(request)), "first\nsecond");

    const duplicate = await runCurlCommand({
      py: pyodide(),
      args: ["curl", "-H", "@-", "--data-binary", "@-", "https://example.com"],
      cwd: "/home/web",
      stdin: encoder.encode("value"),
    });
    assert.equal(duplicate.exitCode, 2);
    assert.match(text(duplicate.stderr), /stdin can only be consumed once/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("curl follows redirects only with -L and fails safely on opaque redirects", async () => {
  const originalFetch = globalThis.fetch;
  const redirects: RequestRedirect[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    redirects.push(init?.redirect ?? "follow");
    return init?.redirect === "follow"
      ? new Response("FINAL", { status: 200 })
      : new Response("REDIRECT", { status: 302, headers: { Location: "/final" } });
  }) as typeof fetch;
  try {
    const base = { py: pyodide(), cwd: "/home/web" };
    const initial = await runCurlCommand({ ...base, args: ["curl", "-i", "https://example.com/start"] });
    const followed = await runCurlCommand({ ...base, args: ["curl", "-Li", "https://example.com/start"] });
    assert.deepEqual(redirects, ["manual", "follow"]);
    assert.match(text(initial.stdout), /^HTTP\/\? 302/);
    assert.match(text(initial.stdout), /REDIRECT$/);
    assert.match(text(followed.stdout), /^HTTP\/\? 200/);
    assert.match(text(followed.stdout), /FINAL$/);

    globalThis.fetch = (async () => {
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, "type", { value: "opaqueredirect" });
      return response;
    }) as typeof fetch;
    const opaque = await runCurlCommand({ ...base, args: ["curl", "https://other.example/start"] });
    assert.equal(opaque.exitCode, 47);
    assert.match(text(opaque.stderr), /rerun with -L/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("curl streams exact binary output, exposed headers, remote names, and write-out", async () => {
  const fs = new MemoryFs();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array([0, 1, 2, 255]), {
    status: 201,
    statusText: "Created",
    headers: { "Content-Type": "application/octet-stream", "X-Test": "yes" },
  })) as typeof fetch;
  try {
    const result = await runCurlCommand({
      py: pyodide(fs),
      args: [
        "curl", "-D", "headers.txt", "-o", "body.bin", "-w",
        "%{http_code}|%{size_download}|%{method}|%header{x-test}|%{bogus}\\n",
        "https://example.com/file",
      ],
      cwd: "/home/web",
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(fs.files.get("/home/web/body.bin"), new Uint8Array([0, 1, 2, 255]));
    assert.match(text(fs.files.get("/home/web/headers.txt")), /^HTTP\/\? 201 Created\r\n/);
    assert.equal(text(result.stdout), "201|4|GET|yes|\n");
    assert.match(text(result.stderr), /unknown --write-out variable: 'bogus'/);

    const remote = await runCurlCommand({
      py: pyodide(fs),
      args: ["curl", "-O", "https://example.com/a%20b"],
      cwd: "/home/web",
    });
    assert.equal(remote.exitCode, 0);
    assert.ok(fs.files.has("/home/web/a%20b"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("curl supports /dev/null and maps file failures to curl read/write codes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("body")) as typeof fetch;
  try {
    const fs = new MemoryFs();
    fs.writeFile("/home/web/write-out.txt", "%{http_code}:%{size_download}");
    const discarded = await runCurlCommand({
      py: pyodide(fs),
      args: [
        "curl", "-D", "/dev/null", "-o", "/dev/null", "-w", "@write-out.txt",
        "https://example.com",
      ],
      cwd: "/home/web",
    });
    assert.equal(discarded.exitCode, 0);
    assert.equal(text(discarded.stdout), "200:4");
    assert.equal(fs.files.has("/dev/null"), false);

    const outputFailure = await runCurlCommand({
      py: pyodide(fs),
      args: ["curl", "-o", "missing/file", "https://example.com"],
      cwd: "/home/web",
    });
    assert.equal(outputFailure.exitCode, 23);

    const inputFailure = await runCurlCommand({
      py: pyodide(fs),
      args: ["curl", "-d", "@missing", "https://example.com"],
      cwd: "/home/web",
    });
    assert.equal(inputFailure.exitCode, 26);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("curl emits HEAD headers and implements HTTP failure modes", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("MISSING", {
    status: 404,
    statusText: "Not Found",
    headers: { "X-Test": "yes" },
  })) as typeof fetch;
  try {
    const base = { py: pyodide(), cwd: "/home/web" };
    const head = await runCurlCommand({ ...base, args: ["curl", "-I", "https://example.com/missing"] });
    assert.equal(head.exitCode, 0);
    assert.match(text(head.stdout), /^HTTP\/\? 404 Not Found\r\n/);

    const failed = await runCurlCommand({ ...base, args: ["curl", "--fail", "https://example.com/missing"] });
    assert.equal(failed.exitCode, 22);
    assert.equal(failed.stdout?.byteLength, 0);
    assert.match(text(failed.stderr), /HTTP 404 Not Found/);

    const withBody = await runCurlCommand({ ...base, args: ["curl", "--fail-with-body", "https://example.com/missing"] });
    assert.equal(withBody.exitCode, 22);
    assert.equal(text(withBody.stdout), "MISSING");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("curl distinguishes URL, protocol, forbidden-header, and response-limit errors", async () => {
  const malformed = await runCurlCommand({ py: pyodide(), args: ["curl", "http://[bad"], cwd: "/home/web" });
  const protocol = await runCurlCommand({ py: pyodide(), args: ["curl", "ftp://example.com"], cwd: "/home/web" });
  const forbidden = await runCurlCommand({
    py: pyodide(),
    args: ["curl", "-H", "User-Agent: hidden", "https://example.com"],
    cwd: "/home/web",
  });
  assert.equal(malformed.exitCode, 3);
  assert.equal(protocol.exitCode, 1);
  assert.equal(forbidden.exitCode, 2);
  assert.match(text(forbidden.stderr), /browser controls request header/);

  const oversizedQuery = await runCurlCommand({
    py: pyodide(),
    args: ["curl", "-G", "--data-binary", "@-", "https://example.com"],
    cwd: "/home/web",
    stdin: new Uint8Array(400_000),
  });
  assert.equal(oversizedQuery.exitCode, 63);
  assert.match(text(oversizedQuery.stderr), /URL query exceeds/);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, {
    status: 200,
    headers: { "Content-Length": String(32 * 1024 * 1024 + 1) },
  })) as typeof fetch;
  try {
    const limited = await runCurlCommand({
      py: pyodide(),
      args: ["curl", "https://example.com/large"],
      cwd: "/home/web",
    });
    assert.equal(limited.exitCode, 63);
    assert.match(text(limited.stderr), /32 MiB limit/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("curl aborts the whole transfer at --max-time", async () => {
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
      py: pyodide(),
      args: ["curl", "--max-time", "0.001", "https://example.com/slow"],
      cwd: "/home/web",
    });
    assert.equal(result.exitCode, 28);
    assert.match(text(result.stderr), /operation timed out/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
