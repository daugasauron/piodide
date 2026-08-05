/**
 * Agent tools executed inside pyodide's in-browser sandbox.
 *
 *   python  -> run Python code (stdout/stderr streamed live + returned)
 *   read    -> read a file from the MEMFS
 *   write   -> create/overwrite a file in the MEMFS
 *   edit    -> exact string replacements in a MEMFS file
 *   download -> save a MEMFS file through the browser
 *   git     -> canonical Git repositories through Slop + libgit2 Wasm
 *   image   -> display an image file from the MEMFS
 *   html_debug -> check an HTML file in a hidden sandbox
 *   html    -> display an HTML file in a sandboxed browser popout
 *   compile_c -> compile one C source file to a wasm32-wasi object
 *   link_wasi -> link object files into a WASI executable
 *   run_wasi -> run a WASI executable against the live Pyodide MEMFS
 *   compile_raylib -> build one C source into a callable raylib module
 *   raylib -> validate and open the module's software framebuffer
 *   slop    -> run one shell command line (pipes, redirects, expansion)
 *
 * `read`/`write`/`edit` deliberately use the *same* MEMFS that `python` sees,
 * so a file written by `write` is immediately importable / readable by Python.
 * WASI programs share that same filesystem live (no copying): files they
 * create or modify are visible to Python and the editor while they run.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  type Pyodide,
  fsExists,
  fsIsDir,
  fsReadText,
  fsResolve,
  fsWriteText,
  runPythonCapture,
} from "./pyodide-host.ts";
import {
  createGitTool,
  type GitHubCredentials,
} from "./git-tool.ts";
import { downloadPyodideFile } from "./file-transfer.ts";
import { runToolchainInBrowser } from "./c-compiler.ts";
import { runWasiProgram } from "./wasi/browser-runner.ts";
import { runSlopCommand } from "./slop.ts";
import {
  ensureRaylibInstalled,
  raylibIncludePath,
  RAYLIB_OBJECT_PATHS,
  RAYLIB_WASM_EXPORTS,
  validateRaylibModule,
} from "./raylib.ts";

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 50_000;
const MAX_FETCH_BYTES = 50_000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const MAX_C_SOURCE_BYTES = 256 * 1024;
const MAX_WASI_STDIN_BYTES = 64 * 1024;
const MAX_WASI_OUTPUT_CHARS = 100_000;

function text(t: string) {
  return { type: "text" as const, text: t };
}

/* ------------------------------- schemas ------------------------------- */

const PythonParams = Type.Object({
  code: Type.String({
    description:
      "Valid CPython code to run as a top-level script; print() for output. " +
      "Never use notebook `!` commands, pip, os.system, or subprocess. " +
      "Install a pure-Python package with `import micropip; await micropip.install('pkg')`.",
  }),
});

const ReadParams = Type.Object({
  path: Type.String({ description: "Absolute or relative (to /home/web) file path." }),
  offset: Type.Optional(Type.Number({ description: "1-based line number to start at." })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return." })),
});

const WriteParams = Type.Object({
  path: Type.String({ description: "Absolute or relative (to /home/web) file path." }),
  content: Type.String({ description: "The full file contents to write." }),
});

const EditParams = Type.Object({
  path: Type.String({ description: "Absolute or relative (to /home/web) file path." }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({ description: "Exact text to find (must be unique in the file)." }),
      newText: Type.String({ description: "Text to replace it with." }),
    }),
    { description: "One or more exact replacements to apply in order." },
  ),
});

const DownloadParams = Type.Object({
  path: Type.String({
    description: "File in the in-browser filesystem to save through the browser.",
  }),
});

const FetchParams = Type.Object({
  url: Type.String({ description: "Absolute URL to fetch (http/https)." }),
  method: Type.Optional(
    Type.Union([Type.Literal("GET"), Type.Literal("POST")], { description: "HTTP method (default GET)." }),
  ),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Request headers." })),
  body: Type.Optional(Type.String({ description: "Request body for POST." })),
  path: Type.Optional(
    Type.String({
      description:
        "Optional destination in /home/web. Binary responses are written here but not displayed.",
    }),
  ),
});

const ImageParams = Type.Object({
  path: Type.String({
    description: "PNG, JPEG, GIF, or WebP file in the in-browser filesystem.",
  }),
});

const HtmlParams = Type.Object({
  path: Type.String({
    description: "Self-contained HTML file in the in-browser filesystem.",
  }),
});

const HtmlDebugParams = Type.Object({
  path: Type.String({
    description: "Self-contained HTML file in the in-browser filesystem.",
  }),
  settleMs: Type.Optional(
    Type.Number({
      minimum: 100,
      maximum: 5000,
      description: "Time after load to capture asynchronous errors (default 1000 ms).",
    }),
  ),
});

const CompileCParams = Type.Object({
  path: Type.String({
    description: "C source file in the in-browser filesystem.",
  }),
  output: Type.Optional(
    Type.String({
      description: "Destination .o file. Defaults to the source path with an .o suffix.",
    }),
  ),
  standard: Type.Optional(
    Type.Union([Type.Literal("c11"), Type.Literal("c17")], {
      description: "C language standard. The legacy toolchain defaults to C11.",
    }),
  ),
  optimization: Type.Optional(
    Type.Union(
      [
        Type.Literal("0"),
        Type.Literal("1"),
        Type.Literal("2"),
        Type.Literal("3"),
        Type.Literal("s"),
      ],
      { description: "Optimization level matching -O0 through -O3 or -Os. Defaults to -O2." },
    ),
  ),
  debug: Type.Optional(Type.Boolean({ description: "Emit DWARF 4 debug information." })),
  warnings: Type.Optional(
    Type.Boolean({ description: "Enable the supported -Wall and -Wextra warning groups." }),
  ),
  warningsAsErrors: Type.Optional(
    Type.Boolean({ description: "Treat compiler warnings as errors with -Werror." }),
  ),
  defines: Type.Optional(
    Type.Array(Type.String({ maxLength: 256 }), {
      maxItems: 32,
      description: "Preprocessor definitions such as FEATURE=1 (without the -D prefix).",
    }),
  ),
  includeDirs: Type.Optional(
    Type.Array(Type.String({ maxLength: 1024 }), {
      maxItems: 16,
      description: "Additional include directories in /home/web (without the -I prefix).",
    }),
  ),
});

