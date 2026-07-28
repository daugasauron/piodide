/**
 * WASI preview1 host.
 *
 * A from-scratch implementation of the `wasi_snapshot_preview1` import
 * surface (plus the legacy `wasi_unstable` alias) against the pluggable
 * synchronous `WasiFs` interface. It is deliberately runtime-agnostic: the
 * same host drives programs on the browser main thread (direct Pyodide
 * MEMFS bridge), inside a worker (FS proxied over SharedArrayBuffer), and
 * under Node for tests.
 *
 * Coverage target: everything a wasi-libc / Rust std / Zig std command-line
 * program needs — full fd I/O including pread/pwrite, readdir with cookies,
 * the complete path_* family, poll_oneoff (clock + fd), and harmless stubs
 * for sockets.
 */
import {
  CLOCK,
  ERRNO,
  EVENTTYPE,
  FDFLAG,
  FILETYPE,
  FSTFLAG,
  LOOKUPFLAG,
  OFLAG,
  RIGHTS,
  RIGHTS_ALL,
  SUBCLOCKFLAG,
  WasiError,
  errnoOf,
  resolvePath,
  type WasiStat,
} from "./abi.ts";
import type { WasiDirEntry, WasiFs, WasiHandle } from "./fs.ts";

/* ------------------------------- layout ---------------------------------- */

const DIRENT_HEADER_SIZE = 24;
const SUBSCRIPTION_SIZE = 48;
const EVENT_SIZE = 32;
const IOV_SIZE = 8;

const FD_STDIN = 0;
const FD_STDOUT = 1;
const FD_STDERR = 2;

/* ------------------------------- options --------------------------------- */

export interface WasiHostOptions {
  /** Full argv including argv[0]. */
  args?: string[];
  env?: Record<string, string> | string[];
  fs: WasiFs;
  /** Directories exposed to wasi-libc as preopens (fd 3..n), in order. */
  preopens?: string[];
  /**
   * ABI generation: modern "wasi_snapshot_preview1" or legacy snapshot0
   * ("wasi_unstable"). runner.ts auto-detects from the module's imports;
   * the difference that matters is the filestat layout (st_nlink width).
   */
  abiVersion?: "preview1" | "snapshot0";
  /** Pull stdin bytes; return null at EOF. Called only when buffered input ran out. */
  stdin?: () => Uint8Array | null;
  /** stdout/stderr byte sinks (streaming). */
  stdout?: (chunk: Uint8Array) => void;
  stderr?: (chunk: Uint8Array) => void;
  /** Clock overrides (nanoseconds). */
  realtimeNs?: () => bigint;
  monotonicNs?: () => bigint;
  /** Randomness override (defaults to crypto.getRandomValues). */
  random?: (buffer: Uint8Array) => void;
  /** Synchronous sleep in milliseconds (used by poll_oneoff clock waits). */
  sleepSync?: (ms: number) => void;
}

/** Thrown by proc_exit; caught by `WasiHost.start`. */
export class WasiExit {
  readonly code: number;
  constructor(code: number) {
    this.code = code >>> 0;
  }
}

type FdKind = "stdin" | "stdout" | "stderr" | "preopen" | "dir" | "file";

interface FdEntry {
  kind: FdKind;
  /** Absolute path (file/dir/preopen entries). */
  path?: string;
  handle?: WasiHandle;
  rightsBase: bigint;
  rightsInheriting: bigint;
  fdflags: number;
  position: bigint;
  append: boolean;
  /** Lazily captured directory listing for fd_readdir. */
  readdirEntries?: WasiDirEntry[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function defaultRealtimeNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

function defaultMonotonicNs(): bigint {
  return BigInt(Math.round(performance.now() * 1_000_000));
}

function defaultRandom(buffer: Uint8Array): void {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (!cryptoObj?.getRandomValues) {
    throw new WasiError(ERRNO.NOSYS, "crypto.getRandomValues unavailable");
  }
  cryptoObj.getRandomValues(buffer as Uint8Array<ArrayBuffer>);
}

function defaultSleepSync(ms: number): void {
  // In workers (and Node) Atomics.wait on a private buffer parks the thread.
  const sab = new Int32Array(new SharedArrayBuffer(4));
  try {
    Atomics.wait(sab, 0, 0, ms);
    return;
  } catch {
    // Main thread: fall through to the busy wait.
  }
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Busy wait: the only option on a browser main thread.
  }
}

/* --------------------------------- host ---------------------------------- */

export class WasiHost {
  private readonly fs: WasiFs;
  private readonly args: string[];
  private readonly env: string[];
  private readonly argvBuf: Uint8Array;
  private readonly envBuf: Uint8Array;
  private readonly stdinSource?: () => Uint8Array | null;
  private readonly stdoutSink: (chunk: Uint8Array) => void;
  private readonly stderrSink: (chunk: Uint8Array) => void;
  private readonly realtimeNs: () => bigint;
  private readonly monotonicNs: () => bigint;
  private readonly randomFill: (buffer: Uint8Array) => void;
  private readonly sleepSync: (ms: number) => void;
  private readonly abiVersion: "preview1" | "snapshot0";

  private memory: WebAssembly.Memory | null = null;
  private fds = new Map<number, FdEntry>();
  private nextFd = 3;
  private stdinBuffer: Uint8Array = new Uint8Array();

