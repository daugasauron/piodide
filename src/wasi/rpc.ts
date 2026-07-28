/**
 * Synchronous filesystem bridge over one SharedArrayBuffer.
 *
 * The WASI guest runs in a worker and must issue *synchronous* filesystem
 * calls, while the real filesystem (Pyodide's MEMFS) lives on the main
 * thread. The worker serializes each op into the shared buffer and parks in
 * `Atomics.wait`; the main thread waits non-blockingly via
 * `Atomics.waitAsync`, performs the op against any `WasiFs` backend, and
 * wakes the worker. The UI stays fully responsive meanwhile.
 *
 * Wire layout of the shared buffer:
 *
 *   [0..63]    Int32 control block
 *                [0] STATE: 1=request pending, 2=response pending, 3=closed
 *                [1] PAYLOAD_LENGTH (bytes used in the data region)
 *   [64..]     data region: [u32 jsonLength][json][blob]
 *
 * JSON carries the op name and arguments; binary payloads (file data) ride
 * as the trailing blob. BigInts cross as {"$bigint": decimal-string}.
 * Reads and writes larger than the data region are chunked by the client.
 */
import { errnoOf, type WasiStat } from "./abi.ts";
import type { WasiDirEntry, WasiFs, WasiHandle, WasiOpenOptions } from "./fs.ts";

const STATE = 0;
const PAYLOAD_LENGTH = 1;
const CONTROL_BYTES = 64;

const REQUEST = 1;
const RESPONSE = 2;
const CLOSED = 3;

/** Margin for the JSON header when chunking binary payloads. */
const JSON_MARGIN = 4096;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(
    JSON.stringify(value, (_key, v) =>
      typeof v === "bigint" ? { $bigint: v.toString() } : v,
    ),
  );
}

function decodeJson(bytes: Uint8Array): Record<string, unknown> {
  return JSON.parse(decoder.decode(bytes), (_key, v) =>
    v && typeof v === "object" && "$bigint" in v && typeof v.$bigint === "string"
      ? BigInt(v.$bigint)
      : v,
  ) as Record<string, unknown>;
}

/* ------------------------------ client ----------------------------------- */

/**
 * Worker-side `WasiFs` proxying every operation to the main-thread server.
 * All calls block the worker thread (never the main thread).
 */
export class RpcFsClient implements WasiFs {
  private control: Int32Array;
  private data: Uint8Array;
  private view: DataView;
  private dataStart: number;
  /** Max binary bytes per round trip. */
  private blobCapacity: number;

  constructor(buffer: SharedArrayBuffer) {
    if (buffer.byteLength < CONTROL_BYTES + JSON_MARGIN * 2) {
      throw new Error("WASI RPC buffer too small");
    }
    this.control = new Int32Array(buffer, 0, CONTROL_BYTES / 4);
    this.data = new Uint8Array(buffer);
    this.view = new DataView(buffer);
    this.dataStart = CONTROL_BYTES;
    this.blobCapacity = buffer.byteLength - CONTROL_BYTES - JSON_MARGIN;
  }

  private request(
    op: string,
    args: Record<string, unknown>,
    blob?: Uint8Array,
  ): { response: Record<string, unknown>; blob: Uint8Array } {
    const json = encodeJson({ op, ...args });
    if (CONTROL_BYTES + 4 + json.byteLength + (blob?.byteLength ?? 0) > this.data.byteLength) {
      throw new Error(`WASI RPC request too large: ${op}`);
    }
    this.view.setUint32(this.dataStart, json.byteLength, true);
    this.data.set(json, this.dataStart + 4);
    if (blob && blob.byteLength > 0) this.data.set(blob, this.dataStart + 4 + json.byteLength);
    const totalLength = 4 + json.byteLength + (blob?.byteLength ?? 0);

    Atomics.store(this.control, PAYLOAD_LENGTH, totalLength);
    Atomics.store(this.control, STATE, REQUEST);
    Atomics.notify(this.control, STATE);

    for (;;) {
      const state = Atomics.load(this.control, STATE);
      if (state === RESPONSE) break;
      if (state === CLOSED) throw new Error("WASI filesystem bridge closed");
      Atomics.wait(this.control, STATE, state);
    }

    const length = Atomics.load(this.control, PAYLOAD_LENGTH);
    const jsonLength = this.view.getUint32(this.dataStart, true);
    const response = decodeJson(
      this.data.subarray(this.dataStart + 4, this.dataStart + 4 + jsonLength),
    );
    const responseBlob = this.data.slice(
      this.dataStart + 4 + jsonLength,
      this.dataStart + length,
    );
    const errno = (response.errno as number) ?? 0;
    if (errno !== 0) {
      throw new RpcRemoteError(errno, (response.error as string) ?? `${op} failed`);
    }
    return { response, blob: responseBlob };
  }

