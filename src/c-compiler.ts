/**
 * Main-thread orchestration for the in-browser C toolchain.
 *
 * Worker mode (cross-origin isolated): clang/wasm-ld run in a disposable
 * worker and reach the live Pyodide MEMFS over the RPC bridge — compiled
 * objects land directly in /home/web, no snapshotting. Main-thread fallback
 * (no SharedArrayBuffer): the same code runs synchronously against the live
 * MEMFS; the tab is blocked for the duration but no files are copied either.
 */
import CompilerWorker from "./c-compiler.worker.ts?worker";
import type { ToolchainWorkerInit, ToolchainWorkerResult } from "./c-compiler.worker.ts";
import type { Pyodide } from "./pyodide-host.ts";
import { EmscriptenFs } from "./wasi/emscripten-fs.ts";
import { serveWasiFsRpc } from "./wasi/rpc.ts";
import {
  getSysrootTarBytes,
  getToolchainModule,
  runToolchain,
  type ToolchainOperation,
} from "./wasi/toolchain.ts";
import { supportsWorkerWasi } from "./wasi/browser-runner.ts";

const TOOLCHAIN_TIMEOUT_MS = 180_000;
const RPC_BUFFER_BYTES = 4 * 1024 * 1024;

export type { ToolchainOperation } from "./wasi/toolchain.ts";

export interface ToolchainResult {
  diagnostics: string;
}

export async function runToolchainInBrowser(
  py: Pyodide,
  operation: ToolchainOperation,
  signal?: AbortSignal,
): Promise<ToolchainResult> {
  const moduleName = operation.operation === "compile" ? "clang.wasm" : "wasm-ld.wasm";
  const [toolchain, sysrootTar] = await Promise.all([
    getToolchainModule(moduleName),
    getSysrootTarBytes(),
  ]);

  if (!supportsWorkerWasi()) {
    const result = await runToolchain(operation, new EmscriptenFs(py.FS), {
      toolchain,
      sysrootTar,
    });
    if (result.exitCode !== 0) {
      const name = operation.operation === "compile" ? "Clang" : "wasm-ld";
      throw new Error(
        [`${name} exited with status ${result.exitCode}.`, result.diagnostics]
          .filter(Boolean)
          .join("\n"),
      );
    }
    return { diagnostics: result.diagnostics };
  }

  return runInWorker(py, operation, toolchain, sysrootTar, signal);
}

function runInWorker(
  py: Pyodide,
  operation: ToolchainOperation,
  toolchain: WebAssembly.Module,
  sysrootTar: ArrayBuffer,
  signal?: AbortSignal,
): Promise<ToolchainResult> {
  return new Promise((resolve, reject) => {
    const action = operation.operation === "compile" ? "C compilation" : "WASI linking";
    const rpcBuffer = new SharedArrayBuffer(RPC_BUFFER_BYTES);
    const server = serveWasiFsRpc({
      fs: new EmscriptenFs(py.FS),
      buffer: rpcBuffer,
    });
    const worker = new CompilerWorker();
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      server.stop();
      worker.terminate();
      callback();
    };
    const abort = () => finish(() => reject(new Error(`${action} was cancelled.`)));
    const timeout = window.setTimeout(
      () => finish(() => reject(new Error(`${action} timed out.`))),
      TOOLCHAIN_TIMEOUT_MS,
    );

    worker.onmessage = (event: MessageEvent<ToolchainWorkerResult>) => {
      const response = event.data;
      finish(() => {
        if (response.ok) {
          resolve({ diagnostics: response.diagnostics });
        } else {
          const message = [response.error, response.diagnostics].filter(Boolean).join("\n");
          reject(new Error(message || `${action} failed.`));
        }
      });
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || "The WASI toolchain worker crashed.")));
    };

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    const init: ToolchainWorkerInit = {
      operation,
      toolchain,
      // Copy the sysroot tar so the main-thread cache survives the transfer.
      sysrootTar: sysrootTar.slice(0),
      rpcBuffer,
    };
    worker.postMessage(init);
  });
}
