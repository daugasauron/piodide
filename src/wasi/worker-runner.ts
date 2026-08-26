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

function parseEnvironment(bytes: Uint8Array): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of new TextDecoder().decode(bytes).split("\0")) {
    const equals = entry.indexOf("=");
    if (equals > 0) env[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  return env;
}

function createSpawnImport(
  host: WasiHost,
  fs: RpcFsClient,
  withEnvironment: boolean,
  withStderr: boolean,
  withStdoutToStderr: boolean,
  withOrderedDuplication: boolean,
  withArgumentCount = false,
  exactEnvironment = false,
) {
  return (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number => {
    const path = host.readCString(pathPtr);
    const argumentCount = withArgumentCount && ioPtr !== 0
      ? host.readUint32(ioPtr + 60)
      : undefined;
    const args = host.readCStringArray(argvPtr, argumentCount);
    const cwd = host.readCString(cwdPtr);

    let stdinText: Uint8Array | undefined;
    let capture = false;
    let outFile: string | undefined;
    let append = false;
    let errFile: string | undefined;
    let errAppend = false;
    let stderrToStdout = false;
    let stdoutToStderr = false;
    let stderrToInheritedStdout = false;
    let stdoutToInheritedStderr = false;
    let capturePtr = 0;
    let captureCap = 0;
    let captureLenPtr = 0;
    let env: Record<string, string> | undefined;

    if (ioPtr !== 0) {
      const stdinPtr = host.readUint32(ioPtr);
      const stdinLen = host.readUint32(ioPtr + 4);
      capturePtr = host.readUint32(ioPtr + 8);
      captureCap = host.readUint32(ioPtr + 12);
      captureLenPtr = host.readUint32(ioPtr + 16);
      const outFilePtr = host.readUint32(ioPtr + 20);
      append = host.readUint32(ioPtr + 24) !== 0;
      if (stdinPtr !== 0 && stdinLen > 0) stdinText = host.readBytes(stdinPtr, stdinLen);
      capture = capturePtr !== 0;
      if (outFilePtr !== 0) outFile = host.readCString(outFilePtr);
      if (withEnvironment) {
        const envPtr = host.readUint32(ioPtr + 28);
        const envLen = host.readUint32(ioPtr + 32);
        if (envPtr !== 0 && envLen > 0) env = parseEnvironment(host.readBytes(envPtr, envLen));
      }
      if (withStderr) {
        const errFilePtr = host.readUint32(ioPtr + 36);
        errAppend = host.readUint32(ioPtr + 40) !== 0;
        stderrToStdout = host.readUint32(ioPtr + 44) !== 0;
        if (errFilePtr !== 0) errFile = host.readCString(errFilePtr);
      }
      if (withStdoutToStderr) {
        stdoutToStderr = host.readUint32(ioPtr + 48) !== 0;
      }
      if (withOrderedDuplication) {
        stderrToInheritedStdout = host.readUint32(ioPtr + 52) !== 0;
        stdoutToInheritedStderr = host.readUint32(ioPtr + 56) !== 0;
      }
    }

    const result = fs.spawnRpc({
      path, args, cwd, stdinText, capture, outFile, append,
      errFile, errAppend, stderrToStdout, stdoutToStderr,
      stderrToInheritedStdout, stdoutToInheritedStderr, env, exactEnvironment,
    });
    if (capture && result.stdout) {
      const copied = Math.min(captureCap, result.stdout.byteLength);
      host.writeBytes(capturePtr, result.stdout.subarray(0, copied));
      if (captureLenPtr !== 0) {
        host.writeUint32(captureLenPtr, result.stdoutLength ?? result.stdout.byteLength);
      }
    }
    return result.exitCode;
  };
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
                  // v2 remains available to older shell binaries. v3 appends
                  // a NUL-separated exported-environment blob to slop_io.
                  spawn: createSpawnImport(host, fs, false, false, false, false),
                  spawn_v3: createSpawnImport(host, fs, true, false, false, false),
                  spawn_v4: createSpawnImport(host, fs, true, true, false, false),
                  spawn_v5: createSpawnImport(host, fs, true, true, true, false),
                  spawn_v6: createSpawnImport(host, fs, true, true, true, true),
                  // v7 adds an argv count so empty arguments are data, not the
                  // legacy NUL-list terminator.
                  spawn_v7: createSpawnImport(host, fs, true, true, true, true, true),
                  // v8 keeps v7's counted argv and marks the supplied
                  // environment exact, including the empty environment.
                  spawn_v8: createSpawnImport(host, fs, true, true, true, true, true, true),
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
