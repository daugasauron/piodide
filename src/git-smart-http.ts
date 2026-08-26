/** Browser-compatible Git smart-HTTP transport over the shared Pyodide FS. */
import "./git-buffer.ts";
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";

import type { Pyodide, PyodideFSStat } from "./pyodide-host.ts";
import type { GitHubCredentials } from "./git-remote.ts";
import {
  gitIndexForIsomorphicGit,
  preserveGitIndexIntentToAdd,
} from "./git-index-compat.ts";
import {
  forgetEmscriptenSymlinkTarget,
  preserveEmscriptenSymlinkTarget,
  preservedEmscriptenSymlinkTarget,
} from "./wasi/emscripten-fs.ts";

const decoder = new TextDecoder();

type NodeFs = Parameters<typeof git.clone>[0]["fs"];

function errorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const existing = (error as { code?: unknown }).code;
    if (typeof existing === "string") return existing;
    const errno = (error as { errno?: unknown }).errno;
    if (errno === 44) return "ENOENT";
    if (errno === 20) return "EEXIST";
    if (errno === 54) return "ENOTDIR";
    if (errno === 31) return "EISDIR";
    if (errno === 55) return "ENOTEMPTY";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/no such file|not found/i.test(message)) return "ENOENT";
  if (/exist/i.test(message)) return "EEXIST";
  if (/not a directory/i.test(message)) return "ENOTDIR";
  if (/is a directory/i.test(message)) return "EISDIR";
  if (/not empty/i.test(message)) return "ENOTEMPTY";
  return "EIO";
}

function translated(error: unknown): Error & { code: string; errno?: number } {
  const value = error instanceof Error ? error : new Error(String(error));
  const target = value as Error & { code: string; errno?: number };
  target.code = errorCode(error);
  if (error && typeof error === "object" && typeof (error as { errno?: unknown }).errno === "number") {
    target.errno = (error as { errno: number }).errno;
  }
  return target;
}

function call<T>(operation: () => T): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(translated(error));
  }
}

async function asyncCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw translated(error);
  }
}

function millis(value: number | Date): number {
  return value instanceof Date ? value.getTime() : Number(value);
}

/**
 * Emscripten MEMFS resolves symlink targets to absolute paths internally. Node
 * filesystems (and Git) expect readlink to return the link text instead. Turn
 * an in-workspace absolute target back into a path relative to the link's
 * parent. This preserves portable Git symlinks across add/checkout/status.
 */
