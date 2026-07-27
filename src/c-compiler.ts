import CompilerWorker from "./c-compiler.worker.ts?worker";
import type { Pyodide } from "./pyodide-host.ts";

const COMPILE_TIMEOUT_MS = 180_000;
const WORKSPACE_ROOT = "/home/web";
const MAX_WORKSPACE_FILES = 2_000;
const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024;

export interface CompilerFile {
  path: string;
  content: Uint8Array;
}

export interface CompileRequest {
  sourcePath: string;
  outputPath: string;
  workspace: CompilerFile[];
}

export interface CompileResponse {
  ok: boolean;
  output?: CompilerFile;
  diagnostics: string;
  error?: string;
}

export interface CompileCResult {
  output: CompilerFile;
  diagnostics: string;
}

export interface WorkspaceSnapshot {
  files: CompilerFile[];
  bytes: number;
}

/**
 * Compile in a disposable worker. Discarding the worker after each call keeps
 * Clang's large linear memories out of the long-lived Pyodide page heap.
 */
export function compileC(
  request: CompileRequest,
  signal?: AbortSignal,
): Promise<CompileCResult> {
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
        if (response.ok && response.output) {
          resolve({ output: response.output, diagnostics: response.diagnostics });
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
    worker.postMessage(
      request,
      request.workspace.map((file) => file.content.buffer as ArrayBuffer),
    );
  });
}

/**
 * Copy the user workspace into transferable buffers for the compiler worker.
 * Emscripten MEMFS cannot be mounted directly across worker boundaries, so
 * this bounded snapshot is the filesystem bridge. Never transfer the views
 * returned by Pyodide directly: doing so could detach its WebAssembly heap.
 */
export function snapshotCompilerWorkspace(
  py: Pyodide,
  excludedPaths: ReadonlySet<string> = new Set(),
): WorkspaceSnapshot {
  const files: CompilerFile[] = [];
  const pending = [WORKSPACE_ROOT];
  let bytes = 0;

  while (pending.length > 0) {
    const directory = pending.pop()!;
    const names = py.FS
      .readdir(directory)
      .filter((name) => name !== "." && name !== "..")
      .sort()
      .reverse();

    for (const name of names) {
      const path = `${directory}/${name}`.replaceAll("//", "/");
      if (excludedPaths.has(path)) continue;

      const linkStat = py.FS.lstat(path);
      if (py.FS.isLink?.(linkStat.mode)) {
        const targetStat = py.FS.stat(path);
        if (py.FS.isDir(targetStat.mode)) {
          throw new Error(`Compiler workspace does not support directory symlinks: ${path}`);
        }
      } else if (py.FS.isDir(linkStat.mode)) {
        pending.push(path);
        continue;
      }

      const content = new Uint8Array(py.FS.readFile(path) as Uint8Array);
      bytes += content.byteLength;
      if (files.length + 1 > MAX_WORKSPACE_FILES) {
        throw new Error(`Compiler workspace exceeds the ${MAX_WORKSPACE_FILES}-file POC limit.`);
      }
      if (bytes > MAX_WORKSPACE_BYTES) {
        throw new Error(
          `Compiler workspace exceeds the ${MAX_WORKSPACE_BYTES / 1024 / 1024} MiB POC limit.`,
        );
      }
      files.push({ path, content });
    }
  }

  return { files, bytes };
}