  /** Pull stdin bytes from the main thread; null at EOF. */
  stdinRead(length: number): Uint8Array | null {
    const { response, blob } = this.request("stdinRead", { length });
    if (response.eof === true) return null;
    return blob;
  }

  open(path: string, options: WasiOpenOptions, mode: number): WasiHandle {
    const { response } = this.request("open", { path, options, mode });
    return response.handle as number;
  }

  close(handle: WasiHandle): void {
    this.request("close", { handle });
  }

  read(handle: WasiHandle, position: bigint | null, length: number): Uint8Array {
    const chunks: Uint8Array[] = [];
    let remaining = length;
    let offset = position;
    while (remaining > 0) {
      const { blob } = this.request("read", {
        handle,
        position: offset,
        length: Math.min(remaining, this.blobCapacity),
      });
      chunks.push(blob);
      remaining -= blob.byteLength;
      if (offset !== null) offset += BigInt(blob.byteLength);
      if (blob.byteLength < Math.min(remaining + blob.byteLength, this.blobCapacity)) break;
    }
    return concat(chunks);
  }

  write(handle: WasiHandle, position: bigint | null, data: Uint8Array): number {
    let written = 0;
    let offset = position;
    while (written < data.byteLength) {
      const slice = data.subarray(written, written + this.blobCapacity);
      const { response } = this.request(
        "write",
        { handle, position: offset },
        slice,
      );
      const n = response.written as number;
      written += n;
      if (offset !== null) offset += BigInt(n);
      if (n < slice.byteLength) break;
    }
    return written;
  }

  size(handle: WasiHandle): bigint {
    return this.request("size", { handle }).response.size as bigint;
  }

  sync(handle: WasiHandle): void {
    this.request("sync", { handle });
  }

  stat(path: string, followSymlinks: boolean): WasiStat {
    return this.request("stat", { path, followSymlinks }).response.stat as WasiStat;
  }

  readdir(path: string): WasiDirEntry[] {
    return this.request("readdir", { path }).response.entries as WasiDirEntry[];
  }

  mkdir(path: string, mode: number): void {
    this.request("mkdir", { path, mode });
  }

  rmdir(path: string): void {
    this.request("rmdir", { path });
  }

  unlink(path: string): void {
    this.request("unlink", { path });
  }

  rename(from: string, to: string): void {
    this.request("rename", { from, to });
  }

  link(existing: string, path: string): void {
    this.request("link", { existing, path });
  }

  symlink(target: string, path: string): void {
    this.request("symlink", { target, path });
  }

  readlink(path: string): string {
    return this.request("readlink", { path }).response.target as string;
  }

  truncate(path: string, size: bigint): void {
    this.request("truncate", { path, size });
  }

  utimes(path: string, atim: bigint | null, mtim: bigint | null): void {
    this.request("utimes", { path, atim, mtim });
  }
}

/** Error carrying the remote errno. Converted back to WasiError semantics
 * by `errnoOf` through the numeric `errno` field. */
class RpcRemoteError extends Error {
  readonly errno: number;
  constructor(errno: number, message: string) {
    super(message);
    this.errno = errno;
  }
}

/* ------------------------------ server ----------------------------------- */

export interface RpcFsServerOptions {
  fs: WasiFs;
  buffer: SharedArrayBuffer;
  /**
   * Pull stdin for the guest. May be async: the response is simply sent
   * late (the worker stays parked). Return null to signal EOF.
   */
  stdin?: () => Uint8Array | null | Promise<Uint8Array | null>;
  signal?: AbortSignal;
}

export interface RpcFsServer {
  /** Resolves when the server stops (signal or `stop()`). */
  done: Promise<void>;
  stop(): void;
}

/**
 * Serve a `WasiFs` over the shared buffer until stopped. Must run on the
 * thread that owns the real filesystem (the browser main thread for
 * Pyodide MEMFS).
 */
