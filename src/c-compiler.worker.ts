import { WASI } from "@runno/wasi";
import type { WASIFS, WASIExecutionResult } from "@runno/wasi";

const ASSET_BASE_URL = "https://runno.dev/langs";
const SOURCE_PATH = "/source.c";
const OBJECT_PATH = "/program.o";
const OUTPUT_PATH = "/program.wasm";
const TAR_BLOCK_SIZE = 512;

interface CompileRequest {
  source: string;
}

interface CompileResponse {
  ok: boolean;
  wasm?: Uint8Array;
  diagnostics: string;
  error?: string;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<CompileRequest>) => void) | null;
  postMessage(message: CompileResponse, transfer?: Transferable[]): void;
}

const workerScope = globalThis as unknown as WorkerScope;

workerScope.onmessage = (event) => {
  void compile(event.data.source)
    .then((response) => {
      const transfer = response.wasm ? [response.wasm.buffer as ArrayBuffer] : [];
      workerScope.postMessage(response, transfer);
    })
    .catch((error: unknown) => {
      workerScope.postMessage({
        ok: false,
        diagnostics: "",
        error: error instanceof Error ? error.message : String(error),
      });
    });
};

async function compile(source: string): Promise<CompileResponse> {
  const [clang, linker, sysroot] = await Promise.all([
    fetchModule("clang.wasm"),
    fetchModule("wasm-ld.wasm"),
    fetchSysroot(),
  ]);
  const timestamp = timestamps();
  const fs: WASIFS = {
    ...sysroot,
    [SOURCE_PATH]: {
      path: SOURCE_PATH,
      mode: "string",
      content: source,
      timestamps: timestamp,
    },
  };

  const compiled = await run(clang, [
    "clang",
    "-cc1",
    "-triple",
    "wasm32-unknown-wasi",
    "-isysroot",
    "/sys",
    "-internal-isystem",
    "/sys/include",
    "-internal-isystem",
    "/sys/lib/clang/8.0.1/include",
    "-ferror-limit",
    "8",
    "-O2",
    "-emit-obj",
    "-o",
    OBJECT_PATH,
    SOURCE_PATH,
  ], fs);
  if (compiled.result.exitCode !== 0) {
    return {
      ok: false,
      diagnostics: compiled.output,
      error: `Clang exited with status ${compiled.result.exitCode}.`,
    };
  }

  const linked = await run(linker, [
    "wasm-ld",
    "--no-threads",
    "--export-dynamic",
    "-z",
    "stack-size=1048576",
    "-L/sys/lib/wasm32-wasi",
    "/sys/lib/wasm32-wasi/crt1.o",
    OBJECT_PATH,
    "-lc",
    "-o",
    OUTPUT_PATH,
  ], compiled.result.fs);
  const diagnostics = compiled.output + linked.output;
  if (linked.result.exitCode !== 0) {
    return {
      ok: false,
      diagnostics,
      error: `wasm-ld exited with status ${linked.result.exitCode}.`,
    };
  }

  const output = linked.result.fs[OUTPUT_PATH];
  if (!output || output.mode !== "binary") {
    return { ok: false, diagnostics, error: "The linker did not produce a WebAssembly file." };
  }
  return { ok: true, diagnostics, wasm: output.content.slice() };
}

async function run(
  module: WebAssembly.Module,
  args: string[],
  fs: WASIFS,
): Promise<{ result: WASIExecutionResult; output: string }> {
  let output = "";
  const wasi = new WASI({
    args,
    env: {},
    fs,
    stdout: (chunk) => {
      output += chunk;
    },
    stderr: (chunk) => {
      output += chunk;
    },
  });
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  return {
    result: wasi.start({ module, instance }),
    output,
  };
}

async function fetchModule(name: string): Promise<WebAssembly.Module> {
  const response = await fetch(`${ASSET_BASE_URL}/${name}`);
  if (!response.ok) throw new Error(`Could not download ${name} (HTTP ${response.status}).`);
  return WebAssembly.compile(await response.arrayBuffer());
}

async function fetchSysroot(): Promise<WASIFS> {
  const response = await fetch(`${ASSET_BASE_URL}/clang-fs.tar.gz`);
  if (!response.ok) {
    throw new Error(`Could not download the C sysroot (HTTP ${response.status}).`);
  }
  const gzip = new Uint8Array(await response.arrayBuffer());
  const stream = new Blob([gzip]).stream().pipeThrough(new DecompressionStream("gzip"));
  const tar = new Uint8Array(await new Response(stream).arrayBuffer());
  return extractTar(tar);
}

function extractTar(tar: Uint8Array): WASIFS {
  const fs: WASIFS = {};
  const decoder = new TextDecoder();

  for (let offset = 0; offset + TAR_BLOCK_SIZE <= tar.length;) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;

    const name = tarText(decoder, header, 0, 100);
    const prefix = tarText(decoder, header, 345, 155);
    const size = Number.parseInt(tarText(decoder, header, 124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("Invalid C sysroot archive.");

    const type = String.fromCharCode(header[156] ?? 0);
    const contentStart = offset + TAR_BLOCK_SIZE;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.length) throw new Error("Truncated C sysroot archive.");

    if (type === "\0" || type === "0") {
      const archivePath = prefix ? `${prefix}/${name}` : name;
      const path = `/${archivePath.replace(/^\/+/, "")}`;
      fs[path] = {
        path,
        mode: "binary",
        content: tar.slice(contentStart, contentEnd),
        timestamps: timestamps(),
      };
    }

    offset = contentStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  return fs;
}

function tarText(
  decoder: TextDecoder,
  header: Uint8Array,
  offset: number,
  length: number,
): string {
  return decoder.decode(header.subarray(offset, offset + length)).replace(/\0.*$/s, "");
}

function timestamps() {
  const now = new Date();
  return { access: now, modification: now, change: now };
}
