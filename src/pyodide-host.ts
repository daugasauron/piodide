/**
 * Pyodide host: a single in-browser Python runtime + the Emscripten MEMFS
 * that every tool (python / read / write / edit) shares. Nothing here ever
 * touches the host machine — all files live in pyodide's WASM filesystem.
 */

export const PYODIDE_VERSION = "v0.27.7";
export const PYODIDE_INDEX = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;

// Minimal surface we use from pyodide. We keep it loose to avoid depending on
// the (heavy) @types for the whole runtime.
export interface PyodideFSStat {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
  atime: number | Date;
  mtime: number | Date;
  ctime: number | Date;
}

export interface PyodideFS {
  writeFile(path: string, data: string | Uint8Array, opts?: { encoding?: string }): void;
  readFile(path: string, opts?: { encoding?: string }): string | Uint8Array;
  mkdirTree(path: string): void;
  readdir(path: string): string[];
  stat(path: string, dontFollow?: boolean): PyodideFSStat;
  lstat(path: string): PyodideFSStat;
  unlink(path: string): void;
  rmdir(path: string): void;
  chmod(path: string, mode: number): void;
  symlink(target: string, path: string): void;
  readlink(path: string): string;
  analyzePath(path: string): { exists: boolean };
  isDir(mode: number): boolean;
  isLink?(mode: number): boolean;
  chdir(path: string): void;
  // Extended Emscripten surface used by the WASI filesystem bridge.
  open(path: string, flags: string, mode?: number): unknown;
  close(stream: unknown): void;
  read(stream: unknown, buffer: Uint8Array, offset: number, length: number, position?: number): number;
  write(stream: unknown, buffer: Uint8Array, offset: number, length: number, position?: number): number;
  mkdir(path: string, mode?: number): void;
  rename(oldPath: string, newPath: string): void;
  link?(oldPath: string, newPath: string): void;
  truncate(path: string, length: number): void;
  /** Not present in all Emscripten builds. */
  utime?(path: string, atime: number, mtime: number): void;
}

export interface Pyodide {
  runPythonAsync(code: string): Promise<unknown>;
  runPython(code: string): unknown;
  loadPackage(names: string | string[]): Promise<unknown>;
  registerJsModule(name: string, module: Record<string, unknown>): void;
  FS: PyodideFS;
  setStdout(opts: { batched?: (s: string) => void }): void;
  setStderr(opts: { batched?: (s: string) => void }): void;
  version: string;
  /** Emscripten runtime internals used only for lightweight heap telemetry. */
  _module?: {
    HEAP8?: Int8Array;
    getHeapMax?: () => number;
    _emscripten_get_heap_size?: () => number;
  };
}

let pyodidePromise: Promise<Pyodide> | null = null;

/** Per-call capture target for stdout/stderr. Set right before runPythonAsync. */
let activeCapture: { push: (s: string) => void } | null = null;