const LinkWasiParams = Type.Object({
  objects: Type.Array(
    Type.String({ description: "wasm32-wasi .o file in /home/web." }),
    { minItems: 1, maxItems: 32, description: "Object files to link, in link order." },
  ),
  output: Type.String({ description: "Destination .wasm executable in /home/web." }),
  exports: Type.Optional(
    Type.Array(Type.String({ maxLength: 128 }), {
      maxItems: 32,
      description: "Additional C symbols to export from the WebAssembly module.",
    }),
  ),
  strip: Type.Optional(Type.Boolean({ description: "Strip symbols and debug information." })),
});

const RunWasiParams = Type.Object({
  path: Type.String({ description: "WASI .wasm executable in /home/web." }),
  args: Type.Optional(
    Type.Array(Type.String(), { maxItems: 32, description: "Command-line arguments." }),
  ),
  stdin: Type.Optional(Type.String({ description: "Text passed to standard input." })),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      maxProperties: 32,
      description: "Environment variables.",
    }),
  ),
});

const CompileRaylibParams = Type.Object({
  path: Type.String({ description: "C source defining game_init() and game_frame(float)." }),
  output: Type.Optional(
    Type.String({ description: "Destination .wasm file (defaults beside the source)." }),
  ),
  optimization: Type.Optional(
    Type.Union(
      [Type.Literal("0"), Type.Literal("1"), Type.Literal("2"), Type.Literal("3"), Type.Literal("s")],
      { description: "Optimization level; defaults to size optimization (-Os)." },
    ),
  ),
});

const RaylibParams = Type.Object({
  path: Type.String({ description: "Raylib .wasm game produced by compile_raylib." }),
  width: Type.Integer({ minimum: 64, maximum: 1280, description: "Internal framebuffer width." }),
  height: Type.Integer({ minimum: 64, maximum: 720, description: "Internal framebuffer height." }),
  title: Type.Optional(Type.String({ maxLength: 120, description: "Preview title." })),
});

const SlopParams = Type.Object({
  command: Type.String({
    description:
      "One shell command line: pipes (|), redirects (> and >>), &&/|| short-circuit " +
      "lists, ; sequences, $VAR/${VAR}/$? expansion, and quotes. Runs via /bin/slop.",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the fresh shell (default /home/web)." }),
  ),
});

/* ------------------------------- details ------------------------------- */

export interface PythonDetails {
  ok: boolean;
  bytes: number;
}
export interface ReadDetails {
  path: string;
  lines: number;
  truncated: boolean;
}
export interface WriteDetails {
  path: string;
  bytes: number;
}
export interface EditDetails {
  path: string;
  edits: number;
}
export interface DownloadDetails {
  path: string;
  name: string;
  bytes: number;
}
export interface ImageDetails {
  path: string;
  bytes: number;
  mimeType: string;
}
export interface HtmlDetails {
  path: string;
  bytes: number;
}
export interface HtmlDebugDetails extends HtmlDetails {
  durationMs: number;
  messages: string[];
}
export interface CompileCDetails {
  path: string;
  output: string;
  bytes: number;
  durationMs: number;
}
export interface LinkWasiDetails {
  output: string;
  objects: number;
  bytes: number;
  durationMs: number;
}
export interface RunWasiDetails {
  path: string;
  exitCode: number;
  outputBytes: number;
  truncated: boolean;
}
export interface CompileRaylibDetails {
  path: string;
  output: string;
  bytes: number;
  durationMs: number;
}
export interface RaylibDetails {
  path: string;
  bytes: number;
  width: number;
  height: number;
  title: string;
}
export interface SlopDetails {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputBytes: number;
  truncated: boolean;
  stream?: "stdout" | "stderr";
}

/* ------------------------------- python -------------------------------- */

export function createPythonTool(py: Pyodide): AgentTool<typeof PythonParams, PythonDetails> {
  return {
    name: "python",
    label: "Python",
    description:
      "Execute Python 3 code in the in-browser pyodide sandbox. stdout and stderr are " +
      "captured and returned. The filesystem you see here (open/read/write files, os, " +
      "pathlib) is the SAME in-browser filesystem the read/write/edit/image tools use. " +
      "Print results; do not rely on return values. Pass valid CPython—never notebook " +
      "`!` commands, pip, os.system, or subprocess. Install pure-Python packages with " +
      "`import micropip; await micropip.install('pkg')`.",
    parameters: PythonParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, onUpdate) {
      const { output } = await runPythonCapture(py, params.code, (chunk) => {
        // Surface the live chunk as a partial result so the UI can stream it.
        onUpdate?.({
          content: [text(chunk)],
          details: { ok: true, bytes: chunk.length },
        });
      });
      return {
        content: [text(output.length > 0 ? output : "(no output)\n")],
        details: { ok: true, bytes: output.length },
      };
    },
  };
}

/* ------------------------------ compile C ------------------------------ */

