/**
 * slop — the piodide shell.
 *
 * Three consumers share one engine:
 * - SlopSession: the interactive Ctrl+Shift+S shell (long-running /bin/slop
 *   with tty-style input routing).
 * - runSlopCommand: the agent's `slop` tool — one command line per call in
 *   a fresh shell instance (stateless; cwd via parameter).
 * - SlopSpawner: the spawn engine both use (children on $PATH, the
 *   compile/link pseudo-commands routed to the in-browser clang toolchain).
 */
import type { Pyodide } from "./pyodide-host.ts";
import { fsExists, fsIsDir } from "./pyodide-host.ts";
import {
  startWasiProgram,
  type WasiProgramHandle,
} from "./wasi/browser-runner.ts";
import { runToolchainInBrowser } from "./c-compiler.ts";
import { runPythonEntrypoint } from "./python-entrypoint.ts";
import { normalizePath } from "./wasi/abi.ts";
import type { CompileOptions, LinkOptions } from "./wasi/toolchain.ts";

const SHELL_BINARIES = ["slop", "make", "sed", "ar", "ls", "cat", "fd-find", "echo", "env", "grep"];
const COREUTILS = [
  "rm", "cp", "mv", "mkdir", "rmdir", "touch", "ln", "head", "tail", "wc", "sort",
  "cut", "tr", "tee", "basename", "dirname", "seq", "cmp", "install", "readlink", "find", "mktemp",
  "chmod", "uniq", "xargs",
];
const SHELL_SOURCES = [
  "slop.c", "make.c", "coreutils.c", "sed.c", "ar.c", "spawn_stub.c", "patch_import.py",
  "Makefile", "README.md",
  "ls.c", "cat.c", "fd-find.c", "echo.c", "env.c", "grep.c",
];
const MAX_CHILDREN = 32;
const MAX_C_SOURCE_BYTES = 512 * 1024;
const MAX_TOOLCHAIN_INPUTS = 32;
const PYTHON_ENTRYPOINT_MARKER = "piodide host-backed Python entrypoint\n";
/** Pipe captures are bounded so a runaway producer can't eat the page. */
const MAX_CAPTURE_BYTES = 1024 * 1024;

function shellPreopens(cwd: string) {
  return [{ name: ".", path: cwd }, "/home/web", "/", "/bin"];
}

/* ------------------------------ install -------------------------------- */

let installPromise: Promise<void> | null = null;

