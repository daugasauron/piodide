/**
 * Browser-side WASI program orchestration.
 *
 * Two execution strategies share one host implementation:
 *
 * - **worker** (cross-origin isolated, e.g. `npm run dev`): the guest runs in
 *   a disposable worker; every filesystem call and stdin read is bridged to
 *   the live Pyodide MEMFS over a SharedArrayBuffer. Output streams live,
 *   stdin can be fed interactively, and a hung program is killed with
 *   `worker.terminate()`.
 *
 * - **main-thread** (fallback, e.g. GitHub Pages where no COOP/COEP headers
 *   can be set): the guest runs synchronously on the main thread against the
 *   live MEMFS. No timeout is possible and stdin must be pre-fed, but files
 *   are still shared with Python with zero copying.
 */
import WasiWorker from "./runner.worker.ts?worker";
import type { Pyodide } from "../pyodide-host.ts";
import { EmscriptenFs } from "./emscripten-fs.ts";
import { serveWasiFsRpc } from "./rpc.ts";
import { executeWasi } from "./runner.ts";
import type { WasiWorkerInit, WasiWorkerMessage } from "./worker-runner.ts";
import type { WasiRunJs } from "./python-module.ts";
import type { WasiPreopen } from "./host.ts";

const RPC_BUFFER_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_CHARS = 100_000;
const MAX_SPAWN_DEPTH = 4;

export const WASI_PREOPENS: (string | WasiPreopen)[] = ["/home/web", "/"];

export interface WasiProgramRequest {
  executablePath: string;
  /** Arguments without argv[0]. */
  args?: string[];
  env?: Record<string, string>;
  /** Pre-fed stdin (followed by EOF unless `stdinPush` is provided). */
  stdin?: string;
  /**
   * Interactive stdin: when set, the returned controller's `push` feeds the
   * program after any pre-fed `stdin` is consumed. `push(null)` sends EOF.
   */
  interactiveStdin?: boolean;
  /**
   * External stdin provider (e.g. a shell session's shared input buffer).
   * Overrides the internal queue; pull-based, null means EOF.
   */
  stdinProvider?: () => Promise<Uint8Array | null> | Uint8Array | null;
  /** Preopen override (defaults to /home/web + /). */
  preopens?: (string | WasiPreopen)[];
  /**
   * Custom handler for the "piodide" spawn import (shell sessions use this
   * for foreground routing). Default: run the child with inherited output
   * and EOF stdin, up to a bounded nesting depth.
   */
  spawnHandler?: (request: {
    path: string;
    args: string[];
    cwd: string;
    stdinText?: Uint8Array;
    capture?: boolean;
    outFile?: string;
    append?: boolean;
  }) => Promise<{ exitCode: number; stdout?: Uint8Array }>;
  /** Internal: current spawn nesting depth. */
  spawnDepth?: number;
  onStdout?: (text: string) => void;
  /** Raw stdout bytes (takes precedence over onStdout; for pipes/files). */
  onStdoutBytes?: (chunk: Uint8Array) => void;
  onStderr?: (text: string) => void;
  /** Worker mode only; 0 disables. Default 30s. */
  timeoutMs?: number;
}

export interface WasiProgramResult {
  exitCode: number;
}

export interface WasiStdinController {
  push(chunk: Uint8Array | null): void;
  close(): void;
}

export interface WasiProgramHandle {
  result: Promise<WasiProgramResult>;
  stdin: WasiStdinController | null;
  /** Force-stop the program (worker mode: terminate; no-op otherwise). */
  kill(): void;
}

/**
 * JS runner injected into the `wasi` Python module: runs a program with
 * pre-fed stdin and captured (bounded) stdout/stderr.
 */
export function makeJsRunner(py: Pyodide): WasiRunJs {
  return async (path, options) => {
    let stdout = "";
    let stderr = "";
    const cap = (current: string, chunk: string) =>
      current.length >= MAX_CAPTURE_CHARS
        ? current
        : (current + chunk).slice(0, MAX_CAPTURE_CHARS);
    const result = await runWasiProgram(py, {
      executablePath: path,
      args: options?.args ?? [],
      env: options?.env ?? {},
      stdin: options?.stdin ?? "",
      onStdout: (chunk) => {
        stdout = cap(stdout, chunk);
      },
      onStderr: (chunk) => {
        stderr = cap(stderr, chunk);
      },
    });
    return { exitCode: result.exitCode, stdout, stderr };
  };
}