export function createCompileCTool(
  py: Pyodide,
): AgentTool<typeof CompileCParams, CompileCDetails> {
  return {
    name: "compile_c",
    label: "Compile C",
    description:
      "Compile one C source file from /home/web to a wasm32-wasi .o object file. " +
      "Supports bounded C standard, optimization, warning, debug, define, and include " +
      "controls. Quoted local headers are read from the same Pyodide workspace. Use " +
      "link_wasi afterward to create an executable.",
    parameters: CompileCParams,
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const path = fsResolve(py, params.path);
      if (!fsExists(py, path)) throw new Error(`File not found: ${path}`);
      if (fsIsDir(py, path)) throw new Error(`Path is a directory: ${path}`);
      if (!isWasmWorkspacePath(path)) {
        throw new Error("C source must be inside the shared /home/web workspace.");
      }

      const sourceBytes = py.FS.stat(path).size;
      if (sourceBytes > MAX_C_SOURCE_BYTES) {
        throw new Error(`C source exceeds the ${MAX_C_SOURCE_BYTES / 1024} KiB POC limit.`);
      }

      const defaultOutput = path.toLowerCase().endsWith(".c")
        ? `${path.slice(0, -2)}.o`
        : `${path}.o`;
      const output = fsResolve(py, params.output ?? defaultOutput);
      if (!isToolchainPath(output)) {
        throw new Error("C compiler output must be inside /home/web or /bin.");
      }
      if (!output.toLowerCase().endsWith(".o")) {
        throw new Error("C compiler output must end in .o.");
      }
      if (output === path) throw new Error("C compiler output cannot overwrite the source file.");

      const defines = params.defines ?? [];
      for (const define of defines) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*(?:=.*)?$/.test(define)) {
          throw new Error(`Invalid preprocessor definition: ${define}`);
        }
      }
      const includePaths = (params.includeDirs ?? []).map((value) => {
        const includePath = fsResolve(py, value);
        if (!isWasmWorkspacePath(includePath)) {
          throw new Error(`Include directory must be inside /home/web: ${includePath}`);
        }
        if (!fsExists(py, includePath) || !fsIsDir(py, includePath)) {
          throw new Error(`Include directory not found: ${includePath}`);
        }
        return includePath;
      });

      const startedAt = performance.now();
      const result = await runToolchainInBrowser(
        py,
        {
          operation: "compile",
          sourcePath: path,
          outputPath: output,
          options: {
            standard: params.standard,
            optimization: params.optimization,
            debug: params.debug,
            warnings: params.warnings,
            warningsAsErrors: params.warningsAsErrors,
            defines,
            includePaths,
          },
        },
        signal,
      );
      if (!fsExists(py, output)) throw new Error("Clang produced no output file.");
      const outputBytes = py.FS.stat(output).size;
      const durationMs = Math.round(performance.now() - startedAt);
      const summary = `Compiled ${path} -> ${output} (${outputBytes} bytes).`;
      return {
        content: [text(result.diagnostics ? `${summary}\n${result.diagnostics}` : `${summary}\n`)],
        details: { path, output, bytes: outputBytes, durationMs },
      };
    },
  };
}

/* ------------------------------- link WASI ------------------------------ */

export function createLinkWasiTool(
  py: Pyodide,
): AgentTool<typeof LinkWasiParams, LinkWasiDetails> {
  return {
    name: "link_wasi",
    label: "Link WASI",
    description:
      "Link one or more wasm32-wasi .o files from the shared /home/web Pyodide " +
      "filesystem into a WASI .wasm executable using wasm-ld and the bundled WASI libc. " +
      "Can export selected symbols or strip the result.",
    parameters: LinkWasiParams,
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const objects = params.objects.map((value) => {
        const path = fsResolve(py, value);
        if (!isToolchainPath(path)) throw new Error(`Object file must be inside /home/web or /bin: ${path}`);
        if (!fsExists(py, path)) throw new Error(`Object file not found: ${path}`);
        if (fsIsDir(py, path)) throw new Error(`Object file is a directory: ${path}`);
        if (!path.toLowerCase().endsWith(".o")) {
          throw new Error(`Object file must end in .o: ${path}`);
        }
        return path;
      });
      const output = fsResolve(py, params.output);
      if (!isToolchainPath(output)) {
        throw new Error("WASI linker output must be inside /home/web or /bin.");
      }
      if (!output.toLowerCase().endsWith(".wasm") && !output.startsWith("/bin/")) {
        throw new Error("WASI linker output must end in .wasm (or live in /bin).");
      }
      const exports = params.exports ?? [];
      for (const symbol of exports) {
        if (!/^[A-Za-z_.$][A-Za-z0-9_.$]*$/.test(symbol)) {
          throw new Error(`Invalid exported symbol: ${symbol}`);
        }
      }

      const startedAt = performance.now();
      const result = await runToolchainInBrowser(
        py,
        {
          operation: "link",
          objectPaths: objects,
          outputPath: output,
          options: { exports, strip: params.strip },
        },
        signal,
      );
      if (!fsExists(py, output)) throw new Error("wasm-ld produced no output file.");
      const outputBytes = py.FS.stat(output).size;
      const durationMs = Math.round(performance.now() - startedAt);
      const summary =
        `Linked ${objects.length} object file${objects.length === 1 ? "" : "s"} -> ${output} ` +
        `(${outputBytes} bytes).`;
      return {
        content: [text(result.diagnostics ? `${summary}\n${result.diagnostics}` : `${summary}\n`)],
        details: {
          output,
          objects: objects.length,
          bytes: outputBytes,
          durationMs,
        },
      };
    },
  };
}