/** Fetch the committed shell binaries + sources into the MEMFS once. */
export function ensureSlopInstalled(py: Pyodide, note?: (text: string) => void): Promise<void> {
  if (!installPromise) {
    installPromise = (async () => {
      if (fsExists(py, "/bin/slop")) {
        installPythonEntrypoints(py);
        return;
      }
      note?.("  installing slop into /bin …");
      const base = import.meta.env.BASE_URL;
      py.FS.mkdirTree("/bin");
      py.FS.mkdirTree("/home/web/slop");
      for (const name of SHELL_BINARIES) {
        const response = await fetch(`${base}slop/bin/${name}`);
        if (!response.ok) throw new Error(`could not fetch ${name} (HTTP ${response.status})`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        py.FS.writeFile(`/bin/${name}`, bytes);
        if (name === "slop") py.FS.writeFile("/bin/sh", bytes);
      }
      const coreutilsResponse = await fetch(`${base}slop/bin/coreutils`);
      if (!coreutilsResponse.ok) {
        throw new Error(`could not fetch coreutils (HTTP ${coreutilsResponse.status})`);
      }
      const coreutils = new Uint8Array(await coreutilsResponse.arrayBuffer());
      for (const name of COREUTILS) py.FS.writeFile(`/bin/${name}`, coreutils);
      installPythonEntrypoints(py);
      try {
        for (const name of SHELL_SOURCES) {
          const response = await fetch(`${base}slop/src/${name}`);
          if (response.ok) py.FS.writeFile(`/home/web/slop/${name}`, await response.text());
        }
      } catch {
        // Sources are a convenience, not a requirement.
      }
    })();
    // A failed install should be retried on the next attempt.
    installPromise.catch(() => {
      installPromise = null;
    });
  }
  return installPromise;
}

function installPythonEntrypoints(py: Pyodide): void {
  for (const name of ["python", "python3"]) {
    const path = `/bin/${name}`;
    if (!fsExists(py, path)) py.FS.writeFile(path, PYTHON_ENTRYPOINT_MARKER);
    py.FS.chmod(path, 0o755);
  }
}

/* ------------------------------- spawner -------------------------------- */

interface SpawnRequest {
  path: string;
  args: string[];
  cwd: string;
  stdinText?: Uint8Array;
  capture?: boolean;
  outFile?: string;
  append?: boolean;
  errFile?: string;
  errAppend?: boolean;
  stderrToStdout?: boolean;
  /** Exported environment supplied by the spawning shell (spawn ABI v3). */
  env?: Record<string, string>;
}

interface SpawnResult {
  exitCode: number;
  stdout?: Uint8Array;
}

interface SlopSpawnerDeps {
  py: Pyodide;
  writeOut: (text: string) => void;
  writeError: (text: string) => void;
  note: (text: string) => void;
  /** Interactive stdin for children (the session's tty buffer; EOF otherwise). */
  childStdin: () => Promise<Uint8Array | null> | Uint8Array | null;
  signal?: AbortSignal;
}

/** Runs the programs slop spawns (PATH commands, pseudo-commands, nesting). */
export class SlopSpawner {
  /** The currently running direct child (for Ctrl+C kill). */
  foreground: WasiProgramHandle | null = null;
  private activeChildren = 0;
  private deps: SlopSpawnerDeps;

  constructor(deps: SlopSpawnerDeps) {
    this.deps = deps;
  }

  async onSpawn(request: SpawnRequest): Promise<SpawnResult> {
    const {
      path, args, cwd, stdinText, capture, outFile, append,
      errFile, errAppend, stderrToStdout, env,
    } = request;
    if (["python", "python3"].includes(path.split("/").pop() ?? path)) {
      return this.python(request);
    }
    if (path === "compile" || path === "cc") {
      return this.toolchain(request, "compile");
    }
    if (path === "link" || path === "ld") {
      return this.toolchain(request, "link");
    }

    if (this.activeChildren >= MAX_CHILDREN) {
      this.deps.writeError(`slop: too many nested programs\r\n`);
      return { exitCode: 126 };
    }
    this.activeChildren++;

    // stdout routing: capture for pipes, stream to a file for redirects,
    // or straight to the terminal.
    const captured: Uint8Array[] = [];
    let capturedBytes = 0;
    let fileStream: unknown = null;
    let errorStream: unknown = null;
    let fileError: string | null = null;
    if (outFile) {
      try {
        fileStream = this.deps.py.FS.open(outFile, append ? "a" : "w");
      } catch (error) {
        fileError = error instanceof Error ? error.message : String(error);
      }
    }
    if (!fileError && errFile) {
      try {
        errorStream = this.deps.py.FS.open(errFile, errAppend ? "a" : "w");
      } catch (error) {
        fileError = error instanceof Error ? error.message : String(error);
      }
    }
    if (fileError) {
      if (fileStream !== null) this.deps.py.FS.close(fileStream);
      this.deps.writeError(`slop: ${errFile ?? outFile}: ${fileError}\r\n`);
      this.activeChildren--;
      return { exitCode: 1 };
    }

    const writeChunk = (chunk: Uint8Array) => {
      if (capture) {
        if (capturedBytes + chunk.byteLength <= MAX_CAPTURE_BYTES) {
          captured.push(chunk.slice());
        } else if (capturedBytes < MAX_CAPTURE_BYTES) {
          captured.push(chunk.slice(0, MAX_CAPTURE_BYTES - capturedBytes));
        }
        capturedBytes += chunk.byteLength;
        return;
      }
      const py = this.deps.py;
      py.FS.write(fileStream, chunk, 0, chunk.byteLength);
    };

    const writeError = (text: string) => {
      if (stderrToStdout) {
        if (capture || outFile) writeChunk(new TextEncoder().encode(text));
        else this.deps.writeOut(text);
      } else if (errorStream !== null) {
        const chunk = new TextEncoder().encode(text);
        this.deps.py.FS.write(errorStream, chunk, 0, chunk.byteLength);
      } else {
        this.deps.writeError(text);
      }
    };

    // Piped stdin replaces the session input for this child.
    const stdinProvider = stdinText
      ? (() => {
          let sent = false;
          return () => {
            if (sent) return null;
            sent = true;
            return stdinText;
          };
        })()
      : this.deps.childStdin;

    const handle = startWasiProgram(
      this.deps.py,
      {
        executablePath: path,
        args: args.slice(1),
        env: { PATH: "/bin", PWD: cwd, TERM: "ghostty", ...(env ?? {}) },
        preopens: shellPreopens(cwd),
        interactiveStdin: true,
        stdinProvider,
        timeoutMs: 0,
        spawnHandler: (nested) => this.onSpawn(nested),
        onStdoutBytes: capture || outFile ? writeChunk : undefined,
        onStdout: capture || outFile ? undefined : this.deps.writeOut,
        onStderr: writeError,
      },
      this.deps.signal,
    );
    this.foreground = handle;
    try {
      const result = await handle.result;
      if (fileStream !== null) this.deps.py.FS.close(fileStream);
      if (errorStream !== null) this.deps.py.FS.close(errorStream);
      if (capture) {
        return { exitCode: result.exitCode, stdout: concatChunks(captured, capturedBytes) };
      }
      return { exitCode: result.exitCode };
    } catch {
      if (fileStream !== null) this.deps.py.FS.close(fileStream);
      if (errorStream !== null) this.deps.py.FS.close(errorStream);
      return { exitCode: 130 }; // SIGINT-style: killed (Ctrl+C) or crashed
    } finally {
      this.foreground = null;
      this.activeChildren--;
    }
  }

  /* ---------------------- compile / link pseudo-commands ----------------- */

  private resolveInCwd(path: string, cwd: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    return normalizePath(`${cwd}/${path}`);
  }

  private async python(request: SpawnRequest): Promise<SpawnResult> {
    if (this.activeChildren >= MAX_CHILDREN) {
      this.deps.writeError("slop: too many nested programs\r\n");
      return { exitCode: 126 };
    }
    this.activeChildren++;
    const captured: Uint8Array[] = [];
    let capturedBytes = 0;
    let fileStream: unknown = null;
    let errorStream: unknown = null;
    try {
      if (request.outFile) {
        fileStream = this.deps.py.FS.open(request.outFile, request.append ? "a" : "w");
      }
      if (request.errFile) {
        errorStream = this.deps.py.FS.open(request.errFile, request.errAppend ? "a" : "w");
      }
      const stdout = (text: string) => {
        const chunk = new TextEncoder().encode(text);
        if (request.capture) {
          if (capturedBytes + chunk.byteLength <= MAX_CAPTURE_BYTES) captured.push(chunk);
          else if (capturedBytes < MAX_CAPTURE_BYTES) {
            captured.push(chunk.slice(0, MAX_CAPTURE_BYTES - capturedBytes));
          }
          capturedBytes += chunk.byteLength;
        } else if (fileStream !== null) {
          this.deps.py.FS.write(fileStream, chunk, 0, chunk.byteLength);
        } else {
          this.deps.writeOut(text);
        }
      };
      const stderr = (text: string) => {
        if (request.stderrToStdout) {
          stdout(text);
        } else if (errorStream !== null) {
          const chunk = new TextEncoder().encode(text);
          this.deps.py.FS.write(errorStream, chunk, 0, chunk.byteLength);
        } else {
          this.deps.writeError(text);
        }
      };
      const exitCode = await runPythonEntrypoint(this.deps.py, {
        args: request.args,
        cwd: request.cwd,
        env: request.env,
        stdin: request.stdinText,
        stdout,
        stderr,
      });
      return request.capture
        ? { exitCode, stdout: concatChunks(captured, capturedBytes) }
        : { exitCode };
    } catch (error) {
      this.deps.writeError(
        "python: " + (error instanceof Error ? error.message : String(error)) + "\r\n",
      );
      return { exitCode: 1 };
    } finally {
      if (fileStream !== null) this.deps.py.FS.close(fileStream);
      if (errorStream !== null) this.deps.py.FS.close(errorStream);
      this.activeChildren--;
    }
  }

  private compileUsage(command: string): string {
    return (
      `usage: ${command} -c [-O0|-O1|-O2|-O3|-Os] [-std=c11|c17] [-g] ` +
      "[-Wall] [-Wextra] [-Werror] [-Dname[=value]] [-I dir] <file.c> [-o out.o]\r\n"
    );
  }

  private linkUsage(command: string): string {
    return `usage: ${command} [-s] [--export=symbol] <a.o b.o ...> -o <out.wasm>\r\n`;
  }

  private async toolchain(
    request: SpawnRequest,
    operation: "compile" | "link",
  ): Promise<SpawnResult> {
    let stdout = "";
    let stderr = "";
    const writeOut = (text: string) => { stdout += text; };
    const writeError = (text: string) => { stderr += text; };
    const command = request.path;
    const args = request.args.slice(1);
    const exitCode = operation === "compile"
      ? await this.toolchainCompile(args, request.cwd, command, writeOut, writeError)
      : await this.toolchainLink(args, request.cwd, command, writeOut, writeError);

    if (request.stderrToStdout) {
      stdout += stderr;
      stderr = "";
    }
    const writeFile = (path: string, append: boolean | undefined, value: string) => {
      const stream = this.deps.py.FS.open(path, append ? "a" : "w");
      try {
        const bytes = new TextEncoder().encode(value);
        this.deps.py.FS.write(stream, bytes, 0, bytes.byteLength);
      } finally {
        this.deps.py.FS.close(stream);
      }
    };
    try {
      if (request.outFile) writeFile(request.outFile, request.append, stdout);
      else if (!request.capture && stdout) this.deps.writeOut(stdout);
      if (request.errFile) writeFile(request.errFile, request.errAppend, stderr);
      else if (stderr) this.deps.writeError(stderr);
    } catch (error) {
      this.deps.writeError(
        `${command}: ${error instanceof Error ? error.message : String(error)}\r\n`,
      );
      return { exitCode: 1 };
    }
    if (request.capture) {
      const bytes = new TextEncoder().encode(stdout);
      return { exitCode, stdout: bytes.slice(0, MAX_CAPTURE_BYTES) };
    }
    return { exitCode };
  }

  private async toolchainCompile(
    args: string[],
    cwd: string,
    command: string,
    writeOut: (text: string) => void,
    writeError: (text: string) => void,
  ): Promise<number> {
    const positional: string[] = [];
    let output: string | null = null;
    const options: CompileOptions = {};
    const defines: string[] = [];
    const includePaths: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--help") {
        writeOut(this.compileUsage(command));
        return 0;
      }
      if (arg === "-c") continue;
      if (arg === "-o") {
        if (i + 1 >= args.length) {
          writeError(`${command}: -o requires a path\r\n`);
          return 2;
        }
        output = args[++i];
        continue;
      }
      if (/^-O[0123s]$/.test(arg)) {
        options.optimization = arg.slice(2) as CompileOptions["optimization"];
        continue;
      }
      if (arg === "-std=c11" || arg === "-std=c17") {
        options.standard = arg.slice(5) as CompileOptions["standard"];
        continue;
      }
      if (arg === "-g") {
        options.debug = true;
        continue;
      }
      if (arg === "-Wall" || arg === "-Wextra") {
        options.warnings = true;
        continue;
      }
      if (arg === "-Werror") {
        options.warningsAsErrors = true;
        continue;
      }
      if (arg === "-D" || arg.startsWith("-D")) {
        const define = arg === "-D" ? args[++i] : arg.slice(2);
        if (!define || !/^[A-Za-z_][A-Za-z0-9_]*(?:=.*)?$/.test(define)) {
          writeError(`${command}: invalid -D definition\r\n`);
          return 2;
        }
        defines.push(define);
        continue;
      }
      if (arg === "-I" || arg.startsWith("-I")) {
        const include = arg === "-I" ? args[++i] : arg.slice(2);
        if (!include) {
          writeError(`${command}: -I requires a directory\r\n`);
          return 2;
        }
        const resolved = this.resolveInCwd(include, cwd);
        if (!fsExists(this.deps.py, resolved) || !fsIsDir(this.deps.py, resolved)) {
          writeError(`${command}: include directory not found: ${resolved}\r\n`);
          return 2;
        }
        includePaths.push(resolved);
        continue;
      }
      if (arg.startsWith("-")) {
        writeError(`${command}: unsupported option: ${arg}\r\n`);
        return 2;
      }
      positional.push(arg);
    }
    if (positional.length !== 1) {
      writeError(this.compileUsage(command));
      return 2;
    }
    if (defines.length > MAX_TOOLCHAIN_INPUTS || includePaths.length > MAX_TOOLCHAIN_INPUTS) {
      writeError(`${command}: too many -D or -I options\r\n`);
      return 2;
    }
    const sourcePath = this.resolveInCwd(positional[0], cwd);
    if (!sourcePath.toLowerCase().endsWith(".c")) {
      writeError(`${command}: source file must end in .c\r\n`);
      return 2;
    }
    if (!fsExists(this.deps.py, sourcePath) || fsIsDir(this.deps.py, sourcePath)) {
      writeError(`${command}: source file not found: ${sourcePath}\r\n`);
      return 2;
    }
    if (this.deps.py.FS.stat(sourcePath).size > MAX_C_SOURCE_BYTES) {
      writeError(`${command}: source exceeds the 512 KiB limit\r\n`);
      return 2;
    }
    const defaultOut = sourcePath.toLowerCase().endsWith(".c")
      ? `${sourcePath.slice(0, -2)}.o`
      : `${sourcePath}.o`;
    const outputPath = output ? this.resolveInCwd(output, cwd) : defaultOut;
    if (!outputPath.toLowerCase().endsWith(".o")) {
      writeError(`${command}: compiler output must end in .o\r\n`);
      return 2;
    }
    if (outputPath === sourcePath) {
      writeError(`${command}: output cannot overwrite the source file\r\n`);
      return 2;
    }
    options.defines = defines;
    options.includePaths = includePaths;
    this.deps.note(`  compiling ${sourcePath} …`);
    try {
      const result = await runToolchainInBrowser(
        this.deps.py,
        { operation: "compile", sourcePath, outputPath, options },
        this.deps.signal,
      );
      if (result.diagnostics) writeError(result.diagnostics.replaceAll("\n", "\r\n"));
      return 0;
    } catch (error) {
      writeError(
        `${command}: ${error instanceof Error ? error.message : String(error)}\r\n`.replaceAll("\n", "\r\n"),
      );
      return 1;
    }
  }

  private async toolchainLink(
    args: string[],
    cwd: string,
    command: string,
    writeOut: (text: string) => void,
    writeError: (text: string) => void,
  ): Promise<number> {
    const objects: string[] = [];
    let output: string | null = null;
    const options: LinkOptions = {};
    const exports: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--help") {
        writeOut(this.linkUsage(command));
        return 0;
      }
      if (arg === "-o") {
        if (i + 1 >= args.length) {
          writeError(`${command}: -o requires a path\r\n`);
          return 2;
        }
        output = args[++i];
        continue;
      }
      if (arg === "-s" || arg === "--strip-all") {
        options.strip = true;
        continue;
      }
      if (arg === "--export" || arg.startsWith("--export=")) {
        const symbol = arg === "--export" ? args[++i] : arg.slice("--export=".length);
        if (!symbol || !/^[A-Za-z_.$][A-Za-z0-9_.$]*$/.test(symbol)) {
          writeError(`${command}: invalid exported symbol\r\n`);
          return 2;
        }
        exports.push(symbol);
        continue;
      }
      if (arg.startsWith("-")) {
        writeError(`${command}: unsupported option: ${arg}\r\n`);
        return 2;
      }
      objects.push(arg);
    }
    if (objects.length === 0 || !output) {
      writeError(this.linkUsage(command));
      return 2;
    }
    if (objects.length > MAX_TOOLCHAIN_INPUTS || exports.length > MAX_TOOLCHAIN_INPUTS) {
      writeError(`${command}: too many object files or exports\r\n`);
      return 2;
    }
    const objectPaths = objects.map((object) => this.resolveInCwd(object, cwd));
    const outputPath = this.resolveInCwd(output, cwd);
    for (const objectPath of objectPaths) {
      if (
        !objectPath.toLowerCase().endsWith(".o") ||
        !fsExists(this.deps.py, objectPath) ||
        fsIsDir(this.deps.py, objectPath)
      ) {
        writeError(`${command}: object file not found: ${objectPath}\r\n`);
        return 2;
      }
    }
    if (!outputPath.toLowerCase().endsWith(".wasm") && !outputPath.startsWith("/bin/")) {
      writeError(`${command}: output must end in .wasm or be inside /bin\r\n`);
      return 2;
    }
    options.exports = exports;
    this.deps.note(`  linking ${outputPath} …`);
    try {
      const result = await runToolchainInBrowser(
        this.deps.py,
        { operation: "link", objectPaths, outputPath, options },
        this.deps.signal,
      );
      if (result.diagnostics) writeError(result.diagnostics.replaceAll("\n", "\r\n"));
      return 0;
    } catch (error) {
      writeError(
        `${command}: ${error instanceof Error ? error.message : String(error)}\r\n`.replaceAll("\n", "\r\n"),
      );
      return 1;
    }
  }
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(Math.min(total, MAX_CAPTURE_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset + chunk.byteLength > out.byteLength) break;
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/* --------------------------- one-shot commands --------------------------- */

export interface SlopCommandOptions {
  /** Working directory for the fresh shell (default /home/web). */
  cwd?: string;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  note?: (text: string) => void;
  /** Worker mode only; 0 disables (default 30s). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Run one slop command line (pipes, redirects, expansion) in a fresh shell
 * instance. Stateless: the filesystem persists, cwd does not (pass cwd).
 */
export async function runSlopCommand(
  py: Pyodide,
  command: string,
  options: SlopCommandOptions = {},
): Promise<{ exitCode: number }> {
  await ensureSlopInstalled(py, options.note);
  const cwd = options.cwd ?? "/home/web";
  const spawner = new SlopSpawner({
    py,
    writeOut: options.onStdout ?? (() => {}),
    writeError: options.onStderr ?? options.onStdout ?? (() => {}),
    note: options.note ?? (() => {}),
    childStdin: () => null, // deterministic EOF for interactive reads
    signal: options.signal,
  });
  // Pre-fed stdin works in worker and main-thread fallback modes. It closes
  // after the command, so both the shell and stdin-reading children terminate.
  const handle = startWasiProgram(
    py,
    {
      executablePath: "/bin/slop",
      env: { PATH: "/bin", PWD: cwd, TERM: "ghostty", SLOP_QUIET: "1" },
      preopens: shellPreopens(cwd),
      stdin: command.endsWith("\n") ? command : `${command}\n`,
      timeoutMs: options.timeoutMs ?? 30_000,
      spawnHandler: (request) => spawner.onSpawn(request),
      onStdout: options.onStdout,
      onStderr: options.onStderr ?? options.onStdout,
    },
    options.signal,
  );
  return handle.result;
}

/* --------------------------- interactive session ------------------------- */

/**
 * One shared input buffer for the session, like a tty: input typed while a
 * child runs is consumed by whatever reads next (the child, or the shell
 * after the child exits). A null marker is a one-shot EOF for the next
 * reader only (unlike StdinQueue's permanent EOF state).
 */
class SharedInput {
  private queue: (Uint8Array | null)[] = [];
  private waiting: ((item: Uint8Array | null) => void)[] = [];

  push(item: Uint8Array | null): void {
    if (item !== null && item.byteLength === 0) return;
    if (this.waiting.length > 0) this.waiting.shift()!(item);
    else this.queue.push(item);
  }

  next(): Promise<Uint8Array | null> | Uint8Array | null {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

export interface SlopSessionDeps {
  py: Pyodide;
  writeOut: (text: string) => void;
  note: (text: string) => void;
  onExit: () => void;
}

export class SlopSession {
  private deps: SlopSessionDeps;
  private slop: WasiProgramHandle | null = null;
  private line = "";
  private input = new SharedInput();
  private spawner: SlopSpawner;

  constructor(deps: SlopSessionDeps) {
    this.deps = deps;
    this.spawner = new SlopSpawner({
      py: deps.py,
      writeOut: deps.writeOut,
      writeError: deps.writeOut,
      note: deps.note,
      childStdin: () => this.input.next(),
    });
  }

  get alive(): boolean {
    return this.slop !== null;
  }

  async start(): Promise<void> {
    if (this.slop) return;
    await ensureSlopInstalled(this.deps.py, this.deps.note);
    const handle = startWasiProgram(this.deps.py, {
      executablePath: "/bin/slop",
      env: { PATH: "/bin", PWD: "/home/web", TERM: "ghostty" },
      preopens: shellPreopens("/home/web"),
      interactiveStdin: true,
      stdinProvider: () => this.input.next(),
      timeoutMs: 0,
      spawnHandler: (request) => this.spawner.onSpawn(request),
      onStdout: this.deps.writeOut,
      onStderr: this.deps.writeOut,
    });
    this.slop = handle;
    this.line = "";
    handle.result
      .catch(() => ({ exitCode: -1 }))
      .then(({ exitCode }) => {
        if (this.slop === handle) {
          this.slop = null;
          this.deps.note(`  slop exited (${exitCode}) — Ctrl+Shift+S to restart`);
          this.deps.onExit();
        }
      });
  }

  /** Stop the shell and any foreground child. */
  stop(): void {
    this.spawner.foreground?.kill();
    this.slop?.kill();
    this.slop = null;
  }

  /** Terminal input while the shell view is active (canonical line mode). */
  feed(data: string): void {
    const encoder = new TextEncoder();
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        this.deps.writeOut("\r\n");
        this.input.push(encoder.encode(`${this.line}\n`));
        this.line = "";
      } else if (ch === "\x7f" || ch === "\b") {
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.deps.writeOut("\b \b");
        }
      } else if (ch === "\x03") {
        // Ctrl+C: kill the foreground child, or cancel the line at the prompt.
        this.deps.writeOut("^C\r\n");
        if (this.spawner.foreground) this.spawner.foreground.kill();
        else {
          this.line = "";
          this.input.push(encoder.encode("\n"));
        }
        return;
      } else if (ch === "\x04") {
        // Ctrl+D: an EOF marker for whoever reads next (child, or the shell
        // at its prompt, which exits on EOF).
        if (this.line.length > 0) {
          this.input.push(encoder.encode(this.line));
          this.line = "";
        } else {
          this.input.push(null);
        }
      } else if (ch >= " ") {
        this.line += ch;
        this.deps.writeOut(ch);
      }
    }
  }
}
