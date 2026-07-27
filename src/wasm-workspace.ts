import type { Pyodide } from "./pyodide-host.ts";
import { fsExists, fsIsDir } from "./pyodide-host.ts";

export const WASM_WORKSPACE_ROOT = "/home/web";
const MAX_WORKSPACE_FILES = 2_000;
const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024;

export interface WorkspaceFile {
  path: string;
  content: Uint8Array;
}

export interface WorkspaceSnapshot {
  files: WorkspaceFile[];
  bytes: number;
}

export interface WorkspaceSyncResult {
  written: number;
  deleted: number;
}

export function isWasmWorkspacePath(path: string): boolean {
  return path.startsWith(`${WASM_WORKSPACE_ROOT}/`);
}

/**
 * Copy the user workspace into transferable buffers. Emscripten MEMFS cannot
 * be mounted directly across worker boundaries, so this bounded snapshot is
 * the bridge. Always copy Pyodide views: transferring one directly could
 * detach its WebAssembly heap.
 */
export function snapshotWasmWorkspace(
  py: Pyodide,
  excludedPaths: ReadonlySet<string> = new Set(),
): WorkspaceSnapshot {
  const files: WorkspaceFile[] = [];
  const pending = [WASM_WORKSPACE_ROOT];
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
          throw new Error(`WASM workspace does not support directory symlinks: ${path}`);
        }
      } else if (py.FS.isDir(linkStat.mode)) {
        pending.push(path);
        continue;
      }

      const content = new Uint8Array(py.FS.readFile(path) as Uint8Array);
      bytes += content.byteLength;
      validateWorkspaceSize(files.length + 1, bytes);
      files.push({ path, content });
    }
  }

  return { files, bytes };
}

/** Apply files changed by a WASI program back to the Pyodide workspace. */
export function syncWasmWorkspace(
  py: Pyodide,
  originalPaths: readonly string[],
  files: WorkspaceFile[],
  directories: readonly string[],
): WorkspaceSyncResult {
  let bytes = 0;
  const finalPaths = new Set<string>();
  for (const file of files) {
    if (!isWasmWorkspacePath(file.path)) {
      throw new Error(`WASI returned a file outside /home/web: ${file.path}`);
    }
    if (finalPaths.has(file.path)) throw new Error(`WASI returned duplicate file: ${file.path}`);
    finalPaths.add(file.path);
    bytes += file.content.byteLength;
    validateWorkspaceSize(finalPaths.size, bytes);
  }

  for (const directory of directories) {
    if (directory !== WASM_WORKSPACE_ROOT && !isWasmWorkspacePath(directory)) {
      throw new Error(`WASI returned a directory outside /home/web: ${directory}`);
    }
    py.FS.mkdirTree(directory);
  }

  let deleted = 0;
  for (const path of originalPaths) {
    if (!finalPaths.has(path) && fsExists(py, path) && !fsIsDir(py, path)) {
      py.FS.unlink(path);
      deleted++;
    }
  }

  let written = 0;
  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    if (slash > 0) py.FS.mkdirTree(file.path.slice(0, slash));
    if (fileMatches(py, file)) continue;
    py.FS.writeFile(file.path, file.content);
    written++;
  }
  return { written, deleted };
}

function fileMatches(py: Pyodide, file: WorkspaceFile): boolean {
  if (!fsExists(py, file.path) || fsIsDir(py, file.path)) return false;
  const current = py.FS.readFile(file.path) as Uint8Array;
  if (current.byteLength !== file.content.byteLength) return false;
  for (let i = 0; i < current.byteLength; i++) {
    if (current[i] !== file.content[i]) return false;
  }
  return true;
}

function validateWorkspaceSize(files: number, bytes: number): void {
  if (files > MAX_WORKSPACE_FILES) {
    throw new Error(`WASM workspace exceeds the ${MAX_WORKSPACE_FILES}-file POC limit.`);
  }
  if (bytes > MAX_WORKSPACE_BYTES) {
    throw new Error(
      `WASM workspace exceeds the ${MAX_WORKSPACE_BYTES / 1024 / 1024} MiB POC limit.`,
    );
  }
}