  constructor(options: WasiHostOptions) {
    this.fs = options.fs;
    this.args = options.args ?? [];
    const envPairs = Array.isArray(options.env)
      ? options.env
      : Object.entries(options.env ?? {}).map(([key, value]) => `${key}=${value}`);
    this.env = envPairs;
    this.argvBuf = joinCStrings(this.args);
    this.envBuf = joinCStrings(this.env);
    this.stdinSource = options.stdin;
    this.stdoutSink = options.stdout ?? (() => {});
    this.stderrSink = options.stderr ?? (() => {});
    this.realtimeNs = options.realtimeNs ?? defaultRealtimeNs;
    this.monotonicNs = options.monotonicNs ?? defaultMonotonicNs;
    this.randomFill = options.random ?? defaultRandom;
    this.sleepSync = options.sleepSync ?? defaultSleepSync;
    this.abiVersion = options.abiVersion ?? "preview1";

    this.fds.set(FD_STDIN, stdEntry("stdin", RIGHTS.FD_READ));
    this.fds.set(FD_STDOUT, stdEntry("stdout", RIGHTS.FD_WRITE));
    this.fds.set(FD_STDERR, stdEntry("stderr", RIGHTS.FD_WRITE));
    for (const preopen of options.preopens ?? ["/"]) {
      const fd = this.nextFd++;
      this.fds.set(fd, {
        kind: "preopen",
        path: preopen,
        rightsBase: RIGHTS_ALL,
        rightsInheriting: RIGHTS_ALL,
        fdflags: 0,
        position: 0n,
        append: false,
      });
    }
  }

  /* ------------------------------ memory ------------------------------- */

  private view(): DataView {
    if (!this.memory) throw new Error("WASI memory not set");
    return new DataView(this.memory.buffer);
  }

  private bytes(): Uint8Array {
    if (!this.memory) throw new Error("WASI memory not set");
    return new Uint8Array(this.memory.buffer);
  }

  private readString(pointer: number, length: number): string {
    return decoder.decode(this.bytes().subarray(pointer, pointer + length));
  }

  /* ------------------------------ fd table ------------------------------ */

  private entry(fd: number): FdEntry {
    const found = this.fds.get(fd);
    if (!found) throw new WasiError(ERRNO.BADF, `bad file descriptor ${fd}`);
    return found;
  }

  private allocFd(entry: FdEntry): number {
    const fd = this.nextFd++;
    this.fds.set(fd, entry);
    return fd;
  }

  private closeEntry(entry: FdEntry): void {
    if (entry.handle !== undefined) {
      try {
        this.fs.close(entry.handle);
      } catch {
        // Closing an already-broken handle is not an error path worth
        // surfacing during cleanup.
      }
      entry.handle = undefined;
    }
  }

  /** Resolve a path_* argument against its base fd. */
  private resolveAt(fd: number, pathPointer: number, pathLength: number): string {
    const base = this.entry(fd);
    const relative = this.readString(pathPointer, pathLength);
    if (relative.startsWith("/")) return resolvePath("/", relative);
    if (base.kind !== "dir" && base.kind !== "preopen") {
      throw new WasiError(ERRNO.NOTDIR, "path base is not a directory");
    }
    return resolvePath(base.path ?? "/", relative);
  }

  /* --------------------------- import surface --------------------------- */

  /** The import object for WebAssembly.instantiate. */
  getImportObject(): Record<string, Record<string, WebAssembly.ImportValue>> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imports: Record<string, any> = {
      args_get: this.argsGet.bind(this),
      args_sizes_get: this.argsSizesGet.bind(this),
      environ_get: this.environGet.bind(this),
      environ_sizes_get: this.environSizesGet.bind(this),
      clock_res_get: this.clockResGet.bind(this),
      clock_time_get: this.clockTimeGet.bind(this),
      fd_advise: () => ERRNO.SUCCESS,
      fd_allocate: this.fdAllocate.bind(this),
      fd_close: this.wrap(this.fdClose.bind(this)),
      fd_datasync: this.wrap(this.fdSync.bind(this)),
      fd_fdstat_get: this.wrap(this.fdFdstatGet.bind(this)),
      fd_fdstat_set_flags: this.wrap(this.fdFdstatSetFlags.bind(this)),
      fd_fdstat_set_rights: this.wrap(this.fdFdstatSetRights.bind(this)),
      fd_filestat_get: this.wrap(this.fdFilestatGet.bind(this)),
      fd_filestat_set_size: this.wrap(this.fdFilestatSetSize.bind(this)),
      fd_filestat_set_times: this.wrap(this.fdFilestatSetTimes.bind(this)),
      fd_pread: this.wrap(this.fdPread.bind(this)),
      fd_prestat_get: this.wrap(this.fdPrestatGet.bind(this)),
      fd_prestat_dir_name: this.wrap(this.fdPrestatDirName.bind(this)),
      fd_pwrite: this.wrap(this.fdPwrite.bind(this)),
      fd_read: this.wrap(this.fdRead.bind(this)),
      fd_readdir: this.wrap(this.fdReaddir.bind(this)),
      fd_renumber: this.wrap(this.fdRenumber.bind(this)),
      fd_seek: this.wrap(this.fdSeek.bind(this)),
      fd_sync: this.wrap(this.fdSync.bind(this)),
      fd_tell: this.wrap(this.fdTell.bind(this)),
      fd_write: this.wrap(this.fdWrite.bind(this)),
      path_create_directory: this.wrap(this.pathCreateDirectory.bind(this)),
      path_filestat_get: this.wrap(this.pathFilestatGet.bind(this)),
      path_filestat_set_times: this.wrap(this.pathFilestatSetTimes.bind(this)),
      path_link: this.wrap(this.pathLink.bind(this)),
      path_open: this.wrap(this.pathOpen.bind(this)),
      path_readlink: this.wrap(this.pathReadlink.bind(this)),
      path_remove_directory: this.wrap(this.pathRemoveDirectory.bind(this)),
      path_rename: this.wrap(this.pathRename.bind(this)),
      path_symlink: this.wrap(this.pathSymlink.bind(this)),
      path_unlink_file: this.wrap(this.pathUnlinkFile.bind(this)),
      poll_oneoff: this.wrap(this.pollOneoff.bind(this)),
      proc_exit: (code: number) => {
        throw new WasiExit(code);
      },
      proc_raise: (_signal: number) => ERRNO.SUCCESS,
      sched_yield: () => ERRNO.SUCCESS,
      random_get: this.wrap(this.randomGet.bind(this)),
      sock_accept: () => ERRNO.NOTSUP,
      sock_recv: () => ERRNO.NOTSUP,
      sock_send: () => ERRNO.NOTSUP,
      sock_shutdown: () => ERRNO.NOTSUP,
    };
    return {
      wasi_snapshot_preview1: imports,
      wasi_unstable: imports,
    };
  }

