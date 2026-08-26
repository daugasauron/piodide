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
import {
  runCurlCommand,
  type HostCommandResult,
} from "./slop-host-commands.ts";
import {
  runGitRemoteCommand,
  type GitHubCredentials,
} from "./git-remote.ts";
import { runGitEngineCommand } from "./git-engine.ts";
import { normalizePath } from "./wasi/abi.ts";
import type { CompileOptions, LinkOptions } from "./wasi/toolchain.ts";

const SHELL_BINARIES = ["slop", "make", "sed", "ar", "git", "ls", "cat", "fd-find", "echo", "env", "grep"];
const COREUTILS = [
  "rm", "cp", "mv", "mkdir", "rmdir", "touch", "ln", "head", "tail", "wc", "sort",
  "cut", "paste", "tr", "tee", "basename", "dirname", "seq", "cmp", "comm", "join", "xxd", "base64", "strings", "truncate", "install", "readlink", "realpath", "du", "find", "mktemp",
  "chmod", "uniq", "xargs", "stat", "diff", "printf", "true", "false", "sha256sum", "date", "sleep",
];
const SHELL_SOURCES = [
  "slop.c", "make.c", "coreutils.c", "sed.c", "ar.c", "git.c", "spawn_stub.c", "patch_import.py",
  "Makefile", "README.md",
  "ls.c", "cat.c", "fd-find.c", "echo.c", "env.c", "grep.c",
];
const MAX_CHILDREN = 32;
const MAX_C_SOURCE_BYTES = 512 * 1024;
const MAX_TOOLCHAIN_INPUTS = 32;
const MAX_PYTHON_STREAM_BYTES = 16 * 1024 * 1024;
const HOST_ENTRYPOINT_MARKER = "piodide browser-hosted command\n";
/** Pipe captures are bounded so a runaway producer can't eat the page. */
const MAX_CAPTURE_BYTES = 1024 * 1024;

function boundedBytes(value: Uint8Array): { stdout: Uint8Array; stdoutLength: number } {
  return {
    stdout: value.byteLength <= MAX_CAPTURE_BYTES
      ? value
      : value.subarray(0, MAX_CAPTURE_BYTES).slice(),
    stdoutLength: value.byteLength,
  };
}

function shellPreopens(cwd: string) {
  return [{ name: ".", path: cwd }, "/home/web", "/", "/bin"];
}

/* ------------------------------ install -------------------------------- */

let installPromise: Promise<void> | null = null;