/* -------------------------------- run WASI ------------------------------ */

export function createRunWasiTool(
  py: Pyodide,
): AgentTool<typeof RunWasiParams, RunWasiDetails> {
  return {
    name: "run_wasi",
    label: "Run WASI",
    description:
      "Run a WASI .wasm executable from /home/web. The program shares the live " +
      "Pyodide filesystem: files it creates, edits, or deletes are immediately " +
      "visible to Python and the other tools. stdout and stderr are returned.",
    parameters: RunWasiParams,
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate) {
      const path = fsResolve(py, params.path);
      requireWorkspaceFile(py, path, "WASI executable");
      if (!path.toLowerCase().endsWith(".wasm")) {
        throw new Error("WASI executable must end in .wasm.");
      }
      const stdin = params.stdin ?? "";
      if (byteLength(stdin) > MAX_WASI_STDIN_BYTES) {
        throw new Error(`WASI stdin exceeds the ${MAX_WASI_STDIN_BYTES / 1024} KiB limit.`);
      }

      let output = "";
      let outputTruncated = false;
      const appendOutput = (chunk: string) => {
        if (output.length >= MAX_WASI_OUTPUT_CHARS) {
          outputTruncated = true;
          return;
        }
        const remaining = MAX_WASI_OUTPUT_CHARS - output.length;
        output += chunk.slice(0, remaining);
        if (chunk.length > remaining) outputTruncated = true;
      };

      const result = await runWasiProgram(
        py,
        {
          executablePath: path,
          args: params.args ?? [],
          stdin,
          env: params.env ?? {},
          onStdout: appendOutput,
          onStderr: appendOutput,
        },
        signal,
      );
      const renderedOutput = output + (outputTruncated ? "\n…<WASI output truncated>\n" : "");
      if (renderedOutput) {
        onUpdate?.({
          content: [text(renderedOutput)],
          details: {
            path,
            exitCode: result.exitCode,
            outputBytes: byteLength(output),
            truncated: outputTruncated,
          },
        });
      }
      return {
        content: [text(renderedOutput || "(no output)\n")],
        details: {
          path,
          exitCode: result.exitCode,
          outputBytes: byteLength(output),
          truncated: outputTruncated,
        },
      };
    },
  };
}

/* ------------------------------ raylib --------------------------------- */

export function createCompileRaylibTool(
  py: Pyodide,
): AgentTool<typeof CompileRaylibParams, CompileRaylibDetails> {
  return {
    name: "compile_raylib",
    label: "Compile raylib",
    description:
      "Compile and link one C source file into an interactive raylib 6 WASI framebuffer game. " +
      "Include raylib.h and define exactly `void game_init(void)` plus " +
      "`void game_frame(float delta_seconds)`. The browser supplies the frame loop and maps " +
      "raylib keyboard, mouse, and touch input. The raylib preview automatically supplies the " +
      "module's WASI imports; do not build an HTML or JavaScript host. SetTargetFPS is unnecessary. " +
      "Audio and rmodels are not included. " +
      "Use the raylib tool afterward to validate and display the game.",
    parameters: CompileRaylibParams,
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const path = fsResolve(py, params.path);
      requireWorkspaceFile(py, path, "Raylib source");
      if (!path.toLowerCase().endsWith(".c")) throw new Error("Raylib source must end in .c.");
      const sourceBytes = py.FS.stat(path).size;
      if (sourceBytes > MAX_C_SOURCE_BYTES) {
        throw new Error(`C source exceeds the ${MAX_C_SOURCE_BYTES / 1024} KiB limit.`);
      }
      const output = fsResolve(
        py,
        params.output ?? `${path.slice(0, -2)}.wasm`,
      );
      if (!isWasmWorkspacePath(output) || !output.toLowerCase().endsWith(".wasm")) {
        throw new Error("Raylib output must be a .wasm file inside /home/web.");
      }
      if (output === path) throw new Error("Raylib output cannot overwrite its source.");

      await ensureRaylibInstalled(py);
      const object = `${output}.raylib.o`;
      const startedAt = performance.now();
      try {
        const compiled = await runToolchainInBrowser(
          py,
          {
            operation: "compile",
            sourcePath: path,
            outputPath: object,
            options: {
              standard: "c17",
              optimization: params.optimization ?? "s",
              warnings: true,
              includePaths: [raylibIncludePath()],
              functionSections: true,
            },
          },
          signal,
        );
        const linked = await runToolchainInBrowser(
          py,
          {
            operation: "link",
            objectPaths: [object, ...RAYLIB_OBJECT_PATHS],
            outputPath: output,
            options: {
              exports: [...RAYLIB_WASM_EXPORTS],
              strip: true,
              reactor: true,
              systemLibraries: ["m"],
            },
          },
          signal,
        );
        if (!fsExists(py, output)) throw new Error("Raylib linker produced no output file.");
        const bytes = py.FS.stat(output).size;
        const diagnostics = [compiled.diagnostics, linked.diagnostics].filter(Boolean).join("\n");
        const summary = `Compiled raylib game ${path} -> ${output} (${bytes} bytes).`;
        return {
          content: [text(diagnostics ? `${summary}\n${diagnostics}` : `${summary}\n`)],
          details: {
            path,
            output,
            bytes,
            durationMs: Math.round(performance.now() - startedAt),
          },
        };
      } finally {
        if (fsExists(py, object)) py.FS.unlink(object);
      }
    },
  };
}