export function serveWasiFsRpc(options: RpcFsServerOptions): RpcFsServer {
  const control = new Int32Array(options.buffer, 0, CONTROL_BYTES / 4);
  const data = new Uint8Array(options.buffer);
  const view = new DataView(options.buffer);
  const dataStart = CONTROL_BYTES;
  const handles = new Map<number, WasiHandle>();
  let nextHandle = 1;
  let stopped = false;

  const respond = (payload: Record<string, unknown>, blob?: Uint8Array) => {
    const json = encodeJson(payload);
    view.setUint32(dataStart, json.byteLength, true);
    data.set(json, dataStart + 4);
    if (blob && blob.byteLength > 0) data.set(blob, dataStart + 4 + json.byteLength);
    Atomics.store(control, PAYLOAD_LENGTH, 4 + json.byteLength + (blob?.byteLength ?? 0));
    Atomics.store(control, STATE, RESPONSE);
    Atomics.notify(control, STATE);
  };

  const respondError = (error: unknown) => {
    respond({
      errno: errnoOf(error),
      error: error instanceof Error ? error.message : String(error),
    });
  };

  const dispatch = async (
    op: string,
    args: Record<string, unknown>,
    blob: Uint8Array,
  ): Promise<void> => {
    const fs = options.fs;
    switch (op) {
      case "open": {
        const handle = fs.open(
          args.path as string,
          args.options as WasiOpenOptions,
          args.mode as number,
        );
        const id = nextHandle++;
        handles.set(id, handle);
        respond({ errno: 0, handle: id });
        return;
      }
      case "close": {
        const handle = handles.get(args.handle as number);
        if (handle !== undefined) {
          fs.close(handle);
          handles.delete(args.handle as number);
        }
        respond({ errno: 0 });
        return;
      }
      case "read": {
        const handle = handles.get(args.handle as number);
        if (handle === undefined) throw new Error("unknown handle");
        const chunk = fs.read(
          handle,
          (args.position as bigint) ?? null,
          args.length as number,
        );
        respond({ errno: 0 }, chunk);
        return;
      }
      case "write": {
        const handle = handles.get(args.handle as number);
        if (handle === undefined) throw new Error("unknown handle");
        const written = fs.write(handle, (args.position as bigint) ?? null, blob);
        respond({ errno: 0, written });
        return;
      }
      case "size": {
        const handle = handles.get(args.handle as number);
        if (handle === undefined) throw new Error("unknown handle");
        respond({ errno: 0, size: fs.size(handle) });
        return;
      }
      case "sync": {
        const handle = handles.get(args.handle as number);
        if (handle !== undefined) fs.sync(handle);
        respond({ errno: 0 });
        return;
      }
      case "stat":
        respond({ errno: 0, stat: fs.stat(args.path as string, args.followSymlinks as boolean) });
        return;
      case "readdir":
        respond({ errno: 0, entries: fs.readdir(args.path as string) });
        return;
      case "mkdir":
        fs.mkdir(args.path as string, args.mode as number);
        respond({ errno: 0 });
        return;
      case "rmdir":
        fs.rmdir(args.path as string);
        respond({ errno: 0 });
        return;
      case "unlink":
        fs.unlink(args.path as string);
        respond({ errno: 0 });
        return;
      case "rename":
        fs.rename(args.from as string, args.to as string);
        respond({ errno: 0 });
        return;
      case "link":
        fs.link(args.existing as string, args.path as string);
        respond({ errno: 0 });
        return;
      case "symlink":
        fs.symlink(args.target as string, args.path as string);
        respond({ errno: 0 });
        return;
      case "readlink":
        respond({ errno: 0, target: fs.readlink(args.path as string) });
        return;
      case "truncate":
        fs.truncate(args.path as string, args.size as bigint);
        respond({ errno: 0 });
        return;
      case "utimes":
        fs.utimes(args.path as string, (args.atim as bigint) ?? null, (args.mtim as bigint) ?? null);
        respond({ errno: 0 });
        return;
      case "stdinRead": {
        const chunk = (await options.stdin?.()) ?? null;
        if (chunk === null || chunk.byteLength === 0) respond({ errno: 0, eof: true });
        else respond({ errno: 0 }, chunk);
        return;
      }
      default:
        throw new Error(`unknown WASI RPC op: ${op}`);
    }
  };

  const handleRequest = async () => {
    const length = Atomics.load(control, PAYLOAD_LENGTH);
    const jsonLength = view.getUint32(dataStart, true);
    let args: Record<string, unknown>;
    let blob: Uint8Array;
    try {
      args = decodeJson(data.subarray(dataStart + 4, dataStart + 4 + jsonLength));
      blob = data.slice(dataStart + 4 + jsonLength, dataStart + length);
    } catch (error) {
      respondError(error);
      return;
    }
    const op = args.op as string;
    await dispatch(op, args, blob).catch(respondError);
  };

  const done = (async () => {
    while (!stopped) {
      const state = Atomics.load(control, STATE);
      if (state === REQUEST) {
        // Await the dispatch: the response flips STATE to RESPONSE, so the
        // loop only ever has one outstanding request.
        await handleRequest();
        continue;
      }
      if (state === CLOSED) break;
      const wait = Atomics.waitAsync(control, STATE, state);
      if (!wait.async) continue;
      await Promise.race([wait.value, abortPromise(options.signal)]);
    }
  })();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    Atomics.store(control, STATE, CLOSED);
    Atomics.notify(control, STATE);
  };

  options.signal?.addEventListener("abort", stop, { once: true });
  return { done, stop };
}

function abortPromise(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
