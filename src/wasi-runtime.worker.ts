import { WASI } from "@runno/wasi";
import type { WASIFS } from "@runno/wasi";
import type { WasiRunRequest, WasiRunResponse } from "./wasi-runtime.ts";
import type { WorkspaceFile } from "./wasm-workspace.ts";

const WORKSPACE_PREFIX = "/home/web/";
const OUTPUT_LIMIT = 100_000;
const RUNNO_DIRECTORY_SENTINEL = ".runno";

interface WorkerScope {
  onmessage: ((event: MessageEvent<WasiRunRequest>) => void) | null;
  postMessage(message: WasiRunResponse, transfer?: Transferable[]): void;
}

const workerScope = globalThis as unknown as WorkerScope;

workerScope.onmessage = (event) => {
  void execute(event.data)
    .then((response) => {
      const transfer = (response.files ?? []).map(
        (file) => file.content.buffer as ArrayBuffer,
      );
      workerScope.postMessage(response, transfer);
    })
    .catch((error: unknown) => {
      workerScope.postMessage({
        ok: false,
        output: "",
        outputTruncated: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
};

async function execute(request: WasiRunRequest): Promise<WasiRunResponse> {
  const fs = workspaceFS(request.workspace);
  const executable = fs[request.executablePath];
  if (!executable || executable.mode !== "binary") {
    throw new Error(`WASI executable not found: ${request.executablePath}`);
  }

  let output = "";
  let outputTruncated = false;
  const appendOutput = (chunk: string) => {
    if (output.length >= OUTPUT_LIMIT) {
      outputTruncated = true;
      return;
    }
    const remaining = OUTPUT_LIMIT - output.length;
    output += chunk.slice(0, remaining);
    if (chunk.length > remaining) outputTruncated = true;
  };
  const stdin = createStdin(request.stdin);
  const wasi = new WASI({
    args: [request.executablePath, ...request.args],
    env: { PWD: "/home/web", ...request.env },
    fs,
    stdin,
    stdout: appendOutput,
    stderr: appendOutput,
  });
  const binary = executable.content.slice().buffer as ArrayBuffer;
  const module = await WebAssembly.compile(binary);
  const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
  const result = wasi.start({ module, instance });
  const workspace = extractWorkspace(result.fs);

  return {
    ok: true,
    exitCode: result.exitCode,
    output,
    outputTruncated,
    files: workspace.files,
    directories: workspace.directories,
  };
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

function extractWorkspace(fs: WASIFS): {
  files: WorkspaceFile[];
  directories: string[];
} {
  const files: WorkspaceFile[] = [];
  const directories = new Set<string>(["/home/web"]);
  for (const [path, file] of Object.entries(fs)) {
    if (!path.startsWith(WORKSPACE_PREFIX)) continue;
    if (path.endsWith(`/${RUNNO_DIRECTORY_SENTINEL}`)) {
      directories.add(path.slice(0, -RUNNO_DIRECTORY_SENTINEL.length - 1));
      continue;
    }
    const slash = path.lastIndexOf("/");
    if (slash > 0) directories.add(path.slice(0, slash));
    const content = file.mode === "binary"
      ? file.content.slice()
      : new TextEncoder().encode(file.content);
    files.push({ path, content });
  }
  return { files, directories: [...directories] };
}

function createStdin(input: string): (maxByteLength: number) => string | null {
  let offset = 0;
  const encoder = new TextEncoder();
  return (maxByteLength) => {
    if (offset >= input.length) return null;
    let end = Math.min(input.length, offset + maxByteLength);
    while (end > offset && encoder.encode(input.slice(offset, end)).byteLength > maxByteLength) {
      end--;
    }
    if (end === offset) return null;
    const chunk = input.slice(offset, end);
    offset = end;
    return chunk;
  };
}

function timestamps() {
  const now = new Date();
  return { access: now, modification: now, change: now };
}
