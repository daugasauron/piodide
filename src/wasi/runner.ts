/**
 * Shared "compile → instantiate → start" for one WASI command module,
 * synchronous on whatever thread it is called. The browser strategies
 * (main-thread vs SAB worker) and the Node tests all funnel through here.
 */
import { WasiHost, type WasiHostOptions } from "./host.ts";

export interface WasiExecuteOptions extends WasiHostOptions {
  binary: Uint8Array | ArrayBuffer | WebAssembly.Module;
}

export interface WasiExecuteResult {
  exitCode: number;
}

export async function executeWasi(options: WasiExecuteOptions): Promise<WasiExecuteResult> {
  const { binary, ...hostOptions } = options;
  const module =
    binary instanceof WebAssembly.Module
      ? binary
      : await WebAssembly.compile(
          (binary instanceof Uint8Array ? binary : new Uint8Array(binary)) as BufferSource,
        );
  const host = new WasiHost({ abiVersion: detectAbiVersion(module), ...hostOptions });
  const instance = await WebAssembly.instantiate(module, host.getImportObject());
  const exitCode = host.start(instance);
  return { exitCode };
}

/** Detect the WASI ABI generation from the module's import namespaces. */
function detectAbiVersion(module: WebAssembly.Module): "preview1" | "snapshot0" {
  for (const entry of WebAssembly.Module.imports(module)) {
    if (entry.module === "wasi_unstable") return "snapshot0";
    if (entry.module === "wasi_snapshot_preview1") return "preview1";
  }
  return "preview1";
}
