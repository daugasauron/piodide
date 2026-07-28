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
                  spawn: (pathPtr: number, argvPtr: number, cwdPtr: number): number => {
                    const path = host.readCString(pathPtr);
                    const args = host.readCStringArray(argvPtr);
                    const cwd = host.readCString(cwdPtr);
                    return fs.spawnRpc(path, args, cwd);
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