  /** Wrap a syscall so thrown WasiErrors become errnos. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wrap<T extends (...args: any[]) => number>(fn: T): T {
    return ((...args: unknown[]) => {
      try {
        return fn(...args);
      } catch (error) {
        if (error instanceof WasiExit) throw error;
        return errnoOf(error);
      }
    }) as T;
  }

  /**
   * Bind the guest memory, call `_start`, and resolve with the exit code.
   * Re-throws guest traps as errors.
   */
  start(instance: WebAssembly.Instance): number {
    const exports = instance.exports as {
      memory?: WebAssembly.Memory;
      _start?: () => void;
      _initialize?: () => void;
    };
    if (!exports.memory) throw new Error("WASI guest does not export memory");
    this.memory = exports.memory;
    try {
      if (exports._start) {
        exports._start();
        return 0;
      }
      if (exports._initialize) {
        // Reactor module: initialize only.
        exports._initialize();
        return 0;
      }
      throw new Error("WASI guest exports neither _start nor _initialize");
    } catch (error) {
      if (error instanceof WasiExit) return error.code;
      throw error;
    } finally {
      for (const entry of this.fds.values()) this.closeEntry(entry);
      this.fds.clear();
    }
  }

  /* --------------------------- args / environ --------------------------- */

  private argsSizesGet(argcPtr: number, argvBufSizePtr: number): number {
    const view = this.view();
    view.setUint32(argcPtr, this.args.length, true);
    view.setUint32(argvBufSizePtr, this.argvBuf.byteLength, true);
    return ERRNO.SUCCESS;
  }

  private argsGet(argvPtr: number, argvBufPtr: number): number {
    return writeCStrings(this.view(), this.args, argvPtr, argvBufPtr);
  }

  private environSizesGet(countPtr: number, bufSizePtr: number): number {
    const view = this.view();
    view.setUint32(countPtr, this.env.length, true);
    view.setUint32(bufSizePtr, this.envBuf.byteLength, true);
    return ERRNO.SUCCESS;
  }

  private environGet(environPtr: number, environBufPtr: number): number {
    return writeCStrings(this.view(), this.env, environPtr, environBufPtr);
  }

  /* -------------------------------- clocks ------------------------------ */

  private clockResGet(clockId: number, resolutionPtr: number): number {
    if (clockId !== CLOCK.REALTIME && clockId !== CLOCK.MONOTONIC) return ERRNO.INVAL;
    this.view().setBigUint64(resolutionPtr, 1_000_000n, true); // 1 ms
    return ERRNO.SUCCESS;
  }

  private clockTimeGet(clockId: number, _precision: bigint, timePtr: number): number {
    const value =
      clockId === CLOCK.REALTIME
        ? this.realtimeNs()
        : clockId === CLOCK.MONOTONIC
          ? this.monotonicNs()
          : null;
    if (value === null) return ERRNO.INVAL;
    this.view().setBigUint64(timePtr, value, true);
    return ERRNO.SUCCESS;
  }

  /* ------------------------------ fd status ----------------------------- */

  private fdFdstatGet(fd: number, bufPtr: number): number {
    const entry = this.entry(fd);
    const view = this.view();
    const filetype =
      entry.kind === "stdin" || entry.kind === "stdout" || entry.kind === "stderr"
        ? FILETYPE.CHARACTER_DEVICE
        : entry.kind === "file"
          ? FILETYPE.REGULAR_FILE
          : FILETYPE.DIRECTORY;
    view.setUint8(bufPtr, filetype);
    view.setUint8(bufPtr + 1, 0);
    view.setUint16(bufPtr + 2, entry.fdflags, true);
    view.setUint32(bufPtr + 4, 0, true);
    view.setBigUint64(bufPtr + 8, entry.rightsBase, true);
    view.setBigUint64(bufPtr + 16, entry.rightsInheriting, true);
    return ERRNO.SUCCESS;
  }