export function createRaylibTool(
  py: Pyodide,
): AgentTool<typeof RaylibParams, RaylibDetails> {
  return {
    name: "raylib",
    label: "Raylib preview",
    description:
      "Validate and open a compile_raylib-produced game in the full-screen framebuffer preview. " +
      "The canvas scales to the device while retaining the requested internal resolution. " +
      "Call this exactly once, after compilation succeeds.",
    parameters: RaylibParams,
    executionMode: "sequential",
    async execute(_id, params) {
      const path = fsResolve(py, params.path);
      requireWorkspaceFile(py, path, "Raylib game");
      if (!path.toLowerCase().endsWith(".wasm")) throw new Error("Raylib game must end in .wasm.");
      await validateRaylibModule(py, path, params.width, params.height);
      const bytes = py.FS.stat(path).size;
      const title = params.title?.trim() || path;
      return {
        content: [text(`Raylib framebuffer ready: ${path} (${params.width}×${params.height}, ${bytes} bytes)\n`)],
        details: { path, bytes, width: params.width, height: params.height, title },
      };
    },
  };
}

/* ------------------------------- slop shell ----------------------------- */

export function createSlopTool(
  py: Pyodide,
  getGitHubCredentials: () => GitHubCredentials | null = () => null,
): AgentTool<typeof SlopParams, SlopDetails> {
  return {
    name: "slop",
    label: "Slop shell",
    description:
      "Run one command line in the slop shell against the live Pyodide filesystem. " +
      "Supports pipes (|), stdout/stderr redirects, &&/|| short-circuit lists, ; sequences, " +
      "$VAR/${VAR}/$?/$(command)/$((arithmetic)) expansion, globbing, and quotes. " +
      "$PATH is exactly /bin and includes bounded file utilities, uniq, and xargs. Host-routed " +
      "cc/ld compile and link WASI programs; libgit2 provides Git-compatible repositories, " +
      "with GitHub clone/pull/push over browser fetch; curl is also CORS-limited. " +
      "Each call is a fresh " +
      "shell: cwd does not persist between calls (pass cwd instead), but every file " +
      "change does. stdout, stderr, and the exit code are returned.",
    parameters: SlopParams,
    executionMode: "sequential",
    async execute(_id, params, signal, onUpdate) {
      const cwd = params.cwd ? fsResolve(py, params.cwd) : "/home/web";
      if (!fsExists(py, cwd) || !fsIsDir(py, cwd)) {
        throw new Error(`Not a directory: ${cwd}`);
      }
      if (byteLength(params.command) > MAX_WASI_STDIN_BYTES) {
        throw new Error("Command line too long.");
      }

      let stdout = "";
      let stderr = "";
      let truncated = false;
      let outputLength = 0;
      const append = (channel: "stdout" | "stderr", chunk: string) => {
        if (outputLength >= MAX_WASI_OUTPUT_CHARS) {
          truncated = true;
          return "";
        }
        const remaining = MAX_WASI_OUTPUT_CHARS - outputLength;
        const captured = chunk.slice(0, remaining);
        if (channel === "stdout") stdout += captured;
        else stderr += captured;
        outputLength += captured.length;
        if (chunk.length > remaining) truncated = true;
        return captured;
      };

      const emitUpdate = (channel: "stdout" | "stderr", chunk: string) => {
        onUpdate?.({
          content: [text(chunk)],
          details: {
            command: params.command,
            cwd,
            exitCode: -1,
            stdout,
            stderr,
            stdoutBytes: byteLength(stdout),
            stderrBytes: byteLength(stderr),
            outputBytes: byteLength(stdout) + byteLength(stderr),
            truncated,
            stream: channel,
          },
        });
      };

      const result = await runSlopCommand(
        py,
        params.command,
        {
          cwd,
          onStdout: (chunk) => {
            const captured = append("stdout", chunk);
            if (captured) emitUpdate("stdout", captured);
          },
          onStderr: (chunk) => {
            const captured = append("stderr", chunk);
            if (captured) emitUpdate("stderr", captured);
          },
          signal,
          getGitHubCredentials,
        },
      );

      const renderChannel = (name: string, value: string) => {
        const body = value || "(empty)\n";
        return `${name}:\n${body}${body.endsWith("\n") ? "" : "\n"}`;
      };
      const rendered =
        renderChannel("stdout", stdout) +
        renderChannel("stderr", stderr) +
        (truncated ? "\n…<slop output truncated>\n" : "") +
        `[exit ${result.exitCode}]\n`;
      return {
        content: [text(rendered)],
        details: {
          command: params.command,
          cwd,
          exitCode: result.exitCode,
          stdout,
          stderr,
          stdoutBytes: byteLength(stdout),
          stderrBytes: byteLength(stderr),
          outputBytes: byteLength(stdout) + byteLength(stderr),
          truncated,
        },
      };
    },
  };
}

/* -------------------------------- read -------------------------------- */

export function createReadTool(py: Pyodide): AgentTool<typeof ReadParams, ReadDetails> {
  return {
    name: "read",
    label: "Read",
    description:
      "Read a text file from the in-browser filesystem. Returns the contents with line " +
      "numbers. Use offset (1-based line) and limit (line count) to page through large files. " +
      "Paths are relative to /home/web.",
    parameters: ReadParams,
    async execute(_id, params) {
      const path = fsResolve(py, params.path);
      if (!fsExists(py, path)) throw new Error(`File not found: ${path}`);
      if (fsIsDir(py, path)) throw new Error(`Path is a directory: ${path}`);

      const raw = fsReadText(py, path);
      const allLines = raw.split("\n");
      if (raw.endsWith("\n")) allLines.pop();

      const offset = Math.max(1, params.offset ?? 1);
      const limit = params.limit ?? MAX_READ_LINES;
      const start = offset - 1;
      const slice = allLines.slice(start, start + limit);

      let body = slice.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
      const truncated = body.length > MAX_READ_BYTES;
      if (truncated) body = body.slice(0, MAX_READ_BYTES) + "\n…<truncated>";

      const header = `<${path}>`;
      const footer =
        allLines.length > slice.length + start
          ? `\n(${slice.length} of ${allLines.length} lines shown; use offset to read more)`
          : "";

      return {
        content: [text(`${header}\n${body}${footer}\n`)],
        details: { path, lines: slice.length, truncated },
      };
    },
  };
}

