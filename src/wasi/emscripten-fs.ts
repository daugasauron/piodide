/**
 * Live bridge: `WasiFs` backed directly by Pyodide's Emscripten MEMFS.
 *
 * No copying, no snapshots — a WASI program reads and writes the exact same
 * files Python and the editor see, while it runs. The interface below is a
 * structural subset of Emscripten's FS API so this module stays unit-free
 * of the Pyodide loader.
 */
import {
  ERRNO,
  FILETYPE,
  WasiError,
  type Errno,
  type Filetype,
  type WasiStat,
} from "./abi.ts";
import type { WasiDirEntry, WasiFs, WasiHandle, WasiOpenOptions } from "./fs.ts";

/** Structural subset of the Emscripten FS API used by the bridge. */
export interface EmscriptenLikeFs {
  open(path: string, flags: string, mode?: number): EmscriptenStream;
  close(stream: EmscriptenStream): void;
  read(
    stream: EmscriptenStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position?: number,
  ): number;
  write(
    stream: EmscriptenStream,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position?: number,
  ): number;
  stat(path: string, dontFollow?: boolean): EmscriptenStat;
  lstat(path: string): EmscriptenStat;
  readdir(path: string): string[];
  mkdir(path: string, mode?: number): void;
  rmdir(path: string): void;
  unlink(path: string): void;
  rename(oldPath: string, newPath: string): void;
  link?(oldPath: string, newPath: string): void;
  symlink(target: string, path: string): void;
  readlink(path: string): string;
  truncate(path: string, length: number): void;
  utime(path: string, atime: number, mtime: number): void;
  analyzePath(path: string): { exists: boolean };
  isDir(mode: number): boolean;
  isFile?(mode: number): boolean;
  isLink?(mode: number): boolean;
}

export type EmscriptenStream = unknown;

export interface EmscriptenStat {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
  atime: number | Date;
  mtime: number | Date;
  ctime: number | Date;
}

const S_IFMT = 0o170000;
const S_IFSOCK = 0o140000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
const S_IFBLK = 0o060000;
const S_IFDIR = 0o040000;
const S_IFCHR = 0o020000;
const S_IFIFO = 0o010000;

/** Emscripten (Linux-ish) errno → WASI errno. */
const EMSCRIPTEN_ERRNO_MAP: Record<number, Errno> = {
  1: ERRNO.PERM,
  2: ERRNO.NOENT,
  4: ERRNO.INTR,
  5: ERRNO.IO,
  6: ERRNO.NXIO,
  9: ERRNO.BADF,
  10: ERRNO.CHILD,
  11: ERRNO.AGAIN,
  12: ERRNO.NOMEM,
  13: ERRNO.ACCES,
  16: ERRNO.BUSY,
  17: ERRNO.EXIST,
  18: ERRNO.XDEV,
  19: ERRNO.NODEV,
  20: ERRNO.NOTDIR,
  21: ERRNO.ISDIR,
  22: ERRNO.INVAL,
  23: ERRNO.NFILE,
  24: ERRNO.MFILE,
  25: ERRNO.NOTTY,
  26: ERRNO.TXTBSY,
  27: ERRNO.FBIG,
  28: ERRNO.NOSPC,
  29: ERRNO.SPIPE,
  30: ERRNO.ROFS,
  31: ERRNO.MLINK,
  32: ERRNO.PIPE,
  33: ERRNO.DOM,
  34: ERRNO.RANGE,
  36: ERRNO.NAMETOOLONG,
  39: ERRNO.NOTEMPTY,
  40: ERRNO.LOOP,
  42: ERRNO.NOMSG,
  95: ERRNO.NOTSUP,
};

/** Convert a thrown Emscripten FS.ErrnoError into a WasiError. */
export function rethrowAsWasiError(error: unknown, context: string): never {
  const errno = (error as { errno?: number }).errno;
  if (typeof errno === "number") {
    const mapped = EMSCRIPTEN_ERRNO_MAP[errno] ?? ERRNO.IO;
    const message = error instanceof Error ? error.message : String(error);
    throw new WasiError(mapped, `${context}: ${message}`);
  }
  throw error;
}

interface EmscriptenHandle {
  stream: EmscriptenStream | null;
  path: string;
  isDir: boolean;
  canRead: boolean;
  canWrite: boolean;
}