/** Load the pyodide.js bootstrap script from the CDN (once). */
function loadBootstrap(): Promise<void> {
  return new Promise((resolve, reject) => {
    const g = globalThis as unknown as { loadPyodide?: unknown };
    if (typeof g.loadPyodide === "function") return resolve();
    const s = document.createElement("script");
    s.src = `${PYODIDE_INDEX}pyodide.js`;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${s.src}`));
    document.head.appendChild(s);
  });
}

/** Load (and memoize) the pyodide runtime. `onProgress` gets status strings. */
export async function loadPyodideRuntime(onProgress?: (msg: string) => void): Promise<Pyodide> {
  if (pyodidePromise) return pyodidePromise;
  pyodidePromise = (async () => {
    onProgress?.("Downloading Python runtime (WASM)…");
    await loadBootstrap();
    onProgress?.("Booting CPython…");
    const load = (globalThis as unknown as {
      loadPyodide: (o: { indexURL: string }) => Promise<Pyodide>;
    }).loadPyodide;
    const py = await load({ indexURL: PYODIDE_INDEX });

    // Make `import micropip` available so the python tool can install pure-Python
    // wheels from PyPI at runtime.
    onProgress?.("Loading micropip…");
    await py.loadPackage("micropip");

    // Route stdout/stderr through whatever capture is currently active.
    // Idle output (none, in practice) is dropped.
    // Pyodide's batched callbacks contain one logical line without its newline.
    py.setStdout({ batched: (s: string) => activeCapture?.push(`${s}\n`) });
    py.setStderr({ batched: (s: string) => activeCapture?.push(`${s}\n`) });

    // A project directory so paths feel natural.
    py.FS.mkdirTree("/home/web");
    py.FS.chdir("/home/web");
    // Emscripten creates this empty placeholder home. The app consistently
    // uses /home/web, so remove it instead of exposing a misleading directory.
    try {
      const entries = py.FS
        .readdir("/home/web_user")
        .filter((name) => name !== "." && name !== "..");
      if (entries.length === 0) py.FS.rmdir("/home/web_user");
    } catch {
      // Some Pyodide builds do not create it.
    }
    return py;
  })();
  return pyodidePromise;
}

export interface RunResult {
  /** combined stdout+stderr captured during the run */
  output: string;
}

export interface WasmHeapUsage {
  allocated: number;
  limit: number;
  percent: number;
}

/**
 * Report allocated Pyodide linear memory against its wasm32 ceiling. This is
 * committed WASM heap capacity, not an object-by-object Python memory profile.
 */
export function getWasmHeapUsage(py: Pyodide): WasmHeapUsage | null {
  const module = py._module;
  if (!module) return null;

  const allocated = module._emscripten_get_heap_size?.() ?? module.HEAP8?.byteLength;
  const limit = module.getHeapMax?.() ?? 0xffff0000;
  if (!allocated || !Number.isFinite(allocated) || !Number.isFinite(limit) || limit <= 0) {
    return null;
  }
  return { allocated, limit, percent: (allocated / limit) * 100 };
}

export function formatWasmHeapUsage(py: Pyodide): string {
  const usage = getWasmHeapUsage(py);
  if (!usage) return "unavailable";
  const percent =
    usage.percent < 10 ? usage.percent.toFixed(1) : Math.round(usage.percent).toString();
  const limitGiB = Math.round(usage.limit / 1024 ** 3);
  return `${percent}%/${limitGiB}GB`;
}

/**
 * Run Python code, capturing stdout/stderr. `onChunk` is called with output
 * fragments as they are flushed (for live streaming into the terminal).
 */
export async function runPythonCapture(
  py: Pyodide,
  code: string,
  onChunk?: (s: string) => void,
): Promise<RunResult> {
  const chunks: string[] = [];
  const prev = activeCapture;
  activeCapture = {
    push: (s: string) => {
      chunks.push(s);
      onChunk?.(s);
    },
  };
  try {
    await py.runPythonAsync(code);
    return { output: chunks.join("") };
  } finally {
    activeCapture = prev;
  }
}

/* ------------------------------------------------------------------ */
/* Filesystem helpers (pyodide MEMFS) — shared by read/write/edit.     */
/* ------------------------------------------------------------------ */

export function fsReadText(py: Pyodide, path: string): string {
  return py.FS.readFile(path, { encoding: "utf8" }) as string;
}

export function fsWriteText(py: Pyodide, path: string, content: string): void {
  const slash = path.lastIndexOf("/");
  if (slash > 0) py.FS.mkdirTree(path.slice(0, slash));
  py.FS.writeFile(path, content, { encoding: "utf8" });
}

export function fsExists(py: Pyodide, path: string): boolean {
  try {
    return py.FS.analyzePath(path).exists;
  } catch {
    return false;
  }
}

export function fsIsDir(py: Pyodide, path: string): boolean {
  try {
    return py.FS.isDir(py.FS.stat(path).mode);
  } catch {
    return false;
  }
}

/** Normalize a possibly-relative path against the current working directory. */
export function fsResolve(py: Pyodide, path: string): string {
  if (path.startsWith("/")) return path;
  const cwd = py.runPython("import os; os.getcwd()") as string;
  const parts = (cwd + "/" + path).split("/");
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") stack.pop();
    else stack.push(p);
  }
  return "/" + stack.join("/");
}