export function gitSymlinkTarget(linkPath: string, target: string): string {
  if (!target.startsWith("/")) return target;
  const parent = linkPath.slice(0, linkPath.lastIndexOf("/")) || "/";
  const from = parent.split("/").filter(Boolean);
  const to = target.split("/").filter(Boolean);
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common++;
  return [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/") || ".";
}

function stats(py: Pyodide, value: PyodideFSStat, symbolicLink: boolean) {
  const fs = py.FS;
  return {
    ...value,
    atimeMs: millis(value.atime),
    mtimeMs: millis(value.mtime),
    ctimeMs: millis(value.ctime),
    birthtimeMs: millis(value.ctime),
    atime: new Date(millis(value.atime)),
    mtime: new Date(millis(value.mtime)),
    ctime: new Date(millis(value.ctime)),
    birthtime: new Date(millis(value.ctime)),
    isFile: () => !fs.isDir(value.mode) && !symbolicLink,
    isDirectory: () => fs.isDir(value.mode),
    isSymbolicLink: () => symbolicLink,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

interface IsomorphicGitFsOptions {
  hideIntentToAdd?: boolean;
}

function isGitIndexBytes(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x44 && bytes[1] === 0x49 &&
    bytes[2] === 0x52 && bytes[3] === 0x43;
}

/** Adapt Emscripten MEMFS to the small Node fs.promises surface isomorphic-git uses. */
export function createIsomorphicGitFs(
  py: Pyodide,
  options: IsomorphicGitFsOptions = {},
): NodeFs {
  const fs = py.FS;
  const promises = {
    readFile: (path: string, readOptions?: unknown) => asyncCall(async () => {
      const value = fs.readFile(path);
      let bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      if (isGitIndexBytes(bytes)) {
        bytes = await gitIndexForIsomorphicGit(bytes, options.hideIntentToAdd);
      }
      const encoding = typeof readOptions === "string"
        ? readOptions
        : (readOptions as { encoding?: string } | undefined)?.encoding;
      return encoding ? decoder.decode(bytes) : bytes;
    }),
    writeFile: (path: string, data: string | Uint8Array, writeOptions?: unknown) => asyncCall(async () => {
      let payload = typeof data === "string" ? new TextEncoder().encode(data) : data;
      if (isGitIndexBytes(payload)) {
        let current: Uint8Array | undefined;
        if (fs.analyzePath(path).exists) {
          const value = fs.readFile(path);
          const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
          if (isGitIndexBytes(bytes)) current = bytes;
        }
        payload = await preserveGitIndexIntentToAdd(current, payload);
      }
      fs.writeFile(path, payload);
      const mode = typeof writeOptions === "object" && writeOptions
        ? (writeOptions as { mode?: number }).mode
        : undefined;
      if (mode !== undefined) fs.chmod(path, mode);
    }),
    unlink: (path: string) => call(() => {
      forgetEmscriptenSymlinkTarget(fs, path);
      fs.unlink(path);
    }),
    readdir: (path: string) => call(() => fs.readdir(path).filter(
      (name) => name !== "." && name !== "..",
    )),
    mkdir: (path: string, options?: unknown) => call(() => {
      const recursive = typeof options === "object" && options
        ? Boolean((options as { recursive?: boolean }).recursive)
        : false;
      if (recursive) fs.mkdirTree(path);
      else fs.mkdir(path);
    }),
    rmdir: (path: string) => call(() => fs.rmdir(path)),
    stat: (path: string) => call(() => stats(py, fs.stat(path), false)),
    lstat: (path: string) => call(() => {
      const value = fs.lstat(path);
      return stats(py, value, Boolean(fs.isLink?.(value.mode)));
    }),
    readlink: (path: string) => call(() =>
      preservedEmscriptenSymlinkTarget(fs, path) ?? gitSymlinkTarget(path, fs.readlink(path))),
    symlink: (target: string, path: string) => call(() => {
      fs.symlink(target, path);
      preserveEmscriptenSymlinkTarget(fs, path, target);
    }),
    chmod: (path: string, mode: number) => call(() => fs.chmod(path, mode)),
    rename: (from: string, to: string) => call(() => fs.rename(from, to)),
  };
  return { promises } as unknown as NodeFs;
}

export interface SmartHttpOptions {
  py: Pyodide;
  dir?: string;
  url?: string;
  remote?: string;
  ref?: string;
  remoteRef?: string;
  corsProxy?: string;
  singleBranch?: boolean;
  depth?: number;
  prune?: boolean;
  pruneTags?: boolean;
  credentials?: GitHubCredentials | null;
  signal?: AbortSignal;
}

function auth(options: SmartHttpOptions) {
  const credentials = options.credentials;
  if (!credentials || options.corsProxy || !options.url) return undefined;
  let target: URL;
  let api: URL;
  try {
    target = new URL(options.url);
    api = new URL(credentials.apiBaseUrl);
  } catch {
    return undefined;
  }
  const allowedHost = api.hostname.toLowerCase() === "api.github.com"
    ? "github.com"
    : api.hostname.toLowerCase();
  if (target.protocol !== "https:" || target.hostname.toLowerCase() !== allowedHost) return undefined;
  return () => ({ username: credentials.login, password: credentials.token });
}

function transport(options: SmartHttpOptions) {
  return {
    fs: createIsomorphicGitFs(options.py),
    http,
    corsProxy: options.corsProxy,
    onAuth: auth(options),
  };
}

export async function smartClone(options: SmartHttpOptions & { dir: string; url: string }): Promise<void> {
  await git.clone({
    ...transport(options),
    dir: options.dir,
    url: options.url,
    ref: options.ref,
    singleBranch: options.singleBranch ?? false,
    depth: options.depth,
  });
}

export async function smartFetch(options: SmartHttpOptions & { dir: string }): Promise<void> {
  await git.fetch({
    ...transport(options),
    dir: options.dir,
    url: options.url,
    remote: options.remote || "origin",
    ref: options.ref,
    remoteRef: options.remoteRef,
    prune: options.prune,
    pruneTags: options.pruneTags,
  });
}

export async function smartPull(
  options: SmartHttpOptions & { dir: string },
  author: { name: string; email: string },
): Promise<void> {
  await git.pull({
    ...transport(options),
    dir: options.dir,
    url: options.url,
    remote: options.remote || "origin",
    ref: options.ref,
    remoteRef: options.remoteRef,
    author,
  });
}

export async function smartPush(options: SmartHttpOptions & { dir: string }) {
  return git.push({
    ...transport(options),
    dir: options.dir,
    url: options.url,
    remote: options.remote || "origin",
    ref: options.ref,
    remoteRef: options.remoteRef,
  });
}

export async function smartListServerRefs(options: SmartHttpOptions & { url: string }) {
  return git.listServerRefs({
    http,
    url: options.url,
    corsProxy: options.corsProxy,
    onAuth: auth(options),
    symrefs: true,
    peelTags: true,
  });
}

export { git as isomorphicGit };