export function supportsWorkerWasi(): boolean {
  return (
    typeof crossOriginIsolated !== "undefined" &&
    crossOriginIsolated &&
    typeof SharedArrayBuffer !== "undefined" &&
    typeof Atomics.waitAsync === "function"
  );
}

export class StdinQueue implements WasiStdinController {
  private queue: (Uint8Array | null)[] = [];
  private waiting: ((chunk: Uint8Array | null) => void)[] = [];
  private eof = false;

  push(chunk: Uint8Array | null): void {
    if (this.eof) return;
    if (chunk === null) {
      this.eof = true;
      const waiters = this.waiting.splice(0);
      for (const resolve of waiters) resolve(null);
      return;
    }
    if (chunk.byteLength === 0) return; // empty chunks are dropped
    if (this.waiting.length > 0) this.waiting.shift()!(chunk);
    else this.queue.push(chunk);
  }

  close(): void {
    this.push(null);
  }

  next(): Promise<Uint8Array | null> | Uint8Array | null {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    if (this.eof) return null;
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

/**
 * Start a WASI program from the Pyodide filesystem. Returns immediately with
 * a result promise, an optional interactive stdin controller, and a kill
 * switch.
 */
export function startWasiProgram(
  py: Pyodide,
  request: WasiProgramRequest,
  signal?: AbortSignal,
): WasiProgramHandle {
  if (signal?.aborted) {
    return {
      result: Promise.reject(new Error("WASI execution was cancelled.")),
      stdin: null,
      kill: () => {},
    };
  }
  if (supportsWorkerWasi()) return startInWorker(py, request, signal);
  return startOnMainThread(py, request, signal);
}

/** Convenience wrapper: run to completion with optional pre-fed stdin. */
export async function runWasiProgram(
  py: Pyodide,
  request: WasiProgramRequest,
  signal?: AbortSignal,
): Promise<WasiProgramResult> {
  const handle = startWasiProgram(py, request, signal);
  return handle.result;
}

/* ------------------------------ worker mode ------------------------------ */

function startInWorker(
  py: Pyodide,
  request: WasiProgramRequest,
  signal?: AbortSignal,
): WasiProgramHandle {
  const stdin = new StdinQueue();
  if (request.stdin !== undefined && request.stdin.length > 0) {
    stdin.push(new TextEncoder().encode(request.stdin));
  }
  if (!request.interactiveStdin) stdin.close();
  const stdinNext = request.stdinProvider ?? (() => stdin.next());

  const rpcBuffer = new SharedArrayBuffer(RPC_BUFFER_BYTES);
  const fs = new EmscriptenFs(py.FS);
  const spawnDepth = request.spawnDepth ?? 0;
  const spawn =
    request.spawnHandler ??
    (async ({
      path,
      args,
      cwd,
      stdinText,
      capture,
    }: {
      path: string;
      args: string[];
      cwd: string;
      stdinText?: Uint8Array;
      capture?: boolean;
      outFile?: string;
      append?: boolean;
    }): Promise<{ exitCode: number; stdout?: Uint8Array }> => {
      if (spawnDepth >= MAX_SPAWN_DEPTH) return { exitCode: 126 };
      const captured: Uint8Array[] = [];
      const child = startWasiProgram(py, {
        executablePath: path,
        args: args.slice(1),
        env: { PATH: "/bin", PWD: cwd, ...(request.env ?? {}) },
        preopens: ["/home/web", "/", "/bin"],
        timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        spawnDepth: spawnDepth + 1,
        stdinProvider: stdinText
          ? (() => {
              let sent = false;
              return () => {
                if (sent) return null;
                sent = true;
                return stdinText;
              };
            })()
          : undefined,
        onStdoutBytes: capture ? (chunk) => captured.push(chunk.slice()) : undefined,
        onStdout: capture ? undefined : request.onStdout,
        onStderr: request.onStderr,
      });
      try {
        const result = await child.result;
        if (capture) {
          const total = captured.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          const stdout = new Uint8Array(total);
          let offset = 0;
          for (const chunk of captured) {
            stdout.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return { exitCode: result.exitCode, stdout };
        }
        return { exitCode: result.exitCode };
      } catch {
        return { exitCode: 130 };
      }
    });
  const server = serveWasiFsRpc({
    fs,
    buffer: rpcBuffer,
    stdin: stdinNext,
    spawn,
  });

  const worker = new WasiWorker();
  const decoder = new TextDecoder();
  let kill: () => void = () => {};

  const result = new Promise<WasiProgramResult>((resolve, reject) => {
    let settled = false;
    let timeoutId = 0;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abort);
      server.stop();
      worker.terminate();
      callback();
    };
    const abort = () => finish(() => reject(new Error("WASI execution was cancelled.")));
    kill = () => finish(() => reject(new Error("WASI execution was killed.")));

    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (timeoutMs > 0) {
      timeoutId = window.setTimeout(
        () => finish(() => reject(new Error(`WASI execution exceeded the ${Math.round(timeoutMs / 1000)}s limit.`))),
        timeoutMs,
      );
    }

    worker.onmessage = (event: MessageEvent<WasiWorkerMessage>) => {
      const message = event.data;
      if (message.type === "stdout") {
        if (request.onStdoutBytes) request.onStdoutBytes(message.chunk);
        else request.onStdout?.(decoder.decode(message.chunk, { stream: true }));
        return;
      }
      if (message.type === "stderr") {
        request.onStderr?.(decoder.decode(message.chunk, { stream: true }));
        return;
      }
      if (message.type === "result") {
        finish(() => resolve({ exitCode: message.exitCode }));
        return;
      }
      finish(() => reject(new Error(message.error || "WASI execution failed.")));
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || "The WASI worker crashed.")));
    };

