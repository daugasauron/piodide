import CompilerWorker from "./c-compiler.worker.ts?worker";

const COMPILE_TIMEOUT_MS = 180_000;

interface CompileResponse {
  ok: boolean;
  wasm?: Uint8Array;
  diagnostics: string;
  error?: string;
}

export interface CompileCResult {
  wasm: Uint8Array;
  diagnostics: string;
}

/**
 * Compile in a disposable worker. Discarding the worker after each call keeps
 * Clang's large linear memories out of the long-lived Pyodide page heap.
 */
export function compileC(source: string, signal?: AbortSignal): Promise<CompileCResult> {
  return new Promise((resolve, reject) => {
    const worker = new CompilerWorker();
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      callback();
    };
    const abort = () => finish(() => reject(new Error("C compilation was cancelled.")));
    const timeout = window.setTimeout(
      () => finish(() => reject(new Error("C compilation timed out."))),
      COMPILE_TIMEOUT_MS,
    );

    worker.onmessage = (event: MessageEvent<CompileResponse>) => {
      const response = event.data;
      finish(() => {
        if (response.ok && response.wasm) {
          resolve({ wasm: response.wasm, diagnostics: response.diagnostics });
        } else {
          const message = [response.error, response.diagnostics].filter(Boolean).join("\n");
          reject(new Error(message || "C compilation failed."));
        }
      });
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || "The C compiler worker crashed.")));
    };

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    worker.postMessage({ source });
  });
}
