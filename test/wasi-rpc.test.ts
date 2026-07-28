/**
 * Full-stack test: WASI guest in a Node worker thread, filesystem served by
 * a MemoryFs on the "main" thread over SharedArrayBuffer — the same path the
 * browser uses in cross-origin-isolated mode, with EmscriptenFs swapped for
 * MemoryFs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MemoryFs } from "../src/wasi/memory-fs.ts";
import { serveWasiFsRpc } from "../src/wasi/rpc.ts";
import type { WasiWorkerInit, WasiWorkerMessage } from "../src/wasi/worker-runner.ts";
import { fixtureBinary } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));

interface RpcRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runOverRpc(
  fs: MemoryFs,
  name: string,
  options: {
    args?: string[];
    env?: Record<string, string>;
    stdin?: () => Uint8Array | null | Promise<Uint8Array | null>;
  } = {},
): Promise<RpcRunResult> {
  const rpcBuffer = new SharedArrayBuffer(2 * 1024 * 1024);
  const server = serveWasiFsRpc({ fs, buffer: rpcBuffer, stdin: options.stdin });
  const worker = new Worker(new URL(join(here, "rpc-worker.ts"), import.meta.url));
  try {
    const binary = fixtureBinary(name);
    const init: WasiWorkerInit = {
      binary: binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength) as ArrayBuffer,
      args: options.args ?? [name],
      env: options.env ?? {},
      preopens: ["/home/web", "/"],
      rpcBuffer,
    };
    const decoder = new TextDecoder();
    let stdout = "";
    let stderr = "";
    const exitCode = await new Promise<number>((resolve, reject) => {
      worker.on("message", (message: WasiWorkerMessage) => {
        if (message.type === "stdout") stdout += decoder.decode(message.chunk, { stream: true });
        else if (message.type === "stderr") stderr += decoder.decode(message.chunk, { stream: true });
        else if (message.type === "result") resolve(message.exitCode);
        else if (message.type === "error") reject(new Error(message.error));
      });
      worker.on("error", reject);
      worker.postMessage(init);
    });
    return { exitCode, stdout, stderr };
  } finally {
    server.stop();
    await worker.terminate();
  }
}

test("rpc stack: cat reads and writes through the bridge", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  fs.writeFile("/home/web/input.txt", "bridged content\n");
  const run = await runOverRpc(fs, "cat.wasm", { args: ["cat.wasm", "/home/web/input.txt"] });
  assert.equal(run.exitCode, 0);
  assert.equal(run.stdout, "bridged content\n");
});

test("rpc stack: guest writes land in the server filesystem", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  const binary = fixtureBinary("fops.wasm");
  void binary;
  const run = await runOverRpc(fs, "fops.wasm");
  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /rmdir: ok\n/);
  // fops cleans up after itself; the base directory must be gone again.
  assert.equal(fs.exists("/home/web/fops"), false);
});

test("rpc stack: stdin is pulled from the server side", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  let calls = 0;
  const chunks = ["first chunk\n", "second chunk\n"];
  const run = await runOverRpc(fs, "cat.wasm", {
    stdin: () => {
      if (calls < chunks.length) {
        const text = chunks[calls++];
        return new TextEncoder().encode(text);
      }
      return null;
    },
  });
  assert.equal(run.exitCode, 0);
  assert.equal(run.stdout, "first chunk\nsecond chunk\n");
  assert.ok(calls >= 2, `expected the server stdin to be pulled, got ${calls} calls`);
});

test("rpc stack: delayed (async) stdin resolves the parked worker", { timeout: 20_000 }, async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  let sent = false;
  const run = await runOverRpc(fs, "cat.wasm", {
    stdin: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve(sent ? null : new TextEncoder().encode("late input\n"));
          sent = true;
        }, 50);
      }),
  });
  assert.equal(run.exitCode, 0);
  assert.equal(run.stdout, "late input\n");
});