function toNs(value: number | Date): bigint {
  const ms = value instanceof Date ? value.getTime() : value;
  return BigInt(Math.trunc(ms)) * 1_000_000n;
}

function toMs(ns: bigint): number {
  return Number(ns / 1_000_000n);
}

export class EmscriptenFs implements WasiFs {
  private fs: EmscriptenLikeFs;

  constructor(fs: EmscriptenLikeFs) {
    this.fs = fs;
  }

  private filetypeOf(mode: number): Filetype {
    const kind = mode & S_IFMT;
    switch (kind) {
      case S_IFDIR:
        return FILETYPE.DIRECTORY;
      case S_IFREG:
        return FILETYPE.REGULAR_FILE;
      case S_IFLNK:
        return FILETYPE.SYMBOLIC_LINK;
      case S_IFCHR:
        return FILETYPE.CHARACTER_DEVICE;
      case S_IFBLK:
        return FILETYPE.BLOCK_DEVICE;
      case S_IFSOCK:
        return FILETYPE.SOCKET_STREAM;
      case S_IFIFO:
        return FILETYPE.UNKNOWN;
      default:
        return FILETYPE.UNKNOWN;
    }
  }

  private statOf(stat: EmscriptenStat): WasiStat {
    return {
      dev: BigInt(stat.dev ?? 0),
      ino: BigInt(stat.ino ?? 0),
      filetype: this.filetypeOf(stat.mode),
      nlink: BigInt(stat.nlink ?? 1),
      size: BigInt(stat.size ?? 0),
      atim: toNs(stat.atime),
      mtim: toNs(stat.mtime),
      ctim: toNs(stat.ctime),
    };
  }

  open(path: string, options: WasiOpenOptions, mode: number): WasiHandle {
    try {
      const exists = this.fs.analyzePath(path).exists;
      if (exists) {
        if (options.create && options.createExcl) {
          throw new WasiError(ERRNO.EXIST, `file exists: ${path}`);
        }
        const lst = this.fs.lstat(path);
        const isLink = this.fs.isLink?.(lst.mode) ?? false;
        if (isLink && !options.followSymlinks) {
          throw new WasiError(ERRNO.LOOP, `symlink with O_NOFOLLOW: ${path}`);
        }
        const st = isLink ? this.fs.stat(path) : lst;
        const isDir = this.fs.isDir(st.mode);
        if (options.directory && !isDir) {
          throw new WasiError(ERRNO.NOTDIR, `not a directory: ${path}`);
        }
        if (isDir && options.write) {
          throw new WasiError(ERRNO.ISDIR, `is a directory: ${path}`);
        }
        if (isDir || options.directory) {
          // Directories need no stream: reads come from readdir(path).
          return { stream: null, path, isDir: true, canRead: false, canWrite: false };
        }
        if (options.truncate) {
          if (!options.write) throw new WasiError(ERRNO.ACCES, `O_TRUNC without write`);
          this.fs.truncate(path, 0);
        }
      } else {
        if (!options.create) throw new WasiError(ERRNO.NOENT, `no such file: ${path}`);
        if (options.directory) throw new WasiError(ERRNO.NOENT, `no such directory: ${path}`);
        // Create an empty file, then fall through to the standard open.
        const created = this.fs.open(path, "w", mode);
        this.fs.close(created);
      }

      // Append must exist (POSIX O_APPEND without O_CREAT fails on missing).
      if (options.append && !exists && !options.create) {
        throw new WasiError(ERRNO.NOENT, `no such file: ${path}`);
      }

      const flags = options.read && options.write ? "r+" : options.read ? "r" : "r+";
      const stream = this.fs.open(path, flags, mode);
      return {
        stream,
        path,
        isDir: false,
        canRead: options.read,
        canWrite: options.write,
      };
    } catch (error) {
      if (error instanceof WasiError) throw error;
      rethrowAsWasiError(error, `open ${path}`);
    }
  }

  close(handle: WasiHandle): void {
    const h = handle as EmscriptenHandle;
    if (h.stream !== null) {
      try {
        this.fs.close(h.stream);
      } catch (error) {
        rethrowAsWasiError(error, `close ${h.path}`);
      }
      h.stream = null;
    }
  }

