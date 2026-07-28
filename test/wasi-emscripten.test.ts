/**
 * EmscriptenFs bridge test: runs fixtures against the Emscripten-shaped
 * adapter (the browser main-thread production path) using a mock that
 * mimics Emscripten behavior — string open flags, numeric ErrnoError codes,
 * ms timestamps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryFs } from "../src/wasi/memory-fs.ts";
import { EmscriptenFs, type EmscriptenLikeFs, type EmscriptenStat } from "../src/wasi/emscripten-fs.ts";
import { ERRNO, FILETYPE, WasiError, type WasiStat } from "../src/wasi/abi.ts";
import { executeWasi } from "../src/wasi/runner.ts";
import { fixtureBinary } from "./helpers.ts";

/** WASI errno → Emscripten (Linux-ish) errno, inverse of the bridge map. */
const WASI_TO_EMSCRIPTEN: Record<number, number> = {
  [ERRNO.PERM]: 1,
  [ERRNO.NOENT]: 2,
  [ERRNO.INTR]: 4,
  [ERRNO.IO]: 5,
  [ERRNO.NXIO]: 6,
  [ERRNO.BADF]: 9,
  [ERRNO.AGAIN]: 11,
  [ERRNO.ACCES]: 13,
  [ERRNO.BUSY]: 16,
  [ERRNO.EXIST]: 17,
  [ERRNO.XDEV]: 18,
  [ERRNO.NODEV]: 19,
  [ERRNO.NOTDIR]: 20,
  [ERRNO.ISDIR]: 21,
  [ERRNO.INVAL]: 22,
  [ERRNO.NFILE]: 23,
  [ERRNO.MFILE]: 24,
  [ERRNO.NOTTY]: 25,
  [ERRNO.FBIG]: 27,
  [ERRNO.NOSPC]: 28,
  [ERRNO.SPIPE]: 29,
  [ERRNO.ROFS]: 30,
  [ERRNO.MLINK]: 31,
  [ERRNO.PIPE]: 32,
  [ERRNO.NAMETOOLONG]: 36,
  [ERRNO.NOTEMPTY]: 39,
  [ERRNO.LOOP]: 40,
  [ERRNO.NOTSUP]: 95,
};


class EmscriptenStyleError extends Error {
  errno: number;
  constructor(errno: number, message: string) {
    super(message);
    this.errno = errno;
  }
}

function toEmscriptenError(error: unknown): never {
  if (error instanceof WasiError) {
    throw new EmscriptenStyleError(WASI_TO_EMSCRIPTEN[error.errno] ?? 5, error.message);
  }
  throw error;
}

interface MockStream {
  path: string;
  canRead: boolean;
  canWrite: boolean;
  position: number;
  closed: boolean;
}

/** Minimal Emscripten MEMFS lookalike backed by MemoryFs. */
class MockEmscriptenFs implements EmscriptenLikeFs {
  private mem = new MemoryFs();
  private nextStream = 1;
  private streams = new Map<number, MockStream>();

  constructor() {
    this.mem.mkdirTree("/home/web");
  }

  private statToEmscripten(stat: WasiStat): EmscriptenStat {
    const typeBits =
      stat.filetype === FILETYPE.DIRECTORY
        ? 0o040000
        : stat.filetype === FILETYPE.SYMBOLIC_LINK
          ? 0o120000
          : 0o100000;
    return {
      dev: Number(stat.dev),
      ino: Number(stat.ino),
      mode: typeBits | 0o755,
      nlink: Number(stat.nlink),
      size: Number(stat.size),
      atime: Number(stat.atim / 1_000_000n),
      mtime: Number(stat.mtim / 1_000_000n),
      ctime: Number(stat.ctim / 1_000_000n),
    };
  }

  open(path: string, flags: string, _mode?: number): number {
    const exists = this.mem.exists(path);
    if ((flags === "r" || flags === "r+") && !exists) {
      throw new EmscriptenStyleError(2, `No such file or directory`);
    }
    if (flags === "w" || flags === "w+" || flags === "a" || flags === "a+") {
      if (!exists) this.mem.writeFile(path, new Uint8Array());
      if (flags === "w" || flags === "w+") this.mem.truncate(path, 0n);
    }
    const id = this.nextStream++;
    this.streams.set(id, {
      path,
      canRead: flags.includes("r") || flags.includes("+"),
      canWrite: !flags.startsWith("r") || flags.includes("+"),
      position: 0,
      closed: false,
    });
    return id;
  }

  private stream(id: unknown): MockStream {
    const stream = this.streams.get(id as number);
    if (!stream || stream.closed) throw new EmscriptenStyleError(9, "Bad file descriptor");
    return stream;
  }

  close(stream: unknown): void {
    this.stream(stream).closed = true;
  }

  read(stream: unknown, buffer: Uint8Array, offset: number, length: number, position?: number): number {
    const s = this.stream(stream);
    if (!s.canRead) throw new EmscriptenStyleError(9, "Bad file descriptor");
    const handle = this.mem.open(s.path, { read: true, write: false, create: false, createExcl: false, truncate: false, append: false, directory: false, followSymlinks: true }, 0);
    const data = this.mem.read(handle, BigInt(position ?? s.position), length);
    this.mem.close(handle);
    buffer.set(data, offset);
    if (position === undefined) s.position += data.byteLength;
    return data.byteLength;
  }