/* ------------------------------- image -------------------------------- */

export function createImageTool(py: Pyodide): AgentTool<typeof ImageParams, ImageDetails> {
  return {
    name: "image",
    label: "Image",
    description:
      "Display a PNG, JPEG, GIF, or WebP file from the in-browser filesystem directly " +
      "in the terminal using Ghostty's Kitty graphics protocol. This is the only tool " +
      "that displays an image; call it exactly once after creating or downloading the file.",
    parameters: ImageParams,
    async execute(_id, params) {
      const path = fsResolve(py, params.path);
      if (!fsExists(py, path)) throw new Error(`File not found: ${path}`);
      if (fsIsDir(py, path)) throw new Error(`Path is a directory: ${path}`);
      const bytes = py.FS.readFile(path) as Uint8Array;
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`Image exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit.`);
      }
      const mimeType = detectImageMime(bytes, path);
      if (!mimeType) throw new Error(`Unsupported image format: ${path}`);
      return {
        content: [
          text(`Displaying ${path} (${bytes.byteLength} bytes)\n`),
          { type: "image" as const, data: bytesToBase64(bytes), mimeType },
        ],
        details: { path, bytes: bytes.byteLength, mimeType },
      };
    },
  };
}

/* -------------------------------- html --------------------------------- */

const HTML_DEBUG_CHANNEL = "piodide-html-debug";
const MAX_HTML_DEBUG_MESSAGES = 40;
const MAX_HTML_DEBUG_MESSAGE_LENGTH = 1000;

interface HtmlDebugReport {
  channel: typeof HTML_DEBUG_CHANNEL;
  token: string;
  kind: "ready" | "load" | "console" | "error";
  level?: "log" | "info" | "warn" | "error";
  message?: string;
}

/** Inject diagnostics before the page's own scripts without changing its origin. */
export function instrumentHtmlForDebug(html: string, token: string): string {
  const prelude = `<script>(() => {
  const channel = ${JSON.stringify(HTML_DEBUG_CHANNEL)};
  const token = ${JSON.stringify(token)};
  const send = (kind, detail = {}) => parent.postMessage({ channel, token, kind, ...detail }, "*");
  const format = (value) => {
    if (value instanceof Error) return value.stack || (value.name + ": " + value.message);
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...values) => {
      send("console", { level, message: values.map(format).join(" ") });
      original(...values);
    };
  }
  addEventListener("error", (event) => {
    if (event.target !== window) {
      const target = event.target;
      const location = target?.src || target?.href || target?.currentSrc || "";
      send("error", { message: "Resource failed: " + (target?.tagName || "unknown") + (location ? " " + location : "") });
      return;
    }
    send("error", { message: event.error?.stack || event.message || "Unknown script error" });
  }, true);
  addEventListener("unhandledrejection", (event) => {
    send("error", { message: "Unhandled promise rejection: " + format(event.reason) });
  });
  addEventListener("load", () => send("load"), { once: true });
  send("ready");
})();</script>`;

  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head?.index !== undefined) {
    const offset = head.index + head[0].length;
    return html.slice(0, offset) + prelude + html.slice(offset);
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const offset = doctype?.[0].length ?? 0;
  return html.slice(0, offset) + prelude + html.slice(offset);
}

function htmlDebugMessage(report: HtmlDebugReport): string {
  const prefix = report.kind === "console" ? `[console.${report.level}] ` : "";
  return (prefix + (report.message ?? ""))
    .replace(/[\r\n]+/g, " ")
    .slice(0, MAX_HTML_DEBUG_MESSAGE_LENGTH);
}

