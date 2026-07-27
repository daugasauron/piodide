import { WASI } from "@runno/wasi";
import type { WASIFS, WASIExecutionResult } from "@runno/wasi";
import type {
  ToolchainRequest,
  ToolchainResponse,
} from "./c-compiler.ts";
import type { WorkspaceFile } from "./wasm-workspace.ts";

const ASSET_BASE_URL = "https://runno.dev/langs";
const TAR_BLOCK_SIZE = 512;
const DIRECTORY_SENTINEL = ".piodide-compiler-directory";

interface WorkerScope {
  onmessage: ((event: MessageEvent<ToolchainRequest>) => void) | null;
  postMessage(message: ToolchainResponse, transfer?: Transferable[]): void;
}

const workerScope = globalThis as unknown as WorkerScope;

workerScope.onmessage = (event) => {
  void runToolchain(event.data)
    .then((response) => {
      const transfer = response.output
        ? [response.output.content.buffer as ArrayBuffer]
        : [];
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

async function runToolchain(request: ToolchainRequest): Promise<ToolchainResponse> {
  const [module, sysroot] = await Promise.all([
    fetchModule(request.operation === "compile" ? "clang.wasm" : "wasm-ld.wasm"),
    fetchSysroot(),
  ]);
  const fs: WASIFS = {
    ...sysroot,
    ...workspaceFS(request.workspace),
  };
  ensureParentDirectory(fs, request.outputPath);

  const command = request.operation === "compile"
    ? compileCommand(request.sourcePath, request.outputPath)
    : linkCommand(request.objectPaths, request.outputPath);
  const executed = await run(module, command, fs);
  if (executed.result.exitCode !== 0) {
    return {
      ok: false,
      diagnostics: executed.output,
      error:
        `${request.operation === "compile" ? "Clang" : "wasm-ld"} exited with ` +
        `status ${executed.result.exitCode}.`,
    };
  }

  const output = executed.result.fs[request.outputPath];
  if (!output || output.mode !== "binary") {
    return {
      ok: false,
      diagnostics: executed.output,
      error: `${request.operation === "compile" ? "Clang" : "wasm-ld"} produced no output.`,
    };
  }
  return {
    ok: true,
    diagnostics: executed.output,
    output: { path: request.outputPath, content: output.content.slice() },
  };
}

function compileCommand(sourcePath: string, outputPath: string): string[] {
  return [
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
    outputPath,
    sourcePath,
  ];
}

function linkCommand(objectPaths: string[], outputPath: string): string[] {
  return [
    "wasm-ld",
    "--no-threads",
    "--export-dynamic",
    "-z",
    "stack-size=1048576",
    "-L/sys/lib/wasm32-wasi",
    "/sys/lib/wasm32-wasi/crt1.o",
    ...objectPaths,
    "-lc",
    "-o",
    outputPath,
  ];
}

function workspaceFS(files: WorkspaceFile[]): WASIFS {
  const fs: WASIFS = {};
  for (const file of files) {
    fs[file.path] = {
      path: file.path,
      mode: "binary",
      content: file.content,
      timestamps: timestamps(),
    };
  }
  return fs;
}

function ensureParentDirectory(fs: WASIFS, path: string): void {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return;
  const parent = path.slice(0, slash);
  const prefix = `${parent}/`;
  if (Object.keys(fs).some((candidate) => candidate.startsWith(prefix))) return;
  const sentinel = `${prefix}${DIRECTORY_SENTINEL}`;
  fs[sentinel] = {
    path: sentinel,
    mode: "binary",
    content: new Uint8Array(),
    timestamps: timestamps(),
  };
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
