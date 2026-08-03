/**
 * In-browser C toolchain: clang (compile) and wasm-ld (link), themselves
 * wasm32-wasi programs, running on the same WASI host as everything else.
 *
 * The compiler binaries and the WASI sysroot are lazily downloaded from
 * runno.dev on first use. The sysroot is unpacked into a `MemoryFs` mounted
 * at /sys; the user workspace (/home/web) is the live Pyodide MEMFS reached
 * either directly (main-thread fallback) or over the RPC bridge (worker).
 */
import { MemoryFs } from "./memory-fs.ts";
import { RoutedFs } from "./fs.ts";
import { executeWasi } from "./runner.ts";
import type { WasiFs } from "./fs.ts";

const ASSET_BASE_URL = "https://runno.dev/langs";
export type ToolchainAssetName = "clang.wasm" | "wasm-ld.wasm" | "clang-fs.tar.gz";
export const TOOLCHAIN_ASSET_SHA256: Readonly<Record<ToolchainAssetName, string>> = {
  "clang.wasm": "2a466f0e990329d3230b869d04fc20803eae96a7feb3a3f6c93e25a77b8aed1d",
  "wasm-ld.wasm": "36419ed202011765222098d7701218378b67f634d50f0a4625059ae2c9860f48",
  "clang-fs.tar.gz": "7ed12063619882e4dfa710ab371fc91848b256f85a4075747e8bd5c167902b50",
};
const TAR_BLOCK_SIZE = 512;
const SYSROOT_PREFIX = "/sys";
const CLANG_VERSION = "8.0.1";
const ERRNO_COMPAT_HEADER = `#ifndef __wasm_basics___errno_h
#define __wasm_basics___errno_h

#ifdef __cplusplus
extern "C" {
#endif

/*
 * This legacy sysroot's libc archive defines errno as a plain global. Its
 * bundled header incorrectly declares it as TLS, which Clang 8's wasm backend
 * cannot lower. Keep the declaration consistent with the linked definition.
 */
extern int errno;
#define errno errno

#ifdef __cplusplus
}
#endif

#endif
`;

export type CStandard = "c11" | "c17";
export type COptimization = "0" | "1" | "2" | "3" | "s";

export interface CompileOptions {
  standard?: CStandard;
  optimization?: COptimization;
  debug?: boolean;
  warnings?: boolean;
  warningsAsErrors?: boolean;
  defines?: string[];
  includePaths?: string[];
  /** Internal asset builds use per-function sections so wasm-ld can discard unused code. */
  functionSections?: boolean;
}

export interface LinkOptions {
  exports?: string[];
  strip?: boolean;
  /** Link a callable module without WASI's command-style _start entrypoint. */
  reactor?: boolean;
  systemLibraries?: ("m")[];
}

export type ToolchainOperation =
  | {
      operation: "compile";
      sourcePath: string;
      outputPath: string;
      options?: CompileOptions;
    }
  | {
      operation: "link";
      objectPaths: string[];
      outputPath: string;
      options?: LinkOptions;
    };

export interface ToolchainRunResult {
  exitCode: number;
  diagnostics: string;
}

/* ------------------------------ asset fetch ------------------------------ */

const byteCache = new Map<string, Promise<ArrayBuffer>>();
const compiledCache = new Map<string, Promise<WebAssembly.Module>>();

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyToolchainAsset(
  name: ToolchainAssetName,
  bytes: ArrayBuffer,
): Promise<ArrayBuffer> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const actual = hex(digest);
  const expected = TOOLCHAIN_ASSET_SHA256[name];
  if (actual !== expected) {
    throw new Error(
      `Integrity check failed for ${name}: expected SHA-256 ${expected}, received ${actual}.`,
    );
  }
  return bytes;
}

function fetchBytes(name: ToolchainAssetName): Promise<ArrayBuffer> {
  let cached = byteCache.get(name);
  if (!cached) {
    cached = (async () => {
      const url = `${ASSET_BASE_URL}/${name}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not download ${url} (HTTP ${response.status}).`);
      return verifyToolchainAsset(name, await response.arrayBuffer());
    })();
    byteCache.set(name, cached);
  }
  return cached;
}

/**
 * Fetch + compile a toolchain binary once (main-thread cache). Compiled
 * modules structured-clone into workers cheaply, unlike byte buffers.
 */
export function getToolchainModule(name: "clang.wasm" | "wasm-ld.wasm"): Promise<WebAssembly.Module> {
  let cached = compiledCache.get(name);
  if (!cached) {
    cached = fetchBytes(name).then((bytes) => WebAssembly.compile(bytes));
    compiledCache.set(name, cached);
  }
  return cached;
}

/** Fetch the gzipped sysroot tar once (main-thread cache). */
export function getSysrootTarBytes(): Promise<ArrayBuffer> {
  return fetchBytes("clang-fs.tar.gz");
}

