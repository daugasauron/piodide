import WasiWorker from "./wasi-runtime.worker.ts?worker";
import type { WorkspaceFile } from "./wasm-workspace.ts";

const RUN_TIMEOUT_MS = 30_000;

export interface WasiRunRequest {
  executablePath: string;
  args: string[];
  stdin: string;
  env: Record<string, string>;
  workspace: WorkspaceFile[];
}

export interface WasiRunResponse {
  ok: boolean;
  exitCode?: number;
  output: string;
  outputTruncated: boolean;
  files?: WorkspaceFile[];
  directories?: string[];
  error?: string;
}

export interface WasiRunResult {
  exitCode: number;
  output: string;
  outputTruncated: boolean;
  files: WorkspaceFile[];
  directories: string[];
}

/** Run one WASI command in a disposable, time-bounded browser worker. */
export function runWasi(
  request: WasiRunRequest,
  signal?: AbortSignal,
): Promise<WasiRunResult> {
  return new Promise((resolve, reject) => {
    const worker = new WasiWorker();
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      callback();
    };
    const abort = () => finish(() => reject(new Error("WASI execution was cancelled.")));
    const timeout = window.setTimeout(
      () => finish(() => reject(new Error("WASI execution exceeded the 30 second limit."))),
      RUN_TIMEOUT_MS,
    );

    worker.onmessage = (event: MessageEvent<WasiRunResponse>) => {
      const response = event.data;
      finish(() => {
        if (
          response.ok &&
          response.exitCode !== undefined &&
          response.files &&
          response.directories
        ) {
          resolve({
            exitCode: response.exitCode,
            output: response.output,
            outputTruncated: response.outputTruncated,
            files: response.files,
            directories: response.directories,
          });
        } else {
          reject(new Error(response.error || "WASI execution failed."));
        }
      });
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || "The WASI runtime worker crashed.")));
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