  write(stream: unknown, buffer: Uint8Array, offset: number, length: number, position?: number): number {
    const s = this.stream(stream);
    if (!s.canWrite) throw new EmscriptenStyleError(9, "Bad file descriptor");
    const handle = this.mem.open(s.path, { read: true, write: true, create: false, createExcl: false, truncate: false, append: false, directory: false, followSymlinks: true }, 0);
    const data = buffer.slice(offset, offset + length);
    const written = this.mem.write(handle, position === undefined ? BigInt(s.position) : BigInt(position), data);
    this.mem.close(handle);
    if (position === undefined) s.position += written;
    return written;
  }

  stat(path: string, dontFollow?: boolean): EmscriptenStat {
    try {
      return this.statToEmscripten(this.mem.stat(path, !dontFollow));
    } catch (error) {
      toEmscriptenError(error);
    }
  }

  lstat(path: string): EmscriptenStat {
    return this.stat(path, true);
  }

  readdir(path: string): string[] {
    try {
      return [".", "..", ...this.mem.readdir(path).map((entry) => entry.name)];
    } catch (error) {
      toEmscriptenError(error);
    }
  }

  mkdir(path: string, mode?: number): void {
    try {
      this.mem.mkdir(path, mode ?? 0o755);
    } catch (error) {
      toEmscriptenError(error);
    }
  }
  rmdir(path: string): void {
    try {
      this.mem.rmdir(path);
    } catch (error) {
      toEmscriptenError(error);
    }
  }
  unlink(path: string): void {
    try {
      this.mem.unlink(path);
    } catch (error) {
      toEmscriptenError(error);
    }
  }
  rename(oldPath: string, newPath: string): void {
    try {
      this.mem.rename(oldPath, newPath);
    } catch (error) {
      toEmscriptenError(error);
    }
  }
  link(oldPath: string, newPath: string): void {
    try {
      this.mem.link(oldPath, newPath);
    } catch (error) {
      toEmscriptenError(error);
    }
  }
  symlink(target: string, path: string): void {
    try {
      this.mem.symlink(target, path);
    } catch (error) {
      toEmscriptenError(error);
    }
  }
  readlink(path: string): string {
    try {
      return this.mem.readlink(path);
    } catch (error) {
      toEmscriptenError(error);
    }
  }
  truncate(path: string, length: number): void {
    try {
      this.mem.truncate(path, BigInt(length));
    } catch (error) {
      toEmscriptenError(error);
    }
  }
  utime(path: string, atime: number, mtime: number): void {
    try {
      this.mem.utimes(path, BigInt(atime) * 1_000_000n, BigInt(mtime) * 1_000_000n);
    } catch (error) {
      toEmscriptenError(error);
    }
  }
  analyzePath(path: string): { exists: boolean } {
    return { exists: this.mem.exists(path) };
  }
  isDir(mode: number): boolean {
    return (mode & 0o170000) === 0o040000;
  }
  isLink(mode: number): boolean {
    return (mode & 0o170000) === 0o120000;
  }

  /** Test helper. */
  readFile(path: string): Uint8Array {
    return this.mem.readFile(path);
  }
  writeFile(path: string, data: string): void {
    this.mem.writeFile(path, data);
  }
}

async function runOnMock(mock: MockEmscriptenFs, name: string, args: string[], stdinText = "") {
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  let stdinSent = stdinText.length === 0;
  const result = await executeWasi({
    binary: fixtureBinary(name),
    args,
    env: {},
    fs: new EmscriptenFs(mock),
    preopens: ["/home/web", "/"],
    stdin: () => {
      if (stdinSent) return null;
      stdinSent = true;
      return new TextEncoder().encode(stdinText);
    },
    stdout: (chunk) => {
      stdout += decoder.decode(chunk, { stream: true });
    },
    stderr: (chunk) => {
      stderr += decoder.decode(chunk, { stream: true });
    },
  });
  return { ...result, stdout, stderr };
}

test("emscripten bridge: cat reads through the adapter", async () => {
  const mock = new MockEmscriptenFs();
  mock.writeFile("/home/web/data.txt", "via emscripten bridge\n");
  const run = await runOnMock(mock, "cat.wasm", ["cat.wasm", "/home/web/data.txt"]);
  assert.equal(run.exitCode, 0);
  assert.equal(run.stdout, "via emscripten bridge\n");
});

test("emscripten bridge: guest writes land in the underlying fs", async () => {
  const mock = new MockEmscriptenFs();
  const run = await runOnMock(mock, "fops.wasm", ["fops.wasm"]);
  assert.equal(run.exitCode, 0);
  // The full fops suite must succeed through the Emscripten-shaped adapter.
  assert.match(run.stdout, /link: ok\n/);
  assert.match(run.stdout, /nlink: 2\n/);
  assert.match(run.stdout, /rmdir: ok\n/);
  assert.match(run.stdout, /rmdir-missing: No such file or directory/);
  const failures = run.stdout
    .split("\n")
    .filter((line) =>
      /: (No such|Bad file|Is a directory|Not a directory|File exists|Not supported|Invalid|Permission|Too many|Directory not empty|Illegal)/.test(line),
    )
    .filter((line) => !line.startsWith("rmdir-missing"));
  assert.deepEqual(failures, [], run.stdout);
});

test("emscripten bridge: missing file maps Emscripten errno to WASI ENOENT", async () => {
  const mock = new MockEmscriptenFs();
  const run = await runOnMock(mock, "cat.wasm", ["cat.wasm", "/home/web/absent.txt"]);
  assert.equal(run.exitCode, 1);
  assert.match(run.stdout, /No such file or directory/);
});