/** Decompress + unpack the sysroot tar into a fresh MemoryFs. */
export async function extractSysroot(tarGz: ArrayBuffer | Uint8Array): Promise<MemoryFs> {
  const stream = new Blob([tarGz as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  const tar = new Uint8Array(await new Response(stream).arrayBuffer());
  const fs = extractTar(tar);
  fs.writeFile("/include/__errno.h", ERRNO_COMPAT_HEADER);
  return fs;
}

function extractTar(tar: Uint8Array): MemoryFs {
  const fs = new MemoryFs();
  const decoder = new TextDecoder();

  for (let offset = 0; offset + TAR_BLOCK_SIZE <= tar.length; ) {
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
      // The archive root is a single "sys/" directory; strip it so the
      // contents mount cleanly at /sys via RoutedFs.
      const stripped = archivePath.replace(/^\/+/, "").replace(/^sys\//, "");
      if (stripped === "") continue;
      fs.writeFile(`/${stripped}`, tar.slice(contentStart, contentEnd));
    }

    offset = contentStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  return fs;
}

function tarText(decoder: TextDecoder, header: Uint8Array, offset: number, length: number): string {
  return decoder.decode(header.subarray(offset, offset + length)).replace(/\0.*$/s, "");
}

/* ------------------------------- commands -------------------------------- */

function compileCommand(
  sourcePath: string,
  outputPath: string,
  options: CompileOptions = {},
): string[] {
  return [
    "clang",
    "-cc1",
    "-triple",
    "wasm32-unknown-wasi",
    "-isysroot",
    SYSROOT_PREFIX,
    "-internal-isystem",
    `${SYSROOT_PREFIX}/include`,
    "-internal-isystem",
    `${SYSROOT_PREFIX}/lib/clang/${CLANG_VERSION}/include`,
    "-ferror-limit",
    "8",
    `-O${options.optimization ?? "2"}`,
    ...(options.standard ? [`-std=${options.standard}`] : []),
    ...(options.debug ? ["-debug-info-kind=standalone", "-dwarf-version=4"] : []),
    ...(options.warnings ? ["-Wall", "-Wextra"] : []),
    ...(options.warningsAsErrors ? ["-Werror"] : []),
    ...(options.defines ?? []).map((define) => `-D${define}`),
    ...(options.includePaths ?? []).flatMap((path) => ["-I", path]),
    ...(options.functionSections ? ["-ffunction-sections", "-fdata-sections"] : []),
    "-emit-obj",
    "-o",
    outputPath,
    sourcePath,
  ];
}

function linkCommand(
  objectPaths: string[],
  outputPath: string,
  options: LinkOptions = {},
): string[] {
  return [
    "wasm-ld",
    "--no-threads",
    "--export-dynamic",
    ...(options.reactor ? ["--no-entry"] : []),
    "-z",
    "stack-size=1048576",
    `-L${SYSROOT_PREFIX}/lib/wasm32-wasi`,
    ...(options.reactor ? [] : [`${SYSROOT_PREFIX}/lib/wasm32-wasi/crt1.o`]),
    ...objectPaths,
    "-lc",
    ...(options.systemLibraries ?? []).map((library) => `-l${library}`),
    `${SYSROOT_PREFIX}/lib/clang/${CLANG_VERSION}/lib/wasi/libclang_rt.builtins-wasm32.a`,
    ...(options.exports ?? []).map((symbol) => `--export=${symbol}`),
    ...(options.strip ? ["--strip-all"] : []),
    "-o",
    outputPath,
  ];
}

/* ------------------------------ execution -------------------------------- */

export interface ToolchainAssets {
  /** clang.wasm or wasm-ld.wasm (compiled module preferred). */
  toolchain: WebAssembly.Module | ArrayBuffer;
  /** Gzipped sysroot tar. */
  sysrootTar: ArrayBuffer | Uint8Array;
}

/**
 * Run clang or wasm-ld once against `rootFs` (the live workspace filesystem)
 * with the sysroot mounted at /sys. Works on any thread.
 */
export async function runToolchain(
  operation: ToolchainOperation,
  rootFs: WasiFs,
  assets: ToolchainAssets,
): Promise<ToolchainRunResult> {
  const sysroot = await extractSysroot(assets.sysrootTar);
  const fs = new RoutedFs(rootFs, [{ prefix: SYSROOT_PREFIX, fs: sysroot }]);
  const args =
    operation.operation === "compile"
      ? compileCommand(operation.sourcePath, operation.outputPath, operation.options)
      : linkCommand(operation.objectPaths, operation.outputPath, operation.options);

  let diagnostics = "";
  const decoder = new TextDecoder();
  const append = (chunk: Uint8Array) => {
    diagnostics += decoder.decode(chunk, { stream: true });
  };
  const { exitCode } = await executeWasi({
    binary: assets.toolchain,
    args,
    env: {},
    fs,
    preopens: ["/", "/home/web"],
    stdin: () => null,
    stdout: append,
    stderr: append,
  });
  return { exitCode, diagnostics };
}
