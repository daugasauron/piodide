/**
 * Worker-side WASI program runner.
 *
 * Environment-agnostic: the vite worker entry and the Node test wrapper
 * both delegate here with a small message-port adapter. The worker gets the
 * executable bytes plus one SharedArrayBuffer; every filesystem call and
 * stdin read is bridged synchronously to the main thread over that buffer
 * (see rpc.ts). stdout/stderr stream back as plain messages.
 */
import { RpcFsClient } from "./rpc.ts";
import { executeWasi } from "./runner.ts";
import type { WasiHost, WasiPreopen } from "./host.ts";

export interface WasiWorkerInit {
  binary: ArrayBuffer;
  args: string[];
  env: Record<string, string>;
  preopens: (string | WasiPreopen)[];
  rpcBuffer: SharedArrayBuffer;
  /** Expose the "piodide" spawn import to the guest. */
  spawnApi?: boolean;
}

export type WasiWorkerMessage =
  | { type: "stdout"; chunk: Uint8Array }
  | { type: "stderr"; chunk: Uint8Array }
  | { type: "result"; exitCode: number }
  | { type: "error"; error: string };

export interface WorkerPort {
  postMessage(message: WasiWorkerMessage, transfer?: Transferable[]): void;
  setHandler(handler: (message: WasiWorkerInit) => void): void;
}

export function startWasiWorker(port: WorkerPort): void {
  port.setHandler((init) => {
    void (async () => {
      const fs = new RpcFsClient(init.rpcBuffer);
      const post = (message: WasiWorkerMessage, transfer?: Transferable[]) =>
        port.postMessage(message, transfer);
      try {
        const result = await executeWasi({
          binary: new Uint8Array(init.binary),
          args: init.args,
          env: init.env,
          fs,
          preopens: init.preopens,
          stdin: () => fs.stdinRead(65_536),
          stdout: (chunk) => post({ type: "stdout", chunk }, [chunk.buffer as ArrayBuffer]),
          stderr: (chunk) => post({ type: "stderr", chunk }, [chunk.buffer as ArrayBuffer]),
          extendImports: init.spawnApi
            ? (host: WasiHost) => ({
                piodide: {
                  /**
                   * spawn(path, argv_blob, cwd, io*) — the io struct (slop_io
                   * in shell/src/slop.c) routes stdin/stdout:
                   *   +0  stdin_data ptr   +4  stdin_len
                   *   +8  capture ptr      +12 capture_cap
                   *   +16 capture_len out-ptr
                   *   +20 out_file ptr     +24 out_append
                   */
                  spawn: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number => {
                    const path = host.readCString(pathPtr);
                    const args = host.readCStringArray(argvPtr);
                    const cwd = host.readCString(cwdPtr);

                    let stdinText: Uint8Array | undefined;
                    let capture = false;
                    let outFile: string | undefined;
                    let append = false;
                    let capturePtr = 0;
                    let captureCap = 0;
                    let captureLenPtr = 0;

                    if (ioPtr !== 0) {
                      const stdinPtr = host.readUint32(ioPtr);
                      const stdinLen = host.readUint32(ioPtr + 4);
                      capturePtr = host.readUint32(ioPtr + 8);
                      captureCap = host.readUint32(ioPtr + 12);
                      captureLenPtr = host.readUint32(ioPtr + 16);
                      const outFilePtr = host.readUint32(ioPtr + 20);
                      append = host.readUint32(ioPtr + 24) !== 0;
                      if (stdinPtr !== 0 && stdinLen > 0) {
                        stdinText = host.readBytes(stdinPtr, stdinLen);
                      }
                      capture = capturePtr !== 0;
                      if (outFilePtr !== 0) outFile = host.readCString(outFilePtr);
                    }

                    const result = fs.spawnRpc({
                      path,
                      args,
                      cwd,
                      stdinText,
                      capture,
                      outFile,
                      append,
                    });
                    if (capture && result.stdout) {
                      const copied = Math.min(captureCap, result.stdout.byteLength);
                      host.writeBytes(capturePtr, result.stdout.subarray(0, copied));
                      if (captureLenPtr !== 0) {
                        host.writeUint32(captureLenPtr, result.stdout.byteLength);
                      }
                    }
                    return result.exitCode;
                  },
                },
              })
            : undefined,
        });
        post({ type: "result", exitCode: result.exitCode });
      } catch (error) {
        post({
          type: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });
}
