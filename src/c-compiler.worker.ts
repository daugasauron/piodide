/**
 * Compiler worker: runs clang / wasm-ld (themselves WASI programs) on the
 * shared WASI host. The user workspace is bridged live from the main thread
 * over the RPC SharedArrayBuffer; the sysroot is a local MemoryFs overlay.
 */
import { RpcFsClient } from "./wasi/rpc.ts";
import { runToolchain, type ToolchainOperation } from "./wasi/toolchain.ts";

export interface ToolchainWorkerInit {
  operation: ToolchainOperation;
  toolchain: WebAssembly.Module;
  sysrootTar: ArrayBuffer;
  rpcBuffer: SharedArrayBuffer;
}

export interface ToolchainWorkerResult {
  ok: boolean;
  exitCode: number;
  diagnostics: string;
  error?: string;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<ToolchainWorkerInit>) => void) | null;
  postMessage(message: ToolchainWorkerResult): void;
}

const workerScope = globalThis as unknown as WorkerScope;

workerScope.onmessage = (event) => {
  const init = event.data;
  void (async () => {
    try {
      const fs = new RpcFsClient(init.rpcBuffer);
      const result = await runToolchain(init.operation, fs, {
        toolchain: init.toolchain,
        sysrootTar: init.sysrootTar,
      });
      const ok = result.exitCode === 0;
      workerScope.postMessage({
        ok,
        exitCode: result.exitCode,
        diagnostics: result.diagnostics,
        ...(ok
          ? {}
          : {
              error: `${init.operation.operation === "compile" ? "Clang" : "wasm-ld"} exited with status ${result.exitCode}.`,
            }),
      });
    } catch (error) {
      workerScope.postMessage({
        ok: false,
        exitCode: -1,
        diagnostics: "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};