  read(handle: WasiHandle, position: bigint | null, length: number): Uint8Array {
    const h = handle as EmscriptenHandle;
    if (h.isDir || h.stream === null) throw new WasiError(ERRNO.ISDIR, `read on directory`);
    if (!h.canRead) throw new WasiError(ERRNO.BADF, `handle not open for reading`);
    const buffer = new Uint8Array(length);
    try {
      const read =
        position === null
          ? this.fs.read(h.stream, buffer, 0, length)
          : this.fs.read(h.stream, buffer, 0, length, Number(position));
      return buffer.subarray(0, read);
    } catch (error) {
      rethrowAsWasiError(error, `read ${h.path}`);
    }
  }

  write(handle: WasiHandle, position: bigint | null, data: Uint8Array): number {
    const h = handle as EmscriptenHandle;
    if (h.isDir || h.stream === null) throw new WasiError(ERRNO.ISDIR, `write on directory`);
    if (!h.canWrite) throw new WasiError(ERRNO.BADF, `handle not open for writing`);
    try {
      return position === null
        ? this.fs.write(h.stream, data, 0, data.byteLength)
        : this.fs.write(h.stream, data, 0, data.byteLength, Number(position));
    } catch (error) {
      rethrowAsWasiError(error, `write ${h.path}`);
    }
  }

  size(handle: WasiHandle): bigint {
    const h = handle as EmscriptenHandle;
    try {
      return BigInt(this.fs.stat(h.path).size);
    } catch (error) {
      rethrowAsWasiError(error, `size ${h.path}`);
    }
  }

  sync(_handle: WasiHandle): void {
    // MEMFS is memory: nothing to flush.
  }

  stat(path: string, followSymlinks: boolean): WasiStat {
    try {
      const stat = followSymlinks ? this.fs.stat(path) : this.fs.lstat(path);
      return this.statOf(stat);
    } catch (error) {
      rethrowAsWasiError(error, `stat ${path}`);
    }
  }

  readdir(path: string): WasiDirEntry[] {
    try {
      const names = this.fs.readdir(path).filter((name) => name !== "." && name !== "..");
      return names.map((name) => {
        const childPath = path === "/" ? `/${name}` : `${path}/${name}`;
        let stat: EmscriptenStat;
        try {
          stat = this.fs.lstat(childPath);
        } catch {
          return { name, filetype: FILETYPE.UNKNOWN, ino: 0n };
        }
        return { name, filetype: this.filetypeOf(stat.mode), ino: BigInt(stat.ino ?? 0) };
      });
    } catch (error) {
      rethrowAsWasiError(error, `readdir ${path}`);
    }
  }

  mkdir(path: string, mode: number): void {
    try {
      this.fs.mkdir(path, mode);
    } catch (error) {
      rethrowAsWasiError(error, `mkdir ${path}`);
    }
  }

  rmdir(path: string): void {
    try {
      this.fs.rmdir(path);
    } catch (error) {
      rethrowAsWasiError(error, `rmdir ${path}`);
    }
  }

  unlink(path: string): void {
    try {
      this.fs.unlink(path);
    } catch (error) {
      rethrowAsWasiError(error, `unlink ${path}`);
    }
  }

  rename(from: string, to: string): void {
    try {
      this.fs.rename(from, to);
    } catch (error) {
      rethrowAsWasiError(error, `rename ${from}`);
    }
  }

  link(existing: string, path: string): void {
    if (!this.fs.link) throw new WasiError(ERRNO.NOTSUP, "hard links unsupported");
    try {
      this.fs.link(existing, path);
    } catch (error) {
      rethrowAsWasiError(error, `link ${existing}`);
    }
  }

  symlink(target: string, path: string): void {
    try {
      this.fs.symlink(target, path);
    } catch (error) {
      rethrowAsWasiError(error, `symlink ${path}`);
    }
  }

  readlink(path: string): string {
    try {
      return this.fs.readlink(path);
    } catch (error) {
      rethrowAsWasiError(error, `readlink ${path}`);
    }
  }

  truncate(path: string, size: bigint): void {
    try {
      this.fs.truncate(path, Number(size));
    } catch (error) {
      rethrowAsWasiError(error, `truncate ${path}`);
    }
  }

  utimes(path: string, atim: bigint | null, mtim: bigint | null): void {
    try {
      const current = this.fs.stat(path);
      const atime = atim === null ? current.atime : toMs(atim);
      const mtime = mtim === null ? current.mtime : toMs(mtim);
      this.fs.utime(path, atime as number, mtime as number);
    } catch (error) {
      rethrowAsWasiError(error, `utimes ${path}`);
    }
  }
}