    signal?.addEventListener("abort", abort, { once: true });

    const binary = new Uint8Array(py.FS.readFile(request.executablePath) as Uint8Array);
    const init: WasiWorkerInit = {
      binary: binary.slice().buffer as ArrayBuffer,
      args: [request.executablePath, ...(request.args ?? [])],
      env: { PWD: "/home/web", ...(request.env ?? {}) },
      preopens: request.preopens ?? WASI_PREOPENS,
      rpcBuffer,
      spawnApi: true,
    };
    worker.postMessage(init, [init.binary]);
  });

  return {
    result,
    stdin: request.interactiveStdin && !request.stdinProvider ? stdin : null,
    kill,
  };
}

export type { WasiRunJs } from "./python-module.ts";

/* ---------------------------- main-thread mode --------------------------- */

function startOnMainThread(
  py: Pyodide,
  request: WasiProgramRequest,
  signal?: AbortSignal,
): WasiProgramHandle {
  // Synchronous wasm cannot be preempted on the main thread; deliver stdin
  // from the pre-fed string only.
  const binary = new Uint8Array(py.FS.readFile(request.executablePath) as Uint8Array);
  const stdinText = request.stdin ?? "";
  let stdinSent = stdinText.length === 0;
  const decoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();

  const result = (async () => {
    if (signal?.aborted) throw new Error("WASI execution was cancelled.");
    const { exitCode } = await executeWasi({
      binary: binary.slice(),
      args: [request.executablePath, ...(request.args ?? [])],
      env: { PWD: "/home/web", ...(request.env ?? {}) },
      fs: new EmscriptenFs(py.FS),
      preopens: request.preopens ?? WASI_PREOPENS,
      stdin: () => {
        if (stdinSent) return null;
        stdinSent = true;
        return new TextEncoder().encode(stdinText);
      },
      stdout: (chunk) => request.onStdout?.(decoder.decode(chunk, { stream: true })),
      stderr: (chunk) => request.onStderr?.(stderrDecoder.decode(chunk, { stream: true })),
    });
    return { exitCode };
  })();

  return { result, stdin: null, kill: () => {} };
}