export function createHtmlDebugTool(
  py: Pyodide,
): AgentTool<typeof HtmlDebugParams, HtmlDebugDetails> {
  return {
    name: "html_debug",
    label: "HTML debug",
    description:
      "Run a self-contained HTML file in an invisible opaque-origin sandbox before showing " +
      "it. Captures console output, console errors, uncaught exceptions, unhandled promise " +
      "rejections, and resource failures. Fix reported errors and rerun this tool until it " +
      "passes, then call html exactly once for the user-visible result.",
    parameters: HtmlDebugParams,
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const path = fsResolve(py, params.path);
      if (!fsExists(py, path)) throw new Error(`File not found: ${path}`);
      if (fsIsDir(py, path)) throw new Error(`Path is a directory: ${path}`);

      const html = fsReadText(py, path);
      const bytes = byteLength(html);
      if (bytes > MAX_HTML_BYTES) {
        throw new Error(`HTML exceeds the ${MAX_HTML_BYTES / 1024 / 1024} MB limit.`);
      }

      const settleMs = Math.max(100, Math.min(5000, params.settleMs ?? 1000));
      const token = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;
      const iframe = document.createElement("iframe");
      iframe.dataset.htmlDebug = "true";
      iframe.setAttribute("aria-hidden", "true");
      iframe.setAttribute("tabindex", "-1");
      iframe.inert = true;
      iframe.setAttribute("sandbox", "allow-scripts allow-forms");
      iframe.setAttribute("referrerpolicy", "no-referrer");
      iframe.style.cssText =
        "position:fixed;inset:0;width:100vw;height:100vh;border:0;opacity:0;" +
        "pointer-events:none;z-index:-1";

      const reports: HtmlDebugReport[] = [];
      const errors = new Set<string>();
      let ready = false;
      let loaded = false;
      let settleTimer = 0;
      let hardTimer = 0;
      let cleanup = () => {};
      const startedAt = performance.now();

      await new Promise<void>((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          window.clearTimeout(settleTimer);
          window.clearTimeout(hardTimer);
          resolve();
        };
        const onMessage = (event: MessageEvent) => {
          const report = event.data as Partial<HtmlDebugReport> | null;
          if (
            event.source !== iframe.contentWindow ||
            report?.channel !== HTML_DEBUG_CHANNEL ||
            report.token !== token
          ) return;
          if (report.kind === "ready") ready = true;
          if (report.kind === "load") {
            loaded = true;
            window.clearTimeout(hardTimer);
            window.clearTimeout(settleTimer);
            settleTimer = window.setTimeout(finish, settleMs);
          }
          if (report.kind === "console" || report.kind === "error") {
            const normalized = htmlDebugMessage(report as HtmlDebugReport);
            if (reports.length < MAX_HTML_DEBUG_MESSAGES) {
              reports.push(report as HtmlDebugReport);
            }
            if (report.kind === "error" || report.level === "error") errors.add(normalized);
          }
        };
        const onAbort = () => {
          errors.add("HTML debug aborted");
          finish();
        };
        cleanup = () => {
          window.removeEventListener("message", onMessage);
          signal?.removeEventListener("abort", onAbort);
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        window.addEventListener("message", onMessage);
        signal?.addEventListener("abort", onAbort, { once: true });
        hardTimer = window.setTimeout(() => {
          errors.add("Page did not finish loading within 5 seconds");
          finish();
        }, 5000);
        document.body.append(iframe);
        iframe.srcdoc = instrumentHtmlForDebug(html, token);
      });

      cleanup();
      iframe.remove();
      if (!ready) errors.add("Debug instrumentation did not start");
      if (!loaded) errors.add("Page load event was not reached");
      const durationMs = Math.round(performance.now() - startedAt);
      const messages = reports.map(htmlDebugMessage).filter(Boolean);
      if (errors.size > 0) {
        throw new Error(`HTML debug failed for ${path}:\n${[...errors].map((error) => `- ${error}`).join("\n")}`);
      }

      const output = messages.length > 0
        ? `\n${messages.join("\n")}`
        : "";
      return {
        content: [text(`HTML debug passed: ${path} (${bytes} bytes, ${durationMs} ms)${output}\n`)],
        details: { path, bytes, durationMs, messages },
      };
    },
  };
}

export function createHtmlTool(py: Pyodide): AgentTool<typeof HtmlParams, HtmlDetails> {
  return {
    name: "html",
    label: "HTML",
    description:
      "Open a self-contained HTML file from the in-browser filesystem in a full-screen " +
      "browser preview. Write the file first, then call this tool exactly once. Put CSS " +
      "and JavaScript inline; embed images, data, and Wasm bytes in that file because other " +
      "MEMFS paths are not addressable by the iframe. The sandbox has an opaque origin, so " +
      "localStorage, sessionStorage, IndexedDB, and relative fetches are unavailable; keep " +
      "runtime state in JavaScript memory.",
    parameters: HtmlParams,
    async execute(_id, params) {
      const path = fsResolve(py, params.path);
      if (!fsExists(py, path)) throw new Error(`File not found: ${path}`);
      if (fsIsDir(py, path)) throw new Error(`Path is a directory: ${path}`);

      const html = fsReadText(py, path);
      const bytes = byteLength(html);
      if (bytes > MAX_HTML_BYTES) {
        throw new Error(`HTML exceeds the ${MAX_HTML_BYTES / 1024 / 1024} MB limit.`);
      }
      return {
        content: [text(`Opened ${path} in the browser preview (${bytes} bytes)\n`)],
        details: { path, bytes },
      };
    },
  };
}

/* ------------------------------- write -------------------------------- */

export function createWriteTool(py: Pyodide): AgentTool<typeof WriteParams, WriteDetails> {
  return {
    name: "write",
    label: "Write",
    description:
      "Create or overwrite a file in the in-browser filesystem. Parent directories are " +
      "created automatically. Use this for new files or full rewrites; prefer edit for " +
      "targeted changes.",
    parameters: WriteParams,
    async execute(_id, params) {
      const path = fsResolve(py, params.path);
      const bytes = byteLength(params.content);
      fsWriteText(py, path, params.content);
      return {
        content: [text(`Wrote ${bytes} bytes to ${path}\n`)],
        details: { path, bytes },
      };
    },
  };
}

/* -------------------------------- edit -------------------------------- */

export function createEditTool(py: Pyodide): AgentTool<typeof EditParams, EditDetails> {
  return {
    name: "edit",
    label: "Edit",
    description:
      "Apply exact string replacements to a file in the in-browser filesystem. Each " +
      "edits[].oldText must match a unique region of the file (case- and " +
      "whitespace-sensitive). All edits in one call apply in order. Throws if any " +
      "oldText is missing or not unique.",
    parameters: EditParams,
    async execute(_id, params) {
      const path = fsResolve(py, params.path);
      if (!fsExists(py, path)) throw new Error(`File not found: ${path}`);
      if (fsIsDir(py, path)) throw new Error(`Path is a directory: ${path}`);

      let content = fsReadText(py, path);
      params.edits.forEach((edit, i) => {
        const count = countOccurrences(content, edit.oldText);
        if (count === 0) {
          throw new Error(
            `Edit #${i + 1} failed: oldText not found in ${path}. Make sure it matches exactly.`,
          );
        }
        if (count > 1) {
          throw new Error(
            `Edit #${i + 1} failed: oldText is not unique (${count} matches) in ${path}. ` +
              `Include more surrounding context so it matches exactly once.`,
          );
        }
        content = content.replace(edit.oldText, edit.newText);
      });

      fsWriteText(py, path, content);
      return {
        content: [text(`Edited ${path}: applied ${params.edits.length} replacement(s).\n`)],
        details: { path, edits: params.edits.length },
      };
    },
  };
}

