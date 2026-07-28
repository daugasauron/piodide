/**
 * The synchronous filesystem interface the WASI host runs against.
 *
 * The host owns the guest fd table (positions, flags, preopens); a backend
 * only needs to answer plain filesystem questions. Two production backends
 * exist: `EmscriptenFs` (live Pyodide MEMFS, main thread) and `RpcFsClient`
 * (same MEMFS, reached from a worker over SharedArrayBuffer). `MemoryFs`
 * serves tests and the compiler sysroot.
 *
 * All methods throw `WasiError` (or anything `errnoOf` understands) on
 * failure; returning normally means success. All paths passed to a backend
 * are absolute and normalized. All I/O is explicitly positioned: the host
 * tracks each fd's offset, so backends never need per-handle state beyond
 * what `open` returns. Position `null` means "use and advance the handle's
 * own position" and is only used for the append/stdio cases.
 */
import type { Filetype, WasiStat } from "./abi.ts";

export interface WasiFs {
  /**
   * Open `path` and return an opaque handle (fd-independent; the host maps
   * guest fds onto handles). `mode` is the POSIX creation mode (advisory).
   */
  open(path: string, options: WasiOpenOptions, mode: number): WasiHandle;

  close(handle: WasiHandle): void;

  /**
   * Read up to `length` bytes at `position` (or the handle position when
   * null) into a fresh Uint8Array. Short reads mean EOF.
   */
  read(handle: WasiHandle, position: bigint | null, length: number): Uint8Array;

  /**
   * Write `data` at `position` (or the handle position when null).
   * Returns the number of bytes written.
   */
  write(handle: WasiHandle, position: bigint | null, data: Uint8Array): number;

  /** Current size of the file behind `handle`. */
  size(handle: WasiHandle): bigint;

  /** stat/lstat. `followSymlinks` false ≈ lstat. */
  stat(path: string, followSymlinks: boolean): WasiStat;

  /** Directory entries excluding "." and "..", in readdir order. */
  readdir(path: string): WasiDirEntry[];

  mkdir(path: string, mode: number): void;
  /** Remove an empty directory. */
  rmdir(path: string): void;
  /** Remove a file or symlink. */
  unlink(path: string): void;
  rename(from: string, to: string): void;
  /** Create a hard link `path` referring to `existing`. */
  link(existing: string, path: string): void;
  symlink(target: string, path: string): void;
  readlink(path: string): string;
  /** Resize a file (fd-less; the host knows the path). */
  truncate(path: string, size: bigint): void;
  /** Set times in nanoseconds; null leaves that time untouched. */
  utimes(path: string, atim: bigint | null, mtim: bigint | null): void;
  /** Flush data (no-op for memory-backed filesystems). */
  sync(handle: WasiHandle): void;
}

export type WasiHandle = unknown;

export interface WasiOpenOptions {
  read: boolean;
  write: boolean;
  create: boolean;
  createExcl: boolean;
  truncate: boolean;
  append: boolean;
  directory: boolean;
  followSymlinks: boolean;
}

export interface WasiDirEntry {
  name: string;
  filetype: Filetype;
  ino: bigint;
}

/* ------------------------------------------------------------------------ */
/* Prefix router: mount one fs under a path prefix onto another.            */
/* Used to overlay the compiler sysroot (/sys) onto the live workspace.     */
/* ------------------------------------------------------------------------ */

export interface WasiFsMount {
  /** Absolute mount prefix, e.g. "/sys". Matched on whole segments. */
  prefix: string;
  fs: WasiFs;
}

export class RoutedFs implements WasiFs {
  private mounts: WasiFsMount[];
  private root: WasiFs;

  constructor(root: WasiFs, mounts: WasiFsMount[]) {
    this.root = root;
    // Longest prefix first so nested mounts resolve correctly.
    this.mounts = [...mounts].sort((a, b) => b.prefix.length - a.prefix.length);
  }

  private route(path: string): { fs: WasiFs; path: string } {
    for (const mount of this.mounts) {
      if (path === mount.prefix) return { fs: mount.fs, path: "/" };
      if (path.startsWith(`${mount.prefix}/`)) {
        return { fs: mount.fs, path: path.slice(mount.prefix.length) };
      }
    }
    return { fs: this.root, path };
  }

  open(path: string, options: WasiOpenOptions, mode: number): WasiHandle {
    const routed = this.route(path);
    return { fs: routed.fs, handle: routed.fs.open(routed.path, options, mode) };
  }
  close(handle: WasiHandle): void {
    const h = handle as { fs: WasiFs; handle: WasiHandle };
    h.fs.close(h.handle);
  }
  read(handle: WasiHandle, position: bigint | null, length: number): Uint8Array {
    const h = handle as { fs: WasiFs; handle: WasiHandle };
    return h.fs.read(h.handle, position, length);
  }
  write(handle: WasiHandle, position: bigint | null, data: Uint8Array): number {
    const h = handle as { fs: WasiFs; handle: WasiHandle };
    return h.fs.write(h.handle, position, data);
  }
  size(handle: WasiHandle): bigint {
    const h = handle as { fs: WasiFs; handle: WasiHandle };
    return h.fs.size(h.handle);
  }
  sync(handle: WasiHandle): void {
    const h = handle as { fs: WasiFs; handle: WasiHandle };
    h.fs.sync(h.handle);
  }
  stat(path: string, followSymlinks: boolean): WasiStat {
    const routed = this.route(path);
    return routed.fs.stat(routed.path, followSymlinks);
  }
  readdir(path: string): WasiDirEntry[] {
    const routed = this.route(path);
    return routed.fs.readdir(routed.path);
  }
  mkdir(path: string, mode: number): void {
    const routed = this.route(path);
    routed.fs.mkdir(routed.path, mode);
  }
  rmdir(path: string): void {
    const routed = this.route(path);
    routed.fs.rmdir(routed.path);
  }
  unlink(path: string): void {
    const routed = this.route(path);
    routed.fs.unlink(routed.path);
  }
  rename(from: string, to: string): void {
    const a = this.route(from);
    const b = this.route(to);
    if (a.fs !== b.fs) {
      throw new Error("RoutedFs cannot rename across mounts");
    }
    a.fs.rename(a.path, b.path);
  }
  link(existing: string, path: string): void {
    const a = this.route(existing);
    const b = this.route(path);
    if (a.fs !== b.fs) {
      throw new Error("RoutedFs cannot link across mounts");
    }
    a.fs.link(a.path, b.path);
  }
  symlink(target: string, path: string): void {
    const routed = this.route(path);
    routed.fs.symlink(target, routed.path);
  }
  readlink(path: string): string {
    const routed = this.route(path);
    return routed.fs.readlink(routed.path);
  }
  truncate(path: string, size: bigint): void {
    const routed = this.route(path);
    routed.fs.truncate(routed.path, size);
  }
  utimes(path: string, atim: bigint | null, mtim: bigint | null): void {
    const routed = this.route(path);
    routed.fs.utimes(routed.path, atim, mtim);
  }
}
