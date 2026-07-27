import CompilerWorker from "./c-compiler.worker.ts?worker";
import type { WorkspaceFile } from "./wasm-workspace.ts";

const TOOLCHAIN_TIMEOUT_MS = 180_000;

export type ToolchainRequest =
  | {
      operation: "compile";
      sourcePath: string;
      outputPath: string;
      workspace: WorkspaceFile[];
    }
  | {
      operation: "link";
      objectPaths: string[];
      outputPath: string;
      workspace: WorkspaceFile[];
    };

export interface ToolchainResponse {
  ok: boolean;
  output?: WorkspaceFile;
  diagnostics: string;
  error?: string;
}

export interface ToolchainResult {
  output: WorkspaceFile;
  diagnostics: string;
}

/**
 * Run Clang or wasm-ld in a disposable worker. Discarding the worker after
 * each call keeps their large linear memories out of the long-lived page.
 */
export function runToolchain(
  request: ToolchainRequest,
  signal?: AbortSignal,
): Promise<ToolchainResult> {
  return new Promise((resolve, reject) => {
    const worker = new CompilerWorker();
    const action = request.operation === "compile" ? "C compilation" : "WASI linking";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      callback();
    };
    const abort = () => finish(() => reject(new Error(`${action} was cancelled.`)));
    const timeout = window.setTimeout(
      () => finish(() => reject(new Error(`${action} timed out.`))),
      TOOLCHAIN_TIMEOUT_MS,
    );

    worker.onmessage = (event: MessageEvent<ToolchainResponse>) => {
      const response = event.data;
      finish(() => {
        if (response.ok && response.output) {
          resolve({ output: response.output, diagnostics: response.diagnostics });
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
    worker.postMessage(
      request,
      request.workspace.map((file) => file.content.buffer as ArrayBuffer),
    );
  });
}