  private fdFdstatSetFlags(fd: number, fdflags: number): number {
    const entry = this.entry(fd);
    entry.fdflags = fdflags & 0xffff;
    entry.append = (fdflags & FDFLAG.APPEND) !== 0;
    return ERRNO.SUCCESS;
  }

  private fdFdstatSetRights(fd: number, rightsBase: bigint, rightsInheriting: bigint): number {
    const entry = this.entry(fd);
    if ((rightsBase | entry.rightsBase) !== entry.rightsBase) return ERRNO.NOTCAPABLE;
    if ((rightsInheriting | entry.rightsInheriting) !== entry.rightsInheriting) {
      return ERRNO.NOTCAPABLE;
    }
    entry.rightsBase = rightsBase;
    entry.rightsInheriting = rightsInheriting;
    return ERRNO.SUCCESS;
  }

  /* ------------------------------ fd stat ------------------------------- */

  private fdFilestatGet(fd: number, bufPtr: number): number {
    const entry = this.entry(fd);
    const stat = this.statEntry(entry);
    this.writeFilestat(bufPtr, stat);
    return ERRNO.SUCCESS;
  }

  private statEntry(entry: FdEntry): WasiStat {
    if (entry.kind === "file" || entry.kind === "dir" || entry.kind === "preopen") {
      return this.fs.stat(entry.path ?? "/", true);
    }
    const now = this.realtimeNs();
    return {
      dev: 0n,
      ino: 0n,
      filetype: FILETYPE.CHARACTER_DEVICE,
      nlink: 1n,
      size: 0n,
      atim: now,
      mtim: now,
      ctim: now,
    };
  }

  private writeFilestat(bufPtr: number, stat: WasiStat): void {
    const view = this.view();
    view.setBigUint64(bufPtr, stat.dev, true);
    view.setBigUint64(bufPtr + 8, stat.ino, true);
    view.setUint8(bufPtr + 16, stat.filetype);
    if (this.abiVersion === "snapshot0") {
      // Legacy wasi_unstable layout: st_nlink is u32, so every field after
      // st_filetype sits 4 bytes earlier than in preview1.
      view.setUint32(bufPtr + 20, Number(stat.nlink & 0xffff_ffffn), true);
      view.setBigUint64(bufPtr + 24, stat.size, true);
      view.setBigUint64(bufPtr + 32, stat.atim, true);
      view.setBigUint64(bufPtr + 40, stat.mtim, true);
      view.setBigUint64(bufPtr + 48, stat.ctim, true);
      return;
    }
    view.setUint8(bufPtr + 17, 0);
    view.setUint32(bufPtr + 20, 0, true);
    view.setBigUint64(bufPtr + 24, stat.nlink, true);
    view.setBigUint64(bufPtr + 32, stat.size, true);
    view.setBigUint64(bufPtr + 40, stat.atim, true);
    view.setBigUint64(bufPtr + 48, stat.mtim, true);
    view.setBigUint64(bufPtr + 56, stat.ctim, true);
  }

  private fdFilestatSetSize(fd: number, size: bigint): number {
    const entry = this.entry(fd);
    if (entry.kind !== "file" || entry.path === undefined) {
      throw new WasiError(ERRNO.BADF, "fd_filestat_set_size on non-file");
    }
    this.fs.truncate(entry.path, size);
    return ERRNO.SUCCESS;
  }

  private fdFilestatSetTimes(fd: number, atim: bigint, mtim: bigint, fstflags: number): number {
    const entry = this.entry(fd);
    if (!entry.path) throw new WasiError(ERRNO.BADF, "fd_filestat_set_times on stdio");
    const times = this.resolveSetTimes(atim, mtim, fstflags);
    this.fs.utimes(entry.path, times.atim, times.mtim);
    return ERRNO.SUCCESS;
  }

  private resolveSetTimes(
    atim: bigint,
    mtim: bigint,
    fstflags: number,
  ): { atim: bigint | null; mtim: bigint | null } {
    const now = this.realtimeNs();
    return {
      atim:
        (fstflags & FSTFLAG.SET_ATIM) !== 0
          ? atim
          : (fstflags & FSTFLAG.SET_ATIM_NOW) !== 0
            ? now
            : null,
      mtim:
        (fstflags & FSTFLAG.SET_MTIM) !== 0
          ? mtim
          : (fstflags & FSTFLAG.SET_MTIM_NOW) !== 0
            ? now
            : null,
    };
  }

  /* ------------------------------- fd I/O ------------------------------- */

  private readIovs(iovsPtr: number, iovsLen: number): { pointer: number; length: number }[] {
    const view = this.view();
    const iovs: { pointer: number; length: number }[] = [];
    for (let i = 0; i < iovsLen; i++) {
      iovs.push({
        pointer: view.getUint32(iovsPtr + i * IOV_SIZE, true),
        length: view.getUint32(iovsPtr + i * IOV_SIZE + 4, true),
      });
    }
    return iovs;
  }