export function createDownloadTool(
  py: Pyodide,
): AgentTool<typeof DownloadParams, DownloadDetails> {
  return {
    name: "download",
    label: "Download",
    description:
      "Save one file from the in-browser Pyodide filesystem to the user's browser downloads. " +
      "Use this only when the user asks to download or save a generated file locally. " +
      "Directories are not supported.",
    parameters: DownloadParams,
    executionMode: "sequential",
    async execute(_id, params) {
      const result = downloadPyodideFile(py, params.path);
      return {
        content: [text(`Started browser download: ${result.name}\n`)],
        details: result,
      };
    },
  };
}

/* -------------------------------- fetch ------------------------------- */

export interface FetchDetails {
  status: number;
  ok: boolean;
  bytes: number;
  truncated: boolean;
  path?: string;
  mimeType?: string;
}

/** A tool that uses the browser's native fetch (subject to CORS). */
export function createFetchTool(py: Pyodide): AgentTool<typeof FetchParams, FetchDetails> {
  return {
    name: "fetch",
    label: "Fetch",
    description:
      "Fetch a URL using the browser's native fetch. Subject to the browser's CORS rules, " +
      "so it works for public APIs and CORS-enabled sites (not arbitrary cross-origin pages). " +
      "Returns text responses. Set path to save a binary or image response in the shared " +
      "in-browser filesystem. Saving never displays the file; call the image tool exactly " +
      "once when the user wants to see it.",
    parameters: FetchParams,
    async execute(_id, params) {
      const resp = await fetch(params.url, {
        method: params.method ?? "GET",
        headers: params.headers as Record<string, string> | undefined,
        body: params.body,
      });

      const responseType = resp.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (params.path || responseType?.startsWith("image/")) {
        const buffer = await resp.arrayBuffer();
        if (buffer.byteLength > MAX_IMAGE_BYTES) {
          throw new Error(`Response exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB binary limit.`);
        }
        const bytes = new Uint8Array(buffer);
        const path = params.path ? fsResolve(py, params.path) : undefined;
        if (path) {
          const slash = path.lastIndexOf("/");
          if (slash > 0) py.FS.mkdirTree(path.slice(0, slash));
          py.FS.writeFile(path, bytes);
        }
        const mimeType = detectImageMime(bytes, path ?? params.url);
        const summary =
          `HTTP ${resp.status} ${resp.statusText} · ${bytes.byteLength} bytes` +
          `${path ? ` · saved ${path}` : ""}\n`;
        return {
          content: [
            text(summary),
            ...(mimeType && !path
              ? [{ type: "image" as const, data: bytesToBase64(bytes), mimeType }]
              : []),
          ],
          details: {
            status: resp.status,
            ok: resp.ok,
            bytes: bytes.byteLength,
            truncated: false,
            path,
            mimeType: mimeType ?? undefined,
          },
        };
      }

      let body = await resp.text();
      const truncated = body.length > MAX_FETCH_BYTES;
      if (truncated) body = body.slice(0, MAX_FETCH_BYTES) + "\n…<truncated>";
      return {
        content: [text(`HTTP ${resp.status} ${resp.statusText}\n${body}\n`)],
        details: { status: resp.status, ok: resp.ok, bytes: body.length, truncated },
      };
    },
  };
}

/* ------------------------------ helpers ------------------------------- */

function detectImageMime(bytes: Uint8Array, path: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    return "image/gif";
  }
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    return "image/webp";
  }

  const extension = path.toLowerCase().split(/[?#]/, 1)[0].split(".").pop();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(parts.join(""));
}

function isWasmWorkspacePath(path: string): boolean {
  return path.startsWith("/home/web/");
}

/** Toolchain inputs/outputs may also live in /bin (shell commands). */
function isToolchainPath(path: string): boolean {
  return isWasmWorkspacePath(path) || path.startsWith("/bin/");
}

function requireWorkspaceFile(py: Pyodide, path: string, label: string): void {
  if (!isWasmWorkspacePath(path)) throw new Error(`${label} must be inside /home/web: ${path}`);
  if (!fsExists(py, path)) throw new Error(`${label} not found: ${path}`);
  if (fsIsDir(py, path)) throw new Error(`${label} is a directory: ${path}`);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export type AnyTool = AgentTool<any, any>;
export function createAllTools(
  py: Pyodide,
  getGitHubCredentials: () => GitHubCredentials | null,
): AnyTool[] {
  return [
    createPythonTool(py),
    createCompileCTool(py),
    createLinkWasiTool(py),
    createRunWasiTool(py),
    createCompileRaylibTool(py),
    createRaylibTool(py),
    createSlopTool(py, getGitHubCredentials),
    createReadTool(py),
    createWriteTool(py),
    createEditTool(py),
    createDownloadTool(py),
    createGitTool(py, getGitHubCredentials),
    createFetchTool(py),
    createImageTool(py),
    createHtmlDebugTool(py),
    createHtmlTool(py),
  ];
}