/** Fetch the committed shell binaries + sources into the MEMFS once. */
export function ensureSlopInstalled(py: Pyodide, note?: (text: string) => void): Promise<void> {
  if (!installPromise) {
    installPromise = (async () => {
      const nativeGitInstalled = fsExists(py, "/bin/git") && py.FS.stat("/bin/git").size > 1024;
      if (fsExists(py, "/bin/slop") && nativeGitInstalled) {
        installHostEntrypoints(py);
        installShellAliases(py);
        await installHostSources(py);
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
      installHostEntrypoints(py);
      installShellAliases(py);
      await installHostSources(py);
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

function installHostEntrypoints(py: Pyodide): void {
  for (const name of ["python", "python3", "curl", "cc", "compile", "ld", "link"]) {
    const path = `/bin/${name}`;
    if (!fsExists(py, path)) py.FS.writeFile(path, HOST_ENTRYPOINT_MARKER);
    py.FS.chmod(path, 0o755);
  }
}

function installShellAliases(py: Pyodide): void {
  if (fsExists(py, "/bin/grep")) {
    py.FS.writeFile("/bin/rg", py.FS.readFile("/bin/grep"));
    py.FS.chmod("/bin/rg", 0o755);
  }
}

async function installHostSources(py: Pyodide): Promise<void> {
  try {
    const { default: source } = await import("./slop-host-commands.ts?raw");
    py.FS.mkdirTree("/home/web/slop");
    py.FS.writeFile("/home/web/slop/curl-host.ts", source);
  } catch {
    // Host source is an audit convenience, not a runtime requirement.
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
  stdoutToStderr?: boolean;
  stderrToInheritedStdout?: boolean;
  stdoutToInheritedStderr?: boolean;
  /** Exported environment supplied by the spawning shell (spawn ABI v3). */
  env?: Record<string, string>;
  /** Spawn ABI v8: do not inject runtime metadata into this environment. */
  exactEnvironment?: boolean;
}

interface SpawnResult {
  exitCode: number;
  stdout?: Uint8Array;
  /** Original size before RPC-safe truncation; lets the guest reject overflow. */
  stdoutLength?: number;
}

/** File descriptors inherited by a process spawned from another guest. */
interface InheritedOutput {
  stdout: (chunk: Uint8Array) => void;
  stderr: (text: string) => void;
  /** Byte-preserving route used by host-backed Python when available. */
  stderrBytes?: (chunk: Uint8Array) => void;
}

interface SlopSpawnerDeps {
  py: Pyodide;
  writeOut: (text: string) => void;
  writeError: (text: string) => void;
  note: (text: string) => void;
  /** Interactive stdin for children (the session's tty buffer; EOF otherwise). */
  childStdin: () => Promise<Uint8Array | null> | Uint8Array | null;
  /** Resolve a pending interactive read when the host command is aborted. */
  cancelChildStdin?: () => void;
  getGitHubCredentials?: () => GitHubCredentials | null;
  signal?: AbortSignal;
}

/** Runs the programs slop spawns (PATH commands, pseudo-commands, nesting). */
export class SlopSpawner {
  /** The currently running direct child (for Ctrl+C kill). */
  foreground: WasiProgramHandle | null = null;
  private hostAbort: AbortController | null = null;
  private activeChildren = 0;
  private deps: SlopSpawnerDeps;

  constructor(deps: SlopSpawnerDeps) {
    this.deps = deps;
  }

  async onSpawn(request: SpawnRequest, inherited?: InheritedOutput): Promise<SpawnResult> {
    const {
      path, args, cwd, stdinText, capture, outFile, append,
      errFile, errAppend, stderrToStdout, stdoutToStderr,
      stderrToInheritedStdout, stdoutToInheritedStderr, env, exactEnvironment,
    } = request;
    if (["python", "python3"].includes(path.split("/").pop() ?? path)) {
      return this.python(request, inherited);
    }
    const command = path.split("/").pop() ?? path;
    if (command === "curl") {
      return this.hostCommand(request, runCurlCommand, inherited);
    }
    if (command === "git-remote") {
      return this.hostCommand(request, runGitRemoteCommand, inherited);
    }
    if (command === "git-engine") {
      return this.hostCommand(request, runGitEngineCommand, inherited);
    }
    if (command === "compile" || command === "cc") {
      return this.toolchain(request, "compile", inherited);
    }
    if (command === "link" || command === "ld") {
      return this.toolchain(request, "link", inherited);
    }

    if (this.activeChildren >= MAX_CHILDREN) {
      if (inherited) inherited.stderr("slop: too many nested programs\r\n");
      else this.deps.writeError("slop: too many nested programs\r\n");
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
      const message = `slop: ${errFile ?? outFile}: ${fileError}\r\n`;
      if (inherited) inherited.stderr(message);
      else this.deps.writeError(message);
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

    const outputDecoder = new TextDecoder();
    const errorDecoder = new TextDecoder();
    const redirectedOutputDecoder = new TextDecoder();
    const writeInheritedOutput = (chunk: Uint8Array) => {
      if (inherited) inherited.stdout(chunk);
      else this.deps.writeOut(outputDecoder.decode(chunk, { stream: true }));
    };
    const writeInheritedError = (text: string) => {
      if (inherited) inherited.stderr(text);
      else this.deps.writeError(text);
    };
    const writeInheritedErrorBytes = (chunk: Uint8Array) => {
      if (inherited?.stderrBytes) inherited.stderrBytes(chunk);
      else writeInheritedError(errorDecoder.decode(chunk, { stream: true }));
    };
    const writeNaturalOutput = capture || outFile ? writeChunk : writeInheritedOutput;

    const writeErrorBytes = (chunk: Uint8Array) => {
      if (stderrToInheritedStdout) {
        writeInheritedOutput(chunk);
      } else if (stderrToStdout) {
        writeNaturalOutput(chunk);
      } else if (errorStream !== null) {
        this.deps.py.FS.write(errorStream, chunk, 0, chunk.byteLength);
      } else {
        writeInheritedErrorBytes(chunk);
      }
    };
    const writeError = (text: string) => writeErrorBytes(new TextEncoder().encode(text));
    const writeOutput = stdoutToInheritedStderr
      ? (chunk: Uint8Array) => {
          if (inherited?.stderrBytes) inherited.stderrBytes(chunk);
          else writeInheritedError(redirectedOutputDecoder.decode(chunk, { stream: true }));
        }
      : stdoutToStderr
      ? (chunk: Uint8Array) => {
          if (errorStream !== null) {
            this.deps.py.FS.write(errorStream, chunk, 0, chunk.byteLength);
          } else {
            writeInheritedError(redirectedOutputDecoder.decode(chunk, { stream: true }));
          }
        }
      : writeNaturalOutput;

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
        env: exactEnvironment
          ? { ...(env ?? {}) }
          : {
              PATH: "/bin", PWD: cwd, TERM: "ghostty", ...(env ?? {}),
              PIODIDE_CWD: cwd,
              ...(stdinText !== undefined ? { PIODIDE_STDIN: "1" } : {}),
            },
        exactEnvironment,
        preopens: shellPreopens(cwd),
        interactiveStdin: true,
        stdinProvider,
        timeoutMs: 0,
        spawnHandler: (nested) => this.onSpawn(nested, {
          stdout: writeOutput,
          stderr: writeError,
          stderrBytes: writeErrorBytes,
        }),
        onStdoutBytes: writeOutput,
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
        return {
          exitCode: result.exitCode,
          stdout: concatChunks(captured, capturedBytes),
          stdoutLength: capturedBytes,
        };
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

  /** Kill either a WASI child or an async browser-hosted command. */
  killForeground(): boolean {
    const active = this.foreground !== null || this.hostAbort !== null;
    this.foreground?.kill();
    this.hostAbort?.abort();
    if (this.hostAbort) this.deps.cancelChildStdin?.();
    return active;
  }

  private async hostCommand(
    request: SpawnRequest,
    run: typeof runCurlCommand | typeof runGitRemoteCommand | typeof runGitEngineCommand,
    inherited?: InheritedOutput,
  ): Promise<SpawnResult> {
    if (this.activeChildren >= MAX_CHILDREN) {
      if (inherited) inherited.stderr("slop: too many nested programs\r\n");
      else this.deps.writeError("slop: too many nested programs\r\n");
      return { exitCode: 126 };
    }
    this.activeChildren++;
    const controller = new AbortController();
    this.hostAbort = controller;
    const abort = () => {
      controller.abort(this.deps.signal?.reason);
      this.deps.cancelChildStdin?.();
    };
    this.deps.signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = await run({
        py: this.deps.py,
        args: request.args,
        cwd: request.cwd,
        stdin: request.stdinText,
        env: request.env,
        readStdin: this.deps.childStdin,
        signal: controller.signal,
        getGitHubCredentials: this.deps.getGitHubCredentials,
      });
      return this.routeHostResult(request, result, inherited);
    } catch (error) {
      return this.routeHostResult(request, {
        exitCode: controller.signal.aborted ? 130 : 1,
        stderr: new TextEncoder().encode(
          `${request.path}: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
      }, inherited);
    } finally {
      this.deps.signal?.removeEventListener("abort", abort);
      if (this.hostAbort === controller) this.hostAbort = null;
      this.activeChildren--;
    }
  }

  private routeHostResult(
    request: SpawnRequest,
    result: HostCommandResult,
    inherited?: InheritedOutput,
  ): SpawnResult {
    let stdout = result.stdout ?? new Uint8Array();
    let stderr = result.stderr ?? new Uint8Array();
    if (request.stdoutToStderr && stdout.byteLength) {
      stderr = joinBytes(stdout, stderr);
      stdout = new Uint8Array();
    } else if (request.stderrToStdout && stderr.byteLength) {
      const combined = new Uint8Array(stdout.byteLength + stderr.byteLength);
      combined.set(stdout);
      combined.set(stderr, stdout.byteLength);
      stdout = combined;
      stderr = new Uint8Array();
    }
    const writeFile = (path: string, append: boolean | undefined, value: Uint8Array) => {
      const stream = this.deps.py.FS.open(path, append ? "a" : "w");
      try {
        if (value.byteLength) this.deps.py.FS.write(stream, value, 0, value.byteLength);
      } finally {
        this.deps.py.FS.close(stream);
      }
    };
    try {
      if (request.outFile) writeFile(request.outFile, request.append, stdout);
      else if (request.stdoutToInheritedStderr && stdout.byteLength) {
        const text = new TextDecoder().decode(stdout);
        if (inherited) inherited.stderr(text);
        else this.deps.writeError(text);
      } else if (!request.capture && stdout.byteLength) {
        if (inherited) inherited.stdout(stdout);
        else this.deps.writeOut(new TextDecoder().decode(stdout));
      }
      if (request.errFile) writeFile(request.errFile, request.errAppend, stderr);
      else if (request.stderrToInheritedStdout && stderr.byteLength) {
        if (inherited) inherited.stdout(stderr);
        else this.deps.writeOut(new TextDecoder().decode(stderr));
      } else if (stderr.byteLength) {
        const text = new TextDecoder().decode(stderr);
        if (inherited) inherited.stderr(text);
        else this.deps.writeError(text);
      }
    } catch (error) {
      const text = `${request.path}: ${error instanceof Error ? error.message : String(error)}\r\n`;
      if (inherited) inherited.stderr(text);
      else this.deps.writeError(text);
      return { exitCode: 1 };
    }
    if (!request.capture) return { exitCode: result.exitCode };
    return { exitCode: result.exitCode, ...boundedBytes(stdout) };
  }

  /* ---------------------- compile / link pseudo-commands ----------------- */

  private resolveInCwd(path: string, cwd: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    return normalizePath(`${cwd}/${path}`);
  }

  private async python(request: SpawnRequest, inherited?: InheritedOutput): Promise<SpawnResult> {
    if (this.activeChildren >= MAX_CHILDREN) {
      if (inherited) inherited.stderr("slop: too many nested programs\r\n");
      else this.deps.writeError("slop: too many nested programs\r\n");
      return { exitCode: 126 };
    }
    this.activeChildren++;
    const captured: Uint8Array[] = [];
    let capturedBytes = 0;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutExceeded = false;
    let stderrExceeded = false;
    let fileStream: unknown = null;
    let errorStream: unknown = null;
    const stdoutDecoder = new TextDecoder();
    const stderrDecoder = new TextDecoder();
    const redirectedOutputDecoder = new TextDecoder();
    const writeDecoded = (
      decoder: TextDecoder,
      chunk: Uint8Array,
      sink: (text: string) => void,
    ) => {
      const text = decoder.decode(chunk, { stream: true });
      if (text) sink(text);
    };
    const writeInheritedErrorBytes = (chunk: Uint8Array) => {
      if (inherited?.stderrBytes) inherited.stderrBytes(chunk);
      else writeDecoded(stderrDecoder, chunk, inherited?.stderr ?? this.deps.writeError);
    };
    try {
      if (request.outFile) {
        fileStream = this.deps.py.FS.open(request.outFile, request.append ? "a" : "w");
      }
      if (request.errFile) {
        errorStream = this.deps.py.FS.open(request.errFile, request.errAppend ? "a" : "w");
      }
      const routeStdout = (chunk: Uint8Array) => {
        if (request.stdoutToInheritedStderr) {
          if (inherited?.stderrBytes) inherited.stderrBytes(chunk);
          else writeDecoded(
            redirectedOutputDecoder,
            chunk,
            inherited?.stderr ?? this.deps.writeError,
          );
        } else if (request.stdoutToStderr) {
          if (errorStream !== null) {
            this.deps.py.FS.write(errorStream, chunk, 0, chunk.byteLength);
          } else {
            writeInheritedErrorBytes(chunk);
          }
        } else if (request.capture) {
          if (capturedBytes + chunk.byteLength <= MAX_CAPTURE_BYTES) captured.push(chunk.slice());
          else if (capturedBytes < MAX_CAPTURE_BYTES) {
            captured.push(chunk.slice(0, MAX_CAPTURE_BYTES - capturedBytes));
          }
          capturedBytes += chunk.byteLength;
        } else if (fileStream !== null) {
          this.deps.py.FS.write(fileStream, chunk, 0, chunk.byteLength);
        } else if (inherited) {
          inherited.stdout(chunk);
        } else {
          writeDecoded(stdoutDecoder, chunk, this.deps.writeOut);
        }
      };
      const routeStderr = (chunk: Uint8Array) => {
        if (request.stderrToInheritedStdout) {
          if (inherited) inherited.stdout(chunk);
          else writeDecoded(stdoutDecoder, chunk, this.deps.writeOut);
        } else if (request.stderrToStdout) {
          routeStdout(chunk);
        } else if (errorStream !== null) {
          this.deps.py.FS.write(errorStream, chunk, 0, chunk.byteLength);
        } else {
          writeInheritedErrorBytes(chunk);
        }
      };
      const bounded = (
        chunk: Uint8Array,
        stream: "stdout" | "stderr",
        route: (selected: Uint8Array) => void,
      ) => {
        const count = stream === "stdout" ? stdoutBytes : stderrBytes;
        const remaining = Math.max(0, MAX_PYTHON_STREAM_BYTES - count);
        if (remaining > 0) route(chunk.subarray(0, remaining));
        const exceeded = chunk.byteLength > remaining;
        if (stream === "stdout") {
          stdoutBytes = Math.min(MAX_PYTHON_STREAM_BYTES + 1, count + chunk.byteLength);
          stdoutExceeded ||= exceeded;
        } else {
          stderrBytes = Math.min(MAX_PYTHON_STREAM_BYTES + 1, count + chunk.byteLength);
          stderrExceeded ||= exceeded;
        }
      };
      const stdout = (chunk: Uint8Array) => bounded(chunk, "stdout", routeStdout);
      const stderr = (chunk: Uint8Array) => bounded(chunk, "stderr", routeStderr);
      let exitCode = await runPythonEntrypoint(this.deps.py, {
        args: request.args,
        cwd: request.cwd,
        env: request.env,
        stdin: request.stdinText,
        stdout,
        stderr,
      });
      if (stdoutExceeded || stderrExceeded) {
        const streams = stdoutExceeded && stderrExceeded
          ? "stdout and stderr"
          : stdoutExceeded ? "stdout" : "stderr";
        routeStderr(new TextEncoder().encode(
          `python: ${streams} exceed the ${MAX_PYTHON_STREAM_BYTES}-byte invocation limit\n`,
        ));
        exitCode = 2;
      }
      return request.capture
        ? {
            exitCode,
            stdout: concatChunks(captured, capturedBytes),
            // Descriptor duplication can add stderr bytes to the stdout
            // capture. Report the complete routed length so the spawning
            // shell does not truncate the merged stream back to stdout's
            // pre-duplication byte count.
            stdoutLength: capturedBytes,
          }
        : { exitCode };
    } catch (error) {
      const text = "python: " + (error instanceof Error ? error.message : String(error)) + "\r\n";
      writeInheritedErrorBytes(new TextEncoder().encode(text));
      return { exitCode: 1 };
    } finally {
      const stdoutTail = stdoutDecoder.decode();
      if (stdoutTail) this.deps.writeOut(stdoutTail);
      const stderrTail = stderrDecoder.decode();
      if (stderrTail) (inherited?.stderr ?? this.deps.writeError)(stderrTail);
      const redirectedTail = redirectedOutputDecoder.decode();
      if (redirectedTail) (inherited?.stderr ?? this.deps.writeError)(redirectedTail);
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
    inherited?: InheritedOutput,
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

    if (request.stdoutToStderr) {
      stderr = stdout + stderr;
      stdout = "";
    } else if (request.stderrToStdout) {
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
      else if (request.stdoutToInheritedStderr && stdout) {
        if (inherited) inherited.stderr(stdout);
        else this.deps.writeError(stdout);
      } else if (!request.capture && stdout) {
        if (inherited) inherited.stdout(new TextEncoder().encode(stdout));
        else this.deps.writeOut(stdout);
      }
      if (request.errFile) writeFile(request.errFile, request.errAppend, stderr);
      else if (request.stderrToInheritedStdout && stderr) {
        if (inherited) inherited.stdout(new TextEncoder().encode(stderr));
        else this.deps.writeOut(stderr);
      } else if (stderr) {
        if (inherited) inherited.stderr(stderr);
        else this.deps.writeError(stderr);
      }
    } catch (error) {
      const text = `${command}: ${error instanceof Error ? error.message : String(error)}\r\n`;
      if (inherited) inherited.stderr(text);
      else this.deps.writeError(text);
      return { exitCode: 1 };
    }
    if (request.capture) {
      const bytes = new TextEncoder().encode(stdout);
      return { exitCode, ...boundedBytes(bytes) };
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
  const limit = out.byteLength;
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= limit) break;
    const selected = chunk.subarray(0, Math.min(chunk.byteLength, limit - offset));
    out.set(selected, offset);
    offset += selected.byteLength;
  }
  return out;
}

function joinBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

/* --------------------------- one-shot commands --------------------------- */

export interface SlopCommandOptions {
  /** Working directory for the fresh shell (default /home/web). */
  cwd?: string;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  note?: (text: string) => void;
  /** In-memory credentials registered by /github, used by Slop git. */
  getGitHubCredentials?: () => GitHubCredentials | null;
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
    getGitHubCredentials: options.getGitHubCredentials,
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

  cancelNext(): void {
    this.waiting.shift()?.(null);
  }
}

export interface SlopSessionDeps {
  py: Pyodide;
  writeOut: (text: string) => void;
  note: (text: string) => void;
  getGitHubCredentials?: () => GitHubCredentials | null;
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
      cancelChildStdin: () => this.input.cancelNext(),
      getGitHubCredentials: deps.getGitHubCredentials,
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
    this.spawner.killForeground();
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
        if (!this.spawner.killForeground()) {
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