  private fdRead(fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number {
    const entry = this.entry(fd);
    const iovs = this.readIovs(iovsPtr, iovsLen);
    const bytes = this.bytes();
    let total = 0;

    if (entry.kind === "stdin") {
      for (const iov of iovs) {
        let filled = 0;
        while (filled < iov.length) {
          if (this.stdinBuffer.byteLength === 0) {
            const next = this.stdinSource?.() ?? null;
            if (next === null || next.byteLength === 0) break;
            this.stdinBuffer = next;
          }
          const take = Math.min(this.stdinBuffer.byteLength, iov.length - filled);
          bytes.set(this.stdinBuffer.subarray(0, take), iov.pointer + filled);
          this.stdinBuffer = this.stdinBuffer.subarray(take);
          filled += take;
        }
        total += filled;
        if (filled < iov.length) break; // EOF
      }
      this.view().setUint32(nreadPtr, total, true);
      return ERRNO.SUCCESS;
    }

    if (entry.kind !== "file") {
      throw new WasiError(
        entry.kind === "dir" || entry.kind === "preopen" ? ERRNO.ISDIR : ERRNO.BADF,
        "fd_read on non-readable fd",
      );
    }

    for (const iov of iovs) {
      if (iov.length === 0) continue;
      const chunk = this.fs.read(entry.handle, entry.position, iov.length);
      bytes.set(chunk, iov.pointer);
      total += chunk.byteLength;
      entry.position += BigInt(chunk.byteLength);
      if (chunk.byteLength < iov.length) break; // short read = EOF
    }
    this.view().setUint32(nreadPtr, total, true);
    return ERRNO.SUCCESS;
  }

  private fdPread(
    fd: number,
    iovsPtr: number,
    iovsLen: number,
    offset: bigint,
    nreadPtr: number,
  ): number {
    const entry = this.entry(fd);
    if (entry.kind !== "file") throw new WasiError(ERRNO.BADF, "fd_pread on non-file");
    const iovs = this.readIovs(iovsPtr, iovsLen);
    const bytes = this.bytes();
    let total = 0;
    let position = offset;
    for (const iov of iovs) {
      if (iov.length === 0) continue;
      const chunk = this.fs.read(entry.handle, position, iov.length);
      bytes.set(chunk, iov.pointer);
      total += chunk.byteLength;
      position += BigInt(chunk.byteLength);
      if (chunk.byteLength < iov.length) break;
    }
    this.view().setUint32(nreadPtr, total, true);
    return ERRNO.SUCCESS;
  }

  private fdWrite(fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
    const entry = this.entry(fd);
    const iovs = this.readIovs(iovsPtr, iovsLen);
    const bytes = this.bytes();

    if (entry.kind === "stdout" || entry.kind === "stderr") {
      const sink = entry.kind === "stdout" ? this.stdoutSink : this.stderrSink;
      let total = 0;
      for (const iov of iovs) {
        if (iov.length === 0) continue;
        sink(bytes.slice(iov.pointer, iov.pointer + iov.length));
        total += iov.length;
      }
      this.view().setUint32(nwrittenPtr, total, true);
      return ERRNO.SUCCESS;
    }

    if (entry.kind !== "file") {
      throw new WasiError(
        entry.kind === "stdin" ? ERRNO.BADF : ERRNO.ISDIR,
        "fd_write on non-writable fd",
      );
    }

    let total = 0;
    for (const iov of iovs) {
      if (iov.length === 0) continue;
      const position = entry.append ? this.fs.size(entry.handle) : entry.position;
      const chunk = bytes.slice(iov.pointer, iov.pointer + iov.length);
      const written = this.fs.write(entry.handle, position, chunk);
      total += written;
      entry.position = position + BigInt(written);
      if (written < iov.length) break;
    }
    this.view().setUint32(nwrittenPtr, total, true);
    return ERRNO.SUCCESS;
  }

  private fdPwrite(
    fd: number,
    iovsPtr: number,
    iovsLen: number,
    offset: bigint,
    nwrittenPtr: number,
  ): number {
    const entry = this.entry(fd);
    if (entry.kind !== "file") throw new WasiError(ERRNO.BADF, "fd_pwrite on non-file");
    const iovs = this.readIovs(iovsPtr, iovsLen);
    const bytes = this.bytes();
    let total = 0;
    let position = offset;
    for (const iov of iovs) {
      if (iov.length === 0) continue;
      const chunk = bytes.slice(iov.pointer, iov.pointer + iov.length);
      const written = this.fs.write(entry.handle, position, chunk);
      total += written;
      position += BigInt(written);
      if (written < iov.length) break;
    }
    this.view().setUint32(nwrittenPtr, total, true);
    return ERRNO.SUCCESS;
  }

  /* ---------------------------- fd positioning --------------------------- */

  /** snapshot0 numbered whence differently (CUR=0, END=1, SET=2). */
  private mapWhence(whence: number): 0 | 1 | 2 | null {
    if (this.abiVersion === "snapshot0") {
      if (whence === 0) return 1;
      if (whence === 1) return 2;
      if (whence === 2) return 0;
      return null;
    }
    return whence >= 0 && whence <= 2 ? (whence as 0 | 1 | 2) : null;
  }

  private fdSeek(fd: number, offset: bigint, whence: number, newOffsetPtr: number): number {
    const entry = this.entry(fd);
    if (entry.kind !== "file") {
      throw new WasiError(
        entry.kind === "dir" || entry.kind === "preopen" ? ERRNO.NOTDIR : ERRNO.SPIPE,
        "fd_seek on non-seekable fd",
      );
    }
    const mapped = this.mapWhence(whence);
    if (mapped === null) return ERRNO.INVAL;
    let base: bigint;
    if (mapped === 0) base = 0n;
    else if (mapped === 1) base = entry.position;
    else base = this.fs.size(entry.handle);
    const next = base + offset;
    if (next < 0n) return ERRNO.INVAL;
    entry.position = next;
    this.view().setBigUint64(newOffsetPtr, next, true);
    return ERRNO.SUCCESS;
  }

  private fdTell(fd: number, offsetPtr: number): number {
    const entry = this.entry(fd);
    if (entry.kind !== "file") throw new WasiError(ERRNO.SPIPE, "fd_tell on non-file");
    this.view().setBigUint64(offsetPtr, entry.position, true);
    return ERRNO.SUCCESS;
  }

  /* ----------------------------- fd lifecycle ---------------------------- */

  private fdClose(fd: number): number {
    const entry = this.entry(fd);
    this.closeEntry(entry);
    this.fds.delete(fd);
    return ERRNO.SUCCESS;
  }

  private fdSync(fd: number): number {
    const entry = this.entry(fd);
    if (entry.handle !== undefined) this.fs.sync(entry.handle);
    return ERRNO.SUCCESS;
  }

  private fdAllocate(fd: number, offset: bigint, length: bigint): number {
    const entry = this.entry(fd);
    if (entry.kind !== "file") throw new WasiError(ERRNO.BADF, "fd_allocate on non-file");
    const size = this.fs.size(entry.handle);
    if (offset + length > size) this.fs.truncate(entry.path ?? "/", offset + length);
    return ERRNO.SUCCESS;
  }

  private fdRenumber(from: number, to: number): number {
    const entry = this.entry(from);
    if (from === to) return ERRNO.SUCCESS;
    const existing = this.fds.get(to);
    if (existing) this.closeEntry(existing);
    this.fds.set(to, entry);
    this.fds.delete(from);
    return ERRNO.SUCCESS;
  }

  /* ------------------------------- preopen ------------------------------- */

  private fdPrestatGet(fd: number, bufPtr: number): number {
    const entry = this.entry(fd);
    if (entry.kind !== "preopen") throw new WasiError(ERRNO.BADF, "not a preopen fd");
    const view = this.view();
    view.setUint8(bufPtr, 0); // preopen tag
    view.setUint32(bufPtr + 4, encoder.encode(entry.path ?? "/").byteLength, true);
    return ERRNO.SUCCESS;
  }

  private fdPrestatDirName(fd: number, pathPtr: number, pathLength: number): number {
    const entry = this.entry(fd);
    if (entry.kind !== "preopen") throw new WasiError(ERRNO.BADF, "not a preopen fd");
    const encoded = encoder.encode(entry.path ?? "/");
    if (encoded.byteLength > pathLength) return ERRNO.NAMETOOLONG;
    this.bytes().set(encoded, pathPtr);
    return ERRNO.SUCCESS;
  }

  /* ------------------------------- readdir ------------------------------- */

  private fdReaddir(
    fd: number,
    bufPtr: number,
    bufLength: number,
    cookie: bigint,
    sizePtr: number,
  ): number {
    const entry = this.entry(fd);
    if (entry.kind !== "dir" && entry.kind !== "preopen") {
      throw new WasiError(ERRNO.NOTDIR, "fd_readdir on non-directory");
    }
    if (!entry.readdirEntries) {
      const path = entry.path ?? "/";
      const self = this.fs.stat(path, true);
      const parent = this.fs.stat(resolvePath(path, ".."), true);
      entry.readdirEntries = [
        { name: ".", filetype: FILETYPE.DIRECTORY, ino: self.ino },
        { name: "..", filetype: FILETYPE.DIRECTORY, ino: parent.ino },
        ...this.fs.readdir(path),
      ];
    }
    const entries = entry.readdirEntries;
    const view = this.view();
    const bytes = this.bytes();

    let used = 0;
    let index = Number(cookie);
    if (index >= entries.length) {
      // Cookie past the end: no more entries.
      view.setUint32(sizePtr, 0, true);
      return ERRNO.SUCCESS;
    }

    while (index < entries.length) {
      const item = entries[index];
      const name = encoder.encode(item.name);
      if (used + DIRENT_HEADER_SIZE > bufLength) break;
      const headerPtr = bufPtr + used;
      view.setBigUint64(headerPtr, BigInt(index + 1), true); // d_next
      view.setBigUint64(headerPtr + 8, item.ino, true);
      view.setUint32(headerPtr + 16, name.byteLength, true);
      view.setUint8(headerPtr + 20, item.filetype);
      bytes.fill(0, headerPtr + 21, headerPtr + DIRENT_HEADER_SIZE);
      // A name may be truncated to fill the buffer exactly; the next call
      // resumes at d_next (wasmtime allows this partial write too).
      const nameRoom = bufLength - used - DIRENT_HEADER_SIZE;
      const nameBytes = Math.min(name.byteLength, nameRoom);
      bytes.set(name.subarray(0, nameBytes), headerPtr + DIRENT_HEADER_SIZE);
      used += DIRENT_HEADER_SIZE + nameBytes;
      index += 1;
      if (nameBytes < name.byteLength) break;
    }

    view.setUint32(sizePtr, used, true);
    return ERRNO.SUCCESS;
  }

  /* ------------------------------- path open ------------------------------ */

  private pathOpen(
    fd: number,
    _dirflags: number,
    pathPtr: number,
    pathLength: number,
    oflags: number,
    rightsBase: bigint,
    rightsInheriting: bigint,
    fdflags: number,
    resultFdPtr: number,
  ): number {
    const resolved = this.resolveAt(fd, pathPtr, pathLength);
    const wantsRead = (rightsBase & RIGHTS.FD_READ) !== 0n;
    const wantsWrite =
      (rightsBase & (RIGHTS.FD_WRITE | RIGHTS.FD_ALLOCATE | RIGHTS.FD_FILESTAT_SET_SIZE)) !== 0n;
    const isDirectory = (oflags & OFLAG.DIRECTORY) !== 0;

    const handle = this.fs.open(
      resolved,
      {
        read: wantsRead && !isDirectory,
        write: wantsWrite && !isDirectory,
        create: (oflags & OFLAG.CREAT) !== 0,
        createExcl: (oflags & OFLAG.EXCL) !== 0,
        truncate: (oflags & OFLAG.TRUNC) !== 0,
        append: (fdflags & FDFLAG.APPEND) !== 0,
        directory: isDirectory,
        followSymlinks: true,
      },
      0o644,
    );

    const kind: FdKind = isDirectory ? "dir" : "file";
    const newFd = this.allocFd({
      kind,
      path: resolved,
      handle,
      rightsBase,
      rightsInheriting,
      fdflags: fdflags & 0xffff,
      position: 0n,
      append: (fdflags & FDFLAG.APPEND) !== 0,
    });
    this.view().setUint32(resultFdPtr, newFd, true);
    return ERRNO.SUCCESS;
  }

  /* ------------------------------ path stat ------------------------------ */

  private pathFilestatGet(
    fd: number,
    lookupflags: number,
    pathPtr: number,
    pathLength: number,
    bufPtr: number,
  ): number {
    const resolved = this.resolveAt(fd, pathPtr, pathLength);
    const follow = (lookupflags & LOOKUPFLAG.SYMLINK_FOLLOW) !== 0;
    const stat = this.fs.stat(resolved, follow);
    this.writeFilestat(bufPtr, stat);
    return ERRNO.SUCCESS;
  }

  private pathFilestatSetTimes(
    fd: number,
    _lookupflags: number,
    pathPtr: number,
    pathLength: number,
    atim: bigint,
    mtim: bigint,
    fstflags: number,
  ): number {
    const resolved = this.resolveAt(fd, pathPtr, pathLength);
    const times = this.resolveSetTimes(atim, mtim, fstflags);
    this.fs.utimes(resolved, times.atim, times.mtim);
    return ERRNO.SUCCESS;
  }

  /* ------------------------------ path misc ------------------------------ */

  private pathCreateDirectory(fd: number, pathPtr: number, pathLength: number): number {
    const resolved = this.resolveAt(fd, pathPtr, pathLength);
    this.fs.mkdir(resolved, 0o755);
    return ERRNO.SUCCESS;
  }

  private pathRemoveDirectory(fd: number, pathPtr: number, pathLength: number): number {
    const resolved = this.resolveAt(fd, pathPtr, pathLength);
    this.fs.rmdir(resolved);
    return ERRNO.SUCCESS;
  }

  private pathUnlinkFile(fd: number, pathPtr: number, pathLength: number): number {
    const resolved = this.resolveAt(fd, pathPtr, pathLength);
    this.fs.unlink(resolved);
    return ERRNO.SUCCESS;
  }

  private pathRename(
    oldFd: number,
    oldPathPtr: number,
    oldPathLength: number,
    newFd: number,
    newPathPtr: number,
    newPathLength: number,
  ): number {
    const from = this.resolveAt(oldFd, oldPathPtr, oldPathLength);
    const to = this.resolveAt(newFd, newPathPtr, newPathLength);
    this.fs.rename(from, to);
    return ERRNO.SUCCESS;
  }

  private pathLink(
    oldFd: number,
    _oldFlags: number,
    oldPathPtr: number,
    oldPathLength: number,
    newFd: number,
    newPathPtr: number,
    newPathLength: number,
  ): number {
    const from = this.resolveAt(oldFd, oldPathPtr, oldPathLength);
    const to = this.resolveAt(newFd, newPathPtr, newPathLength);
    this.fs.link(from, to);
    return ERRNO.SUCCESS;
  }

  private pathSymlink(
    oldPathPtr: number,
    oldPathLength: number,
    fd: number,
    newPathPtr: number,
    newPathLength: number,
  ): number {
    const target = this.readString(oldPathPtr, oldPathLength);
    const resolved = this.resolveAt(fd, newPathPtr, newPathLength);
    this.fs.symlink(target, resolved);
    return ERRNO.SUCCESS;
  }

  private pathReadlink(
    fd: number,
    pathPtr: number,
    pathLength: number,
    bufPtr: number,
    bufLength: number,
    sizePtr: number,
  ): number {
    const resolved = this.resolveAt(fd, pathPtr, pathLength);
    const target = encoder.encode(this.fs.readlink(resolved));
    const copied = Math.min(target.byteLength, bufLength);
    this.bytes().set(target.subarray(0, copied), bufPtr);
    this.view().setUint32(sizePtr, copied, true);
    return ERRNO.SUCCESS;
  }

  /* ------------------------------ poll_oneoff ----------------------------- */

  private pollOneoff(
    inPtr: number,
    outPtr: number,
    nsubscriptions: number,
    neventsPtr: number,
  ): number {
    if (nsubscriptions === 0) return ERRNO.INVAL;
    const view = this.view();

    interface Subscription {
      userdata: bigint;
      type: number;
      clockId: number;
      timeoutNs: bigint;
      absolute: boolean;
      fd: number;
    }
    const subscriptions: Subscription[] = [];
    for (let i = 0; i < nsubscriptions; i++) {
      const base = inPtr + i * SUBSCRIPTION_SIZE;
      const type = view.getUint8(base + 8);
      subscriptions.push({
        userdata: view.getBigUint64(base, true),
        type,
        clockId: view.getUint32(base + 16, true),
        timeoutNs: view.getBigUint64(base + 24, true),
        absolute: (view.getUint16(base + 40, true) & SUBCLOCKFLAG.ABSTIME) !== 0,
        fd: view.getUint32(base + 16, true),
      });
    }

    const ready = (sub: Subscription): { error: number } | null => {
      if (sub.type === EVENTTYPE.FD_READ || sub.type === EVENTTYPE.FD_WRITE) {
        try {
          const entry = this.entry(sub.fd);
          if (sub.type === EVENTTYPE.FD_READ) {
            const readable =
              entry.kind === "stdin" ||
              entry.kind === "file";
            return readable ? { error: 0 } : { error: ERRNO.BADF };
          }
          const writable =
            entry.kind === "stdout" || entry.kind === "stderr" || entry.kind === "file";
          return writable ? { error: 0 } : { error: ERRNO.BADF };
        } catch (error) {
          return { error: errnoOf(error) };
        }
      }
      return null;
    };

    // Immediate fd events first.
    const events: { index: number; error: number }[] = [];
    let earliestClockMs = Number.POSITIVE_INFINITY;
    let earliestClockIndex = -1;
    const nowMono = this.monotonicNs();
    const nowReal = this.realtimeNs();

    subscriptions.forEach((sub, index) => {
      if (sub.type === EVENTTYPE.CLOCK) {
        const now = sub.clockId === CLOCK.REALTIME ? nowReal : nowMono;
        const targetNs = sub.absolute ? sub.timeoutNs : now + sub.timeoutNs;
        const waitNs = targetNs - now;
        const waitMs = Math.max(0, Number(waitNs / 1_000_000n));
        if (waitMs <= 0) {
          events.push({ index, error: 0 });
        } else if (waitMs < earliestClockMs) {
          earliestClockMs = waitMs;
          earliestClockIndex = index;
        }
        return;
      }
      const result = ready(sub);
      if (result && result.error === 0) events.push({ index, error: 0 });
      else if (result) {
        // Invalid subscriptions are reported as error events, like wasmtime.
        events.push({ index, error: result.error });
      }
    });

    // No ready fd events: block on the earliest clock (bounded to keep the
    // host responsive-ish; the full interval is honored by looping).
    while (events.length === 0 && earliestClockIndex >= 0) {
      this.sleepSync(Math.min(earliestClockMs, 1000));
      const sub = subscriptions[earliestClockIndex];
      const now = sub.clockId === CLOCK.REALTIME ? this.realtimeNs() : this.monotonicNs();
      const targetNs = sub.absolute ? sub.timeoutNs : now + 0n;
      if (sub.absolute) {
        if (now >= targetNs) events.push({ index: earliestClockIndex, error: 0 });
      } else {
        earliestClockMs -= 1000;
        if (earliestClockMs <= 0) events.push({ index: earliestClockIndex, error: 0 });
      }
    }

    if (events.length === 0) return ERRNO.TIMEDOUT;

    events.forEach((event, position) => {
      const sub = subscriptions[event.index];
      const base = outPtr + position * EVENT_SIZE;
      view.setBigUint64(base, sub.userdata, true);
      view.setUint16(base + 8, event.error, true);
      view.setUint8(base + 10, sub.type);
      view.setBigUint64(base + 16, 1n, true); // nbytes (advisory)
      view.setUint16(base + 24, 0, true);
    });
    view.setUint32(neventsPtr, events.length, true);
    return ERRNO.SUCCESS;
  }

  /* -------------------------------- random ------------------------------- */

  private randomGet(bufPtr: number, bufLength: number): number {
    const bytes = this.bytes();
    let offset = 0;
    while (offset < bufLength) {
      const take = Math.min(65_536, bufLength - offset);
      this.randomFill(bytes.subarray(bufPtr + offset, bufPtr + offset + take));
      offset += take;
    }
    return ERRNO.SUCCESS;
  }
}

/* ------------------------------- helpers --------------------------------- */

function stdEntry(kind: FdKind, rights: bigint): FdEntry {
  return {
    kind,
    rightsBase: rights,
    rightsInheriting: 0n,
    fdflags: 0,
    position: 0n,
    append: false,
  };
}

function joinCStrings(values: string[]): Uint8Array {
  const parts = values.map((value) => encoder.encode(value));
  const total = parts.reduce((sum, part) => sum + part.byteLength + 1, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength + 1;
  }
  return out;
}

function writeCStrings(
  view: DataView,
  values: string[],
  pointersPtr: number,
  bufferPtr: number,
): number {
  const bytes = new Uint8Array(view.buffer as ArrayBuffer);
  let cursor = bufferPtr;
  values.forEach((value, index) => {
    view.setUint32(pointersPtr + index * 4, cursor, true);
    const encoded = encoder.encode(value);
    bytes.set(encoded, cursor);
    bytes[cursor + encoded.byteLength] = 0;
    cursor += encoded.byteLength + 1;
  });
  return ERRNO.SUCCESS;
}
