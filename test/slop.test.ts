/**
 * slop shell test: drives the real slop.wasm REPL with scripted input.
 * The "piodide" spawn import is mocked with a synchronous runner that
 * executes child programs (cat.wasm, ls.wasm, fd-find.wasm) against the
 * same MemoryFs with the child's cwd preopen — mirroring the browser's
 * nested-spawn behavior.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ERRNO, FILETYPE, WasiError } from "../src/wasi/abi.ts";
import type { WasiHandle, WasiOpenOptions } from "../src/wasi/fs.ts";
import { MemoryFs } from "../src/wasi/memory-fs.ts";
import { WasiHost } from "../src/wasi/host.ts";

const here = dirname(fileURLToPath(import.meta.url));
const shellBin = (name: string) =>
  new Uint8Array(readFileSync(join(here, "..", "shell", "bin", name)));
const COREUTILS = [
  "rm", "cp", "mv", "mkdir", "rmdir", "touch", "ln", "head", "tail", "wc", "sort",
  "cut", "paste", "tr", "tee", "basename", "dirname", "seq", "cmp", "comm", "join", "xxd", "base64", "strings", "truncate", "install", "readlink", "realpath", "du", "find", "mktemp",
  "chmod", "uniq", "xargs", "stat", "diff", "printf", "true", "false", "sha256sum", "date", "sleep",
];

interface SlopRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  toolchainCommands: string[][];
  pythonCommands: string[][];
  curlCommands: string[][];
  gitCommands: Array<{ args: string[]; cwd: string }>;
  gitStdin: string[];
  gitEnvironments: Array<Record<string, string>>;
}

function installShell(fs: MemoryFs): void {
  for (const name of ["slop", "make", "sed", "ar", "ls", "cat", "fd-find", "echo", "env", "grep"]) {
    fs.writeFile(`/bin/${name}`, shellBin(`${name}.wasm`));
  }
  fs.writeFile("/bin/rg", shellBin("grep.wasm"));
  fs.writeFile("/bin/sh", shellBin("slop.wasm"));
  fs.writeFile("/bin/python", "piodide host-backed Python entrypoint\n");
  fs.writeFile("/bin/python3", "piodide host-backed Python entrypoint\n");
  fs.writeFile("/bin/git", shellBin("git.wasm"));
  fs.writeFile("/bin/curl", "piodide browser-hosted command\n");
  for (const name of ["cc", "compile", "ld", "link"]) {
    fs.writeFile(`/bin/${name}`, "piodide browser-hosted command\n");
  }
  const coreutils = shellBin("coreutils.wasm");
  for (const name of COREUTILS) fs.writeFile(`/bin/${name}`, coreutils);
}

class LateReadFailureFs extends MemoryFs {
  private readonly failing = new Map<WasiHandle, number>();

  override open(path: string, options: WasiOpenOptions, mode: number): WasiHandle {
    const handle = super.open(path, options, mode);
    if (path === "/home/web/late-read.bin" && options.read) this.failing.set(handle, 65_536);
    return handle;
  }

  override read(handle: WasiHandle, position: bigint | null, length: number): Uint8Array {
    const remaining = this.failing.get(handle);
    if (remaining === undefined) return super.read(handle, position, length);
    if (remaining === 0) throw new WasiError(ERRNO.IO, "injected late read failure");
    const bytes = super.read(handle, position, Math.min(length, remaining));
    this.failing.set(handle, remaining - bytes.byteLength);
    return bytes;
  }
}

class TruncateFailureFs extends MemoryFs {
  override truncate(path: string, size: bigint): void {
    if (path === "/home/web/truncate-fail.bin" || path === "/home/web/truncate-create-fail.bin") {
      throw new WasiError(ERRNO.IO, "injected truncate failure");
    }
    super.truncate(path, size);
  }
}

class RmdirCommitFailureFs extends MemoryFs {
  private injected = false;

  override rmdir(path: string): void {
    if (path === "/home/web/rmdir-rollback/second" && !this.injected) {
      this.injected = true;
      throw new WasiError(ERRNO.IO, "injected rmdir failure");
    }
    super.rmdir(path);
  }
}

async function runSlop(
  fs: MemoryFs,
  script: string[],
  options: { quiet?: boolean; sleepSync?: (ms: number) => void } = {},
): Promise<SlopRun> {
  // Pre-compile child modules (instantiation itself is synchronous).
  const modules = new Map<string, WebAssembly.Module>();
  for (const name of ["slop", "make", "sed", "ar", "git", "cat", "ls", "fd-find", "echo", "env", "grep"] as const) {
    modules.set(name, await WebAssembly.compile(shellBin(`${name}.wasm`) as BufferSource));
  }
  modules.set("rg", modules.get("grep")!);
  const coreutilsModule = await WebAssembly.compile(shellBin("coreutils.wasm") as BufferSource);
  for (const name of COREUTILS) modules.set(name, coreutilsModule);
  modules.set("sh", modules.get("slop")!);

  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  const lines = [...script];
  const encoder = new TextEncoder();
  const toolchainCommands: string[][] = [];
  const pythonCommands: string[][] = [];
  const curlCommands: string[][] = [];
  const gitCommands: Array<{ args: string[]; cwd: string }> = [];
  const gitStdin: string[] = [];
  const gitEnvironments: Array<Record<string, string>> = [];

  interface SpawnIo {
    stdinText?: Uint8Array;
    capture?: { ptr: number; cap: number; lenPtr: number };
    outFile?: string;
    append?: boolean;
    errFile?: string;
    errAppend?: boolean;
    stderrToStdout?: boolean;
    stdoutToStderr?: boolean;
    stderrToInheritedStdout?: boolean;
    stdoutToInheritedStderr?: boolean;
    env?: Record<string, string>;
    exactEnvironment?: boolean;
  }

  interface SpawnOutput {
    stdout: (chunk: Uint8Array) => void;
    stderr: (chunk: Uint8Array) => void;
  }

  const runProgram = (
    name: string,
    args: string[],
    cwd: string,
    io: SpawnIo,
    callerHost?: WasiHost,
    inherited?: SpawnOutput,
  ): number => {
    const module = modules.get(name);
    if (!module) return 127;
    let stdinSent = io.stdinText === undefined;
    const captured: Uint8Array[] = [];
    const fileChunks: Uint8Array[] = [];
    const errorChunks: Uint8Array[] = [];
    const writeInheritedStdout = inherited?.stdout ?? ((chunk: Uint8Array) => {
      stdout += decoder.decode(chunk, { stream: true });
    });
    const writeInheritedStderr = inherited?.stderr ?? ((chunk: Uint8Array) => {
      const text = decoder.decode(chunk, { stream: true });
      stderr += text;
      stdout += text;
    });
    const writeStdoutDestination = (chunk: Uint8Array) => {
      if (io.capture) captured.push(chunk.slice());
      else if (io.outFile) fileChunks.push(chunk.slice());
      else writeInheritedStdout(chunk);
    };
    const writeStderrDestination = (chunk: Uint8Array) => {
      if (io.errFile) errorChunks.push(chunk.slice());
      else writeInheritedStderr(chunk);
    };
    const writeStdout = io.stdoutToInheritedStderr
      ? writeInheritedStderr
      : io.stdoutToStderr
      ? writeStderrDestination
      : writeStdoutDestination;
    const writeStderr = io.stderrToInheritedStdout
      ? writeInheritedStdout
      : io.stderrToStdout
      ? writeStdoutDestination
      : writeStderrDestination;
    const host = new WasiHost({
      abiVersion: "snapshot0",
      args,
      env: io.exactEnvironment
        ? { ...(io.env ?? {}) }
        : {
            PATH: "/bin", PWD: cwd, TERM: "ghostty", ...(io.env ?? {}),
            PIODIDE_CWD: cwd,
            ...(io.stdinText !== undefined ? { PIODIDE_STDIN: "1" } : {}),
          },
      fs,
      preopens: [{ name: ".", path: cwd }, "/home/web", "/", "/bin"],
      stdin: () => {
        if (stdinSent) return null;
        stdinSent = true;
        return io.stdinText ?? null;
      },
      stdout: writeStdout,
      stderr: writeStderr,
      sleepSync: options.sleepSync,
      extendImports: (childHost) => ({
        piodide: {
          spawn: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
            handleSpawn(childHost, pathPtr, argvPtr, cwdPtr, ioPtr, false, false, false, false, false, false, {
              stdout: writeStdout,
              stderr: writeStderr,
            }),
          spawn_v3: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
            handleSpawn(childHost, pathPtr, argvPtr, cwdPtr, ioPtr, true, false, false, false, false, false, {
              stdout: writeStdout,
              stderr: writeStderr,
            }),
          spawn_v4: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
            handleSpawn(childHost, pathPtr, argvPtr, cwdPtr, ioPtr, true, true, false, false, false, false, {
              stdout: writeStdout,
              stderr: writeStderr,
            }),
          spawn_v5: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
            handleSpawn(childHost, pathPtr, argvPtr, cwdPtr, ioPtr, true, true, true, false, false, false, {
              stdout: writeStdout,
              stderr: writeStderr,
            }),
          spawn_v6: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
            handleSpawn(childHost, pathPtr, argvPtr, cwdPtr, ioPtr, true, true, true, true, false, false, {
              stdout: writeStdout,
              stderr: writeStderr,
            }),
          spawn_v7: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
            handleSpawn(childHost, pathPtr, argvPtr, cwdPtr, ioPtr, true, true, true, true, true, false, {
              stdout: writeStdout,
              stderr: writeStderr,
            }),
          spawn_v8: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
            handleSpawn(childHost, pathPtr, argvPtr, cwdPtr, ioPtr, true, true, true, true, true, true, {
              stdout: writeStdout,
              stderr: writeStderr,
            }),
        },
      }),
    });
    const instance = new WebAssembly.Instance(module, host.getImportObject());
    const exitCode = host.start(instance);

    if (io.outFile) {
      const existing =
        io.append && fs.exists(io.outFile) ? fs.readFile(io.outFile) : new Uint8Array();
      const total = existing.byteLength + fileChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const combined = new Uint8Array(total);
      combined.set(existing, 0);
      let fileOffset = existing.byteLength;
      for (const chunk of fileChunks) {
        combined.set(chunk, fileOffset);
        fileOffset += chunk.byteLength;
      }
      fs.writeFile(io.outFile, combined);
    }
    if (io.errFile) {
      const existing =
        io.errAppend && fs.exists(io.errFile) ? fs.readFile(io.errFile) : new Uint8Array();
      const total = existing.byteLength + errorChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const combined = new Uint8Array(total);
      combined.set(existing, 0);
      let fileOffset = existing.byteLength;
      for (const chunk of errorChunks) {
        combined.set(chunk, fileOffset);
        fileOffset += chunk.byteLength;
      }
      fs.writeFile(io.errFile, combined);
    }

    if (io.capture && callerHost) {
      const total = captured.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const all = new Uint8Array(total);
      let offset = 0;
      for (const chunk of captured) {
        all.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const copied = Math.min(io.capture.cap, all.byteLength);
      callerHost.writeBytes(io.capture.ptr, all.subarray(0, copied));
      if (io.capture.lenPtr !== 0) callerHost.writeUint32(io.capture.lenPtr, all.byteLength);
    }
    return exitCode;
  };

  const handleSpawn = (
    callerHost: WasiHost,
    pathPtr: number,
    argvPtr: number,
    cwdPtr: number,
    ioPtr: number,
    withEnvironment: boolean,
    withStderr: boolean,
    withStdoutToStderr = false,
    withOrderedDuplication = false,
    withArgumentCount = false,
    exactEnvironment = false,
    inherited?: SpawnOutput,
  ): number => {
    const path = callerHost.readCString(pathPtr);
    const argumentCount = withArgumentCount && ioPtr !== 0
      ? callerHost.readUint32(ioPtr + 60)
      : undefined;
    const childArgs = callerHost.readCStringArray(argvPtr, argumentCount);
    const childCwd = callerHost.readCString(cwdPtr);
    const childName = path.split("/").pop() ?? path;
    if (["cc", "ld", "compile", "link"].includes(childName)) {
      toolchainCommands.push(childArgs);
      return 0;
    }
    if (["python", "python3"].includes(childName)) {
      pythonCommands.push(childArgs);
      return 0;
    }
    if (childName === "curl") {
      curlCommands.push(childArgs);
      if (childArgs.includes("https://large.example") && ioPtr !== 0) {
        const capturePtr = callerHost.readUint32(ioPtr + 8);
        const captureCap = callerHost.readUint32(ioPtr + 12);
        const captureLenPtr = callerHost.readUint32(ioPtr + 16);
        if (capturePtr) callerHost.writeBytes(capturePtr, new Uint8Array(captureCap).fill(65));
        if (captureLenPtr) callerHost.writeUint32(captureLenPtr, captureCap + 1);
      }
      return 0;
    }
    if (childName === "git-engine") {
      gitCommands.push({ args: childArgs, cwd: childCwd });
      if (ioPtr !== 0) {
        const stdinPtr = callerHost.readUint32(ioPtr);
        const stdinLen = callerHost.readUint32(ioPtr + 4);
        if (stdinPtr && stdinLen) gitStdin.push(decoder.decode(callerHost.readBytes(stdinPtr, stdinLen)));
        const envPtr = callerHost.readUint32(ioPtr + 28);
        const envLen = callerHost.readUint32(ioPtr + 32);
        if (envPtr && envLen) {
          const values: Record<string, string> = {};
          for (const entry of decoder.decode(callerHost.readBytes(envPtr, envLen)).split("\0")) {
            const equals = entry.indexOf("=");
            if (equals > 0) values[entry.slice(0, equals)] = entry.slice(equals + 1);
          }
          gitEnvironments.push(values);
        }
      }
      const value = childArgs[1] === "--version"
        ? encoder.encode("git version 2.0.0-piodide (libgit2 + isomorphic-git)\n")
        : new Uint8Array();
      if (ioPtr !== 0) {
        const capturePtr = callerHost.readUint32(ioPtr + 8);
        const captureCap = callerHost.readUint32(ioPtr + 12);
        const captureLenPtr = callerHost.readUint32(ioPtr + 16);
        const large = childArgs.includes("--large-output");
        const boundary = childArgs.includes("--output-boundary");
        if (capturePtr) callerHost.writeBytes(
          capturePtr,
          large || boundary ? new Uint8Array(captureCap).fill(65) : value.subarray(0, captureCap),
        );
        if (captureLenPtr) callerHost.writeUint32(
          captureLenPtr,
          large ? captureCap + 1 : boundary ? captureCap : value.byteLength,
        );
      }
      return 0;
    }

    const io: SpawnIo = { exactEnvironment };
    if (ioPtr !== 0) {
      const stdinPtr = callerHost.readUint32(ioPtr);
      const stdinLen = callerHost.readUint32(ioPtr + 4);
      const capturePtr = callerHost.readUint32(ioPtr + 8);
      const captureCap = callerHost.readUint32(ioPtr + 12);
      const captureLenPtr = callerHost.readUint32(ioPtr + 16);
      const outFilePtr = callerHost.readUint32(ioPtr + 20);
      const append = callerHost.readUint32(ioPtr + 24) !== 0;
      if (stdinPtr !== 0 && stdinLen > 0) io.stdinText = callerHost.readBytes(stdinPtr, stdinLen);
      if (capturePtr !== 0) io.capture = { ptr: capturePtr, cap: captureCap, lenPtr: captureLenPtr };
      if (outFilePtr !== 0) {
        io.outFile = callerHost.readCString(outFilePtr);
        io.append = append;
      }
      if (withEnvironment) {
        const envPtr = callerHost.readUint32(ioPtr + 28);
        const envLen = callerHost.readUint32(ioPtr + 32);
        if (envPtr !== 0 && envLen > 0) {
          io.env = {};
          for (const entry of decoder.decode(callerHost.readBytes(envPtr, envLen)).split("\0")) {
            const equals = entry.indexOf("=");
            if (equals > 0) io.env[entry.slice(0, equals)] = entry.slice(equals + 1);
          }
        }
      }
      if (withStderr) {
        const errFilePtr = callerHost.readUint32(ioPtr + 36);
        io.errAppend = callerHost.readUint32(ioPtr + 40) !== 0;
        io.stderrToStdout = callerHost.readUint32(ioPtr + 44) !== 0;
        if (errFilePtr !== 0) io.errFile = callerHost.readCString(errFilePtr);
      }
      if (withStdoutToStderr) {
        io.stdoutToStderr = callerHost.readUint32(ioPtr + 48) !== 0;
      }
      if (withOrderedDuplication) {
        io.stderrToInheritedStdout = callerHost.readUint32(ioPtr + 52) !== 0;
        io.stdoutToInheritedStderr = callerHost.readUint32(ioPtr + 56) !== 0;
      }
    }
    return runProgram(childName, childArgs, childCwd, io, callerHost, inherited);
  };

  const stdin = () => {
    const next = lines.shift();
    return next === undefined ? null : encoder.encode(`${next}\n`);
  };

  const slopHost = new WasiHost({
    abiVersion: "snapshot0",
    args: ["/bin/slop.wasm"],
    env: {
      PATH: "/bin",
      PWD: "/home/web",
      TERM: "ghostty",
      ...(options.quiet ? { SLOP_QUIET: "1" } : {}),
    },
    fs,
    preopens: [{ name: ".", path: "/home/web" }, "/home/web", "/", "/bin"],
    stdin,
    stdout: (chunk) => {
      stdout += decoder.decode(chunk, { stream: true });
    },
    stderr: (chunk) => {
      const text = decoder.decode(chunk, { stream: true });
      stderr += text;
      stdout += text;
    },
    sleepSync: options.sleepSync,
    extendImports: (host) => ({
      piodide: {
        spawn: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
          handleSpawn(host, pathPtr, argvPtr, cwdPtr, ioPtr, false, false, false, false, false),
        spawn_v3: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
          handleSpawn(host, pathPtr, argvPtr, cwdPtr, ioPtr, true, false, false, false, false),
        spawn_v4: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
          handleSpawn(host, pathPtr, argvPtr, cwdPtr, ioPtr, true, true, false, false, false),
        spawn_v5: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
          handleSpawn(host, pathPtr, argvPtr, cwdPtr, ioPtr, true, true, true, false, false),
        spawn_v6: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
          handleSpawn(host, pathPtr, argvPtr, cwdPtr, ioPtr, true, true, true, true, false),
        spawn_v7: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
          handleSpawn(host, pathPtr, argvPtr, cwdPtr, ioPtr, true, true, true, true, true),
        spawn_v8: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
          handleSpawn(host, pathPtr, argvPtr, cwdPtr, ioPtr, true, true, true, true, true, true),
      },
    }),
  });
  const slopModule = modules.get("slop")!;
  const exitCode = slopHost.start(new WebAssembly.Instance(slopModule, slopHost.getImportObject()));
  return {
    stdout, stderr, exitCode, toolchainCommands, pythonCommands, curlCommands, gitCommands,
    gitStdin, gitEnvironments,
  };
}

test("slop: quiet one-shot mode emits only command output", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(fs, ["echo exact output"], { quiet: true });

  assert.equal(run.exitCode, 0);
  assert.equal(run.stdout, "exact output\n");
});

test("slop: python and /bin/python route to the Pyodide host entrypoint", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(
    fs,
    ["type python", "python -c 'print(1)'", "/bin/python script.py arg", "python3 -V"],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /python is \/bin\/python/);
  assert.deepEqual(run.pythonCommands, [
    ["python", "-c", "print(1)"],
    ["/bin/python", "script.py", "arg"],
    ["python3", "-V"],
  ]);
});

test("slop: compiler and linker host entrypoints are discoverable", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(
    fs,
    [
      "command -v cc",
      "which /bin/cc",
      "type ld",
      "/bin/cc --help",
      "/bin/ld --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /\/bin\/cc/);
  assert.match(run.stdout, /ld is \/bin\/ld/);
  assert.deepEqual(run.toolchainCommands, [
    ["/bin/cc", "--help"],
    ["/bin/ld", "--help"],
  ]);
});

test("slop: builtin help and command discovery reject ambiguous operands", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/sub");
  installShell(fs);
  fs.writeFile("/home/web/tool-script", "echo TOOL-SCRIPT\n");

  const run = await runSlop(
    fs,
    [
      "help pwd",
      "help command",
      "help source",
      "help break",
      "help missing-builtin || echo HELP-MISSING-$?",
      "help pwd extra || echo HELP-EXTRA-$?",
      "pwd",
      "pwd -L",
      "pwd --logical",
      "pwd -L --",
      "pwd -P || echo PWD-PHYSICAL-$?",
      "pwd stray || echo PWD-OPERAND-$?",
      "pwd -- stray || echo PWD-TERMINATOR-OPERAND-$?",
      "cd -L sub",
      "pwd",
      "cd -P .. || echo CD-PHYSICAL-$?",
      "pwd",
      "cd -- ..",
      "pwd",
      "cd --help",
      "discover_fn() { echo DISCOVER-FUNCTION; }",
      "command -v -- sh exit ./tool-script discover_fn",
      "command -v || echo COMMAND-MISSING-$?",
      "command -v -- || echo COMMAND-TERMINATOR-$?",
      "command -v sh -a || echo COMMAND-OPTION-$?",
      "command --help",
      "type -- sh exit ./tool-script discover_fn",
      "type || echo TYPE-MISSING-$?",
      "type sh -a || echo TYPE-OPTION-$?",
      "type missing-name 2> type.err || echo TYPE-NOTFOUND-$?",
      "which -- sh exit ./tool-script discover_fn",
      "which || echo WHICH-MISSING-$?",
      "which sh -a || echo WHICH-OPTION-$?",
      "which missing-name 2> which.err || echo WHICH-NOTFOUND-$?",
      "cat type.err",
      "type --help",
      "which --help",
      "eval --help",
      "recursive_eval() { eval recursive_eval; }",
      "recursive_eval || echo EVAL-RECURSION-$?",
      "echo DISCOVERY-AFTER",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /usage: pwd \[-L\|--logical\] \[--\].*-P is unavailable\n/);
  assert.match(run.stdout, /usage: command -v \[--\] NAME.*command \[--\] NAME \[ARG\.\.\.\].*bypasses functions\n/);
  assert.match(run.stdout, /usage: source \[--\] FILE \[ARG\.\.\.\].*arguments are scoped.*\n/);
  assert.match(run.stdout, /usage: break \[1\].*current loop only\n/);
  assert.match(run.stdout, /help: no help for missing-builtin\nHELP-MISSING-1\n/);
  assert.match(run.stdout, /help: expected at most one builtin name\nHELP-EXTRA-2\n/);
  assert.match(run.stdout, /pwd: physical cwd resolution is unavailable\nPWD-PHYSICAL-2\n/);
  assert.match(run.stdout, /pwd: unsupported operand: stray\nPWD-OPERAND-2\n/);
  assert.match(run.stdout, /pwd: unsupported operand: stray\nPWD-TERMINATOR-OPERAND-2\n/);
  assert.match(run.stdout, /\/home\/web\/sub\nslop: cd: physical cwd resolution is unavailable\nCD-PHYSICAL-2\n\/home\/web\/sub\n/);
  assert.match(run.stdout, /usage: cd \[-L\] \[--\] \[DIR\|-\].*-P is unavailable\n/);
  assert.match(run.stdout, /\/bin\/sh\nexit\n\/home\/web\/tool-script\ndiscover_fn\n/);
  assert.match(run.stdout, /command -v: name required\nCOMMAND-MISSING-2\n/);
  assert.match(run.stdout, /command -v: name required\nCOMMAND-TERMINATOR-2\n/);
  assert.match(run.stdout, /command: unsupported option: -a\nCOMMAND-OPTION-2\n/);
  assert.match(run.stdout, /sh is \/bin\/sh\nexit is a shell builtin\n\.\/tool-script is \/home\/web\/tool-script\ndiscover_fn is a function\n/);
  assert.match(run.stdout, /type: name required\nTYPE-MISSING-2\n/);
  assert.match(run.stdout, /type: unsupported option: -a\nTYPE-OPTION-2\n/);
  assert.match(run.stdout, /TYPE-NOTFOUND-1\n/);
  assert.match(run.stdout, /which: name required\nWHICH-MISSING-2\n/);
  assert.match(run.stdout, /which: unsupported option: -a\nWHICH-OPTION-2\n/);
  assert.match(run.stdout, /WHICH-NOTFOUND-1\n/);
  assert.match(run.stdout, /slop: type: missing-name: not found\n/);
  assert.equal(fs.readFile("/home/web/which.err").byteLength, 0);
  assert.match(run.stdout, /usage: type \[--\] NAME\.\.\.\n/);
  assert.match(run.stdout, /usage: which \[--\] NAME.*includes builtins and functions\n/);
  assert.match(run.stdout, /usage: eval \[ARG\.\.\.\].*at most 8 nested evals\n/);
  assert.match(run.stdout, /eval: recursion limit \(8\) exceeded\nEVAL-RECURSION-2\nDISCOVERY-AFTER\n/);
});

test("slop: printf and read reject data corruption before mutation or output", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile("/home/web/read-max.txt", `${"A".repeat(4095)}\n`);
  fs.writeFile("/home/web/read-overflow.txt", `${"B".repeat(4096)}\n`);
  fs.writeFile("/home/web/read-raw.txt", "one\\two\n");
  fs.writeFile("/home/web/empty.txt", "");
  fs.writeFile(
    "/home/web/read-child.sh",
    "value=CHILD-OLD\nread value\nstatus=$?\nprintf 'CHILD-READ-STATUS=%d\\n' \"$status\"\nprintf 'CHILD-READ-VALUE=<%s>\\n' \"$value\"\nexit \"$status\"\n",
  );

  const run = await runSlop(
    fs,
    [
      "help printf",
      "help echo",
      "help read",
      "printf -- '<%s:%d>\\n' alpha 7 beta 010",
      "printf '<%s:%d>\\n' only",
      "printf '%d:%u\\n' -2147483648 4294967295",
      "printf '%c' > printf-missing-char.out",
      "printf '%c' ABC > printf-first-char.out",
      "nul_substitution=KEEP",
      "nul_substitution=$(printf '%c')",
      "printf 'NUL-SUBSTITUTION-STATUS=%d VALUE=<%s>\\n' $? \"$nul_substitution\"",
      "printf 2> printf-missing.err || echo PRINTF-MISSING-$?",
      "printf -- 2> printf-separator.err || echo PRINTF-SEPARATOR-$?",
      "printf 'prefix%q\\n' x > printf-format.out 2> printf-format.err || echo PRINTF-FORMAT-$?",
      "printf 'prefix=%s number=%d\\n' safe 12x > printf-number.out 2> printf-number.err || echo PRINTF-NUMBER-$?",
      "printf 'prefix=%s number=%d\\n' safe 2147483648 > printf-range.out 2> printf-range.err || echo PRINTF-RANGE-$?",
      "printf 'prefix=%s number=%u\\n' safe -1 > printf-unsigned.out 2> printf-unsigned.err || echo PRINTF-UNSIGNED-$?",
      "printf '%' > printf-dangling.out 2> printf-dangling.err || echo PRINTF-DANGLING-$?",
      "printf 'prefix\\q\\n' > printf-escape.out 2> printf-escape.err || echo PRINTF-ESCAPE-$?",
      "printf 'QUOTED=<%s>\\n' '|' '>' '<' '2>&1'",
      "echo -n x; printf '|'; echo -n -n x; printf '|\\n'",
      "value=OLD",
      "read value < read-max.txt",
      "printf 'READ-MAX-BYTES='; printf '%s' \"$value\" | wc -c",
      "value=OLD",
      "read value < read-overflow.txt 2> read-overflow.err || echo READ-OVERFLOW-$?",
      "printf 'READ-PRESERVED=<%s>\\n' \"$value\"",
      "raw=OLD",
      "read -r -- raw < read-raw.txt",
      "printf 'READ-RAW=<%s>\\n' \"$raw\"",
      "value=KEEP",
      "read value < empty.txt || echo READ-EOF-$?",
      "printf 'READ-EOF-PRESERVED=<%s>\\n' \"$value\"",
      "sh read-child.sh < read-overflow.txt || echo CHILD-READ-EXIT-$?",
      "echo IO-AFTER",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /usage: printf \[--\] FORMAT \[ARG\.\.\.\]/);
  assert.match(run.stdout, /formats: %% %s %c %d %i %u %o %x %X/);
  assert.match(run.stdout, /missing args: %s is empty, integers are zero, and %c emits NUL/);
  assert.match(run.stdout, /usage: echo \[-n\].*only the first exact -n is special/);
  assert.match(run.stdout, /usage: read \[-r\] \[--\] \[NAME\].*max 4095 bytes/);
  assert.match(run.stdout, /<alpha:7>\n<beta:8>\n<only:0>\n-2147483648:4294967295\n/);
  assert.match(run.stdout, /PRINTF-MISSING-2\nPRINTF-SEPARATOR-2\nPRINTF-FORMAT-2\nPRINTF-NUMBER-2\nPRINTF-RANGE-2\nPRINTF-UNSIGNED-2\nPRINTF-DANGLING-2\nPRINTF-ESCAPE-2\n/);
  assert.match(run.stdout, /QUOTED=<\|>\nQUOTED=<>>\nQUOTED=<<>\nQUOTED=<2>&1>\n/);
  assert.match(run.stdout, /x\|-n x\|\n/);
  assert.match(
    run.stdout,
    /slop: command substitution output contains NUL; use a file or pipeline instead\nNUL-SUBSTITUTION-STATUS=2 VALUE=<KEEP>\n/,
  );
  assert.match(run.stdout, /READ-MAX-BYTES=4095\nREAD-OVERFLOW-2\nREAD-PRESERVED=<OLD>\n/);
  assert.match(run.stdout, /READ-RAW=<one\\two>\nREAD-EOF-1\nREAD-EOF-PRESERVED=<KEEP>\n/);
  assert.match(run.stdout, /read: line too long \(max 4095 bytes\)\nCHILD-READ-STATUS=2\nCHILD-READ-VALUE=<CHILD-OLD>\nCHILD-READ-EXIT-2\nIO-AFTER\n/);

  for (const name of ["format", "number", "range", "unsigned", "dangling", "escape"])
    assert.equal(fs.readFile(`/home/web/printf-${name}.out`).byteLength, 0, `${name} must not emit partial stdout`);
  assert.deepEqual(fs.readFile("/home/web/printf-missing-char.out"), new Uint8Array([0]));
  assert.deepEqual(fs.readFile("/home/web/printf-first-char.out"), new TextEncoder().encode("A"));
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/printf-missing.err")), "slop: printf: format required\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/printf-separator.err")), "slop: printf: format required\n");
  assert.match(new TextDecoder().decode(fs.readFile("/home/web/printf-format.err")), /unsupported conversion: %q/);
  assert.match(new TextDecoder().decode(fs.readFile("/home/web/printf-number.err")), /%d: invalid 32-bit signed integer: 12x/);
  assert.match(new TextDecoder().decode(fs.readFile("/home/web/printf-range.err")), /%d: invalid 32-bit signed integer: 2147483648/);
  assert.match(new TextDecoder().decode(fs.readFile("/home/web/printf-unsigned.err")), /%u: invalid 32-bit unsigned integer: -1/);
  assert.match(new TextDecoder().decode(fs.readFile("/home/web/printf-dangling.err")), /dangling % in format/);
  assert.match(new TextDecoder().decode(fs.readFile("/home/web/printf-escape.err")), /unsupported escape: \\q/);
  assert.equal(
    new TextDecoder().decode(fs.readFile("/home/web/read-overflow.err")),
    "slop: read: line too long (max 4095 bytes)\n",
  );
});

test("slop: native git and host curl are discoverable commands", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(
    fs,
    [
      "type git", "command -v curl", "git --version", "/bin/curl -I https://example.com",
      "PWD=/ git status", "git grep -F '' -- file", 'git log --format ""',
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /git is \/bin\/git/);
  assert.match(run.stdout, /\/bin\/curl/);
  assert.match(run.stdout, /git version 2\.0\.0-piodide/);
  assert.deepEqual(run.gitCommands, [
    { args: ["git-engine", "--version"], cwd: "/home/web" },
    { args: ["git-engine", "status"], cwd: "/home/web" },
    { args: ["git-engine", "grep", "-F", "", "--", "file"], cwd: "/home/web" },
    { args: ["git-engine", "log", "--format", ""], cwd: "/home/web" },
  ]);
  assert.deepEqual(run.curlCommands, [["/bin/curl", "-I", "https://example.com"]]);
});

test("slop: Git preserves empty and boundary-sized arguments across both spawn layers", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  const pattern = "x".repeat(65_536);

  const run = await runSlop(fs, [`git grep -F '${pattern}' -- file`], { quiet: true });

  assert.equal(run.exitCode, 0);
  assert.equal(run.gitCommands.length, 1);
  assert.deepEqual(run.gitCommands[0].args.slice(0, 4), ["git-engine", "grep", "-F", pattern]);
  assert.deepEqual(run.gitCommands[0].args.slice(4), ["--", "file"]);
});

test("slop: host markers do not hijack arbitrary explicit paths", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(
    fs,
    ["./curl --version", "/definitely/not/here/curl --version"],
    { quiet: true },
  );

  assert.equal(run.exitCode, 127);
  assert.equal(run.curlCommands.length, 0);
  assert.equal(run.stdout.match(/command not found/g)?.length, 2);
});

test("slop: Git wrapper rejects output truncation", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(fs, ["git --large-output > git-large.out"], { quiet: true });

  assert.equal(run.exitCode, 23);
  assert.match(run.stdout, /git: output exceeds 1048576 bytes/);
  assert.equal(fs.readFile("/home/web/git-large.out").byteLength, 0);
});

test("slop: redirected git ls-files reaches its inclusive 16 MiB command bound", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(
    fs,
    ["git -C /home/web ls-files --output-boundary > ls-files-boundary.bin"],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0, run.stdout);
  const bytes = fs.readFile("/home/web/ls-files-boundary.bin");
  assert.equal(bytes.byteLength, 16 * 1024 * 1024);
  assert.equal(bytes[0], 65);
  assert.equal(bytes[bytes.byteLength - 1], 65);
});

test("slop: Git wrapper forwards piped stdin and command environment", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(
    fs,
    ["echo commit-message | GIT_AUTHOR_NAME=Agent GIT_AUTHOR_EMAIL=agent@example.com git commit -F -"],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.gitStdin, ["commit-message\n"]);
  assert.equal(run.gitEnvironments[0]?.GIT_AUTHOR_NAME, "Agent");
  assert.equal(run.gitEnvironments[0]?.GIT_AUTHOR_EMAIL, "agent@example.com");
});

test("slop: oversized host and WASI output fail before a pipeline consumer runs", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile("/home/web/large.bin", new Uint8Array(1024 * 1024 + 1).fill(66));

  const run = await runSlop(
    fs,
    ["curl https://large.example | wc -c", "cat large.bin | wc -c"],
    { quiet: true },
  );

  assert.equal(run.exitCode, 23);
  assert.equal(run.stdout.match(/command output exceeds 1048576 bytes/g)?.length, 2);
  assert.doesNotMatch(run.stdout, /1048576\s*$/);
  assert.deepEqual(run.curlCommands, [["curl", "https://large.example"]]);
});

test("slop: scripts, control flow, utilities, substitution, and exported env", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile("/home/web/one.txt", "one\n");
  fs.writeFile("/home/web/two.txt", "two\n");

  const run = await runSlop(
    fs,
    [
      "set -e",
      "export CHILD_VALUE=inherited",
      "env | grep CHILD_VALUE",
      "for x in c a b; do",
      "  echo $x >> raw.txt",
      "done",
      "FIRST=$(sort raw.txt | head -n 1)",
      "if test \"$FIRST\" = a; then",
      "  echo control-ok",
      "else",
      "  echo control-failed",
      "fi",
      "echo *.txt | grep one.txt",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /CHILD_VALUE=inherited\n/);
  assert.match(run.stdout, /control-ok\n/);
  assert.match(run.stdout, /one\.txt/);
  assert.doesNotMatch(run.stdout, /control-failed/);
});

test("slop: env launches one child with a bounded exact sanitized environment", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile("/home/web/env-script.sh", "printf 'script-ok\\n'\n");
  const decoder = new TextDecoder();
  const removals60 = Array.from({ length: 60 }, (_, index) => `-u REMOVE_${index}`).join(" ");
  const removals61 = `${removals60} -u REMOVE_60`;
  const command64 = Array(63).fill("x").join(" ");
  const command65 = `${command64} x`;
  const name255 = `N${"A".repeat(254)}`;
  const name256 = `N${"A".repeat(255)}`;
  const exactWord = "w".repeat(4096);
  // env counts every word after argv[0], including the two-byte -i option.
  const exactTotalTail = "t".repeat(4085);
  const oversizedWord = "w".repeat(4097);
  const exactTotal = `${Array(15).fill("\"$ENV_WORD_CHUNK\"").join(" ")} \"$ENV_WORD_TAIL\"`;
  const oversizedTotal = Array(16).fill("\"$ENV_WORD_CHUNK\"").join(" ");

  const accepted = await runSlop(fs, [
    "export ENV_SECRET=caller-secret ENV_KEEP=visible",
    "env -i /bin/env > env-empty.out",
    "env -i -- /bin/env > env-empty-delimited.out",
    "env -u ENV_SECRET /bin/env > env-removed.out",
    "env -u ENV_SECRET -u ENV_SECRET env > env-duplicate.out",
    "env -u ABSENT /bin/env > env-absent.out",
    `env ${removals60} /bin/env > env-remove-limit.out`,
    `env ${removals60} /bin/true a b c d e`,
    `env -u '${name255}' /bin/env > env-name-limit.out`,
    "env -i /bin/echo '' tail > env-empty-argument.out",
    "env /bin/echo -u ENV_SECRET > env-late-options.out",
    "env -i ./env-script.sh > env-script.out",
    "printf payload | env -i /bin/cat > env-stdin.out",
    "env -i /bin/echo pipeline | wc -c > env-pipeline.out",
    "env -i /bin/cat missing-env-input > env-child.out 2> env-child.err; echo CHILD-ERROR-$?",
    "env -i /bin/false; echo CHILD-FALSE-$?",
    `env -i /bin/echo '${exactWord}' > env-word-limit.out`,
    `ENV_WORD_CHUNK='${exactWord}'`,
    `ENV_WORD_TAIL='${exactTotalTail}'`,
    `env -i /bin/true ${exactTotal}`,
    `env -i /bin/echo ${command64} > env-command-limit.out`,
    "env | grep '^ENV_SECRET=caller-secret$'",
    "command -v env",
    "env --help",
  ], { quiet: true });
  assert.equal(accepted.exitCode, 0, accepted.stdout);
  assert.equal(fs.readFile("/home/web/env-empty.out").byteLength, 0);
  assert.equal(fs.readFile("/home/web/env-empty-delimited.out").byteLength, 0);
  for (const path of ["env-removed.out", "env-duplicate.out"]) {
    const output = decoder.decode(fs.readFile(`/home/web/${path}`));
    assert.match(output, /^ENV_KEEP=visible$/m, path);
    assert.doesNotMatch(output, /^ENV_SECRET=/m, path);
  }
  assert.match(decoder.decode(fs.readFile("/home/web/env-absent.out")), /^ENV_SECRET=caller-secret$/m);
  assert.match(decoder.decode(fs.readFile("/home/web/env-remove-limit.out")), /^ENV_KEEP=visible$/m);
  assert.match(decoder.decode(fs.readFile("/home/web/env-name-limit.out")), /^ENV_KEEP=visible$/m);
  assert.equal(decoder.decode(fs.readFile("/home/web/env-empty-argument.out")), " tail\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/env-late-options.out")), "-u ENV_SECRET\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/env-script.out")), "script-ok\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/env-stdin.out")), "payload");
  assert.equal(decoder.decode(fs.readFile("/home/web/env-pipeline.out")), "9\n");
  assert.equal(fs.readFile("/home/web/env-child.out").byteLength, 0);
  assert.match(decoder.decode(fs.readFile("/home/web/env-child.err")), /cat: missing-env-input:/);
  assert.equal(fs.readFile("/home/web/env-word-limit.out").byteLength, 4097);
  assert.equal(decoder.decode(fs.readFile("/home/web/env-command-limit.out")).trim().split(" ").length, 63);
  assert.match(accepted.stdout, /CHILD-ERROR-1\nCHILD-FALSE-1\nENV_SECRET=caller-secret\n/);
  assert.match(accepted.stdout,
    /\/bin\/env\nusage: env\n       env \[-i\] \[-u NAME\]\.\.\. \[--\] COMMAND/);

  const rejected = await runSlop(fs, [
    "env -i 2> env-missing-command.err; echo MISSING-COMMAND-$?",
    "env -- 2> env-delimiter-only.err; echo DELIMITER-ONLY-$?",
    "env -u 2> env-missing-name.err; echo MISSING-NAME-$?",
    "env -u -- /bin/env 2> env-name-delimiter.err; echo NAME-DELIMITER-$?",
    "env -u '' /bin/env 2> env-empty-name.err; echo EMPTY-NAME-$?",
    "env -u 9BAD /bin/env 2> env-bad-name.err; echo BAD-NAME-$?",
    `env -u '${name256}' /bin/env 2> env-long-name.err; echo LONG-NAME-$?`,
    "env -uENV_SECRET /bin/env 2> env-attached.err; echo ATTACHED-$?",
    "env -0 /bin/env 2> env-null.err; echo NULL-$?",
    "env -i -i /bin/env 2> env-repeat-i.err; echo REPEAT-I-$?",
    "env -i --help /bin/env 2> env-mixed-help.err; echo MIXED-HELP-$?",
    "env --help /bin/env 2> env-help-extra.err; echo HELP-EXTRA-$?",
    "env --version 2> env-version.err; echo VERSION-$?",
    "env ENV_ADDED=value /bin/env 2> env-assignment.err; echo ASSIGNMENT-$?",
    "env -u PATH env 2> env-removed-path.err; echo REMOVED-PATH-$?",
    "env -i env 2> env-empty-path.err; echo EMPTY-PATH-$?",
    "env -i -- -missing-command 2> env-dash-command.err; echo DASH-COMMAND-$?",
    "env -i /bin 2> env-directory.err; echo DIRECTORY-$?",
    `env ${removals61} /bin/env 2> env-remove-over.err; echo REMOVE-OVER-$?`,
    `env -i /bin/echo ${command65} 2> env-command-over.err; echo COMMAND-OVER-$?`,
    `env -i /bin/echo '${oversizedWord}' 2> env-word-over.err; echo WORD-OVER-$?`,
    `ENV_WORD_CHUNK='${exactWord}'`,
    `env -i /bin/true ${oversizedTotal} 2> env-total-over.err; echo TOTAL-OVER-$?`,
    "ENV_BAD='bad\u001bname'",
    "env -u \"$ENV_BAD\" /bin/env 2> env-hostile-name.err; echo HOSTILE-NAME-$?",
  ], { quiet: true });
  assert.equal(rejected.exitCode, 0);
  assert.match(rejected.stdout,
    /MISSING-COMMAND-2\nDELIMITER-ONLY-2\nMISSING-NAME-2\nNAME-DELIMITER-2\nEMPTY-NAME-2\nBAD-NAME-2\nLONG-NAME-2\n/);
  assert.match(rejected.stdout,
    /ATTACHED-2\nNULL-2\nREPEAT-I-2\nMIXED-HELP-2\nHELP-EXTRA-2\nVERSION-2\nASSIGNMENT-2\n/);
  assert.match(rejected.stdout,
    /REMOVED-PATH-127\nEMPTY-PATH-127\nDASH-COMMAND-127\nDIRECTORY-126\nREMOVE-OVER-2\nCOMMAND-OVER-2\nWORD-OVER-2\nTOTAL-OVER-2\nHOSTILE-NAME-2\n/);
  assert.equal(decoder.decode(fs.readFile("/home/web/env-hostile-name.err")),
    "env: -u NAME requires an ASCII variable name of at most 255 bytes\n");
  assert.doesNotMatch(decoder.decode(fs.readFile("/home/web/env-hostile-name.err")), /\x1b/);
  assert.equal(decoder.decode(fs.readFile("/home/web/env-removed-path.err")), "env: command not found\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/env-directory.err")), "env: command cannot launch\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/env-command-over.err")),
    "env: child argument vector exceeds 64 entries\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/env-word-over.err")),
    "env: argument exceeds 4096 bytes\n");
  assert.match(decoder.decode(fs.readFile("/home/web/env-total-over.err")),
    /^env: arguments exceed 65536 bytes\n$/);
});

test("slop: one-line compound commands retain shell separator semantics", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(
    fs,
    [
      "if true; then printf 'INLINE-IF\\n'; else echo IF-WRONG; fi",
      "if false; then echo ELIF-WRONG; elif true; then echo INLINE-ELIF; else echo ELSE-WRONG; fi",
      "COUNT=0; while test \"$COUNT\" -lt 2; do echo WHILE-$COUNT; COUNT=$((COUNT + 1)); done",
      "for item in a b; do echo FOR-$item; done",
      "if true; then if false; then echo NESTED-WRONG; else echo INLINE-NESTED; fi; fi",
      "inline_fn() { printf 'FUNCTION=<%s>\\n' \"$1\"; }; inline_fn value",
      "echo 'QUOTED;SEMICOLON'",
      "printf 'SUB=<%s>\\n' \"$(printf a; printf b)\"",
      "echo COMMENT-BEFORE; # echo COMMENT-WRONG; false",
      "echo COMMENT-AFTER",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0, run.stdout);
  assert.match(run.stdout, /INLINE-IF\nINLINE-ELIF\n/);
  assert.match(run.stdout, /WHILE-0\nWHILE-1\nFOR-a\nFOR-b\n/);
  assert.match(run.stdout, /INLINE-NESTED\nFUNCTION=<value>\n/);
  assert.match(run.stdout, /QUOTED;SEMICOLON\nSUB=<ab>\nCOMMENT-BEFORE\nCOMMENT-AFTER\n/);
  assert.doesNotMatch(run.stdout, /WRONG/);
});

test("slop: ls supports bounded human, time, reverse, and directory inspection", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/ls-flags/ordered/subdir");
  installShell(fs);
  fs.writeFile("/home/web/ls-flags/ordered/alpha.old", "abc");
  fs.writeFile("/home/web/ls-flags/ordered/beta.new", new Uint8Array(1536));
  fs.writeFile("/home/web/ls-flags/ordered/gamma.mid", new Uint8Array(2048));
  fs.writeFile("/home/web/ls-flags/ordered/.hidden", "hidden");
  fs.symlink("missing-target", "/home/web/ls-flags/broken-link");
  fs.utimes("/home/web/ls-flags/ordered/subdir", null, 0n);
  fs.utimes("/home/web/ls-flags/ordered/alpha.old", null, 1_000_000_000n);
  fs.utimes("/home/web/ls-flags/ordered/gamma.mid", null, 2_000_000_000n);
  fs.utimes("/home/web/ls-flags/ordered/beta.new", null, 3_000_000_000n);
  const tooMany = Array.from({ length: 65 }, () => "ordered/alpha.old").join(" ");

  const run = await runSlop(
    fs,
    [
      "cd ls-flags",
      "echo LS-DEFAULT",
      "ls -1 ordered",
      "echo LS-REVERSE",
      "ls -r ordered",
      "echo LS-TIME",
      "ls -t ordered",
      "echo LS-TIME-REVERSE",
      "ls -tr ordered",
      "echo LS-COMPACT",
      "ls -lthr ordered",
      "echo LS-HUMAN",
      "ls -lh ordered/beta.new",
      "echo LS-DIRECTORY",
      "ls -d ordered",
      "ls --directory ordered",
      "echo LS-SYMLINK",
      "ls -l broken-link",
      "echo LS-LONG-TIME",
      "ls --sort=time ordered",
      "echo LS-LONG-ALL",
      "ls --all --reverse ordered",
      "ls --human-readable -l ordered/beta.new",
      "ls --color=auto || echo LS-LONG-OPTION-$?",
      "ls -Z || echo LS-SHORT-OPTION-$?",
      `ls ${tooMany} || echo LS-OPERAND-LIMIT-$?`,
      "ls --help",
      "command -v ls",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /LS-DEFAULT\nalpha\.old\nbeta\.new\ngamma\.mid\nsubdir\/\n/);
  assert.match(run.stdout, /LS-REVERSE\nsubdir\/\ngamma\.mid\nbeta\.new\nalpha\.old\n/);
  assert.match(run.stdout, /LS-TIME\nbeta\.new\ngamma\.mid\nalpha\.old\nsubdir\/\n/);
  assert.match(run.stdout, /LS-TIME-REVERSE\nsubdir\/\nalpha\.old\ngamma\.mid\nbeta\.new\n/);
  assert.match(run.stdout, /LS-COMPACT\n\s+0 subdir\/\n\s+3 alpha\.old\n\s+2\.0K gamma\.mid\n\s+1\.5K beta\.new\n/);
  assert.match(run.stdout, /LS-HUMAN\n\s+1\.5K ordered\/beta\.new\n/);
  assert.match(run.stdout, /LS-DIRECTORY\nordered\/\nordered\/\n/);
  assert.match(run.stdout, /LS-SYMLINK\n\s+\d+ broken-link@\n/);
  assert.match(run.stdout, /LS-LONG-TIME\nbeta\.new\ngamma\.mid\nalpha\.old\nsubdir\/\n/);
  assert.match(run.stdout, /LS-LONG-ALL\n[\s\S]*\.hidden\n/);
  assert.match(run.stdout, /ls: unknown option --color=auto\nLS-LONG-OPTION-2\n/);
  assert.match(run.stdout, /ls: unknown option -Z\nLS-SHORT-OPTION-2\n/);
  assert.match(run.stdout, /ls: operand limit is 64\nLS-OPERAND-LIMIT-2\n/);
  assert.match(run.stdout, /usage: ls \[-1adhlrt\].*64 operands; 4096 entries\/directory/);
  assert.match(run.stdout, /\/bin\/ls\n/);
});

test("slop: common agent search and strict-script workflows", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/src/nested");
  fs.mkdirTree("/home/web/.git");
  installShell(fs);
  fs.writeFile("/home/web/src/main.ts", "const answer = 42;\nconst other = 7;\n");
  fs.writeFile("/home/web/src/nested/util.ts", "export const ANSWER = 42;\n");
  fs.writeFile("/home/web/src/ignore.js", "const answer = 0;\n");
  fs.writeFile("/home/web/.git/private.ts", "const answer = -1;\n");

  const run = await runSlop(
    fs,
    [
      "which rg",
      "rg --files -g '*.ts'",
      "rg -n -i -g '*.ts' 'answer[[:space:]]*=' src",
      "rg -l -F '42' src",
      "rg 'never-present' src || echo RG-NOMATCH-$?",
      "set -euo pipefail",
      "false | true || echo PIPEFAIL-$?",
      "set +u",
      "VALUE=$(false) || echo SUBSTITUTION-$?",
      "echo STRICT-CONTINUED",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /\/bin\/rg\n/);
  assert.match(run.stdout, /src\/main\.ts\n/);
  assert.match(run.stdout, /src\/nested\/util\.ts\n/);
  assert.doesNotMatch(run.stdout, /ignore\.js|private\.ts/);
  assert.match(run.stdout, /src\/main\.ts:1:const answer = 42;/);
  assert.match(run.stdout, /src\/nested\/util\.ts:1:export const ANSWER = 42;/);
  assert.match(run.stdout, /RG-NOMATCH-1\n/);
  assert.match(run.stdout, /PIPEFAIL-1\n/);
  assert.match(run.stdout, /SUBSTITUTION-1\n/);
  assert.match(run.stdout, /STRICT-CONTINUED\n/);

  const nounset = await runSlop(
    fs,
    ["set -u", "echo before", "echo $MISSING", "echo after"],
    { quiet: true },
  );
  assert.equal(nounset.exitCode, 2);
  assert.match(nounset.stdout, /MISSING: unbound variable/);
  assert.match(nounset.stdout, /before\n/);
  assert.doesNotMatch(nounset.stdout, /after\n/);
});

test("slop: rg emits bounded NUL-terminated pathname-only output atomically", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  const encoder = new TextEncoder();
  fs.mkdirTree("/home/web/weird");
  fs.mkdirTree("/home/web/empty-rg-paths");
  installShell(fs);
  fs.writeFile("/home/web/weird/normal.txt", "needle\n");
  fs.writeFile("/home/web/weird/line\nbreak.txt", "needle\n");
  fs.writeFile("/home/web/weird/-dash.txt", "absent\n");

  const directoryAtLength = (root: string, targetLength: number): string => {
    let path = root;
    while (path.length < targetLength) {
      const remaining = targetLength - path.length;
      if (remaining === 1) {
        path += "d";
      } else {
        path += `/${"d".repeat(Math.min(32, remaining - 1))}`;
      }
    }
    assert.equal(path.length, targetLength);
    return path;
  };

  // 256 records of 4,096 bytes including their terminator reach 1 MiB exactly.
  const capacityDirectory = directoryAtLength("cap", 4_088);
  fs.mkdirTree(`/home/web/${capacityDirectory}`);
  for (let index = 0; index < 256; index++) {
    const path = `${capacityDirectory}/f${String(index).padStart(5, "0")}`;
    assert.equal(path.length, 4_095);
    fs.writeFile(`/home/web/${path}`, "needle\n");
  }
  fs.writeFile("/home/web/cap-extra", "needle\n");

  const exactDirectory = directoryAtLength("path-exact", 4_089);
  const exactPath = `${exactDirectory}/target`;
  assert.equal(exactPath.length, 4_096);
  fs.mkdirTree(`/home/web/${exactDirectory}`);
  fs.writeFile(`/home/web/${exactPath}`, "needle\n");
  const overDirectory = directoryAtLength("path-over", 4_090);
  const overPath = `${overDirectory}/target`;
  assert.equal(overPath.length, 4_097);
  fs.mkdirTree(`/home/web/${overDirectory}`);
  fs.writeFile(`/home/web/${overPath}`, "needle\n");

  const exactDepthDirectory = `depth-exact/${Array(127).fill("d").join("/")}`;
  const exactDepthPath = `${exactDepthDirectory}/target`;
  fs.mkdirTree(`/home/web/${exactDepthDirectory}`);
  fs.writeFile(`/home/web/${exactDepthPath}`, "needle\n");
  const overDepthDirectory = `depth-over/${Array(128).fill("d").join("/")}`;
  fs.mkdirTree(`/home/web/${overDepthDirectory}`);
  fs.writeFile(`/home/web/${overDepthDirectory}/target`, "needle\n");

  const operandFiles = Array.from({ length: 101 }, (_, index) => `rg-operand-${index}`);
  for (const path of operandFiles) fs.writeFile(`/home/web/${path}`, "needle\n");

  const accepted = await runSlop(fs, [
    "rg --files -0 weird | sort -z > rg-files-short.bin",
    "rg --null --files weird | sort -z > rg-files-long.bin",
    "rg -0l -F needle weird | sort -z > rg-match-short.bin",
    "rg --null --files-with-matches -F needle weird | sort -z > rg-match-long.bin",
    "rg --null --files-without-match -F needle weird | sort -z > rg-without.bin",
    "rg -0l -F needle weird | xargs -0r -n1 printf x > rg-invoked.bin",
    "rg -0l -F never-present weird > rg-no-match.bin; echo NO-MATCH-$?",
    "rg --files -0 empty-rg-paths > rg-empty.bin; echo EMPTY-$?",
    "rg --files -0 cap > rg-capacity.bin; echo CAPACITY-$?",
    "rg --files -0 path-exact > rg-path-exact.bin; echo PATH-EXACT-$?",
    "rg --files -0 depth-exact > rg-depth-exact.bin; echo DEPTH-EXACT-$?",
    `rg --files -0 ${operandFiles.slice(0, 100).join(" ")} > rg-operands.bin; echo OPERANDS-$?`,
    "rg --help",
  ], { quiet: true });
  assert.equal(accepted.exitCode, 0, accepted.stdout);
  const expectedAll = encoder.encode("weird/-dash.txt\0weird/line\nbreak.txt\0weird/normal.txt\0");
  const expectedMatches = encoder.encode("weird/line\nbreak.txt\0weird/normal.txt\0");
  assert.deepEqual(fs.readFile("/home/web/rg-files-short.bin"), expectedAll);
  assert.deepEqual(fs.readFile("/home/web/rg-files-long.bin"), expectedAll);
  assert.deepEqual(fs.readFile("/home/web/rg-match-short.bin"), expectedMatches);
  assert.deepEqual(fs.readFile("/home/web/rg-match-long.bin"), expectedMatches);
  assert.deepEqual(fs.readFile("/home/web/rg-without.bin"), encoder.encode("weird/-dash.txt\0"));
  assert.deepEqual(fs.readFile("/home/web/rg-invoked.bin"), encoder.encode("xx"));
  assert.equal(fs.readFile("/home/web/rg-no-match.bin").byteLength, 0);
  assert.equal(fs.readFile("/home/web/rg-empty.bin").byteLength, 0);
  assert.equal(fs.readFile("/home/web/rg-capacity.bin").byteLength, 1_048_576);
  assert.deepEqual(fs.readFile("/home/web/rg-path-exact.bin"), encoder.encode(`${exactPath}\0`));
  assert.deepEqual(fs.readFile("/home/web/rg-depth-exact.bin"), encoder.encode(`${exactDepthPath}\0`));
  assert.equal(fs.readFile("/home/web/rg-operands.bin").byteLength,
    operandFiles.slice(0, 100).reduce((total, path) => total + path.length + 1, 0), accepted.stdout);
  assert.match(accepted.stdout,
    /NO-MATCH-1\nEMPTY-0\nCAPACITY-0\nPATH-EXACT-0\nDEPTH-EXACT-0\nOPERANDS-0\n/);
  assert.match(accepted.stdout,
    /-0\/--null \(NUL-terminated paths with --files, -l, or --files-without-match\)/);
  assert.match(accepted.stdout,
    /null-path limits: 100 inputs; 4096 bytes\/path; 100000 paths; 1 MiB output/);

  const rejected = await runSlop(fs, [
    "rg -0 needle weird > rg-ordinary.out 2> rg-ordinary.err; echo ORDINARY-$?",
    "rg --files -0 -n weird > rg-number.out 2> rg-number.err; echo NUMBER-$?",
    "rg --files -0 -c weird > rg-count.out 2> rg-count.err; echo COUNT-$?",
    "rg -0ql needle weird > rg-quiet.out 2> rg-quiet.err; echo QUIET-$?",
    "rg -0 -l --null-data needle weird > rg-modes.out 2> rg-modes.err; echo MODES-$?",
    "printf needle | rg -0 -l needle - > rg-stdin.out 2> rg-stdin.err; echo STDIN-$?",
    "rg --files -0 -l weird > rg-conflict.out 2> rg-conflict.err; echo CONFLICT-$?",
    "grep -0 -l needle weird > grep-null.out 2> grep-null.err; echo GREP-$?",
    "rg -0 -l needle weird missing > rg-missing.out 2> rg-missing.err; echo MISSING-$?",
    "rg --files -0 path-over > rg-path-over.out 2> rg-path-over.err; echo PATH-OVER-$?",
    "rg --files -0 depth-over > rg-depth-over.out 2> rg-depth-over.err; echo DEPTH-OVER-$?",
    "rg --files -0 cap cap-extra > rg-capacity-over.out 2> rg-capacity-over.err; echo CAPACITY-OVER-$?",
    `rg --files -0 ${operandFiles.join(" ")} > rg-operands-over.out 2> rg-operands-over.err; echo OPERANDS-OVER-$?`,
  ], { quiet: true });
  assert.equal(rejected.exitCode, 0);
  for (const path of [
    "rg-ordinary.out", "rg-number.out", "rg-count.out", "rg-quiet.out", "rg-modes.out",
    "rg-stdin.out", "rg-conflict.out", "grep-null.out", "rg-missing.out", "rg-path-over.out",
    "rg-depth-over.out",
    "rg-capacity-over.out", "rg-operands-over.out",
  ]) assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  assert.match(rejected.stdout,
    /ORDINARY-2\nNUMBER-2\nCOUNT-2\nQUIET-2\nMODES-2\nSTDIN-2\nCONFLICT-2\nGREP-2\nMISSING-2\nPATH-OVER-2\nDEPTH-OVER-2\nCAPACITY-OVER-2\nOPERANDS-OVER-2\n/);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/rg-ordinary.err")),
    "rg: -0/--null requires --files, -l, or --files-without-match\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/rg-modes.err")),
    "rg: --null and --null-data are different modes and cannot be combined\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/rg-stdin.err")),
    "rg: -0/--null pathname output does not accept stdin\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/rg-missing.err")),
    "rg: missing: No such file or directory\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/rg-path-over.err")),
    "rg: pathname exceeds 4096 bytes\n");
  assert.match(new TextDecoder().decode(fs.readFile("/home/web/rg-depth-over.err")),
    /^rg: .*: traversal depth limit reached\n$/);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/rg-capacity-over.err")),
    "rg: pathname output exceeds 1048576 bytes\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/rg-operands-over.err")),
    "rg: too many input paths (max 100)\n");
});

test("slop: long search aliases and bounded realpath are script-compatible", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/search/sub");
  installShell(fs);
  fs.writeFile("/home/web/search/a.txt", "Alpha\nbeta\n");
  fs.writeFile("/home/web/search/sub/b.txt", "needle\nplain\n");
  fs.writeFile("/home/web/-leading-path", "value\n");
  fs.symlink("../a.txt", "/home/web/search/sub/a-link");

  const run = await runSlop(
    fs,
    [
      "echo GREP-LONG",
      "grep --line-number --ignore-case --extended-regexp --regexp='^(alpha|beta)$' search/a.txt",
      "grep --recursive --with-filename --regexp=needle search",
      "echo RG-LONG",
      "rg --extended-regexp --regexp='needle|missing' search",
      "echo GREP-EMPTY",
      "grep --regexp= search/a.txt",
      "grep --basic-regexp Alpha search/a.txt || echo GREP-OPTION-$?",
      "echo REALPATH",
      "realpath search/sub/../a.txt",
      "realpath -e -P search/sub/a-link",
      "realpath --canonicalize-existing -- -leading-path",
      "realpath search/a.txt search/sub",
      "realpath missing-path || echo REALPATH-MISSING-$?",
      "realpath --logical search/a.txt || echo REALPATH-OPTION-$?",
      "realpath || echo REALPATH-OPERAND-$?",
      "command -v realpath",
      "realpath --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /GREP-LONG\n1:Alpha\n2:beta\nsearch\/sub\/b\.txt:needle\n/);
  assert.match(run.stdout, /RG-LONG\nsearch\/sub\/b\.txt:1:needle\n/);
  assert.match(run.stdout, /GREP-EMPTY\nAlpha\nbeta\n/);
  assert.match(run.stdout, /grep: unknown option --basic-regexp\nGREP-OPTION-2\n/);
  assert.match(run.stdout, /REALPATH\n\/home\/web\/search\/a\.txt\n\/home\/web\/search\/a\.txt\n\/home\/web\/-leading-path\n/);
  assert.match(run.stdout, /\/home\/web\/search\/a\.txt\n\/home\/web\/search\/sub\n/);
  assert.match(run.stdout, /realpath: missing-path:.*\nREALPATH-MISSING-1\n/);
  assert.match(run.stdout, /realpath: unsupported option: --logical\nREALPATH-OPTION-2\n/);
  assert.match(run.stdout, /realpath: missing operand\nREALPATH-OPERAND-2\n/);
  assert.match(run.stdout, /\/bin\/realpath\nusage: realpath/);
});

test("slop: grep and rg union repeated patterns atomically", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  const encoder = new TextEncoder();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile("/home/web/patterns.txt", "foo\nbar\nbaz\nFoo\n");
  fs.writeFile("/home/web/none.txt", "qux\n");
  fs.writeFile("/home/web/-leading.txt", "foo\n");
  fs.writeFile("/home/web/a b.txt", "baz\n");
  fs.writeFile("/home/web/patterns.bin", encoder.encode("foo\0bar\0baz\0"));

  const ordinary = await runSlop(
    fs,
    [
      "grep -e foo -e baz patterns.txt > union.txt",
      "grep -F --regexp=foo --regexp baz patterns.txt > mixed.txt",
      "grep -c -e foo -e 'fo.' patterns.txt > duplicate-count.txt",
      "grep -v -e foo -e baz patterns.txt > inverted.txt",
      "grep -i -e foo -e baz patterns.txt > insensitive.txt",
      "grep -m1 -e foo -e baz patterns.txt > max-one.txt",
      "grep -l -e foo -e baz patterns.txt none.txt > files-with.txt",
      "grep -L -e foo -e baz patterns.txt none.txt > files-without.txt",
      "grep -q -e absent -e baz patterns.txt && echo QUIET-0",
      "grep -F --regexp= --regexp=absent patterns.txt > empty-pattern.txt",
      "grep -F -e foo -e baz -- '-leading.txt' 'a b.txt' > literal-paths.txt",
      "grep -zF -e foo -e baz patterns.bin | sort -z > union.bin",
      "rg -e foo --regexp=baz patterns.txt > rg-union.txt",
      "grep --help",
      "rg --help",
    ],
    { quiet: true },
  );

  assert.equal(ordinary.exitCode, 0);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/union.txt")), "foo\nbaz\n");
  assert.deepEqual(fs.readFile("/home/web/mixed.txt"), fs.readFile("/home/web/union.txt"));
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/duplicate-count.txt")), "1\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/inverted.txt")), "bar\nFoo\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/insensitive.txt")), "foo\nbaz\nFoo\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/max-one.txt")), "foo\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/files-with.txt")), "patterns.txt\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/files-without.txt")), "none.txt\n");
  assert.match(ordinary.stdout, /QUIET-0\n/);
  assert.deepEqual(fs.readFile("/home/web/empty-pattern.txt"), fs.readFile("/home/web/patterns.txt"));
  assert.equal(
    new TextDecoder().decode(fs.readFile("/home/web/literal-paths.txt")),
    "-leading.txt:foo\na b.txt:baz\n",
  );
  assert.deepEqual(fs.readFile("/home/web/union.bin"), encoder.encode("baz\0foo\0"));
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/rg-union.txt")), "1:foo\n3:baz\n");
  assert.match(ordinary.stdout, /patterns: max 64 and 65536 bytes total; any pattern selects a record/);
  assert.match(ordinary.stdout, /explicit inputs: max 100, preflighted before pattern search/);

  const exactPattern = "x".repeat(65_536);
  const overPattern = `${exactPattern}x`;
  const exactPatternFlags = Array.from({ length: 64 }, (_, index) => `--regexp=p${index}`).join(" ");
  const overPatternFlags = `${exactPatternFlags} --regexp=overflow`;
  fs.writeFile("/home/web/pattern-boundary.txt", "p63\n");
  fs.writeFile("/home/web/exact-output.txt", `${"x".repeat(999_999)}\n`);
  fs.writeFile("/home/web/over-output.txt", `${"x".repeat(1_000_000)}\n`);
  const exactInputChunk = `${"x".repeat(1024 * 1024 - 1)}\n`;
  fs.writeFile("/home/web/exact-line-input.txt", exactInputChunk.repeat(16));
  fs.writeFile("/home/web/over-line-input.txt", `${exactInputChunk.repeat(16)}x`);
  fs.writeFile("/home/web/exact-line-records.txt", "x\n".repeat(100_000));
  fs.writeFile("/home/web/over-line-records.txt", "x\n".repeat(100_001));
  const inputFiles = Array.from({ length: 101 }, (_, index) => `input-${index}.txt`);
  for (const path of inputFiles) fs.writeFile(`/home/web/${path}`, "x\n");

  const rejected = await runSlop(
    fs,
    [
      "grep -E -e '[' -e foo patterns.txt > invalid-regex.out || echo INVALID-REGEX-$?",
      "grep -E -q -e '[' -e foo patterns.txt > invalid-quiet.out || echo INVALID-QUIET-$?",
      "grep -e > missing-pattern.out || echo MISSING-PATTERN-$?",
      "grep -efoo patterns.txt > compact-pattern.out || echo COMPACT-PATTERN-$?",
      "grep -e foo patterns.txt missing.txt > missing-file.out || echo MISSING-FILE-$?",
      `grep -F ${exactPatternFlags} pattern-boundary.txt > exact-pattern-count.out`,
      `grep -F ${overPatternFlags} pattern-boundary.txt > over-pattern-count.out || echo PATTERN-COUNT-$?`,
      `grep -F --regexp='${exactPattern}' pattern-boundary.txt > exact-pattern-bytes.out || echo PATTERN-BYTES-EXACT-$?`,
      `grep --regexp='${exactPattern}' pattern-boundary.txt > exact-default-pattern.out || echo DEFAULT-PATTERN-EXACT-$?`,
      `rg --regexp='${exactPattern}' pattern-boundary.txt > exact-rg-pattern.out || echo RG-PATTERN-EXACT-$?`,
      `grep -F --regexp='${overPattern}' pattern-boundary.txt > over-pattern-bytes.out || echo PATTERN-BYTES-$?`,
      "grep -F --regexp= exact-output.txt > exact-output.out",
      "grep -F --regexp= over-output.txt > over-output.out || echo OUTPUT-LIMIT-$?",
      "grep -F absent exact-line-input.txt > exact-input.out || echo INPUT-EXACT-$?",
      "grep -F -e absent -e missing over-line-input.txt > over-input.out || echo INPUT-LIMIT-$?",
      "grep -F absent exact-line-records.txt > exact-records.out || echo RECORDS-EXACT-$?",
      "grep -F -e absent -e missing over-line-records.txt > over-records.out || echo RECORDS-LIMIT-$?",
      `grep -F absent ${inputFiles.slice(0, 100).join(" ")} > exact-files.out || echo FILES-EXACT-$?`,
      `grep -F -e absent -e missing ${inputFiles.join(" ")} > over-files.out || echo FILES-LIMIT-$?`,
    ],
    { quiet: true },
  );

  assert.equal(rejected.exitCode, 0);
  for (const path of [
    "invalid-regex.out", "invalid-quiet.out", "missing-pattern.out", "compact-pattern.out",
    "missing-file.out", "over-pattern-count.out", "over-pattern-bytes.out", "over-output.out",
    "over-input.out", "over-records.out", "exact-files.out", "over-files.out",
    "exact-default-pattern.out", "exact-rg-pattern.out",
  ]) assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/exact-pattern-count.out")), "p63\n");
  assert.equal(fs.readFile("/home/web/exact-pattern-bytes.out").byteLength, 0);
  assert.equal(fs.readFile("/home/web/exact-output.out").byteLength, 1_000_000);
  assert.equal(fs.readFile("/home/web/exact-input.out").byteLength, 0);
  assert.equal(fs.readFile("/home/web/exact-records.out").byteLength, 0);
  assert.match(rejected.stdout, /grep: Missing '\]'\nINVALID-REGEX-2\n/);
  assert.match(rejected.stdout, /grep: Missing '\]'\nINVALID-QUIET-2\n/);
  assert.match(rejected.stdout, /grep: -e requires a pattern\nMISSING-PATTERN-2\n/);
  assert.match(rejected.stdout, /grep: unknown option -e\nCOMPACT-PATTERN-2\n/);
  assert.match(rejected.stdout, /grep: missing\.txt:.*\nMISSING-FILE-2\n/);
  assert.match(rejected.stdout, /grep: too many patterns\nPATTERN-COUNT-2\n/);
  assert.match(rejected.stdout, /PATTERN-BYTES-EXACT-1\n/);
  assert.match(rejected.stdout, /DEFAULT-PATTERN-EXACT-1\n/);
  assert.match(rejected.stdout, /RG-PATTERN-EXACT-1\n/);
  assert.match(rejected.stdout, /grep: patterns exceed 65536 bytes\nPATTERN-BYTES-2\n/);
  assert.match(rejected.stdout, /grep: output limit exceeded\nOUTPUT-LIMIT-2\n/);
  assert.match(rejected.stdout, /INPUT-EXACT-1\n/);
  assert.match(rejected.stdout, /grep: input limit exceeded\nINPUT-LIMIT-2\n/);
  assert.match(rejected.stdout, /RECORDS-EXACT-1\n/);
  assert.match(rejected.stdout, /grep: record limit exceeded\nRECORDS-LIMIT-2\n/);
  assert.match(rejected.stdout, /FILES-EXACT-1\n/);
  assert.match(rejected.stdout, /grep: too many input files \(max 100\)\nFILES-LIMIT-2\n/);
});

test("slop: arithmetic, case blocks, and functions", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(
    fs,
    [
      "COUNT=4",
      "echo ARITH-$((COUNT * 3 + 2))-$((1 << 3))",
      "echo ASSIGN-$((COUNT += 2))-$COUNT",
      "KIND=beta",
      'case "$KIND" in',
      "  alpha)",
      "    echo CASE-WRONG",
      "    ;;",
      "  beta|gamma)",
      "    echo CASE-beta",
      "    ;;",
      "  *)",
      "    echo CASE-DEFAULT",
      "    ;;",
      "esac",
      "greet() {",
      "  local SCOPED=inside",
      '  echo "HELLO-$1-$2"',
      '  echo "LOCAL-$SCOPED"',
      "  return 7",
      "  echo FUNCTION-WRONG",
      "}",
      "greet one two || echo RETURN-$?",
      "echo LOCAL-AFTER-${SCOPED-unset}",
      "type greet",
      "return 3",
      "echo OUTSIDE-RETURN-$?",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /ARITH-14-8\n/);
  assert.match(run.stdout, /ASSIGN-6-6\n/);
  assert.match(run.stdout, /CASE-beta\n/);
  assert.doesNotMatch(run.stdout, /CASE-WRONG|CASE-DEFAULT/);
  assert.match(run.stdout, /HELLO-one-two\n/);
  assert.match(run.stdout, /LOCAL-inside\n/);
  assert.match(run.stdout, /LOCAL-AFTER-unset\n/);
  assert.match(run.stdout, /RETURN-7\n/);
  assert.match(run.stdout, /greet is a function\n/);
  assert.doesNotMatch(run.stdout, /FUNCTION-WRONG/);
  assert.match(run.stdout, /return: not in a function or sourced script\n/);
  assert.match(run.stdout, /OUTSIDE-RETURN-2\n/);
});

test("slop: state builtins validate before mutation and unavailable modes fail explicitly", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(
    fs,
    [
      "export KEEP=old",
      "export ADDED=value bad-name || echo EXPORT-INVALID-$?",
      "echo EXPORT-STATE-${ADDED:-missing}-$KEEP",
      "unset KEEP bad-name || echo UNSET-INVALID-$?",
      "echo UNSET-STATE-$KEEP",
      "unset -- KEEP",
      "echo UNSET-DONE-${KEEP:-missing}",
      "readonly LOCK=value || echo READONLY-$?",
      "echo READONLY-STATE-${LOCK:-missing}",
      "umask || echo UMASK-QUERY-$?",
      "umask 022 || echo UMASK-SET-$?",
      "export --help",
      "unset --help",
      "readonly --help",
      "umask --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /export: invalid name: bad-name\nEXPORT-INVALID-2\n/);
  assert.match(run.stdout, /EXPORT-STATE-missing-old\n/);
  assert.match(run.stdout, /unset: invalid name: bad-name\nUNSET-INVALID-2\n/);
  assert.match(run.stdout, /UNSET-STATE-old\nUNSET-DONE-missing\n/);
  assert.match(run.stdout, /readonly is unavailable; variables are mutable in this bounded shell\nREADONLY-2\n/);
  assert.match(run.stdout, /READONLY-STATE-missing\n/);
  assert.match(run.stdout, /umask is unavailable; WASI exposes no permission modes\nUMASK-QUERY-2\n/);
  assert.match(run.stdout, /umask is unavailable; WASI exposes no permission modes\nUMASK-SET-2\n/);
  assert.match(run.stdout, /usage: export \[--\] NAME\[=VALUE\]/);
  assert.match(run.stdout, /usage: unset \[--\] NAME/);
  assert.match(run.stdout, /usage: readonly NAME\[=VALUE\].*unavailable/);
  assert.match(run.stdout, /usage: umask \[MODE\].*unavailable/);
});

test("slop: shift, return, and exit use strict bounded operands", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile(
    "/home/web/control.sh",
    [
      'echo "SHIFT-START-$#-$1-$2"',
      "shift 1",
      'echo "SHIFT-ONE-$#-$1"',
      "shift nope || echo SHIFT-NUMERIC-$?",
      'echo "SHIFT-AFTER-NUMERIC-$#-$1"',
      "shift 1 extra || echo SHIFT-EXTRA-$?",
      "shift 9 || echo SHIFT-RANGE-$?",
      'echo "SHIFT-AFTER-RANGE-$#-$1"',
      "shift",
      'echo "SHIFT-EMPTY-$#"',
      "shift || echo SHIFT-EMPTY-FAIL-$?",
      "shift --help",
      "bad_numeric() {",
      "  echo RETURN-NUMERIC-BEFORE",
      "  return nope",
      "  echo RETURN-NUMERIC-AFTER",
      "}",
      "bad_extra() {",
      "  return 7 extra",
      "  echo RETURN-EXTRA-AFTER",
      "}",
      "bad_numeric || echo RETURN-NUMERIC-$?",
      "bad_extra || echo RETURN-EXTRA-$?",
      "return --help",
      "exit --help",
      "command -v exit",
    ].join("\n") + "\n",
  );
  fs.writeFile("/home/web/bad-exit.sh", "echo EXIT-BEFORE\nexit nope\necho EXIT-AFTER\n");
  fs.writeFile("/home/web/extra-exit.sh", "exit 7 extra\necho EXIT-EXTRA-AFTER\n");
  fs.writeFile("/home/web/good-exit.sh", "exit 7\necho EXIT-GOOD-AFTER\n");
  fs.writeFile("/home/web/pipe-exit.sh", "exit 0 | cat\necho EXIT-PIPE-CONTINUES-$?\n");

  const run = await runSlop(
    fs,
    [
      "sh control.sh one two",
      "sh bad-exit.sh || echo EXIT-NUMERIC-$?",
      "sh extra-exit.sh || echo EXIT-EXTRA-$?",
      "sh good-exit.sh || echo EXIT-GOOD-$?",
      "sh pipe-exit.sh",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /SHIFT-START-2-one-two\nSHIFT-ONE-1-two\n/);
  assert.match(run.stdout, /shift: expected at most one decimal count from 0 to 128\nSHIFT-NUMERIC-2\n/);
  assert.match(run.stdout, /SHIFT-AFTER-NUMERIC-1-two\n/);
  assert.match(run.stdout, /SHIFT-EXTRA-2\n/);
  assert.match(run.stdout, /shift: 9 exceeds 1 positional parameters\nSHIFT-RANGE-1\n/);
  assert.match(run.stdout, /SHIFT-AFTER-RANGE-1-two\nSHIFT-EMPTY-0\n/);
  assert.match(run.stdout, /shift: 1 exceeds 0 positional parameters\nSHIFT-EMPTY-FAIL-1\n/);
  assert.match(run.stdout, /usage: shift \[COUNT\].*0\.\.128/);
  assert.match(run.stdout, /RETURN-NUMERIC-BEFORE\n/);
  assert.match(run.stdout, /return: expected at most one decimal status from 0 to 255\nRETURN-NUMERIC-2\n/);
  assert.match(run.stdout, /RETURN-EXTRA-2\n/);
  assert.doesNotMatch(run.stdout, /RETURN-NUMERIC-AFTER|RETURN-EXTRA-AFTER/);
  assert.match(run.stdout, /usage: return \[STATUS\].*0\.\.255/);
  assert.match(run.stdout, /usage: exit \[STATUS\].*0\.\.255\nexit\n/);
  assert.match(run.stdout, /EXIT-BEFORE\nslop: exit: expected at most one decimal status from 0 to 255\nEXIT-NUMERIC-2\n/);
  assert.match(run.stdout, /EXIT-EXTRA-2\nEXIT-GOOD-7\n/);
  assert.doesNotMatch(run.stdout, /EXIT-AFTER|EXIT-EXTRA-AFTER|EXIT-GOOD-AFTER/);
  assert.match(run.stdout, /exit: pipelines are unsupported\nEXIT-PIPE-CONTINUES-2\n/);
});

test("slop: set and local validate complete requests before changing state", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(
    fs,
    [
      "set +e +u +x +o pipefail",
      "set",
      "set -e -z || echo SET-FLAG-$?",
      "false",
      "echo ERREXIT-STILL-OFF-$?",
      "set -o pipefail unsupported || echo SET-OPTION-$?",
      "false | true",
      "echo PIPEFAIL-STILL-OFF-$?",
      "set -eu",
      "set",
      "set +eu",
      "set -e -- replaced || echo SET-MIXED-$?-$#-${1:-missing}",
      "set --help",
      "GLOBAL_VALUE=outside",
      "local_check() {",
      "  local GLOBAL_VALUE=inside LOCAL_NEW=value bad-name",
      "  echo LOCAL-INVALID-$?-$GLOBAL_VALUE-${LOCAL_NEW:-missing}",
      "  local -- GLOBAL_VALUE=inside",
      "  echo LOCAL-VALID-$GLOBAL_VALUE",
      "}",
      "local_check",
      "echo LOCAL-AFTER-$GLOBAL_VALUE-${LOCAL_NEW:-missing}",
      "local --help",
      "local OUTSIDE=value || echo LOCAL-OUTSIDE-$?",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /errexit off\nnounset off\nxtrace off\npipefail off\n/);
  assert.match(run.stdout, /set: unsupported flag: z\nSET-FLAG-2\n/);
  assert.match(run.stdout, /ERREXIT-STILL-OFF-1\n/);
  assert.match(run.stdout, /set: unsupported option: unsupported\nSET-OPTION-2\n/);
  assert.match(run.stdout, /PIPEFAIL-STILL-OFF-0\n/);
  assert.match(run.stdout, /errexit on\nnounset on\nxtrace off\npipefail off\n/);
  assert.match(run.stdout, /set: -- must be the first operand for positional replacement\nSET-MIXED-2-0-missing\n/);
  assert.match(run.stdout, /usage: set \[-\/\+eux\] \[-\/\+o pipefail\]/);
  assert.match(run.stdout, /local: invalid name: bad-name\nLOCAL-INVALID-2-outside-missing\n/);
  assert.match(run.stdout, /LOCAL-VALID-inside\nLOCAL-AFTER-outside-missing\n/);
  assert.match(run.stdout, /usage: local \[--\] NAME\[=VALUE\].*validates all names first/);
  assert.match(run.stdout, /local: not in a function\nLOCAL-OUTSIDE-2\n/);
});

test("slop: set -- atomically replaces bounded scoped positional vectors", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  fs.writeFile(
    "/home/web/set-source.sh",
    [
      "printf 'SOURCE-BEFORE-%s:' \"$#\"; printf '<%s>' \"$@\"; printf '\\n'",
      "set -- \"source one\" \"\" source-three",
      "shift",
      "printf 'SOURCE-AFTER-%s:' \"$#\"; printf '<%s>' \"$@\"; printf '\\n'",
    ].join("\n") + "\n",
  );
  const countBoundary = Array.from({ length: 100 }, () => "x").join(" ");
  const countOverflow = Array.from({ length: 101 }, () => "x").join(" ");
  const aggregateBoundary = [
    ...Array.from({ length: 99 }, () => '"$CHUNK_OK"'),
    '"$LAST_OK"',
  ].join(" ");
  const aggregateOverflow = Array.from({ length: 100 }, () => '"$CHUNK"').join(" ");
  fs.writeFile(
    "/home/web/set-driver.sh",
    [
      "printf 'TOP-BEFORE-%s:' \"$#\"; printf '<%s>' \"$@\"; printf '\\n'",
      "set -- \"a b\" \"\" c",
      "printf 'TOP-SET-%s:' \"$#\"; printf '<%s>' \"$@\"; printf '\\n'",
      "shift",
      "set -- \"$@\" \"d e\"",
      "printf 'TOP-APPEND-%s:' \"$#\"; printf '<%s>' \"$@\"; printf '\\n'",
      "scoped() {",
      "  printf 'FUNCTION-BEFORE-%s:' \"$#\"; printf '<%s>' \"$@\"; printf '\\n'",
      "  set -- \"inner one\" \"\" inner-three",
      "  printf 'FUNCTION-AFTER-%s:' \"$#\"; printf '<%s>' \"$@\"; printf '\\n'",
      "}",
      "scoped caller",
      "printf 'TOP-AFTER-FUNCTION-%s:' \"$#\"; printf '<%s>' \"$@\"; printf '\\n'",
      "source set-source.sh source-caller",
      "printf 'TOP-AFTER-SOURCE-%s:' \"$#\"; printf '<%s>' \"$@\"; printf '\\n'",
      "set -- --help -x",
      "printf 'OPTION-LIKE-%s:' \"$#\"; printf '<%s>' \"$@\"; printf '\\n'",
      "NEWLINE=$(printf 'line-one\\nline-two')",
      "set -- \"$NEWLINE\" '*' '[x]'",
      "printf 'RAW-%s:<%s><%s><%s>\\n' \"$#\" \"$1\" \"$2\" \"$3\"",
      "set -- stable \"old value\"",
      `set -- ${countBoundary}`,
      "echo COUNT-EXACT-$#",
      "set -- stable \"old value\"",
      `set -- ${countOverflow} || echo COUNT-LIMIT-$?-$#-$1`,
      `LONG_OK=${"k".repeat(4096)}`,
      "set -- \"$LONG_OK\"",
      "echo ARG-EXACT-$#",
      "set -- stable \"old value\"",
      `LONG=${"l".repeat(4097)}`,
      "set -- \"$LONG\" || echo ARG-LIMIT-$?-$#-$1",
      `CHUNK_OK=${"b".repeat(655)}`,
      `LAST_OK=${"e".repeat(691)}`,
      `set -- ${aggregateBoundary}`,
      "test \"${100}\" = \"$LAST_OK\" && echo TOTAL-EXACT-$#",
      "set -- stable \"old value\"",
      `CHUNK=${"g".repeat(700)}`,
      `set -- ${aggregateOverflow} || echo TOTAL-LIMIT-$?-$#-$1`,
      "set --",
      "printf 'TOP-CLEAR-%s:' \"$#\"; printf '<%s>' \"$@\"; printf '\\n'",
      "help set",
    ].join("\n") + "\n",
  );

  const run = await runSlop(fs, ["sh set-driver.sh original \"old two\""], { quiet: true });

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /^TOP-BEFORE-2:<original><old two>\n/);
  assert.match(run.stdout, /TOP-SET-3:<a b><><c>\n/);
  assert.match(run.stdout, /TOP-APPEND-3:<><c><d e>\n/);
  assert.match(run.stdout, /FUNCTION-BEFORE-1:<caller>\nFUNCTION-AFTER-3:<inner one><><inner-three>\n/);
  assert.match(run.stdout, /TOP-AFTER-FUNCTION-3:<><c><d e>\n/);
  assert.match(run.stdout, /SOURCE-BEFORE-1:<source-caller>\nSOURCE-AFTER-2:<><source-three>\n/);
  assert.match(run.stdout, /TOP-AFTER-SOURCE-3:<><c><d e>\n/);
  assert.match(run.stdout, /OPTION-LIKE-2:<--help><-x>\n/);
  assert.match(run.stdout, /RAW-3:<line-one\nline-two><\*><\[x\]>\n/);
  assert.match(run.stdout, /COUNT-EXACT-100\n/);
  assert.match(run.stdout, /set: too many positional parameters \(limit 100\)\nCOUNT-LIMIT-2-2-stable\n/);
  assert.match(run.stdout, /ARG-EXACT-1\n/);
  assert.match(run.stdout, /set: positional parameter 1 exceeds 4096-byte limit\nARG-LIMIT-2-2-stable\n/);
  assert.match(run.stdout, /TOTAL-EXACT-100\n/);
  assert.match(run.stdout, /set: positional parameters exceed 65536-byte aggregate limit\nTOTAL-LIMIT-2-2-stable\n/);
  assert.match(run.stdout, /TOP-CLEAR-0:<>\n/);
  assert.match(run.stdout, /set -- \[ARG\.\.\.\].*replace this scope's positional parameters atomically/);
  assert.match(run.stdout, /limits: 100 arguments, 4096 bytes each, 65536 bytes total/);
});

test("slop: break and continue are bounded to an active current loop", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(
    fs,
    [
      "break || echo BREAK-OUTSIDE-$?",
      "echo BREAK-OUTSIDE-CONTINUED",
      "continue 1 || echo CONTINUE-OUTSIDE-$?",
      "echo CONTINUE-OUTSIDE-CONTINUED",
      "break 2 || echo BREAK-LEVEL-OUTSIDE-$?",
      "continue nope || echo CONTINUE-LEVEL-OUTSIDE-$?",
      "break --help",
      "continue --help",
      "for ITEM in a b c",
      "do",
      "  echo BREAK-ITEM-$ITEM",
      "  break 1",
      "  echo BREAK-WRONG",
      "done",
      "echo BREAK-DONE",
      "for ITEM in a b",
      "do",
      "  echo CONTINUE-ITEM-$ITEM",
      "  continue",
      "  echo CONTINUE-WRONG",
      "done",
      "echo CONTINUE-DONE",
      "for ITEM in substitution",
      "do",
      "  VALUE=$(break)",
      "  echo SUBSTITUTION-BREAK-$?-${VALUE:-empty}",
      "  echo SUBSTITUTION-LOOP-CONTINUED",
      "done",
      "for ITEM in only",
      "do",
      "  break 2 || echo BREAK-LEVEL-IN-$?",
      "  continue extra || echo CONTINUE-LEVEL-IN-$?",
      "  echo INVALID-CONTROL-CONTINUED",
      "done",
      "leave_loop() {",
      "  echo FUNCTION-BREAK-BEFORE",
      "  break",
      "  echo FUNCTION-BREAK-WRONG",
      "}",
      "for ITEM in function",
      "do",
      "  leave_loop",
      "  echo FUNCTION-LOOP-WRONG",
      "done",
      "echo FUNCTION-BREAK-DONE",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /break: not in a loop\nBREAK-OUTSIDE-2\nBREAK-OUTSIDE-CONTINUED\n/);
  assert.match(run.stdout, /continue: not in a loop\nCONTINUE-OUTSIDE-2\nCONTINUE-OUTSIDE-CONTINUED\n/);
  assert.match(run.stdout, /break: only level 1 is supported\nBREAK-LEVEL-OUTSIDE-2\n/);
  assert.match(run.stdout, /continue: only level 1 is supported\nCONTINUE-LEVEL-OUTSIDE-2\n/);
  assert.match(run.stdout, /usage: break \[1\].*current loop only\nusage: continue \[1\].*current loop only\n/);
  assert.match(run.stdout, /BREAK-ITEM-a\nBREAK-DONE\n/);
  assert.doesNotMatch(run.stdout, /BREAK-ITEM-b|BREAK-ITEM-c|BREAK-WRONG/);
  assert.match(run.stdout, /CONTINUE-ITEM-a\nCONTINUE-ITEM-b\nCONTINUE-DONE\n/);
  assert.doesNotMatch(run.stdout, /CONTINUE-WRONG/);
  assert.match(run.stdout, /break: not in a loop\nSUBSTITUTION-BREAK-2-empty\nSUBSTITUTION-LOOP-CONTINUED\n/);
  assert.match(run.stdout, /BREAK-LEVEL-IN-2\n/);
  assert.match(run.stdout, /CONTINUE-LEVEL-IN-2\nINVALID-CONTROL-CONTINUED\n/);
  assert.match(run.stdout, /FUNCTION-BREAK-BEFORE\nFUNCTION-BREAK-DONE\n/);
  assert.doesNotMatch(run.stdout, /FUNCTION-BREAK-WRONG|FUNCTION-LOOP-WRONG/);
});

test("slop: source scopes arguments and return while bounding recursion", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile("/home/web/observe.sh", 'echo "OBSERVE-$#-${1:-missing}-${2:-missing}-$0"\n');
  fs.writeFile(
    "/home/web/valid-return.sh",
    'echo "SOURCE-RETURN-BEFORE-$#-${1:-missing}"\nSOURCE_VALUE=inside\nreturn 7\necho SOURCE-RETURN-WRONG\n',
  );
  fs.writeFile("/home/web/default-return.sh", "false\nreturn\necho SOURCE-DEFAULT-WRONG\n");
  fs.writeFile("/home/web/bad-return.sh", "echo SOURCE-BAD-BEFORE\nreturn nope\necho SOURCE-BAD-WRONG\n");
  fs.writeFile("/home/web/extra-return.sh", "return 9 extra\necho SOURCE-EXTRA-WRONG\n");
  fs.writeFile(
    "/home/web/help-return.sh",
    "echo SOURCE-HELP-BEFORE\nreturn --help\necho SOURCE-HELP-AFTER-$?\nreturn 0\necho SOURCE-HELP-WRONG\n",
  );
  fs.writeFile(
    "/home/web/substitution-return.sh",
    "VALUE=$(return 5)\necho SOURCE-SUBSTITUTION-$?-${VALUE:-empty}\nreturn 0\n",
  );
  fs.writeFile("/home/web/recursive-source.sh", "source recursive-source.sh\n");
  fs.writeFile(
    "/home/web/source-driver.sh",
    [
      'echo "DRIVER-BEFORE-$#-$1-$2"',
      "source observe.sh",
      "source -- observe.sh child-one child-two",
      ". observe.sh dot-one",
      'echo "DRIVER-AFTER-$#-$1-$2"',
      "source valid-return.sh scoped || echo SOURCE-VALID-$?",
      "echo SOURCE-VALUE-$SOURCE_VALUE",
      "source_function() {",
      "  source valid-return.sh function-scoped || echo FUNCTION-SOURCE-$?",
      "  echo FUNCTION-AFTER-SOURCE",
      "}",
      "source_function",
      "source default-return.sh || echo SOURCE-DEFAULT-$?",
      "source bad-return.sh || echo SOURCE-BAD-$?",
      "source extra-return.sh || echo SOURCE-EXTRA-$?",
      "source help-return.sh",
      "source substitution-return.sh",
      "source recursive-source.sh || echo SOURCE-RECURSION-$?",
      "source missing-source.sh 2> missing-source.err || echo SOURCE-MISSING-$?",
      "cat missing-source.err",
      "source --help",
      'echo "DRIVER-END-$#-$1-$2"',
    ].join("\n") + "\n",
  );

  const run = await runSlop(fs, ["sh source-driver.sh parent-one parent-two"], { quiet: true });

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /DRIVER-BEFORE-2-parent-one-parent-two\n/);
  assert.match(run.stdout, /OBSERVE-2-parent-one-parent-two-.*source-driver\.sh\n/);
  assert.match(run.stdout, /OBSERVE-2-child-one-child-two-.*source-driver\.sh\n/);
  assert.match(run.stdout, /OBSERVE-1-dot-one-missing-.*source-driver\.sh\n/);
  assert.match(run.stdout, /DRIVER-AFTER-2-parent-one-parent-two\n/);
  assert.match(run.stdout, /SOURCE-RETURN-BEFORE-1-scoped\nSOURCE-VALID-7\nSOURCE-VALUE-inside\n/);
  assert.match(run.stdout, /SOURCE-RETURN-BEFORE-1-function-scoped\nFUNCTION-SOURCE-7\nFUNCTION-AFTER-SOURCE\n/);
  assert.match(run.stdout, /SOURCE-DEFAULT-1\n/);
  assert.match(run.stdout, /SOURCE-BAD-BEFORE\nslop: return: expected at most one decimal status from 0 to 255\nSOURCE-BAD-2\n/);
  assert.match(run.stdout, /SOURCE-EXTRA-2\n/);
  assert.doesNotMatch(run.stdout, /SOURCE-RETURN-WRONG|SOURCE-DEFAULT-WRONG|SOURCE-BAD-WRONG|SOURCE-EXTRA-WRONG/);
  assert.match(run.stdout, /SOURCE-HELP-BEFORE\nusage: return \[STATUS\].*\nSOURCE-HELP-AFTER-0\n/);
  assert.doesNotMatch(run.stdout, /SOURCE-HELP-WRONG/);
  assert.match(run.stdout, /return: not in a function or sourced script\nSOURCE-SUBSTITUTION-2-empty\n/);
  assert.match(run.stdout, /source: recursion limit \(8\) exceeded\nSOURCE-RECURSION-2\n/);
  assert.match(run.stdout, /SOURCE-MISSING-1\nslop: missing-source\.sh:.*\n/);
  assert.match(run.stdout, /usage: source \[--\] FILE \[ARG\.\.\.\].*arguments are scoped/);
  assert.match(run.stdout, /DRIVER-END-2-parent-one-parent-two\n/);
  assert.match(
    new TextDecoder().decode(fs.readFile("/home/web/missing-source.err")),
    /^slop: missing-source\.sh:.*\n$/,
  );
});

test("slop: quoted positional vectors preserve argument boundaries across scopes", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/vector-src");
  fs.mkdirTree("/home/web/vector-dst");
  installShell(fs);
  fs.writeFile("/home/web/vector-src/one.txt", "one\n");
  fs.writeFile("/home/web/vector-src/two words.txt", "two\n");
  fs.writeFile(
    "/home/web/at-loop.sh",
    [
      "printf 'LOOP:'",
      "for item in \"$@\"",
      "do",
      "  printf ' <%s>' \"$item\"",
      "done",
      "printf '\\n'",
    ].join("\n") + "\n",
  );
  fs.writeFile("/home/web/cp-wrapper.sh", "cp \"$@\"\n");
  fs.writeFile(
    "/home/web/vector-source.sh",
    [
      "printf 'SOURCE:'",
      "for item in \"$@\"",
      "do",
      "  printf ' <%s>' \"$item\"",
      "done",
      "printf '\\n'",
    ].join("\n") + "\n",
  );
  fs.writeFile(
    "/home/web/source-vector-driver.sh",
    [
      "source vector-source.sh inner \"\" \"inner words\"",
      "printf 'OUTER:'",
      "for item in \"$@\"",
      "do",
      "  printf ' <%s>' \"$item\"",
      "done",
      "printf '\\n'",
    ].join("\n") + "\n",
  );

  const overflowArgs = Array.from({ length: 126 }, (_, index) => `v${index}`).join(" ");
  const run = await runSlop(
    fs,
    [
      "sh at-loop.sh",
      "sh at-loop.sh one \"\" \"two words\"",
      "forward() { \"$@\"; }",
      "forward printf 'FORWARD=<%s>\\n' one \"two words\"",
      "outer() { printf 'BEFORE=<%s>\\n' \"$@\"; inner inside; printf 'AFTER=<%s>\\n' \"$@\"; }",
      "inner() { shift; printf 'INNER-HASH=<%s>\\n' \"$#\"; }",
      "outer outside \"outside words\"",
      "empty_forward() { \"$@\"; }",
      "empty_forward",
      "echo EMPTY-FORWARD-$?",
      "sh -c 'printf \"C=<%s>\\n\" \"$@\"' label c-one \"\" \"c words\"",
      "sh -c 'command \"$@\"' label /bin/printf 'COMMAND=<%s>\\n' command-one \"\" \"command words\"",
      "shadowed() { echo SHADOWED-WRONG; }",
      "command shadowed || echo COMMAND-BYPASS-$?",
      "command -- /bin/printf 'COMMAND-TERMINATED=<%s>\\n' ok",
      "command -- || echo COMMAND-TARGET-$?",
      "command -x || echo COMMAND-OPTION-$?",
      "sh source-vector-driver.sh outer \"outer words\"",
      "sh cp-wrapper.sh vector-src/one.txt \"vector-src/two words.txt\" vector-dst",
      "help > vector-help.txt",
      "overflow_inner() { touch overflow-invoked; }",
      "overflow_outer() { overflow_inner prefix \"$@\"; }",
      `overflow_outer ${overflowArgs}`,
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 2);
  assert.match(run.stdout, /^LOOP:\nLOOP: <one> <> <two words>\n/);
  assert.match(run.stdout, /FORWARD=<one>\nFORWARD=<two words>\n/);
  assert.match(run.stdout, /BEFORE=<outside>\nBEFORE=<outside words>\nINNER-HASH=<0>\nAFTER=<outside>\nAFTER=<outside words>\n/);
  assert.match(run.stdout, /EMPTY-FORWARD-0\n/);
  assert.match(run.stdout, /C=<c-one>\nC=<>\nC=<c words>\n/);
  assert.match(run.stdout, /COMMAND=<command-one>\nCOMMAND=<>\nCOMMAND=<command words>\n/);
  assert.match(run.stdout, /command not found: shadowed\nCOMMAND-BYPASS-127\n/);
  assert.doesNotMatch(run.stdout, /SHADOWED-WRONG/);
  assert.match(run.stdout, /COMMAND-TERMINATED=<ok>\n/);
  assert.match(run.stdout, /command: target required\nCOMMAND-TARGET-2\n/);
  assert.match(run.stdout, /command: unsupported option: -x\nCOMMAND-OPTION-2\n/);
  assert.match(run.stdout, /SOURCE: <inner> <> <inner words>\nOUTER: <outer> <outer words>\n/);
  assert.match(run.stdout, /slop: too many arguments\n$/);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/vector-dst/one.txt")), "one\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/vector-dst/two words.txt")), "two\n");
  assert.match(
    new TextDecoder().decode(fs.readFile("/home/web/vector-help.txt")),
    /standalone quoted "\$@"/,
  );
  assert.equal(fs.exists("/home/web/overflow-invoked"), false);

  const concatenated = await runSlop(
    fs,
    [
      "bad() { touch concatenated-invoked; }",
      "wrapper() { bad \"pre$@post\"; }",
      "wrapper value",
    ],
    { quiet: true },
  );
  assert.equal(concatenated.exitCode, 2);
  assert.match(concatenated.stdout, /quoted \$@ must be a separate shell word/);
  assert.equal(fs.exists("/home/web/concatenated-invoked"), false);
});

test("slop: stderr redirects apply to builtins and spawned programs", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile("/home/web/emit.sh", "echo script-out\necho script-err >&2\n");
  fs.writeFile("/home/web/sourcepart.sh", "echo source-out\necho source-err >&2\n");

  const run = await runSlop(
    fs,
    [
      "cd /missing 2> builtin.err",
      "cat /missing-one 2> child.err",
      "cat /missing-two 2>> child.err",
      "cat /missing-three 2>&1 | grep missing-three",
      "sh emit.sh 2>&1 | cat > merged-pipe.txt",
      "cat /missing-four &> both.txt",
      "sh emit.sh 2>&1 > order-b.txt",
      "source sourcepart.sh > source.out 2> source.err",
      "eval 'echo eval-out; echo eval-err >&2' > eval.out 2> eval.err",
      "cat builtin.err",
      "cat child.err",
      "cat both.txt",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  const builtinError = new TextDecoder().decode(fs.readFile("/home/web/builtin.err"));
  const childError = new TextDecoder().decode(fs.readFile("/home/web/child.err"));
  const both = new TextDecoder().decode(fs.readFile("/home/web/both.txt"));
  const mergedPipe = new TextDecoder().decode(fs.readFile("/home/web/merged-pipe.txt"));
  const ordered = new TextDecoder().decode(fs.readFile("/home/web/order-b.txt"));
  assert.match(builtinError, /cd: \/missing/);
  assert.match(childError, /missing-one/);
  assert.match(childError, /missing-two/);
  assert.match(run.stdout, /missing-three/);
  assert.equal(mergedPipe, "script-out\nscript-err\n");
  assert.match(both, /missing-four/);
  assert.equal(ordered, "script-out\n");
  assert.match(run.stdout, /script-err\n/);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/source.out")), "source-out\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/source.err")), "source-err\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/eval.out")), "eval-out\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/eval.err")), "eval-err\n");
});

test("slop: exact /dev/null redirects are a uniform virtual sink and source", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(
    fs,
    [
      "printf builtin >/dev/null",
      "printf compact 1>/dev/null",
      "printf appended >>/dev/null",
      "command -v git >/dev/null && echo FOUND",
      "false >/dev/null || echo FALSE-$?",
      "cd /missing 2>/dev/null || echo STDERR-$?",
      "cd /missing 2>>/dev/null || echo STDERR-APPEND-$?",
      "cd /missing >/dev/null 2>&1 || echo BOTH-$?",
      "cd /missing 2>&1 >/dev/null || echo ORDER-$?",
      "cat </dev/null && echo EOF",
      "eval 'printf nested; cd /missing' &>/dev/null || echo EVAL-$?",
      "eval 'printf nested; cd /missing' &>>/dev/null || echo EVAL-APPEND-$?",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.equal(run.stderr, "");
  assert.match(run.stdout, /^FOUND\nFALSE-1\nSTDERR-1\nSTDERR-APPEND-1\nBOTH-1\n/);
  assert.match(run.stdout, /slop: cd: \/missing: .+\nORDER-1\nEOF\nEVAL-1\nEVAL-APPEND-1\n$/);
  assert.equal(fs.exists("/dev/null"), false);

  const help = await runSlop(fs, ["slop --help"], { quiet: true });
  assert.equal(help.exitCode, 0);
  assert.match(help.stdout, /\/dev\/null is an exact virtual EOF source and output sink; other \/dev redirects fail/);

  const unsupported = await runSlop(fs, ["printf should-not-run >/dev/zero"], { quiet: true });
  assert.equal(unsupported.exitCode, 1);
  assert.equal(unsupported.stderr, "slop: /dev/zero: unsupported redirect device\n");
  assert.equal(fs.exists("/dev/zero"), false);
});

test("slop: stdout duplicates to stderr without creating ampersand files", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(
    fs,
    [
      "echo builtin-shorthand >&2",
      "printf 'builtin-explicit\\n' 1>&2",
      "printf 'child-output\\n' > source.txt",
      "cat source.txt >&2",
      "printf 'quoted-ampersand\\n' > '&literal'",
      "cat '&literal'",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stderr, /builtin-shorthand/);
  assert.match(run.stderr, /builtin-explicit/);
  assert.match(run.stderr, /child-output/);
  assert.match(run.stdout, /quoted-ampersand/);
  assert.equal(fs.exists("/home/web/&2"), false);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/&literal")), "quoted-ampersand\n");
});

test("slop: test negation reverses file predicates", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile("/home/web/present.txt", "ok\n");

  const run = await runSlop(
    fs,
    [
      "test ! -e present.txt || echo PRESENT-NEGATED-FALSE",
      "test ! -e missing.txt && echo MISSING-NEGATED-TRUE",
      "[ ! -e present.txt ] || echo BRACKET-PRESENT-FALSE",
      "[ ! -e missing.txt ] && echo BRACKET-MISSING-TRUE",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /PRESENT-NEGATED-FALSE/);
  assert.match(run.stdout, /MISSING-NEGATED-TRUE/);
  assert.match(run.stdout, /BRACKET-PRESENT-FALSE/);
  assert.match(run.stdout, /BRACKET-MISSING-TRUE/);
});

test("slop: test guards distinguish false predicates from malformed expressions", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/directory");
  installShell(fs);
  fs.writeFile("/home/web/present.txt", "ok\n");
  fs.symlink("present.txt", "/home/web/present-link");
  fs.symlink("directory", "/home/web/directory-link");
  fs.symlink("missing.txt", "/home/web/broken-link");

  const run = await runSlop(
    fs,
    [
      "[ -L present-link ] && echo PRESENT-LINK",
      "[ -f present-link ] && test -s present-link && echo LINK-TARGET-FILE",
      "[ -d directory-link ] && echo LINK-TARGET-DIRECTORY",
      "test -h broken-link && echo BROKEN-LINK",
      "test -e broken-link || echo BROKEN-TARGET-MISSING-$?",
      "test 10 -gt 2 && echo NUMERIC-TRUE",
      "test 2 -gt 10 || echo NUMERIC-FALSE-$?",
      "test nope -eq 0 || echo INVALID-LEFT-$?",
      "test 0 -eq nope || echo INVALID-RIGHT-$?",
      "test ! nope -eq 0 || echo INVALID-NEGATED-$?",
      "test -q present.txt || echo INVALID-UNARY-$?",
      "test a -wat b || echo INVALID-BINARY-$?",
      "[ -f present.txt || echo MISSING-BRACKET-$?",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(
    run.stdout,
    /PRESENT-LINK\nLINK-TARGET-FILE\nLINK-TARGET-DIRECTORY\nBROKEN-LINK\nBROKEN-TARGET-MISSING-1\n/,
  );
  assert.match(run.stdout, /NUMERIC-TRUE\nNUMERIC-FALSE-1\n/);
  for (const label of [
    "INVALID-LEFT-2", "INVALID-RIGHT-2", "INVALID-NEGATED-2",
    "INVALID-UNARY-2", "INVALID-BINARY-2", "MISSING-BRACKET-2",
  ]) assert.match(run.stdout, new RegExp(`${label}\\n`));
  assert.match(run.stdout, /test: nope: integer expression expected/);
  assert.match(run.stdout, /test: unsupported unary operator: -q/);
  assert.match(run.stdout, /test: unsupported expression/);
  assert.match(run.stdout, /\[: missing '\]'/);
});

test("slop: test timestamp guards follow links and handle missing build outputs", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile("/home/web/older.txt", "old\n");
  fs.writeFile("/home/web/newer.txt", "new\n");
  fs.utimes("/home/web/older.txt", null, 1_000_000_000n);
  fs.utimes("/home/web/newer.txt", null, 2_000_000_000n);
  fs.symlink("older.txt", "/home/web/older-link");
  fs.symlink("newer.txt", "/home/web/newer-link");

  const run = await runSlop(
    fs,
    [
      "test newer.txt -nt older.txt && echo NEWER-TRUE",
      "test older.txt -ot newer.txt && echo OLDER-TRUE",
      "test newer-link -nt older-link && echo LINKS-FOLLOWED",
      "test newer.txt -nt missing-output && echo MISSING-OUTPUT-IS-OLDER",
      "test missing-input -ot newer.txt && echo MISSING-INPUT-IS-OLDER",
      "test older.txt -nt newer.txt || echo NOT-NEWER-$?",
      "test newer.txt -ot older.txt || echo NOT-OLDER-$?",
      "test missing-a -nt missing-b || echo BOTH-MISSING-NT-$?",
      "test missing-a -ot missing-b || echo BOTH-MISSING-OT-$?",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.equal(
    run.stdout,
    "NEWER-TRUE\nOLDER-TRUE\nLINKS-FOLLOWED\nMISSING-OUTPUT-IS-OLDER\n" +
      "MISSING-INPUT-IS-OLDER\nNOT-NEWER-1\nNOT-OLDER-1\nBOTH-MISSING-NT-1\nBOTH-MISSING-OT-1\n",
  );
});

test("slop: test help and permission predicates are explicit without WASI modes", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/directory");
  installShell(fs);
  fs.writeFile("/home/web/present.txt", "ok\n");

  const run = await runSlop(
    fs,
    [
      "test --help",
      "test -e present.txt && echo EXISTS",
      "test -r present.txt || echo READ-PREDICATE-$?",
      "[ -w directory ] || echo WRITE-PREDICATE-$?",
      "test -x present.txt || echo EXEC-PREDICATE-$?",
      "test ! -x present.txt || echo NEGATED-EXEC-PREDICATE-$?",
      "test -x missing.txt || echo MISSING-EXEC-PREDICATE-$?",
      "command -v sh",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /^usage: test EXPRESSION$/m);
  assert.match(run.stdout, /integers: INTEGER -eq\|-ne\|-lt\|-le\|-gt\|-ge INTEGER/);
  assert.match(run.stdout, /-r\/-w\/-x unavailable \(no WASI modes\)/);
  assert.match(run.stdout, /EXISTS\n/);
  for (const label of [
    "READ-PREDICATE-2", "WRITE-PREDICATE-2", "EXEC-PREDICATE-2",
    "NEGATED-EXEC-PREDICATE-2", "MISSING-EXEC-PREDICATE-2",
  ]) assert.match(run.stdout, new RegExp(`${label}\\n`));
  assert.equal(run.stdout.match(/permission predicate unavailable/g)?.length, 5);
  assert.match(run.stdout, /\/bin\/sh\n$/);
});

test("slop: chmod, uniq, and xargs provide bounded useful subsets", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile("/home/web/present.txt", "ok\n");

  const run = await runSlop(
    fs,
    [
      "printf 'a\\na\\nb\\n' | uniq -c",
      "printf 'a b c' | xargs -n 2 echo ITEM",
      "printf 'a b\\nc\\n' | xargs -I{} echo 'pre-{}-post'",
      "printf 'echo\\n' | xargs -I CMD CMD REPLACED-COMMAND",
      "printf '1 2 3' | xargs -n2 echo COMPACT",
      "printf 'x\\n' | xargs -I{} -n 1 echo {} || echo XARGS-MODES-$?",
      "printf '' | xargs -I{} echo SHOULD-NOT-RUN-I",
      "chmod 755 present.txt || echo CHMOD-UNSUPPORTED-$?",
      "chmod 755 missing.txt || echo CHMOD-$?",
      "chmod symbolic present.txt || echo CHMOD-SYNTAX-$?",
      "uniq --unsupported present.txt || echo UNIQ-OPTION-$?",
      "xargs --unsupported || echo XARGS-OPTION-$?",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /\s+2 a\n\s+1 b\n/);
  assert.match(run.stdout, /ITEM a b\nITEM c\n/);
  assert.match(run.stdout, /pre-a b-post\npre-c-post\n/);
  assert.match(run.stdout, /REPLACED-COMMAND\n/);
  assert.match(run.stdout, /COMPACT 1 2\nCOMPACT 3\n/);
  assert.match(run.stdout, /XARGS-MODES-2\n/);
  assert.doesNotMatch(run.stdout, /SHOULD-NOT-RUN-I/);
  assert.match(run.stdout, /mode changes are unsupported on this filesystem/);
  assert.match(run.stdout, /CHMOD-UNSUPPORTED-2\n/);
  assert.match(run.stdout, /chmod: missing\.txt:/);
  assert.match(run.stdout, /CHMOD-1\n/);
  assert.match(run.stdout, /CHMOD-SYNTAX-2\n/);
  assert.match(run.stdout, /UNIQ-OPTION-2\n/);
  assert.match(run.stdout, /XARGS-OPTION-2\n/);
});

test("slop: compact flags, read loops, and xargs builtin counterparts are compatible", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile("/home/web/text.txt", "alpha\nbeta\ngamma\n");
  fs.writeFile("/home/web/backslash.txt", "a\\b c\n");
  fs.writeFile("/home/web/items.txt", "a\nb\n");
  fs.writeFile("/home/web/nul-items", new Uint8Array([0x61, 0, 0x62, 0]));
  fs.writeFile("/home/web/empty", "");
  fs.writeFile(
    "/home/web/loop-status.sh",
    "while read -r line\ndo\n printf 'LOOP=<%s>\\n' \"$line\"\ndone\n",
  );

  const run = await runSlop(
    fs,
    [
      "echo HEAD-COMPACT",
      "head -n2 text.txt",
      "head -nnope text.txt || echo HEAD-INVALID-$?",
      "tail -nnope text.txt || echo TAIL-INVALID-$?",
      "echo SED-COMPACT",
      "sed -nE '/^(alpha|beta)$/p' text.txt",
      "echo XARGS-COMPACT",
      "cat nul-items | xargs -0r -n1 echo NUL",
      "cat empty | xargs -0r false && echo XARGS-EMPTY-OK",
      "read -r line < backslash.txt",
      "printf 'READ=<%s>\\n' \"$line\"",
      "read --help",
      "cat items.txt | sh loop-status.sh && echo LOOP-STATUS-OK",
      "cat empty | sh loop-status.sh && echo EMPTY-LOOP-STATUS-OK",
      "cat items.txt | xargs -n1 printf '<%s>\\n'",
      "printf 'x\\n' | xargs false || echo XARGS-FALSE-$?",
      "/bin/printf 'EXTERNAL=<%s>\\n' direct",
      "/bin/true && echo EXTERNAL-TRUE",
      "/bin/false || echo EXTERNAL-FALSE-$?",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /HEAD-COMPACT\nalpha\nbeta\n/);
  assert.match(run.stdout, /head: invalid count: nope\nHEAD-INVALID-2\n/);
  assert.match(run.stdout, /tail: invalid count: nope\nTAIL-INVALID-2\n/);
  assert.match(run.stdout, /SED-COMPACT\nalpha\nbeta\n/);
  assert.match(run.stdout, /XARGS-COMPACT\nNUL a\nNUL b\nXARGS-EMPTY-OK\n/);
  assert.match(run.stdout, /READ=<a\\b c>\n/);
  assert.match(run.stdout, /usage: read \[-r\] \[--\] \[NAME\].*max 4095 bytes/);
  assert.match(run.stdout, /LOOP=<a>\nLOOP=<b>\nLOOP-STATUS-OK\nEMPTY-LOOP-STATUS-OK\n/);
  assert.match(run.stdout, /<a>\n<b>\nXARGS-FALSE-1\n/);
  assert.match(run.stdout, /EXTERNAL=<direct>\nEXTERNAL-TRUE\nEXTERNAL-FALSE-1\n/);
});

test("slop: head -z selects bounded NUL records atomically", { timeout: 120_000 }, async () => {
  const fs = new LateReadFailureFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  const encoder = new TextEncoder();
  const basic = new Uint8Array([0x61, 0, 0x62, 0]);
  fs.writeFile("/home/web/basic.bin", basic);
  fs.writeFile("/home/web/unterminated.bin", new Uint8Array([0x61, 0, 0x62]));
  fs.writeFile("/home/web/empty-records.bin", new Uint8Array([0, 0, 0x61, 0]));
  fs.writeFile("/home/web/invalid-bytes.bin", new Uint8Array([0x80, 0xff, 0]));
  fs.writeFile("/home/web/empty.bin", new Uint8Array());
  fs.writeFile("/home/web/+1", new Uint8Array([0x70, 0]));

  const exactRecord = new Uint8Array(1024 * 1024).fill(0x61);
  exactRecord[exactRecord.length - 1] = 0;
  const overRecord = new Uint8Array(1024 * 1024 + 1).fill(0x61);
  overRecord[overRecord.length - 1] = 0;
  fs.writeFile("/home/web/exact-record.bin", exactRecord);
  fs.writeFile("/home/web/over-record.bin", overRecord);

  const perInputLimit = new Uint8Array(16 * 1024 * 1024).fill(0x61);
  for (let offset = 1024 * 1024 - 1; offset < perInputLimit.length; offset += 1024 * 1024)
    perInputLimit[offset] = 0;
  const perInputOver = new Uint8Array(perInputLimit.length + 1);
  perInputOver.set(perInputLimit); perInputOver[perInputLimit.length] = 0x62;
  fs.writeFile("/home/web/per-input-limit.bin", perInputLimit);
  fs.writeFile("/home/web/per-input-over.bin", perInputOver);

  const exactRecords = new Uint8Array(200_000);
  for (let offset = 0; offset < exactRecords.length; offset += 2) {
    exactRecords[offset] = 0x61; exactRecords[offset + 1] = 0;
  }
  fs.writeFile("/home/web/exact-records.bin", exactRecords);
  const lateRead = new Uint8Array(131_072);
  for (let offset = 0; offset < lateRead.length; offset += 2) {
    lateRead[offset] = 0x61; lateRead[offset + 1] = 0;
  }
  fs.writeFile("/home/web/late-read.bin", lateRead);

  const run = await runSlop(
    fs,
    [
      "head -z -n 1 basic.bin > first.out",
      "head --zero-terminated basic.bin > default.out",
      "head -z -n2 unterminated.bin > unterminated.out",
      "head -z -n 2 empty-records.bin > empty-records.out",
      "head -z -n10 empty.bin > empty.out",
      "head -z -n0 late-read.bin > zero.out",
      "head -z -n1 basic.bin invalid-bytes.bin > multiple.out",
      "cat basic.bin | head -z -n1 > stdin.out",
      "cat basic.bin | head -z -n1 - > explicit-stdin.out",
      "head -z -n1 missing.bin basic.bin > continued.out || echo CONTINUED-$?",
      "head -z -n1 -- +1 > plus-file.out",
      "head -z -n1 exact-record.bin > exact-record.out",
      "head -z -n1 over-record.bin > over-record.out || echo RECORD-LIMIT-$?",
      "head -z -n16 per-input-limit.bin > /dev/null && echo INPUT-EXACT-OK",
      "head -z -n17 per-input-over.bin > per-input-over.out || echo INPUT-LIMIT-$?",
      "head -z -n100000 exact-records.bin > /dev/null && echo RECORDS-EXACT-OK",
      `head -z -n0 ${Array.from({ length: 100 }, () => "basic.bin").join(" ")} > /dev/null && echo FILES-EXACT-OK`,
      `head -z -n0 ${Array.from({ length: 101 }, () => "basic.bin").join(" ")} > files-over.out || echo FILES-OVER-$?`,
      "head -z -n16 per-input-limit.bin per-input-limit.bin per-input-limit.bin per-input-limit.bin > /dev/null && echo TOTAL-EXACT-OK",
      "head -z -n16 per-input-limit.bin per-input-limit.bin per-input-limit.bin per-input-limit.bin basic.bin > total-over.out || echo TOTAL-LIMIT-$?",
      "wc -c total-over.out",
      "rm total-over.out",
      "head -z -n100001 basic.bin > invalid-count.out || echo COUNT-OVER-$?",
      "head -z -n -1 basic.bin > negative.out || echo NEGATIVE-$?",
      "head -z -n +1 basic.bin > leading-plus.out || echo LEADING-PLUS-$?",
      "head -z -n ' 1' basic.bin > leading-space.out || echo LEADING-SPACE-$?",
      "head -z -n '1 ' basic.bin > trailing-space.out || echo TRAILING-SPACE-$?",
      "head -z --lines 1 basic.bin > long-lines.out || echo LONG-LINES-$?",
      "head -z --lines=1 basic.bin > long-lines-equals.out || echo LONG-LINES-EQUALS-$?",
      "head -z -1 basic.bin > legacy-count.out || echo LEGACY-COUNT-$?",
      "head -z -c1 basic.bin > bytes.out || echo BYTES-$?",
      "head -z +1 > plus.out || echo PLUS-$?",
      "head --zero-terminated=value basic.bin > value.out || echo VALUE-$?",
      "head -z -n > missing-count.out || echo MISSING-COUNT-$?",
      "head -z -n100000 late-read.bin > late-read.out || echo READ-ERROR-$?",
      "head --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.deepEqual(fs.readFile("/home/web/first.out"), new Uint8Array([0x61, 0]));
  assert.deepEqual(fs.readFile("/home/web/default.out"), basic);
  assert.deepEqual(fs.readFile("/home/web/unterminated.out"), new Uint8Array([0x61, 0, 0x62]));
  assert.deepEqual(fs.readFile("/home/web/empty-records.out"), new Uint8Array([0, 0]));
  assert.equal(fs.readFile("/home/web/empty.out").byteLength, 0);
  assert.equal(fs.readFile("/home/web/zero.out").byteLength, 0);
  assert.deepEqual(fs.readFile("/home/web/multiple.out"), new Uint8Array([0x61, 0, 0x80, 0xff, 0]));
  assert.deepEqual(fs.readFile("/home/web/stdin.out"), new Uint8Array([0x61, 0]));
  assert.deepEqual(fs.readFile("/home/web/explicit-stdin.out"), new Uint8Array([0x61, 0]));
  assert.deepEqual(fs.readFile("/home/web/continued.out"), new Uint8Array([0x61, 0]));
  assert.deepEqual(fs.readFile("/home/web/plus-file.out"), new Uint8Array([0x70, 0]));
  assert.deepEqual(fs.readFile("/home/web/exact-record.out"), exactRecord);
  for (const path of [
    "over-record.out", "per-input-over.out", "invalid-count.out", "negative.out",
    "bytes.out", "plus.out", "value.out", "missing-count.out", "late-read.out", "files-over.out",
    "leading-plus.out", "leading-space.out", "trailing-space.out", "long-lines.out",
    "long-lines-equals.out", "legacy-count.out",
  ]) assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  assert.match(run.stdout, /head: missing\.bin:.*\nCONTINUED-1\n/);
  assert.match(run.stdout, /head: over-record\.bin: NUL record exceeds 1048576 bytes\nRECORD-LIMIT-1\n/);
  assert.match(run.stdout, /INPUT-EXACT-OK\n/);
  assert.match(run.stdout, /head: per-input-over\.bin: input exceeds 16777216 bytes\nINPUT-LIMIT-1\n/);
  assert.match(run.stdout, /RECORDS-EXACT-OK\nFILES-EXACT-OK\nhead: too many input files \(max 100\)\nFILES-OVER-2\nTOTAL-EXACT-OK\n/);
  assert.match(run.stdout, /head: basic\.bin: invocation input exceeds 67108864 bytes\nTOTAL-LIMIT-1\n67108864 total-over\.out\n/);
  assert.match(run.stdout, /head: invalid count: 100001\nCOUNT-OVER-2\n/);
  assert.match(run.stdout, /head: invalid count: -1\nNEGATIVE-2\n/);
  assert.match(run.stdout, /head: invalid count: \+1\nLEADING-PLUS-2\n/);
  assert.match(run.stdout, /head: invalid count:  1\nLEADING-SPACE-2\n/);
  assert.match(run.stdout, /head: invalid count: 1 \nTRAILING-SPACE-2\n/);
  assert.match(run.stdout, /head: unsupported option in zero mode: --lines\nLONG-LINES-2\n/);
  assert.match(run.stdout, /head: unsupported option in zero mode: --lines=1\nLONG-LINES-EQUALS-2\n/);
  assert.match(run.stdout, /head: unsupported option in zero mode: -1\nLEGACY-COUNT-2\n/);
  assert.match(run.stdout, /head: -z is incompatible with -c\nBYTES-2\n/);
  assert.match(run.stdout, /head: unsupported count: \+1\nPLUS-2\n/);
  assert.match(run.stdout, /head: unsupported option: --zero-terminated=value\nVALUE-2\n/);
  assert.match(run.stdout, /head: unsupported option: -n\nMISSING-COUNT-2\n/);
  assert.match(run.stdout, /head: late-read\.bin:.*\nREAD-ERROR-1\n/);
  assert.match(run.stdout, /usage: head .*zero-terminated.*NUL records: 100 files, N 0\.\.100000, 1 MiB each, 16 MiB\/file, 64 MiB total/);
  assert.deepEqual(fs.readFile("/home/web/basic.bin"), basic);
  assert.deepEqual(fs.readFile("/home/web/invalid-bytes.bin"), new Uint8Array([0x80, 0xff, 0]));
  assert.equal(encoder.encode(run.stderr).byteLength > 0, true);
});

test("slop: tail selects a bounded raw-byte suffix without partial output", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/directory");
  installShell(fs);
  const encoder = new TextEncoder();
  const ten = encoder.encode("0123456789");
  const binary = new Uint8Array([0x41, 0x00, 0xff, 0x42]);
  const chunked = Uint8Array.from({ length: 131_109 }, (_, index) => (index * 29) & 0xff);
  fs.writeFile("/home/web/ten.bin", ten);
  fs.writeFile("/home/web/empty.bin", new Uint8Array());
  fs.writeFile("/home/web/binary.bin", binary);
  fs.writeFile("/home/web/-fixture", "abc");
  fs.writeFile("/home/web/chunked.bin", chunked);
  fs.writeFile("/home/web/lines.txt", "first\nsecond\nthird\n");
  const hashBefore = createHash("sha256")
    .update(fs.readFile("/home/web/ten.bin"))
    .update(fs.readFile("/home/web/binary.bin"))
    .update(fs.readFile("/home/web/chunked.bin"))
    .digest("hex");

  const run = await runSlop(
    fs,
    [
      "tail -c 3 ten.bin > separated.out",
      "tail -c3 ten.bin > compact.out",
      "tail -c003 ten.bin > leading-zero.out",
      "cat ten.bin | tail -c 3 > implicit-stdin.out",
      "cat ten.bin | tail -c 3 - > explicit-stdin.out",
      "tail -c 0 ten.bin > zero.out",
      "tail -c 20 ten.bin > longer.out",
      "tail -c 3 empty.bin > empty.out",
      "tail -c 2 binary.bin > binary.out",
      "tail -c 2 -- -fixture > dashed.out",
      "tail -c 65539 chunked.bin > chunked.out",
      "tail -c 16777215 ten.bin > below-limit.out",
      "tail -c 16777216 ten.bin > at-limit.out",
      "tail -n +2 lines.txt > line-mode.out",
      "tail -c nope ten.bin > invalid-separated.out || echo INVALID-SEPARATED-$?",
      "tail -c > invalid-empty.out || echo INVALID-EMPTY-$?",
      "tail -c -1 ten.bin > invalid-negative.out || echo INVALID-NEGATIVE-$?",
      "tail -c+1 ten.bin > invalid-plus.out || echo INVALID-PLUS-$?",
      "tail -c1x ten.bin > invalid-suffix.out || echo INVALID-SUFFIX-$?",
      "tail -c ' 3' ten.bin > invalid-space.out || echo INVALID-SPACE-$?",
      "tail -c 16777217 ten.bin > over-limit.out || echo OVER-LIMIT-$?",
      "tail --bytes=3 ten.bin > long-option.out || echo LONG-OPTION-$?",
      "tail -c3 ten.bin empty.bin > operands.out || echo OPERANDS-$?",
      "tail -c3 missing.bin > missing.out || echo MISSING-$?",
      "tail -c3 directory > directory.out || echo DIRECTORY-$?",
      "printf sentinel | tail -c nope > invalid-pipe.out || echo INVALID-PIPE-$?",
      "command -v tail",
      "tail --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  for (const path of ["separated.out", "compact.out", "leading-zero.out", "implicit-stdin.out", "explicit-stdin.out"]) {
    assert.deepEqual(fs.readFile(`/home/web/${path}`), encoder.encode("789"), path);
  }
  assert.equal(fs.readFile("/home/web/zero.out").byteLength, 0);
  assert.deepEqual(fs.readFile("/home/web/longer.out"), ten);
  assert.equal(fs.readFile("/home/web/empty.out").byteLength, 0);
  assert.deepEqual(fs.readFile("/home/web/binary.out"), new Uint8Array([0xff, 0x42]));
  assert.deepEqual(fs.readFile("/home/web/dashed.out"), encoder.encode("bc"));
  assert.deepEqual(fs.readFile("/home/web/chunked.out"), chunked.subarray(chunked.length - 65_539));
  assert.deepEqual(fs.readFile("/home/web/below-limit.out"), ten);
  assert.deepEqual(fs.readFile("/home/web/at-limit.out"), ten);
  assert.deepEqual(fs.readFile("/home/web/line-mode.out"), encoder.encode("second\nthird\n"));
  for (const path of [
    "invalid-separated.out", "invalid-empty.out", "invalid-negative.out", "invalid-plus.out",
    "invalid-suffix.out", "invalid-space.out", "over-limit.out", "long-option.out", "operands.out",
    "missing.out", "directory.out", "invalid-pipe.out",
  ]) assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  assert.match(run.stdout, /tail: invalid count: nope\nINVALID-SEPARATED-2\n/);
  assert.match(run.stdout, /tail: invalid count: \nINVALID-EMPTY-2\n/);
  assert.match(run.stdout, /tail: invalid count: -1\nINVALID-NEGATIVE-2\n/);
  assert.match(run.stdout, /tail: invalid count: \+1\nINVALID-PLUS-2\n/);
  assert.match(run.stdout, /tail: invalid count: 1x\nINVALID-SUFFIX-2\n/);
  assert.match(run.stdout, /tail: invalid count:  3\nINVALID-SPACE-2\n/);
  assert.match(run.stdout, /tail: invalid count: 16777217\nOVER-LIMIT-2\n/);
  assert.match(run.stdout, /tail: unsupported option: --bytes=3\nLONG-OPTION-2\n/);
  assert.match(run.stdout, /tail: only one input file is supported\nOPERANDS-2\n/);
  assert.match(run.stdout, /tail: missing\.bin:.*\nMISSING-1\n/);
  assert.match(run.stdout, /tail: directory:.*\nDIRECTORY-1\n/);
  assert.match(run.stdout, /tail: invalid count: nope\nINVALID-PIPE-2\n/);
  assert.match(run.stdout, /\/bin\/tail\nusage: tail \[-n LINES\|-nLINES\|-c BYTES\|-cBYTES\].*0\.\.16777216/);
  const hashAfter = createHash("sha256")
    .update(fs.readFile("/home/web/ten.bin"))
    .update(fs.readFile("/home/web/binary.bin"))
    .update(fs.readFile("/home/web/chunked.bin"))
    .digest("hex");
  assert.equal(hashAfter, hashBefore);

  const faultFs = new LateReadFailureFs();
  faultFs.mkdirTree("/home/web");
  installShell(faultFs);
  faultFs.writeFile("/home/web/late-read.bin", new Uint8Array(131_072).fill(0x61));
  const failed = await runSlop(
    faultFs,
    ["tail -c 64 late-read.bin > late.out || echo LATE-READ-$?"],
    { quiet: true },
  );
  assert.equal(failed.exitCode, 0);
  assert.equal(faultFs.readFile("/home/web/late.out").byteLength, 0);
  assert.match(failed.stdout, /tail: late-read\.bin:.*\nLATE-READ-1\n/);
});

test("slop: operand terminators, wc aliases, and streamed SHA-256 are agent-safe", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile("/home/web/abc.txt", "abc");
  fs.writeFile("/home/web/-dash.txt", "abc");
  fs.writeFile("/home/web/counts.txt", "one two\nthree\n");
  fs.writeFile("/home/web/empty.txt", "");
  const longBytes = Uint8Array.from({ length: 257 }, (_, index) => index & 0xff);
  fs.writeFile("/home/web/long.bin", longBytes);

  const run = await runSlop(
    fs,
    [
      "basename -- ./-dash.txt",
      "basename -- source.c .c",
      "dirname -- ./-dash.txt",
      "wc --lines --words --bytes counts.txt",
      "sha256sum abc.txt",
      "printf abc | sha256sum",
      "sha256sum -- -dash.txt",
      "sha256sum empty.txt long.bin",
      "sha256sum missing.txt || echo SHA-MISSING-$?",
      "sha256sum --bad abc.txt || echo SHA-OPTION-$?",
      "command -v sha256sum",
    ],
    { quiet: true },
  );

  const digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /^-dash\.txt\nsource\n\.\n/m);
  assert.match(run.stdout, /2 3 14 counts\.txt\n/);
  assert.match(run.stdout, new RegExp(`${digest}  abc\\.txt\\n`));
  assert.match(run.stdout, new RegExp(`${digest}  -\\n`));
  assert.match(run.stdout, new RegExp(`${digest}  -dash\\.txt\\n`));
  assert.match(run.stdout, /e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  empty\.txt\n/);
  const longDigest = createHash("sha256").update(longBytes).digest("hex");
  assert.match(run.stdout, new RegExp(`${longDigest}  long\\.bin\\n`));
  assert.match(run.stdout, /sha256sum: missing\.txt:.*\nSHA-MISSING-1\n/);
  assert.match(run.stdout, /sha256sum: unsupported option: --bad\nSHA-OPTION-2\n/);
  assert.match(run.stdout, /\/bin\/sha256sum\n/);
});

test("slop: sha256sum check mode prevalidates bounded canonical manifests", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/adir");
  installShell(fs);
  const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
  const abcDigest = digest("abc");
  const emptyDigest = digest("");
  fs.writeFile("/home/web/abc.txt", "abc");
  fs.writeFile("/home/web/empty.txt", "");
  fs.writeFile("/home/web/space name.txt", "space payload");
  fs.writeFile("/home/web/slash\\name.txt", "backslash payload");
  fs.writeFile("/home/web/ leading.txt", "leading payload");
  fs.writeFile("/home/web/-dash.txt", "dash payload");

  const goodRecords = [
    `${abcDigest}  abc.txt`,
    `${emptyDigest.toUpperCase()} *empty.txt`,
    `${digest("space payload")}  space name.txt`,
    `${digest("backslash payload")} *slash\\name.txt`,
    `${digest("leading payload")}   leading.txt`,
    `${digest("dash payload")}  -dash.txt`,
    `${abcDigest}  abc.txt`,
  ];
  const goodManifest = `${goodRecords.join("\n")}\n`;
  fs.writeFile("/home/web/good.manifest", goodManifest);
  fs.writeFile("/home/web/no-final.manifest", `${emptyDigest.toUpperCase()} *empty.txt`);
  fs.writeFile("/home/web/-checks", goodManifest);
  const renderCheckPath = (path: string): string =>
    path.includes("\\") || path.includes("\n")
      ? `\\${path.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")}`
      : path;
  const goodOutput = `${goodRecords.map((record) => `${renderCheckPath(record.slice(66))}: OK`).join("\n")}\n`;

  const mismatchManifest = [
    `${"0".repeat(64)}  abc.txt`,
    `${emptyDigest}  empty.txt`,
    `${abcDigest}  missing.txt`,
    `${emptyDigest}  adir`,
  ].join("\n") + "\n";
  fs.writeFile("/home/web/mismatch.manifest", mismatchManifest);

  const run = await runSlop(fs, [
    "sha256sum -c good.manifest > good.out 2> good.err; echo GOOD-$?",
    "sha256sum --check no-final.manifest > no-final.out 2> no-final.err; echo NO-FINAL-$?",
    "cat good.manifest | sha256sum -c > stdin-omitted.out 2> stdin-omitted.err; echo STDIN-OMITTED-$?",
    "cat good.manifest | sha256sum --check - > stdin-explicit.out 2> stdin-explicit.err; echo STDIN-EXPLICIT-$?",
    "sha256sum -c -- -checks > dashed.out 2> dashed.err; echo DASHED-$?",
    "sha256sum -c mismatch.manifest > mismatch.out 2> mismatch.err; echo MIXED-$?",
    "sha256sum --help",
  ], { quiet: true });
  assert.equal(run.exitCode, 0);
  for (const marker of ["GOOD-0", "NO-FINAL-0", "STDIN-OMITTED-0", "STDIN-EXPLICIT-0", "DASHED-0", "MIXED-1"])
    assert.match(run.stdout, new RegExp(`(?:^|\\n)${marker}\\n`), marker);
  for (const path of ["good.out", "stdin-omitted.out", "stdin-explicit.out", "dashed.out"])
    assert.equal(new TextDecoder().decode(fs.readFile(`/home/web/${path}`)), goodOutput, path);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/no-final.out")), "empty.txt: OK\n");
  for (const path of ["good.err", "no-final.err", "stdin-omitted.err", "stdin-explicit.err", "dashed.err"])
    assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  assert.equal(
    new TextDecoder().decode(fs.readFile("/home/web/mismatch.out")),
    "abc.txt: FAILED\nempty.txt: OK\nmissing.txt: FAILED open or read\nadir: FAILED open or read\n",
  );
  assert.equal(
    new TextDecoder().decode(fs.readFile("/home/web/mismatch.err")),
    "sha256sum: WARNING: 1 computed checksum(s) did NOT match\n" +
      "sha256sum: WARNING: 2 listed file(s) could not be read\n",
  );
  assert.match(run.stdout, /usage: sha256sum.*-c\|--check.*1048576|usage: sha256sum.*-c\|--check.*1 MiB/s);

  const malformed = new Map<string, string>([
    ["short", `${"0".repeat(63)}  abc.txt\n`],
    ["long", `${"0".repeat(65)}  abc.txt\n`],
    ["nonhex", `g${"0".repeat(63)}  abc.txt\n`],
    ["one-space", `${abcDigest} abc.txt\n`],
    ["tab-separator", `${abcDigest}\t abc.txt\n`],
    ["empty-path", `${abcDigest}  \n`],
    ["blank", "\n"],
    ["comment", "# checksum list\n"],
    ["nul", `${abcDigest}  abc.txt\0tail\n`],
    ["stdin-target", `${abcDigest}  -\n`],
  ]);
  const malformedCommands: string[] = [];
  for (const [name, content] of malformed) {
    fs.writeFile(`/home/web/${name}.manifest`, content);
    malformedCommands.push(
      `sha256sum -c ${name}.manifest > ${name}.out 2> ${name}.err; echo BAD-${name}-$?`,
    );
  }
  fs.writeFile("/home/web/empty.manifest", "");
  const invocationCommands = [
    "sha256sum -c empty.manifest > empty-manifest.out 2> empty-manifest.err; echo EMPTY-MANIFEST-$?",
    "sha256sum -c absent.manifest > missing-manifest.out 2> missing-manifest.err; echo MISSING-MANIFEST-$?",
    "sha256sum -c adir > directory-manifest.out 2> directory-manifest.err; echo DIRECTORY-MANIFEST-$?",
    "sha256sum -c good.manifest extra > extra.out 2> extra.err; echo EXTRA-$?",
    "sha256sum -c -- > delimiter.out 2> delimiter.err; echo DELIMITER-$?",
    "sha256sum -c -checks > undelimited-dash.out 2> undelimited-dash.err; echo UNDELIMITED-DASH-$?",
    "sha256sum -cgood.manifest > attached-short.out 2> attached-short.err; echo ATTACHED-SHORT-$?",
    "sha256sum --check=good.manifest > attached-long.out 2> attached-long.err; echo ATTACHED-LONG-$?",
    "sha256sum good.manifest -c > late-mode.out 2> late-mode.err; echo LATE-MODE-$?",
    "sha256sum --bad abc.txt > unknown.out 2> unknown.err; echo UNKNOWN-$?",
  ];
  const rejected = await runSlop(fs, [...malformedCommands, ...invocationCommands], { quiet: true });
  assert.equal(rejected.exitCode, 0);
  for (const name of malformed.keys()) {
    assert.match(rejected.stdout, new RegExp(`BAD-${name}-2\\n`), name);
    assert.equal(fs.readFile(`/home/web/${name}.out`).byteLength, 0, name);
    assert.match(new TextDecoder().decode(fs.readFile(`/home/web/${name}.err`)), /sha256sum: .*malformed checksum line/);
  }
  for (const [marker, path] of [
    ["EMPTY-MANIFEST", "empty-manifest"], ["MISSING-MANIFEST", "missing-manifest"],
    ["DIRECTORY-MANIFEST", "directory-manifest"], ["EXTRA", "extra"],
    ["DELIMITER", "delimiter"], ["UNDELIMITED-DASH", "undelimited-dash"],
    ["ATTACHED-SHORT", "attached-short"], ["ATTACHED-LONG", "attached-long"],
    ["LATE-MODE", "late-mode"], ["UNKNOWN", "unknown"],
  ]) {
    assert.match(rejected.stdout, new RegExp(`${marker}-2\\n`), marker);
    assert.equal(fs.readFile(`/home/web/${path}.out`).byteLength, 0, path);
    assert.ok(fs.readFile(`/home/web/${path}.err`).byteLength > 0, path);
  }

  const maximumRecord = `${abcDigest}  ${"p".repeat(4_030)}`;
  assert.equal(new TextEncoder().encode(maximumRecord).byteLength, 4_096);
  fs.writeFile("/home/web/max-record.manifest", maximumRecord);
  fs.writeFile("/home/web/over-record.manifest", `${maximumRecord}p`);
  const oneRecord = `${abcDigest}  abc.txt\n`;
  fs.writeFile("/home/web/max-records.manifest", oneRecord.repeat(4_096));
  fs.writeFile("/home/web/over-records.manifest", oneRecord.repeat(4_097));
  const maximumLine = `${abcDigest}  ${"q".repeat(4_030)}`;
  const maximumManifest = `${`${maximumLine}\n`.repeat(255)}${abcDigest}  ${"r".repeat(3_775)}`;
  assert.equal(new TextEncoder().encode(maximumManifest).byteLength, 1_048_576);
  fs.writeFile("/home/web/max-size.manifest", maximumManifest);
  fs.writeFile("/home/web/over-size.manifest", `${maximumManifest}r`);
  const bounds = await runSlop(fs, [
    "sha256sum -c max-record.manifest > max-record.out 2> max-record.err; echo MAX-RECORD-$?",
    "sha256sum -c over-record.manifest > over-record.out 2> over-record.err; echo OVER-RECORD-$?",
    "sha256sum -c max-records.manifest > max-records.out 2> max-records.err; echo MAX-RECORDS-$?",
    "sha256sum -c over-records.manifest > over-records.out 2> over-records.err; echo OVER-RECORDS-$?",
    "sha256sum -c max-size.manifest > max-size.out 2> max-size.err; echo MAX-SIZE-$?",
    "sha256sum -c over-size.manifest > over-size.out 2> over-size.err; echo OVER-SIZE-$?",
  ], { quiet: true });
  assert.equal(bounds.exitCode, 0);
  assert.match(bounds.stdout, /MAX-RECORD-1\nOVER-RECORD-2\nMAX-RECORDS-0\nOVER-RECORDS-2\nMAX-SIZE-1\nOVER-SIZE-2\n/);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/max-records.out")), "abc.txt: OK\n".repeat(4_096));
  assert.match(new TextDecoder().decode(fs.readFile("/home/web/max-record.err")), /1 listed file\(s\) could not be read/);
  assert.match(new TextDecoder().decode(fs.readFile("/home/web/max-size.err")), /256 listed file\(s\) could not be read/);
  for (const path of ["over-record.out", "over-records.out", "over-size.out"])
    assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  assert.match(new TextDecoder().decode(fs.readFile("/home/web/over-record.err")), /line 1 exceeds 4096 bytes/);
  assert.match(new TextDecoder().decode(fs.readFile("/home/web/over-records.err")), /exceeds 4096 records/);
  assert.match(new TextDecoder().decode(fs.readFile("/home/web/over-size.err")), /exceeds 1048576 bytes/);

  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/abc.txt")), "abc");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/good.manifest")), goodManifest);

  const targetFaultFs = new LateReadFailureFs();
  targetFaultFs.mkdirTree("/home/web");
  installShell(targetFaultFs);
  const lateBytes = new Uint8Array(131_072).fill(0x61);
  targetFaultFs.writeFile("/home/web/late-read.bin", lateBytes);
  targetFaultFs.writeFile(
    "/home/web/target-fault.manifest",
    `${digest(lateBytes)}  late-read.bin\n`,
  );
  const targetFault = await runSlop(targetFaultFs, [
    "sha256sum -c target-fault.manifest > target-fault.out 2> target-fault.err; echo TARGET-FAULT-$?",
  ], { quiet: true });
  assert.match(targetFault.stdout, /TARGET-FAULT-1\n/);
  assert.equal(new TextDecoder().decode(targetFaultFs.readFile("/home/web/target-fault.out")), "late-read.bin: FAILED open or read\n");
  assert.equal(
    new TextDecoder().decode(targetFaultFs.readFile("/home/web/target-fault.err")),
    "sha256sum: WARNING: 1 listed file(s) could not be read\n",
  );

  const manifestFaultFs = new LateReadFailureFs();
  manifestFaultFs.mkdirTree("/home/web");
  installShell(manifestFaultFs);
  manifestFaultFs.writeFile("/home/web/abc.txt", "abc");
  manifestFaultFs.writeFile("/home/web/late-read.bin", oneRecord.repeat(1_000));
  const manifestFault = await runSlop(manifestFaultFs, [
    "sha256sum -c late-read.bin > manifest-fault.out 2> manifest-fault.err; echo MANIFEST-FAULT-$?",
  ], { quiet: true });
  assert.match(manifestFault.stdout, /MANIFEST-FAULT-2\n/);
  assert.equal(manifestFaultFs.readFile("/home/web/manifest-fault.out").byteLength, 0);
  assert.match(new TextDecoder().decode(manifestFaultFs.readFile("/home/web/manifest-fault.err")), /checksum manifest read error/);
});

test("slop: sha256sum canonical records escape every line-breaking path", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  const decoder = new TextDecoder();
  fs.mkdirTree("/home/web");
  installShell(fs);
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const marker = "\\";
  const names = {
    plain: "plain",
    backslash: "back\\slash",
    newline: "line\nbreak",
    both: "both\\slash\nend",
    carriage: "carriage\rreturn",
  };
  const contents = {
    plain: "plain payload\n",
    backslash: "backslash payload\n",
    newline: "newline payload\n",
    both: "both payload\n",
    carriage: "carriage payload\n",
  };
  for (const key of Object.keys(names) as Array<keyof typeof names>)
    fs.writeFile(`/home/web/${names[key]}`, contents[key]);

  const encodePath = (path: string): string =>
    path.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
  const renderPath = (path: string): string =>
    path.includes("\\") || path.includes("\n") ? `${marker}${encodePath(path)}` : path;
  const record = (key: keyof typeof names): string =>
    `${renderPath(names[key]) === names[key] ? "" : marker}${digest(contents[key])}  ${encodePath(names[key])}\n`;
  const manifest = (Object.keys(names) as Array<keyof typeof names>).map(record).join("");
  const checkedOutput = (Object.keys(names) as Array<keyof typeof names>)
    .map((key) => `${renderPath(names[key])}: OK\n`).join("");

  fs.writeFile("/home/web/legacy-backslash.manifest",
    `${digest(contents.backslash)}  ${names.backslash}\n`);
  fs.writeFile("/home/web/marked-plain.manifest",
    `${marker}${digest(contents.plain)}  ${names.plain}\n`);
  fs.writeFile("/home/web/bad-unknown.manifest",
    `${marker}${digest(contents.plain)}  bad${marker}tname\n`);
  fs.writeFile("/home/web/bad-trailing.manifest",
    `${marker}${digest(contents.plain)}  trailing${marker}\n`);
  fs.writeFile("/home/web/bad-stdin.manifest",
    `${marker}${digest(contents.plain)}  -\n`);
  fs.writeFile("/home/web/newline-mismatch.manifest",
    `${marker}${"0".repeat(64)}  line${marker}nbreak\n`);
  const exactEscapedName = `${"\\".repeat(2_014)}x`;
  const overEscapedName = "\\".repeat(2_015);
  fs.writeFile(`/home/web/${exactEscapedName}`, "exact encoded record\n");
  fs.writeFile(`/home/web/${overEscapedName}`, "over encoded record\n");

  const run = await runSlop(fs, [
    "BS=$(printf 'back\\\\slash')",
    "NL=$(printf 'line\\nbreak')",
    "BOTH=$(printf 'both\\\\slash\\nend')",
    "CR=$(printf 'carriage\\rreturn')",
    "sha256sum -- plain \"$BS\" \"$NL\" \"$BOTH\" \"$CR\" > escaped.manifest 2> escaped.err; echo HASH-$?",
    "sha256sum -c escaped.manifest > checked.out 2> checked.err; echo CHECK-$?",
    "sha256sum -c legacy-backslash.manifest > legacy.out 2> legacy.err; echo LEGACY-$?",
    "sha256sum -c marked-plain.manifest > marked.out 2> marked.err; echo MARKED-$?",
    "sha256sum -c bad-unknown.manifest > unknown.out 2> unknown.err; echo UNKNOWN-$?",
    "sha256sum -c bad-trailing.manifest > trailing.out 2> trailing.err; echo TRAILING-$?",
    "sha256sum -c bad-stdin.manifest > stdin-path.out 2> stdin-path.err; echo STDIN-PATH-$?",
    "sha256sum -c newline-mismatch.manifest > mismatch.out 2> mismatch.err; echo MISMATCH-$?",
    "MISSING=$(printf 'missing\\nname')",
    "sha256sum -- \"$MISSING\" > missing.out 2> missing.err; echo MISSING-$?",
    `sha256sum -- '${exactEscapedName}' > exact-record.out 2> exact-record.err; echo EXACT-$?`,
    "sha256sum -c exact-record.out > exact-check.out 2> exact-check.err; echo EXACT-CHECK-$?",
    `sha256sum -- '${overEscapedName}' > over-record-output.out 2> over-record-output.err; echo OVER-$?`,
  ], { quiet: true });

  assert.equal(run.exitCode, 0);
  for (const markerName of ["HASH-0", "CHECK-0", "LEGACY-0", "MARKED-0", "EXACT-0", "EXACT-CHECK-0"])
    assert.match(run.stdout, new RegExp(`(?:^|\\n)${markerName}\\n`), markerName);
  for (const markerName of ["UNKNOWN-2", "TRAILING-2", "STDIN-PATH-2", "MISMATCH-1", "MISSING-1", "OVER-1"])
    assert.match(run.stdout, new RegExp(`(?:^|\\n)${markerName}\\n`), markerName);
  assert.equal(decoder.decode(fs.readFile("/home/web/escaped.manifest")), manifest);
  assert.equal(decoder.decode(fs.readFile("/home/web/checked.out")), checkedOutput);
  assert.equal(decoder.decode(fs.readFile("/home/web/legacy.out")),
    `${renderPath(names.backslash)}: OK\n`);
  assert.equal(decoder.decode(fs.readFile("/home/web/marked.out")), "plain: OK\n");
  for (const path of ["escaped.err", "checked.err", "legacy.err", "marked.err", "exact-record.err", "exact-check.err"])
    assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  for (const path of ["unknown.out", "trailing.out", "stdin-path.out"])
    assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  for (const path of ["unknown.err", "trailing.err", "stdin-path.err"])
    assert.match(decoder.decode(fs.readFile(`/home/web/${path}`)), /malformed checksum line 1/, path);
  assert.equal(decoder.decode(fs.readFile("/home/web/mismatch.out")),
    `${renderPath(names.newline)}: FAILED\n`);
  assert.equal(decoder.decode(fs.readFile("/home/web/mismatch.err")),
    "sha256sum: WARNING: 1 computed checksum(s) did NOT match\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/missing.err")),
    `sha256sum: ${renderPath("missing\nname")}: No such file or directory\n`);
  assert.equal(fs.readFile("/home/web/missing.out").byteLength, 0);
  assert.equal(fs.readFile("/home/web/exact-record.out").byteLength, 4_097);
  assert.equal(decoder.decode(fs.readFile("/home/web/exact-check.out")),
    `${renderPath(exactEscapedName)}: OK\n`);
  assert.equal(fs.readFile("/home/web/over-record-output.out").byteLength, 0);
  assert.match(decoder.decode(fs.readFile("/home/web/over-record-output.err")),
    /encoded checksum record exceeds 4096 bytes\n$/);
  assert.equal(decoder.decode(fs.readFile(`/home/web/${overEscapedName}`)), "over encoded record\n");
});

test("slop: bounded UTC date and finite sleep support agent timing", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  const before = Math.floor(Date.now() / 1000);
  let sleptMilliseconds = 0;

  const run = await runSlop(
    fs,
    [
      "echo DATE-DEFAULT",
      "date",
      "echo DATE-EPOCH",
      "date +%s",
      "echo DATE-UTC",
      "date -u +%Y-%m-%dT%H:%M:%SZ",
      "date --utc +%s",
      "date '+%%s=%s'",
      "echo DATE-EMPTY-BEFORE",
      "date +",
      "echo DATE-EMPTY-AFTER",
      "date --set now || echo DATE-OPTION-$?",
      "date now || echo DATE-SET-$?",
      "date +a +b || echo DATE-MULTIPLE-$?",
      "sleep 0",
      "sleep -- 0.04s",
      "sleep 0.0002m",
      "sleep 0.000003h",
      "sleep -1 || echo SLEEP-NEGATIVE-$?",
      "sleep nan || echo SLEEP-NAN-$?",
      "sleep 61 || echo SLEEP-LIMIT-$?",
      "sleep 1d || echo SLEEP-SUFFIX-$?",
      "sleep || echo SLEEP-OPERAND-$?",
      "date --help",
      "sleep --help",
      "command -v date",
      "command -v sleep",
    ],
    { quiet: true, sleepSync: (milliseconds) => { sleptMilliseconds += milliseconds; } },
  );
  const after = Math.floor(Date.now() / 1000);

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /DATE-DEFAULT\n\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n/);
  assert.match(run.stdout, /DATE-UTC\n\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n/);
  const epochs = [...run.stdout.matchAll(/^([0-9]{10,})$/gm)].map((match) => Number(match[1]));
  assert.ok(epochs.length >= 2);
  for (const epoch of epochs) assert.ok(epoch >= before - 1 && epoch <= after + 1);
  assert.match(run.stdout, /^%s=[0-9]{10,}$/m);
  assert.match(run.stdout, /DATE-EMPTY-BEFORE\n\nDATE-EMPTY-AFTER\n/);
  for (const marker of ["DATE-OPTION", "DATE-SET", "DATE-MULTIPLE"]) {
    assert.match(run.stdout, new RegExp(`${marker}-2\\n`));
  }
  for (const marker of ["SLEEP-NEGATIVE", "SLEEP-NAN", "SLEEP-LIMIT", "SLEEP-SUFFIX", "SLEEP-OPERAND"]) {
    assert.match(run.stdout, new RegExp(`${marker}-2\\n`));
  }
  assert.match(run.stdout, /usage: date \[-u\|--utc\] \[\+FORMAT\]/);
  assert.match(run.stdout, /usage: sleep \[--\] DURATION/);
  assert.match(run.stdout, /\/bin\/date\n\/bin\/sleep\n/);
  assert.ok(sleptMilliseconds >= 58 && sleptMilliseconds < 100, `unexpected sleep request total: ${sleptMilliseconds} ms`);
});

test("slop: bounded sort keys and UTF-8 cut ranges cover agent text workflows", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile("/home/web/table.txt", "z 10 xx\nm 1 zz\na 2 yy\n");
  fs.writeFile("/home/web/chars.txt", "abcdef\nåßçd\n");
  fs.writeFile("/home/web/-chars.txt", "xy\n");
  fs.writeFile("/home/web/plain.txt", "plain\n");

  const run = await runSlop(
    fs,
    [
      "echo SORT-NUMERIC",
      "sort -k2,2n table.txt",
      "echo SORT-LONG",
      "sort --key=2,2 table.txt",
      "echo SORT-REVERSE",
      "sort -r -k 2,2n table.txt",
      "echo SORT-INVALID",
      "sort -k2,3 table.txt || echo SORT-RANGE-$?",
      "sort --key=nope table.txt || echo SORT-SYNTAX-$?",
      "echo CUT-RANGES",
      "cut -c2-3 chars.txt",
      "cut -c1,3-4 chars.txt",
      "cut -c-2 chars.txt",
      "cut -c4- chars.txt",
      "cut --characters=2-3 chars.txt",
      "cut -c1 -- -chars.txt",
      "cat chars.txt | cut -c2-3 -",
      "cut -d: -f2 plain.txt",
      "printf no-final | cut -c1-2",
      "echo :END",
      "echo CUT-INVALID",
      "cut -c0 chars.txt || echo CUT-ZERO-$?",
      "cut -c4-2 chars.txt || echo CUT-REVERSE-$?",
      "cut -d:: -f1 chars.txt || echo CUT-DELIMITER-$?",
      "cut -d: -c1 chars.txt || echo CUT-MODES-$?",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /SORT-NUMERIC\nm 1 zz\na 2 yy\nz 10 xx\n/);
  assert.match(run.stdout, /SORT-LONG\nm 1 zz\nz 10 xx\na 2 yy\n/);
  assert.match(run.stdout, /SORT-REVERSE\nz 10 xx\na 2 yy\nm 1 zz\n/);
  assert.match(run.stdout, /SORT-INVALID\nsort: key must be FIELD or FIELD,FIELD with equal fields and optional n\nSORT-RANGE-2\n/);
  assert.match(run.stdout, /sort: key must be FIELD or FIELD,FIELD with equal fields and optional n\nSORT-SYNTAX-2\n/);
  assert.match(run.stdout, /CUT-RANGES\nbc\nßç\nacd\nåçd\nab\nåß\ndef\nd\nbc\nßç\nx\nbc\nßç\nplain\nno:END\n/);
  assert.match(run.stdout, /CUT-INVALID\ncut: character list must contain N, N-M, -M, or N- ranges\nCUT-ZERO-2\n/);
  assert.match(run.stdout, /cut: character list must contain N, N-M, -M, or N- ranges\nCUT-REVERSE-2\n/);
  assert.match(run.stdout, /cut: delimiter must be one byte\nCUT-DELIMITER-2\n/);
  assert.match(run.stdout, /cut: a delimiter applies only to fields\nCUT-MODES-2\n/);
});

test("slop: sort field separators are byte-exact, deterministic, and atomic", async () => {
  const fs = new LateReadFailureFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  const encoder = new TextEncoder();
  fs.writeFile("/home/web/csv.txt", "b,10\na,2\nc,1\n");
  fs.writeFile("/home/web/empty-fields.txt", "b::2\na:1:9\na::1\n");
  fs.writeFile("/home/web/ties.txt", "b:x\nb:x\na:x\nc:y\n");
  fs.writeFile("/home/web/exponent-separator.txt", "1e2\n1e100\n");
  fs.writeFile("/home/web/tabs.txt", "b\t2\na\t1\n");
  fs.writeFile("/home/web/no-key.txt", "b,2\na,1\n");
  fs.writeFile("/home/web/opaque.txt", new Uint8Array([
    0x61, 0x3a, 0xff, 0x00, 0x0a,
    0x62, 0x3a, 0x00, 0x78, 0x0a,
  ]));
  fs.writeFile("/home/web/keyed-zero.bin", encoder.encode("z:10\ninside\0a:2\tq\0m:1\0"));
  const exactLfRecord = new Uint8Array(1024 * 1024 + 1).fill(0x61);
  exactLfRecord[exactLfRecord.length - 1] = 0x0a;
  const overLfRecord = new Uint8Array(1024 * 1024 + 2).fill(0x61);
  overLfRecord[overLfRecord.length - 1] = 0x0a;
  fs.writeFile("/home/web/exact-lf-record.bin", exactLfRecord);
  fs.writeFile("/home/web/over-lf-record.bin", overLfRecord);
  fs.writeFile("/home/web/exact-lf-count.bin", new Uint8Array(100_000).fill(0x0a));
  fs.writeFile("/home/web/over-lf-count.bin", new Uint8Array(100_001).fill(0x0a));
  const lateRead = new Uint8Array(131_072);
  for (let offset = 0; offset < lateRead.length; offset += 4) {
    lateRead[offset] = 0x61; lateRead[offset + 1] = 0x3a;
    lateRead[offset + 2] = 0x31; lateRead[offset + 3] = 0x0a;
  }
  fs.writeFile("/home/web/late-read.bin", lateRead);

  const run = await runSlop(
    fs,
    [
      "sort -t, -k2,2n csv.txt > compact.out",
      "sort -t , -k2,2n csv.txt > separated.out",
      "sort --field-separator=, -k2,2n csv.txt > long.out",
      "sort -t, -k 2,2n csv.txt > key-separated.out",
      "sort -t, --key 2,2n csv.txt > key-long-separated.out",
      "sort -t, --key=2,2n csv.txt > key-long-equals.out",
      "sort -t: -k2,2 empty-fields.txt > empty-fields.out",
      "sort -t: -u -k2,2 ties.txt > unique.out",
      "sort -t: -r -k2,2 ties.txt > reverse.out",
      "sort -te -k1,1n exponent-separator.txt > exponent.out",
      "sort -t '\t' -k2,2n tabs.txt > tabs.out",
      "sort -t, no-key.txt > no-key.out",
      "sort -t: -k2,2 opaque.txt > opaque.out",
      "sort -z -t: -k2,2n keyed-zero.bin > keyed-zero.out",
      "sort -t: -k4,4 empty-fields.txt > missing-field.out",
      "sort -t: -k1000 exact-lf-record.bin > exact-lf-record.out",
      "sort -t: -k1,1 over-lf-record.bin > over-lf-record.out || echo LF-RECORD-LIMIT-$?",
      "sort -t: -k1,1 exact-lf-count.bin > /dev/null && echo LF-COUNT-EXACT-OK",
      "sort -t: -k1,1 over-lf-count.bin > over-lf-count.out || echo LF-COUNT-LIMIT-$?",
      "sort -t '' csv.txt > empty-separator.out || echo EMPTY-SEPARATOR-$?",
      "sort -t:: csv.txt > wide-separator.out || echo WIDE-SEPARATOR-$?",
      "sort -t🙂 csv.txt > multibyte-separator.out || echo MULTIBYTE-SEPARATOR-$?",
      "sort -t, -t: csv.txt > duplicate-separator.out || echo DUPLICATE-SEPARATOR-$?",
      "sort -t > missing-separator.out || echo MISSING-SEPARATOR-$?",
      "sort --field-separator , csv.txt > separated-long.out || echo SEPARATED-LONG-$?",
      "sort -t:: missing.txt > syntax-before-open.out || echo SYNTAX-FIRST-$?",
      "sort -t, -k+2 csv.txt > signed-key.out || echo SIGNED-KEY-$?",
      "sort -t, -k1001 csv.txt > key-limit.out || echo KEY-LIMIT-$?",
      "sort -t, late-read.bin > late-read.out || echo READ-ERROR-$?",
      "sort -t, missing.txt > missing.out || echo MISSING-$?",
      "sort --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  const numeric = encoder.encode("c,1\na,2\nb,10\n");
  for (const path of [
    "compact.out", "separated.out", "long.out", "key-separated.out",
    "key-long-separated.out", "key-long-equals.out",
  ])
    assert.deepEqual(fs.readFile(`/home/web/${path}`), numeric, path);
  assert.deepEqual(fs.readFile("/home/web/empty-fields.out"), encoder.encode("a::1\nb::2\na:1:9\n"));
  assert.deepEqual(fs.readFile("/home/web/unique.out"), encoder.encode("a:x\nb:x\nc:y\n"));
  assert.deepEqual(fs.readFile("/home/web/reverse.out"), encoder.encode("c:y\nb:x\nb:x\na:x\n"));
  assert.deepEqual(fs.readFile("/home/web/exponent.out"), encoder.encode("1e100\n1e2\n"));
  assert.deepEqual(fs.readFile("/home/web/tabs.out"), encoder.encode("a\t1\nb\t2\n"));
  assert.deepEqual(fs.readFile("/home/web/no-key.out"), encoder.encode("a,1\nb,2\n"));
  assert.deepEqual(fs.readFile("/home/web/opaque.out"), new Uint8Array([
    0x62, 0x3a, 0x00, 0x78, 0x0a,
    0x61, 0x3a, 0xff, 0x00, 0x0a,
  ]));
  assert.deepEqual(fs.readFile("/home/web/keyed-zero.out"), encoder.encode("m:1\0a:2\tq\0z:10\ninside\0"));
  assert.deepEqual(fs.readFile("/home/web/missing-field.out"), encoder.encode("a:1:9\na::1\nb::2\n"));
  assert.deepEqual(fs.readFile("/home/web/exact-lf-record.out"), exactLfRecord);
  for (const path of [
    "empty-separator.out", "wide-separator.out", "multibyte-separator.out",
    "duplicate-separator.out", "missing-separator.out", "separated-long.out",
    "syntax-before-open.out", "signed-key.out", "key-limit.out", "late-read.out", "missing.out",
    "over-lf-record.out", "over-lf-count.out",
  ]) assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  assert.match(run.stdout, /sort: field separator must be one non-NUL byte other than the record terminator\nEMPTY-SEPARATOR-2\n/);
  assert.match(run.stdout, /WIDE-SEPARATOR-2\n/);
  assert.match(run.stdout, /MULTIBYTE-SEPARATOR-2\n/);
  assert.match(run.stdout, /sort: field separator may be specified only once\nDUPLICATE-SEPARATOR-2\n/);
  assert.match(run.stdout, /sort: -t requires a field separator\nMISSING-SEPARATOR-2\n/);
  assert.match(run.stdout, /sort: unsupported option: --field-separator\nSEPARATED-LONG-2\n/);
  assert.match(run.stdout, /sort: field separator must be one non-NUL byte other than the record terminator\nSYNTAX-FIRST-2\n/);
  assert.match(run.stdout, /sort: key must be FIELD or FIELD,FIELD with equal fields and optional n\nSIGNED-KEY-2\n/);
  assert.match(run.stdout, /KEY-LIMIT-2\n/);
  assert.match(run.stdout, /sort: record exceeds 1048576 bytes\nLF-RECORD-LIMIT-2\n/);
  assert.match(run.stdout, /LF-COUNT-EXACT-OK\nsort: too many records \(limit 100000\)\nLF-COUNT-LIMIT-2\n/);
  assert.match(run.stdout, /sort: late-read\.bin:.*\nREAD-ERROR-1\n/);
  assert.match(run.stdout, /sort: missing\.txt:.*\nMISSING-1\n/);
  assert.match(run.stdout, /usage: sort .*field-separator=BYTE.*byte fields; -z uses NUL records/);
  assert.deepEqual(fs.readFile("/home/web/csv.txt"), encoder.encode("b,10\na,2\nc,1\n"));
  assert.deepEqual(fs.readFile("/home/web/opaque.txt"), new Uint8Array([
    0x61, 0x3a, 0xff, 0x00, 0x0a,
    0x62, 0x3a, 0x00, 0x78, 0x0a,
  ]));
});

test("slop: cut -z extracts bounded NUL-delimited fields atomically", { timeout: 120_000 }, async () => {
  const fs = new LateReadFailureFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  const encoder = new TextEncoder();
  fs.writeFile("/home/web/basic.bin", encoder.encode("a:b\0c:d\0"));
  fs.writeFile("/home/web/tabs.bin", encoder.encode("a\tb\0c\td\0"));
  fs.writeFile("/home/web/plain-record.bin", encoder.encode("plain\0"));
  fs.writeFile("/home/web/-cut.bin", encoder.encode("dash:value\0"));
  fs.writeFile("/home/web/semantic.bin", new Uint8Array([
    ...encoder.encode("plain\0a::c\0:lead\0trail:\0a:b\n"),
    0xff, 0, 0, ...encoder.encode("last:value"),
  ]));
  fs.writeFile("/home/web/late-read.bin", new Uint8Array(131_072).fill(0x61));

  const maxRecord = new Uint8Array(1024 * 1024 + 1).fill(0x3a);
  maxRecord[maxRecord.length - 1] = 0;
  fs.writeFile("/home/web/max-cut-record.bin", maxRecord);
  const oversizedRecord = new Uint8Array(1024 * 1024 + 2).fill(0x3a);
  oversizedRecord[oversizedRecord.length - 1] = 0;
  fs.writeFile("/home/web/oversized-cut-record.bin", oversizedRecord);
  fs.writeFile("/home/web/exact-cut-records.bin", new Uint8Array(100_000));
  fs.writeFile("/home/web/too-many-cut-records.bin", new Uint8Array(100_001));

  const exactInput = new Uint8Array(16 * 1024 * 1024).fill(0x78);
  for (let offset = 1024 * 1024 - 1; offset < exactInput.length; offset += 1024 * 1024) {
    exactInput[offset] = 0;
  }
  fs.writeFile("/home/web/exact-cut-input.bin", exactInput);
  const oversizedInput = new Uint8Array(exactInput.length + 1);
  oversizedInput.set(exactInput); oversizedInput[oversizedInput.length - 1] = 0x78;
  fs.writeFile("/home/web/oversized-cut-input.bin", oversizedInput);
  const oversizedOutput = exactInput.slice();
  oversizedOutput[oversizedOutput.length - 1] = 0x78;
  fs.writeFile("/home/web/oversized-cut-output.bin", oversizedOutput);

  const run = await runSlop(
    fs,
    [
      "cut -z -d: -f2 basic.bin > basic.out",
      "cut --zero-terminated -f2 tabs.bin > tabs.out",
      "cut -d: --zero-terminated -f2 semantic.bin > semantic.out",
      "cut -z -d: -f3 basic.bin > missing-field.out",
      "cut -z -d: -f99 plain-record.bin > no-delimiter.out",
      "cat basic.bin | cut -z -d: -f2 - > stdin.out",
      "cut -z -d: -f2 -- -cut.bin > dashed.out",
      "cut -z --zero-terminated -d, -d: -f1 -f2 basic.bin > repeated.out",
      "cut -z -d: -f1048577 max-cut-record.bin > exact-record.out && echo EXACT-RECORD-OK",
      "cut -z -f1 exact-cut-records.bin > exact-count.out && echo EXACT-COUNT-OK",
      "cut -z -f1 exact-cut-input.bin > exact-input.out && echo EXACT-INPUT-OUTPUT-OK",
      "cut -z -f1 oversized-cut-input.bin > input-limit.out || echo INPUT-LIMIT-$?",
      "cut -z -d: -f1 oversized-cut-record.bin > record-limit.out || echo RECORD-LIMIT-$?",
      "cut -z -f1 too-many-cut-records.bin > count-limit.out || echo COUNT-LIMIT-$?",
      "cut -z -f1 oversized-cut-output.bin > output-limit.out || echo OUTPUT-LIMIT-$?",
      "cut -z -f1 late-read.bin > read-limit.out || echo READ-ERROR-$?",
      "cut -z -f1 missing-cut.bin > missing.out || echo MISSING-$?",
      "cut -z one two > operands.out || echo OPERANDS-$?",
      "cut -z > selector.out || echo SELECTOR-$?",
      "cut -z -f1 -c1 basic.bin > selectors.out || echo SELECTORS-$?",
      "cut -z -c1 basic.bin > character.out || echo CHARACTER-$?",
      "cut -z -f0 basic.bin > field-zero.out || echo FIELD-ZERO-$?",
      "cut -z -f1048578 basic.bin > field-high.out || echo FIELD-HIGH-$?",
      "cut -z -fnope basic.bin > field-syntax.out || echo FIELD-SYNTAX-$?",
      "cut -z -d '' -f1 basic.bin > delimiter-empty.out || echo DELIMITER-EMPTY-$?",
      "cut -z -d:: -f1 basic.bin > delimiter-wide.out || echo DELIMITER-WIDE-$?",
      "cut -z -q -f1 basic.bin > option.out || echo OPTION-$?",
      "cut -z -d > missing-option.out || echo MISSING-OPTION-$?",
      "cut --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.deepEqual(fs.readFile("/home/web/basic.out"), encoder.encode("b\0d\0"));
  assert.deepEqual(fs.readFile("/home/web/tabs.out"), encoder.encode("b\0d\0"));
  assert.deepEqual(
    fs.readFile("/home/web/semantic.out"),
    new Uint8Array([
      ...encoder.encode("plain\0\0lead\0\0b\n"), 0xff, 0, 0, ...encoder.encode("value\0"),
    ]),
  );
  assert.deepEqual(fs.readFile("/home/web/missing-field.out"), new Uint8Array([0, 0]));
  assert.deepEqual(fs.readFile("/home/web/no-delimiter.out"), encoder.encode("plain\0"));
  assert.deepEqual(fs.readFile("/home/web/stdin.out"), encoder.encode("b\0d\0"));
  assert.deepEqual(fs.readFile("/home/web/dashed.out"), encoder.encode("value\0"));
  assert.deepEqual(fs.readFile("/home/web/repeated.out"), encoder.encode("b\0d\0"));
  assert.deepEqual(fs.readFile("/home/web/exact-record.out"), new Uint8Array([0]));
  assert.deepEqual(fs.readFile("/home/web/exact-count.out"), new Uint8Array(100_000));
  assert.deepEqual(fs.readFile("/home/web/exact-input.out"), exactInput);
  for (const path of [
    "input-limit.out", "record-limit.out", "count-limit.out", "output-limit.out",
    "read-limit.out", "missing.out", "operands.out", "selector.out", "selectors.out",
    "character.out", "field-zero.out", "field-high.out", "field-syntax.out",
    "delimiter-empty.out", "delimiter-wide.out", "option.out", "missing-option.out",
  ]) assert.equal(fs.readFile("/home/web/" + path).byteLength, 0, path);

  assert.match(run.stdout, /EXACT-RECORD-OK\nEXACT-COUNT-OK\nEXACT-INPUT-OUTPUT-OK\n/);
  assert.match(run.stdout, /cut: input exceeds 16777216 bytes\nINPUT-LIMIT-1\n/);
  assert.match(run.stdout, /cut: NUL record exceeds 1048576 bytes\nRECORD-LIMIT-1\n/);
  assert.match(run.stdout, /cut: more than 100000 NUL records\nCOUNT-LIMIT-1\n/);
  assert.match(run.stdout, /cut: output exceeds 16777216 bytes\nOUTPUT-LIMIT-1\n/);
  assert.match(run.stdout, /READ-ERROR-1\n/);
  assert.match(run.stdout, /cut: missing-cut\.bin: .*\nMISSING-1\n/);
  assert.match(run.stdout, /cut: only one input file is supported\nOPERANDS-2\n/);
  assert.match(run.stdout, /cut: exactly one of -f or -c is required\nSELECTOR-2\n/);
  assert.match(run.stdout, /cut: exactly one of -f or -c is required\nSELECTORS-2\n/);
  assert.match(run.stdout, /cut: -z supports field mode only\nCHARACTER-2\n/);
  assert.match(run.stdout, /cut: field must be an integer from 1 through 1048577\nFIELD-ZERO-2\n/);
  assert.match(run.stdout, /cut: field must be an integer from 1 through 1048577\nFIELD-HIGH-2\n/);
  assert.match(run.stdout, /cut: field must be an integer from 1 through 1048577\nFIELD-SYNTAX-2\n/);
  assert.match(run.stdout, /cut: delimiter must be one non-NUL byte\nDELIMITER-EMPTY-2\n/);
  assert.match(run.stdout, /cut: delimiter must be one non-NUL byte\nDELIMITER-WIDE-2\n/);
  assert.match(run.stdout, /cut: unsupported option: -q\nOPTION-2\n/);
  assert.match(run.stdout, /cut: -d requires a delimiter\nMISSING-OPTION-2\n/);
  assert.match(run.stdout, /cut \(-z\|--zero-terminated\).*NUL records: 16 MiB input\/output, 100000 records, 1 MiB each/);
});

test("slop: paste composes bounded LF-delimited byte records atomically", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/read-failure");
  installShell(fs);
  const encoder = new TextEncoder();
  fs.writeFile("/home/web/left.txt", "alpha\nbeta");
  fs.writeFile("/home/web/right.txt", "1\n2\n3\n");
  fs.writeFile("/home/web/f1.txt", "a\nb\n");
  fs.writeFile("/home/web/f2.txt", "1\n2\n");
  fs.writeFile("/home/web/f3.txt", "X\nY\n");
  fs.writeFile("/home/web/one.txt", "a\n");
  fs.writeFile("/home/web/two.txt", "1\n");
  fs.writeFile("/home/web/empty.txt", new Uint8Array());
  fs.writeFile("/home/web/-left", "dash\n");
  fs.writeFile("/home/web/-right", "name\n");
  fs.writeFile(
    "/home/web/opaque-left.bin",
    new Uint8Array([0x41, 0x00, 0x0d, 0xff, 0x0a]),
  );
  fs.writeFile("/home/web/opaque-right.bin", new Uint8Array([0x42, 0x0a]));

  const maxRecord = new Uint8Array(1024 * 1024 + 1).fill(0x6d);
  maxRecord[maxRecord.length - 1] = 0x0a;
  fs.writeFile("/home/web/max-paste-record.bin", maxRecord);
  const oversizedRecord = new Uint8Array(1024 * 1024 + 2).fill(0x6d);
  oversizedRecord[oversizedRecord.length - 1] = 0x0a;
  fs.writeFile("/home/web/oversized-paste-record.bin", oversizedRecord);
  fs.writeFile("/home/web/exact-paste-records.bin", new Uint8Array(100_000).fill(0x0a));
  fs.writeFile("/home/web/too-many-paste-records.bin", new Uint8Array(100_001).fill(0x0a));
  const exactInput = new Uint8Array(16 * 1024 * 1024).fill(0x78);
  for (let offset = 1024 * 1024 - 1; offset < exactInput.length; offset += 1024 * 1024) {
    exactInput[offset] = 0x0a;
  }
  fs.writeFile("/home/web/exact-paste-input.bin", exactInput);

  const thirtyTwoInputs = "paste " + Array(32).fill("empty.txt").join(" ") +
    " > thirty-two.out && echo THIRTY-TWO-OK";
  const thirtyThreeInputs = "paste " + Array(33).fill("empty.txt").join(" ") +
    " > thirty-three.out || echo TOO-MANY-FILES-$?";
  const maxDelimiter = "paste -d '" + "🙂".repeat(256) +
    "' one.txt two.txt > max-delimiter.out && echo MAX-DELIMITER-OK";
  const oversizedDelimiter = "paste -d '" + "🙂".repeat(257) +
    "' one.txt two.txt > oversized-delimiter.out || echo DELIMITER-LIMIT-$?";

  const run = await runSlop(
    fs,
    [
      "paste left.txt right.txt > parallel.out",
      "paste -sd, left.txt > compact-serial.out",
      "paste -s -d : left.txt empty.txt right.txt > serial-files.out",
      "paste -s -d ',🙂' right.txt right.txt > serial-cycling.out",
      "paste -d ',🙂' f1.txt f2.txt f3.txt > cycling.out",
      "paste -d '' one.txt two.txt > empty-delimiter.out",
      "paste -d, -d: one.txt two.txt > last-delimiter.out",
      "paste -ss -d '\\\\t' f1.txt f2.txt f3.txt > literal-backslash.out",
      "printf 'a\\nb\\nc\\nd\\n' | paste - - > repeated-stdin.out",
      "printf 'a\\nb' | paste > implicit-stdin.out",
      "printf 'a\\nb' | paste -s - empty.txt > serial-stdin.out",
      "paste -- -left -right > dashed.out",
      "paste opaque-left.bin opaque-right.bin > opaque.out",
      "paste -s empty.txt > empty-serial.out",
      "paste -s max-paste-record.bin > exact-record.out && echo EXACT-RECORD-OK",
      "paste -sd '' exact-paste-records.bin > exact-count.out && echo EXACT-COUNT-OK",
      "paste -s exact-paste-input.bin > /dev/null && echo EXACT-INPUT-OK",
      thirtyTwoInputs,
      maxDelimiter,
      "paste one.txt missing.txt > missing.out || echo MISSING-$?",
      "paste one.txt read-failure > read-error.out || echo READ-ERROR-$?",
      "paste one.txt oversized-paste-record.bin > late-record.out || echo RECORD-LIMIT-$?",
      "paste one.txt too-many-paste-records.bin > late-count.out || echo COUNT-LIMIT-$?",
      "paste one.txt exact-paste-input.bin > late-aggregate.out || echo INPUT-LIMIT-$?",
      thirtyThreeInputs,
      oversizedDelimiter,
      "paste -q one.txt > bad-option.out || echo BAD-OPTION-$?",
      "paste -z one.txt > zero-option.out || echo ZERO-OPTION-$?",
      "paste --serial one.txt > long-option.out || echo LONG-OPTION-$?",
      "paste -d > missing-delimiter.out || echo MISSING-DELIMITER-$?",
      "cut -c1 one.txt > cut-regression.out",
      "printf aaab | tr -s a > tr-regression.out",
      "command -v paste",
      "paste --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.deepEqual(
    fs.readFile("/home/web/parallel.out"),
    encoder.encode("alpha\t1\nbeta\t2\n\t3\n"),
  );
  assert.deepEqual(fs.readFile("/home/web/compact-serial.out"), encoder.encode("alpha,beta\n"));
  assert.deepEqual(
    fs.readFile("/home/web/serial-files.out"),
    encoder.encode("alpha:beta\n1:2:3\n"),
  );
  assert.deepEqual(
    fs.readFile("/home/web/serial-cycling.out"),
    encoder.encode("1,2🙂3\n1,2🙂3\n"),
  );
  assert.deepEqual(
    fs.readFile("/home/web/cycling.out"),
    encoder.encode("a,1🙂X\nb,2🙂Y\n"),
  );
  assert.deepEqual(fs.readFile("/home/web/empty-delimiter.out"), encoder.encode("a1\n"));
  assert.deepEqual(fs.readFile("/home/web/last-delimiter.out"), encoder.encode("a:1\n"));
  assert.deepEqual(
    fs.readFile("/home/web/literal-backslash.out"),
    encoder.encode("a\\b\n1\\2\nX\\Y\n"),
  );
  assert.deepEqual(fs.readFile("/home/web/repeated-stdin.out"), encoder.encode("a\tb\nc\td\n"));
  assert.deepEqual(fs.readFile("/home/web/implicit-stdin.out"), encoder.encode("a\nb\n"));
  assert.deepEqual(fs.readFile("/home/web/serial-stdin.out"), encoder.encode("a\tb\n"));
  assert.deepEqual(fs.readFile("/home/web/dashed.out"), encoder.encode("dash\tname\n"));
  assert.deepEqual(
    fs.readFile("/home/web/opaque.out"),
    new Uint8Array([0x41, 0x00, 0x0d, 0xff, 0x09, 0x42, 0x0a]),
  );
  assert.equal(fs.readFile("/home/web/empty-serial.out").byteLength, 0);
  assert.deepEqual(fs.readFile("/home/web/exact-record.out"), maxRecord);
  const exactCountOutput = fs.readFile("/home/web/exact-count.out");
  assert.equal(exactCountOutput.byteLength, 1);
  assert.equal(exactCountOutput[0], 0x0a);
  assert.equal(fs.readFile("/home/web/thirty-two.out").byteLength, 0);
  assert.deepEqual(fs.readFile("/home/web/max-delimiter.out"), encoder.encode("a🙂1\n"));
  assert.deepEqual(fs.readFile("/home/web/cut-regression.out"), encoder.encode("a\n"));
  assert.deepEqual(fs.readFile("/home/web/tr-regression.out"), encoder.encode("ab"));
  for (const path of [
    "missing.out", "read-error.out", "late-record.out", "late-count.out", "late-aggregate.out",
    "thirty-three.out", "oversized-delimiter.out", "bad-option.out", "zero-option.out",
    "long-option.out", "missing-delimiter.out",
  ]) assert.equal(fs.readFile("/home/web/" + path).byteLength, 0);

  assert.match(run.stdout, /EXACT-RECORD-OK\nEXACT-COUNT-OK\nEXACT-INPUT-OK\nTHIRTY-TWO-OK\nMAX-DELIMITER-OK\n/);
  assert.match(run.stdout, /paste: missing\.txt: cannot read\nMISSING-1\n/);
  assert.match(run.stdout, /paste: read-failure: cannot read\nREAD-ERROR-1\n/);
  assert.match(run.stdout, /paste: oversized-paste-record\.bin: record exceeds 1048576 bytes\nRECORD-LIMIT-1\n/);
  assert.match(run.stdout, /paste: aggregate record count exceeds 100000\nCOUNT-LIMIT-1\n/);
  assert.match(run.stdout, /paste: aggregate input exceeds 16777216 bytes\nINPUT-LIMIT-1\n/);
  assert.match(run.stdout, /paste: too many input files \(limit 32\)\nusage: paste .*\nTOO-MANY-FILES-2\n/);
  assert.match(run.stdout, /paste: delimiter list exceeds 256 characters\nusage: paste .*\nDELIMITER-LIMIT-2\n/);
  assert.match(run.stdout, /paste: unsupported option: -q\nusage: paste .*\nBAD-OPTION-2\n/);
  assert.match(run.stdout, /paste: unsupported option: -z\nusage: paste .*\nZERO-OPTION-2\n/);
  assert.match(run.stdout, /paste: unsupported option: --serial\nusage: paste .*\nLONG-OPTION-2\n/);
  assert.match(run.stdout, /paste: -d requires a delimiter list\nusage: paste .*\nMISSING-DELIMITER-2\n/);
  assert.match(run.stdout, /\/bin\/paste\nusage: paste \[-s\] \[-d DELIMS\].*32 files\/16 MiB\/100000 records\/1 MiB each/);
});

test("slop: sort and uniq preserve bounded NUL-delimited agent records", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/names");
  installShell(fs);
  const encoder = new TextEncoder();
  fs.writeFile("/home/web/names/line\nbreak", "one");
  fs.writeFile("/home/web/names/tab\tfile", "two");
  fs.writeFile("/home/web/records.bin", new Uint8Array([
    0x62, 0, 0x61, 0x0a, 0x78, 0, 0xff, 0, 0,
  ]));
  fs.writeFile("/home/web/repeated.bin", new Uint8Array([
    0x62, 0, 0x62, 0, 0x61, 0x0a, 0x78, 0, 0x61, 0x0a, 0x78, 0,
  ]));
  fs.writeFile("/home/web/unterminated.bin", new Uint8Array([0x62, 0, 0x61]));
  fs.writeFile("/home/web/empty.bin", new Uint8Array());
  fs.writeFile("/home/web/empty-records.bin", new Uint8Array([0, 0]));
  fs.writeFile("/home/web/numeric.bin", encoder.encode("10\0" + "2\0"));
  fs.writeFile("/home/web/keyed.bin", encoder.encode("z 10\ninside\0a 2\tq\0m 1\0"));
  fs.writeFile("/home/web/-z", encoder.encode("c\na\n"));
  fs.writeFile("/home/web/exact-records.bin", new Uint8Array(100_000));
  fs.writeFile("/home/web/too-many-records.bin", new Uint8Array(100_001));
  const maxRecord = new Uint8Array(1024 * 1024 + 1).fill(0x61);
  maxRecord[maxRecord.length - 1] = 0;
  fs.writeFile("/home/web/max-record.bin", maxRecord);
  const oversizedRecord = new Uint8Array(1024 * 1024 + 2).fill(0x61);
  oversizedRecord[oversizedRecord.length - 1] = 0;
  fs.writeFile("/home/web/oversized-record.bin", oversizedRecord);

  const exactInput = new Uint8Array(16 * 1024 * 1024).fill(0x78);
  const exactChunk = 1024 * 1024;
  for (let offset = exactChunk - 1; offset < exactInput.length; offset += exactChunk) {
    exactInput[offset] = 0;
  }
  fs.writeFile("/home/web/input-limit.bin", exactInput);

  const ordinary = await runSlop(
    fs,
    [
      "sort -z records.bin > sorted.bin",
      "sort -rz records.bin > reverse.bin",
      "sort -zu repeated.bin > unique-sorted.bin",
      "uniq -z repeated.bin > adjacent.bin",
      "uniq -cz repeated.bin > counted.bin",
      "sort -z unterminated.bin > terminated.bin",
      "sort -z empty.bin > empty.out",
      "sort -z empty-records.bin > empty-records.out",
      "sort -zu empty-records.bin > one-empty.out",
      "sort -zn numeric.bin > numeric.out",
      "sort -z -k2,2n keyed.bin > keyed.out",
      "sort -- -z > dashed.out",
      "find names -type f -print0 | sort -z | uniq -z > names.out",
      "sort -zu -t: -k1,1 exact-records.bin > exact-records.out",
      "uniq -z exact-records.bin > exact-uniq.out",
      "sort -z -t: -k1,1 max-record.bin > max-record.out",
      "sort -zu -t: -k1,1 input-limit.bin > input-limit.out",
      "sort -z -t: -k1,1 too-many-records.bin > rejected-count.out || echo SORT-COUNT-$?",
      "uniq -z too-many-records.bin > rejected-uniq-count.out || echo UNIQ-COUNT-$?",
      "sort -z -t: -k1,1 oversized-record.bin > rejected-record.out || echo SORT-RECORD-$?",
      "uniq -z oversized-record.bin > rejected-uniq-record.out || echo UNIQ-RECORD-$?",
      "sort --zero-terminated records.bin || echo SORT-LONG-$?",
      "uniq --zero-terminated records.bin || echo UNIQ-LONG-$?",
      "uniq records.bin repeated.bin || echo UNIQ-FILES-$?",
      "sort --help",
      "uniq --help",
    ],
    { quiet: true },
  );

  assert.equal(ordinary.exitCode, 0);
  assert.deepEqual(fs.readFile("/home/web/sorted.bin"), new Uint8Array([
    0, 0x61, 0x0a, 0x78, 0, 0x62, 0, 0xff, 0,
  ]));
  assert.deepEqual(fs.readFile("/home/web/reverse.bin"), new Uint8Array([
    0xff, 0, 0x62, 0, 0x61, 0x0a, 0x78, 0, 0,
  ]));
  assert.deepEqual(
    fs.readFile("/home/web/unique-sorted.bin"),
    new Uint8Array([0x61, 0x0a, 0x78, 0, 0x62, 0]),
  );
  assert.deepEqual(
    fs.readFile("/home/web/adjacent.bin"),
    new Uint8Array([0x62, 0, 0x61, 0x0a, 0x78, 0]),
  );
  assert.deepEqual(
    fs.readFile("/home/web/counted.bin"),
    encoder.encode("      2 b\0      2 a\nx\0"),
  );
  assert.deepEqual(fs.readFile("/home/web/terminated.bin"), encoder.encode("a\0b\0"));
  assert.equal(fs.readFile("/home/web/empty.out").byteLength, 0);
  assert.deepEqual(fs.readFile("/home/web/empty-records.out"), new Uint8Array([0, 0]));
  assert.deepEqual(fs.readFile("/home/web/one-empty.out"), new Uint8Array([0]));
  assert.deepEqual(fs.readFile("/home/web/numeric.out"), encoder.encode("2\0" + "10\0"));
  assert.deepEqual(
    fs.readFile("/home/web/keyed.out"),
    encoder.encode("m 1\0a 2\tq\0z 10\ninside\0"),
  );
  assert.deepEqual(fs.readFile("/home/web/dashed.out"), encoder.encode("a\nc\n"));
  assert.deepEqual(
    fs.readFile("/home/web/names.out"),
    encoder.encode("names/line\nbreak\0names/tab\tfile\0"),
  );
  assert.deepEqual(fs.readFile("/home/web/exact-records.out"), new Uint8Array([0]));
  assert.deepEqual(fs.readFile("/home/web/exact-uniq.out"), new Uint8Array([0]));
  assert.equal(fs.readFile("/home/web/max-record.out").byteLength, maxRecord.byteLength);
  assert.deepEqual(fs.readFile("/home/web/max-record.out"), maxRecord);
  const limitOutput = fs.readFile("/home/web/input-limit.out");
  assert.equal(limitOutput.byteLength, exactChunk);
  assert.equal(limitOutput[0], 0x78);
  assert.equal(limitOutput[limitOutput.length - 1], 0);
  for (const path of [
    "rejected-count.out", "rejected-uniq-count.out", "rejected-record.out", "rejected-uniq-record.out",
  ]) assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0);
  assert.match(ordinary.stdout, /sort: too many records \(limit 100000\)\nSORT-COUNT-2\n/);
  assert.match(ordinary.stdout, /uniq: too many records \(limit 100000\)\nUNIQ-COUNT-2\n/);
  assert.match(ordinary.stdout, /sort: record exceeds 1048576 bytes\nSORT-RECORD-2\n/);
  assert.match(ordinary.stdout, /uniq: record exceeds 1048576 bytes\nUNIQ-RECORD-2\n/);
  assert.match(ordinary.stdout, /sort: unsupported option: --zero-terminated\nSORT-LONG-2\n/);
  assert.match(ordinary.stdout, /uniq: unsupported option: --zero-terminated\nUNIQ-LONG-2\n/);
  assert.match(ordinary.stdout, /uniq: only one input file is supported\nUNIQ-FILES-2\n/);
  assert.match(ordinary.stdout, /usage: sort \[-rznu\].*-z uses NUL records/);
  assert.match(ordinary.stdout, /usage: uniq \[-cduz\].*-z NUL records/);

  const overInput = new Uint8Array(exactInput.length + 1);
  overInput.set(exactInput); overInput[overInput.length - 1] = 0x79;
  fs.writeFile("/home/web/input-limit.bin", overInput);
  const limits = await runSlop(
    fs,
    [
      "sort -z -t: -k1,1 input-limit.bin > rejected-input.out || echo SORT-INPUT-$?",
      "uniq -z input-limit.bin > rejected-uniq-input.out || echo UNIQ-INPUT-$?",
    ],
    { quiet: true },
  );
  assert.equal(limits.exitCode, 0);
  assert.match(limits.stdout, /sort: input exceeds 16777216 bytes\nSORT-INPUT-2\n/);
  assert.match(limits.stdout, /uniq: input exceeds 16777216 bytes\nUNIQ-INPUT-2\n/);
  assert.equal(fs.readFile("/home/web/rejected-input.out").byteLength, 0);
  assert.equal(fs.readFile("/home/web/rejected-uniq-input.out").byteLength, 0);
});

test("slop: uniq selects adjacent repeated and unique byte groups atomically", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  installShell(fs);
  const encoder = new TextEncoder();
  const joinBytes = (...chunks: Array<string | Uint8Array>): Uint8Array => {
    const encoded = chunks.map((chunk) => typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    const output = new Uint8Array(encoded.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of encoded) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  };
  fs.writeFile("/home/web/groups.txt", "a\na\nb\nc\nc\nc\n");
  fs.writeFile("/home/web/-groups", "a\na\nb\nc\nc\nc\n");
  fs.writeFile("/home/web/unterminated.txt", "a\na\nb");
  fs.writeFile("/home/web/empty-records.txt", "\n\nx\n");
  fs.writeFile("/home/web/empty.txt", new Uint8Array());
  fs.writeFile("/home/web/nul-groups.bin", encoder.encode("a\0a\0b\0c\0c\0"));
  const binaryGroups = joinBytes(
    new Uint8Array([0xff, 0x00, 0x61, 0x0a, 0xff, 0x00, 0x61, 0x0a, 0x80]),
  );
  fs.writeFile("/home/web/binary-groups.bin", binaryGroups);
  fs.writeFile("/home/web/maximum-group.txt", "x\n".repeat(100_000));
  const exactRecord = new Uint8Array(1024 * 1024 + 1).fill(0x61);
  exactRecord[exactRecord.length - 1] = 0x0a;
  const oversizedRecord = new Uint8Array(1024 * 1024 + 2).fill(0x61);
  oversizedRecord[oversizedRecord.length - 1] = 0x0a;
  fs.writeFile("/home/web/exact-uniq-line.bin", exactRecord);
  fs.writeFile("/home/web/oversized-uniq-line.bin", oversizedRecord);
  fs.writeFile("/home/web/too-many-uniq-lines.txt", "q\n".repeat(100_001));
  const inputHashBefore = createHash("sha256")
    .update(fs.readFile("/home/web/groups.txt"))
    .update(fs.readFile("/home/web/nul-groups.bin"))
    .update(fs.readFile("/home/web/binary-groups.bin"))
    .digest("hex");

  const run = await runSlop(
    fs,
    [
      "uniq groups.txt > default.out",
      "uniq -d groups.txt > repeated.out",
      "uniq -u groups.txt > unique.out",
      "uniq -du groups.txt > union.out",
      "uniq -ud groups.txt > reverse-union.out",
      "uniq -c -d groups.txt > counted-repeated.out",
      "uniq -cu groups.txt > counted-unique.out",
      "uniq -cdu groups.txt > counted-union.out",
      "uniq -dd -uu groups.txt > idempotent.out",
      "uniq -d unterminated.txt > unterminated-repeated.out",
      "uniq -u unterminated.txt > unterminated-unique.out",
      "uniq -d empty-records.txt > empty-repeated.out",
      "uniq -u empty-records.txt > empty-unique.out",
      "uniq -d empty.txt > empty.out",
      "uniq -zd nul-groups.bin > nul-repeated.out",
      "uniq -zu nul-groups.bin > nul-unique.out",
      "uniq -zdu nul-groups.bin > nul-union.out",
      "uniq -d binary-groups.bin > binary-repeated.out",
      "uniq -u binary-groups.bin > binary-unique.out",
      "uniq -du binary-groups.bin > binary-union.out",
      "printf 'a\\na\\nb\\n' | uniq -d - > explicit-stdin.out",
      "printf 'a\\na\\nb\\n' | uniq -u > implicit-stdin.out",
      "uniq -d -- -groups > dashed.out",
      "uniq -cd maximum-group.txt > maximum-group.out",
      "uniq -u maximum-group.txt > maximum-unique.out",
      "uniq -d exact-uniq-line.bin > exact-record.out && echo EXACT-RECORD-OK",
      "uniq -d oversized-uniq-line.bin > oversized-record.out || echo RECORD-LIMIT-$?",
      "uniq -d too-many-uniq-lines.txt > oversized-count.out || echo COUNT-LIMIT-$?",
      "uniq -Q groups.txt > unknown.out || echo UNKNOWN-$?",
      "uniq -D groups.txt > all-repeated.out || echo ALL-REPEATED-$?",
      "uniq --repeated groups.txt > long-option.out || echo LONG-OPTION-$?",
      "uniq -d groups.txt empty.txt > operands.out || echo OPERANDS-$?",
      "uniq -d missing.txt > missing.out || echo MISSING-$?",
      "command -v uniq",
      "uniq --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.deepEqual(fs.readFile("/home/web/default.out"), encoder.encode("a\nb\nc\n"));
  assert.deepEqual(fs.readFile("/home/web/repeated.out"), encoder.encode("a\nc\n"));
  assert.deepEqual(fs.readFile("/home/web/unique.out"), encoder.encode("b\n"));
  assert.deepEqual(fs.readFile("/home/web/union.out"), encoder.encode("a\nb\nc\n"));
  assert.deepEqual(fs.readFile("/home/web/reverse-union.out"), fs.readFile("/home/web/union.out"));
  assert.deepEqual(fs.readFile("/home/web/counted-repeated.out"), encoder.encode("      2 a\n      3 c\n"));
  assert.deepEqual(fs.readFile("/home/web/counted-unique.out"), encoder.encode("      1 b\n"));
  assert.deepEqual(
    fs.readFile("/home/web/counted-union.out"),
    encoder.encode("      2 a\n      1 b\n      3 c\n"),
  );
  assert.deepEqual(fs.readFile("/home/web/idempotent.out"), fs.readFile("/home/web/union.out"));
  assert.deepEqual(fs.readFile("/home/web/unterminated-repeated.out"), encoder.encode("a\n"));
  assert.deepEqual(fs.readFile("/home/web/unterminated-unique.out"), encoder.encode("b\n"));
  assert.deepEqual(fs.readFile("/home/web/empty-repeated.out"), encoder.encode("\n"));
  assert.deepEqual(fs.readFile("/home/web/empty-unique.out"), encoder.encode("x\n"));
  assert.equal(fs.readFile("/home/web/empty.out").byteLength, 0);
  assert.deepEqual(fs.readFile("/home/web/nul-repeated.out"), encoder.encode("a\0c\0"));
  assert.deepEqual(fs.readFile("/home/web/nul-unique.out"), encoder.encode("b\0"));
  assert.deepEqual(fs.readFile("/home/web/nul-union.out"), encoder.encode("a\0b\0c\0"));
  assert.deepEqual(
    fs.readFile("/home/web/binary-repeated.out"),
    new Uint8Array([0xff, 0x00, 0x61, 0x0a]),
  );
  assert.deepEqual(fs.readFile("/home/web/binary-unique.out"), new Uint8Array([0x80, 0x0a]));
  assert.deepEqual(fs.readFile("/home/web/binary-union.out"), joinBytes(
    new Uint8Array([0xff, 0x00, 0x61, 0x0a, 0x80, 0x0a]),
  ));
  assert.deepEqual(fs.readFile("/home/web/explicit-stdin.out"), encoder.encode("a\n"));
  assert.deepEqual(fs.readFile("/home/web/implicit-stdin.out"), encoder.encode("b\n"));
  assert.deepEqual(fs.readFile("/home/web/dashed.out"), encoder.encode("a\nc\n"));
  assert.deepEqual(fs.readFile("/home/web/maximum-group.out"), encoder.encode(" 100000 x\n"));
  assert.equal(fs.readFile("/home/web/maximum-unique.out").byteLength, 0);
  assert.equal(fs.readFile("/home/web/exact-record.out").byteLength, 0);
  for (const path of [
    "oversized-record.out", "oversized-count.out", "unknown.out", "all-repeated.out",
    "long-option.out", "operands.out", "missing.out",
  ]) assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  assert.match(run.stdout, /EXACT-RECORD-OK\n/);
  assert.match(run.stdout, /uniq: record exceeds 1048576 bytes\nRECORD-LIMIT-2\n/);
  assert.match(run.stdout, /uniq: too many records \(limit 100000\)\nCOUNT-LIMIT-2\n/);
  for (const marker of ["UNKNOWN-2", "ALL-REPEATED-2", "LONG-OPTION-2", "OPERANDS-2", "MISSING-1"]) {
    assert.match(run.stdout, new RegExp(`(?:^|\\n)${marker}\\n`), marker);
  }
  assert.match(run.stdout, /\/bin\/uniq\nusage: uniq \[-cduz\].*-d repeated groups; -u unique groups/);
  const inputHashAfter = createHash("sha256")
    .update(fs.readFile("/home/web/groups.txt"))
    .update(fs.readFile("/home/web/nul-groups.bin"))
    .update(fs.readFile("/home/web/binary-groups.bin"))
    .digest("hex");
  assert.equal(inputHashAfter, inputHashBefore);
});

test("slop: cmp is a strict quiet-capable binary predicate", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/adir");
  installShell(fs);
  const encoder = new TextEncoder();
  const equal = new Uint8Array([0x61, 0x00, 0xff, 0x0a, 0x7a]);
  const differentLeft = new Uint8Array([0x61, 0x62, 0x00, 0xff, 0x5a, 0x0a]);
  const differentRight = new Uint8Array([0x61, 0x62, 0x00, 0xfe, 0x5a, 0x0a]);
  fs.writeFile("/home/web/equal-left.bin", equal);
  fs.writeFile("/home/web/equal-right.bin", equal);
  fs.writeFile("/home/web/different-left.bin", differentLeft);
  fs.writeFile("/home/web/different-right.bin", differentRight);
  fs.writeFile("/home/web/prefix.bin", "abc");
  fs.writeFile("/home/web/longer.bin", "abcd");
  fs.writeFile("/home/web/empty.bin", new Uint8Array());
  fs.writeFile("/home/web/one.bin", new Uint8Array([0x80]));
  fs.writeFile("/home/web/line-left.txt", "a\nb\nc");
  fs.writeFile("/home/web/line-right.txt", "a\nb\nx");
  fs.writeFile("/home/web/--dashed", equal);
  fs.writeFile("/home/web/dash-peer", equal);
  const hashBefore = createHash("sha256")
    .update(fs.readFile("/home/web/equal-left.bin"))
    .update(fs.readFile("/home/web/different-left.bin"))
    .update(fs.readFile("/home/web/prefix.bin"))
    .update(fs.readFile("/home/web/line-left.txt"))
    .digest("hex");

  const run = await runSlop(
    fs,
    [
      "cmp equal-left.bin equal-right.bin && echo EQUAL-0",
      "cmp empty.bin empty.bin && echo EMPTY-0",
      "cmp different-left.bin different-right.bin > different.out || echo DIFFERENT-$?",
      "cmp prefix.bin longer.bin > prefix.out || echo PREFIX-$?",
      "cmp longer.bin prefix.bin > reverse-prefix.out || echo REVERSE-PREFIX-$?",
      "cmp empty.bin one.bin > empty-prefix.out || echo EMPTY-PREFIX-$?",
      "cmp line-left.txt line-right.txt > line.out || echo LINE-$?",
      "cmp -- --dashed dash-peer && echo DASHED-0",
      "cmp - equal-right.bin < equal-left.bin && echo STDIN-LEFT-0",
      "cmp equal-left.bin - < equal-right.bin && echo STDIN-RIGHT-0",
      "cat equal-left.bin | cmp - equal-right.bin && echo PIPE-0",
      "cmp - different-right.bin < different-left.bin > stdin-different.out || echo STDIN-DIFFERENT-$?",
      "cmp -s equal-left.bin equal-right.bin && echo QUIET-EQUAL-0",
      "cmp -s different-left.bin different-right.bin > quiet-different.out 2> quiet-different.err || echo QUIET-DIFFERENT-$?",
      "cmp -s missing.bin equal-left.bin > quiet-missing.out 2> quiet-missing.err || echo QUIET-MISSING-$?",
      "cmp -s adir equal-left.bin > quiet-directory.out 2> quiet-directory.err || echo QUIET-DIRECTORY-$?",
      "cmp -s -- --dashed dash-peer && echo QUIET-DASHED-0",
      "cmp missing-first.bin missing-second.bin > missing-first.out 2> missing-first.err || echo MISSING-FIRST-$?",
      "cmp equal-left.bin missing-second.bin > missing-second.out 2> missing-second.err || echo MISSING-SECOND-$?",
      "cmp adir equal-left.bin > directory.out 2> directory.err || echo DIRECTORY-$?",
      "cmp > zero-operands.out 2> zero-operands.err || echo ZERO-OPERANDS-$?",
      "cmp equal-left.bin > one-operand.out 2> one-operand.err || echo ONE-OPERAND-$?",
      "cmp equal-left.bin equal-right.bin extra > excess-equal.out 2> excess-equal.err || echo EXCESS-EQUAL-$?",
      "cmp different-left.bin different-right.bin extra > excess-different.out 2> excess-different.err || echo EXCESS-DIFFERENT-$?",
      "cmp -q equal-left.bin equal-right.bin > unknown-short.out 2> unknown-short.err || echo UNKNOWN-SHORT-$?",
      "cmp --silent equal-left.bin equal-right.bin > unknown-long.out 2> unknown-long.err || echo UNKNOWN-LONG-$?",
      "cmp --dashed dash-peer > unescaped-dash.out 2> unescaped-dash.err || echo UNESCAPED-DASH-$?",
      "printf input | cmp - - > both-stdin.out 2> both-stdin.err || echo BOTH-STDIN-$?",
      "cmp --help extra > help-extra.out 2> help-extra.err || echo HELP-EXTRA-$?",
      "cmp -s equal-left.bin equal-right.bin extra > quiet-excess.out 2> quiet-excess.err || echo QUIET-EXCESS-$?",
      "cmp -s - - > quiet-both-stdin.out 2> quiet-both-stdin.err || echo QUIET-BOTH-STDIN-$?",
      "cmp -s -q equal-left.bin > quiet-unknown.out 2> quiet-unknown.err || echo QUIET-UNKNOWN-$?",
      "command -v cmp",
      "cmp --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.deepEqual(
    fs.readFile("/home/web/different.out"),
    encoder.encode("different-left.bin different-right.bin differ: byte 4, line 1\n"),
  );
  assert.deepEqual(
    fs.readFile("/home/web/prefix.out"),
    encoder.encode("prefix.bin longer.bin differ: byte 4, line 1\n"),
  );
  assert.deepEqual(
    fs.readFile("/home/web/reverse-prefix.out"),
    encoder.encode("longer.bin prefix.bin differ: byte 4, line 1\n"),
  );
  assert.deepEqual(
    fs.readFile("/home/web/empty-prefix.out"),
    encoder.encode("empty.bin one.bin differ: byte 1, line 1\n"),
  );
  assert.deepEqual(
    fs.readFile("/home/web/line.out"),
    encoder.encode("line-left.txt line-right.txt differ: byte 5, line 3\n"),
  );
  assert.deepEqual(
    fs.readFile("/home/web/stdin-different.out"),
    encoder.encode("- different-right.bin differ: byte 4, line 1\n"),
  );
  for (const path of [
    "quiet-different.out", "quiet-different.err", "quiet-missing.out", "quiet-missing.err",
    "quiet-directory.out", "quiet-directory.err", "missing-first.out", "missing-second.out",
    "directory.out", "zero-operands.out", "one-operand.out", "excess-equal.out",
    "excess-different.out", "unknown-short.out", "unknown-long.out", "unescaped-dash.out",
    "both-stdin.out", "help-extra.out", "quiet-excess.out", "quiet-excess.err",
    "quiet-both-stdin.out", "quiet-both-stdin.err", "quiet-unknown.out", "quiet-unknown.err",
  ]) assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/missing-first.err")), "cmp: missing-first.bin: cannot open\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/missing-second.err")), "cmp: missing-second.bin: cannot open\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/directory.err")), "cmp: adir: is a directory\n");
  const usageDiagnostic = "cmp: usage: cmp [-s] [--] FILE1 FILE2\n";
  for (const path of [
    "zero-operands.err", "one-operand.err", "excess-equal.err", "excess-different.err",
    "unknown-short.err", "unknown-long.err", "unescaped-dash.err", "both-stdin.err", "help-extra.err",
  ]) assert.equal(new TextDecoder().decode(fs.readFile(`/home/web/${path}`)), usageDiagnostic, path);
  for (const marker of [
    "DIFFERENT-1", "PREFIX-1", "REVERSE-PREFIX-1", "EMPTY-PREFIX-1", "LINE-1",
    "STDIN-DIFFERENT-1", "QUIET-DIFFERENT-1", "QUIET-MISSING-2", "QUIET-DIRECTORY-2",
    "MISSING-FIRST-2", "MISSING-SECOND-2", "DIRECTORY-2", "ZERO-OPERANDS-2",
    "ONE-OPERAND-2", "EXCESS-EQUAL-2", "EXCESS-DIFFERENT-2", "UNKNOWN-SHORT-2",
    "UNKNOWN-LONG-2", "UNESCAPED-DASH-2", "BOTH-STDIN-2", "HELP-EXTRA-2",
    "QUIET-EXCESS-2", "QUIET-BOTH-STDIN-2", "QUIET-UNKNOWN-2",
  ]) assert.match(run.stdout, new RegExp(`(?:^|\\n)${marker}\\n`), marker);
  for (const marker of [
    "EQUAL-0", "EMPTY-0", "DASHED-0", "STDIN-LEFT-0", "STDIN-RIGHT-0", "PIPE-0",
    "QUIET-EQUAL-0", "QUIET-DASHED-0",
  ]) assert.match(run.stdout, new RegExp(`(?:^|\\n)${marker}\\n`), marker);
  assert.match(run.stdout, /\/bin\/cmp\nusage: cmp \[-s\] \[--\] FILE1 FILE2\n/);
  const hashAfter = createHash("sha256")
    .update(fs.readFile("/home/web/equal-left.bin"))
    .update(fs.readFile("/home/web/different-left.bin"))
    .update(fs.readFile("/home/web/prefix.bin"))
    .update(fs.readFile("/home/web/line-left.txt"))
    .digest("hex");
  assert.equal(hashAfter, hashBefore);

  const faultFs = new LateReadFailureFs();
  faultFs.mkdirTree("/home/web");
  installShell(faultFs);
  const lateLeft = new Uint8Array(131_072).fill(0x61); lateLeft[0] = 0x62;
  const lateRight = new Uint8Array(131_072).fill(0x61);
  faultFs.writeFile("/home/web/late-read.bin", lateLeft);
  faultFs.writeFile("/home/web/late-peer.bin", lateRight);
  const failed = await runSlop(
    faultFs,
    [
      "cmp late-read.bin late-peer.bin > late.out 2> late.err || echo LATE-$?",
      "cmp -s late-read.bin late-peer.bin > quiet-late.out 2> quiet-late.err || echo QUIET-LATE-$?",
    ],
    { quiet: true },
  );
  assert.equal(failed.exitCode, 0);
  assert.equal(faultFs.readFile("/home/web/late.out").byteLength, 0);
  assert.equal(new TextDecoder().decode(faultFs.readFile("/home/web/late.err")), "cmp: late-read.bin: read error\n");
  assert.equal(faultFs.readFile("/home/web/quiet-late.out").byteLength, 0);
  assert.equal(faultFs.readFile("/home/web/quiet-late.err").byteLength, 0);
  assert.match(failed.stdout, /LATE-2\nQUIET-LATE-2\n/);
});

test("slop: comm compares bounded sorted byte records atomically", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  const encoder = new TextEncoder();
  fs.writeFile("/home/web/left.txt", "alpha\ncommon\nzulu\n");
  fs.writeFile("/home/web/right.txt", "beta\ncommon\nyankee\n");
  fs.writeFile("/home/web/duplicates-left.txt", "a\na\nb\n");
  fs.writeFile("/home/web/duplicates-right.txt", "a\nb\nb\n");
  fs.writeFile("/home/web/-left", "common\nleft\n");
  fs.writeFile("/home/web/-right", "common\nright\n");
  fs.writeFile("/home/web/final-left.bin", encoder.encode("a\nz"));
  fs.writeFile("/home/web/final-right.bin", encoder.encode("z"));
  fs.writeFile(
    "/home/web/binary-left.bin",
    new Uint8Array([0x00, 0x0a, 0x80, 0x0a, 0xff, 0x0a]),
  );
  fs.writeFile(
    "/home/web/binary-right.bin",
    new Uint8Array([0x00, 0x0a, 0xff, 0x0a]),
  );
  fs.writeFile("/home/web/unsorted.txt", "a\nc\nb\n");
  fs.writeFile("/home/web/empty.txt", new Uint8Array());

  const maxRecord = new Uint8Array(1024 * 1024).fill(0x6d);
  fs.writeFile("/home/web/max-comm-record.bin", maxRecord);
  const oversizedRecord = new Uint8Array(1024 * 1024 + 1).fill(0x6d);
  fs.writeFile("/home/web/oversized-comm-record.bin", oversizedRecord);
  fs.writeFile("/home/web/exact-comm-records.bin", new Uint8Array(100_000).fill(0x0a));
  fs.writeFile("/home/web/too-many-comm-records.bin", new Uint8Array(100_001).fill(0x0a));
  const exactInput = new Uint8Array(16 * 1024 * 1024).fill(0x78);
  for (let offset = 1024 * 1024 - 1; offset < exactInput.length; offset += 1024 * 1024) {
    exactInput[offset] = 0x0a;
  }
  fs.writeFile("/home/web/exact-comm-input.bin", exactInput);
  const oversizedInput = new Uint8Array(exactInput.length + 1);
  oversizedInput.set(exactInput); oversizedInput[oversizedInput.length - 1] = 0x7a;
  fs.writeFile("/home/web/oversized-comm-input.bin", oversizedInput);

  const run = await runSlop(
    fs,
    [
      "comm left.txt right.txt > default.out",
      "comm -12 left.txt right.txt > common.out",
      "comm -13 left.txt right.txt > right-only.out",
      "comm -23 left.txt right.txt > left-only.out",
      "comm -3 left.txt right.txt > unique.out",
      "comm -1 -2 -3 left.txt right.txt > all-suppressed.out",
      "comm -12 duplicates-left.txt duplicates-right.txt > duplicate-common.out",
      "comm duplicates-left.txt duplicates-right.txt > duplicates.out",
      "printf 'zulu\\nalpha\\ncommon\\n' | sort | comm -12 - right.txt > stdin.out",
      "comm -12 -- -left -right > dashed.out",
      "comm final-left.bin final-right.bin > final.out",
      "comm -12 binary-left.bin binary-right.bin > binary.out",
      "comm empty.txt empty.txt > empty.out",
      "comm -123 empty.txt empty.txt > suppressed-empty.out",
      "comm -1 max-comm-record.bin empty.txt && echo EXACT-RECORD-OK",
      "comm -1 exact-comm-records.bin empty.txt && echo EXACT-COUNT-OK",
      "comm -1 exact-comm-input.bin empty.txt && echo EXACT-INPUT-OK",
      "comm unsorted.txt right.txt > unsorted.out || echo UNSORTED-$?",
      "comm left.txt missing.txt > missing.out || echo MISSING-$?",
      "comm left.txt oversized-comm-record.bin > oversized-record.out || echo RECORD-LIMIT-$?",
      "comm left.txt too-many-comm-records.bin > oversized-count.out || echo COUNT-LIMIT-$?",
      "comm left.txt oversized-comm-input.bin > oversized-input.out || echo INPUT-LIMIT-$?",
      "comm left.txt > one-operand.out || echo ONE-OPERAND-$?",
      "comm left.txt right.txt empty.txt > three-operands.out || echo THREE-OPERANDS-$?",
      "comm -x left.txt right.txt > unknown-option.out || echo UNKNOWN-OPTION-$?",
      "printf unused | comm - - > both-stdin.out || echo BOTH-STDIN-$?",
      "cmp left.txt left.txt && echo CMP-UNCHANGED",
      "diff -q left.txt left.txt && echo DIFF-UNCHANGED",
      "printf 'b\\na\\n' | sort | uniq > adjacent.out",
      "command -v comm",
      "comm --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.deepEqual(
    fs.readFile("/home/web/default.out"),
    encoder.encode("alpha\n\tbeta\n\t\tcommon\n\tyankee\nzulu\n"),
  );
  assert.deepEqual(fs.readFile("/home/web/common.out"), encoder.encode("common\n"));
  assert.deepEqual(fs.readFile("/home/web/right-only.out"), encoder.encode("beta\nyankee\n"));
  assert.deepEqual(fs.readFile("/home/web/left-only.out"), encoder.encode("alpha\nzulu\n"));
  assert.deepEqual(
    fs.readFile("/home/web/unique.out"),
    encoder.encode("alpha\n\tbeta\n\tyankee\nzulu\n"),
  );
  assert.equal(fs.readFile("/home/web/all-suppressed.out").byteLength, 0);
  assert.deepEqual(fs.readFile("/home/web/duplicate-common.out"), encoder.encode("a\nb\n"));
  assert.deepEqual(
    fs.readFile("/home/web/duplicates.out"),
    encoder.encode("\t\ta\na\n\t\tb\n\tb\n"),
  );
  assert.deepEqual(fs.readFile("/home/web/stdin.out"), encoder.encode("common\n"));
  assert.deepEqual(fs.readFile("/home/web/dashed.out"), encoder.encode("common\n"));
  assert.deepEqual(fs.readFile("/home/web/final.out"), encoder.encode("a\n\t\tz"));
  assert.deepEqual(
    fs.readFile("/home/web/binary.out"),
    new Uint8Array([0x00, 0x0a, 0xff, 0x0a]),
  );
  assert.equal(fs.readFile("/home/web/empty.out").byteLength, 0);
  assert.equal(fs.readFile("/home/web/suppressed-empty.out").byteLength, 0);
  assert.deepEqual(fs.readFile("/home/web/adjacent.out"), encoder.encode("a\nb\n"));
  for (const path of [
    "unsorted.out", "missing.out", "oversized-record.out", "oversized-count.out",
    "oversized-input.out", "one-operand.out", "three-operands.out", "unknown-option.out",
    "both-stdin.out",
  ]) assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0);
  assert.match(run.stdout, /EXACT-RECORD-OK\nEXACT-COUNT-OK\nEXACT-INPUT-OK\n/);
  assert.match(run.stdout, /comm: unsorted\.txt: input is not sorted at record 3\nUNSORTED-1\n/);
  assert.match(run.stdout, /comm: missing\.txt: cannot read\nMISSING-1\n/);
  assert.match(run.stdout, /comm: oversized-comm-record\.bin: input limit exceeded\nRECORD-LIMIT-1\n/);
  assert.match(run.stdout, /comm: too-many-comm-records\.bin: input limit exceeded\nCOUNT-LIMIT-1\n/);
  assert.match(run.stdout, /comm: oversized-comm-input\.bin: input limit exceeded\nINPUT-LIMIT-1\n/);
  assert.match(run.stdout, /comm: expected exactly two files\nusage: comm .*\nONE-OPERAND-2\n/);
  assert.match(run.stdout, /comm: expected exactly two files\nusage: comm .*\nTHREE-OPERANDS-2\n/);
  assert.match(run.stdout, /comm: unsupported option: -x\nusage: comm .*\nUNKNOWN-OPTION-2\n/);
  assert.match(run.stdout, /comm: both inputs cannot be standard input\nBOTH-STDIN-2\n/);
  assert.match(run.stdout, /CMP-UNCHANGED\nDIFF-UNCHANGED\n\/bin\/comm\n/);
  assert.match(run.stdout, /usage: comm \[-123\] \[--\] FILE1 FILE2.*16 MiB\/100000 records\/1 MiB each/);
});

test("slop: join reconciles bounded sorted keyed byte records atomically", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  installShell(fs);
  const encoder = new TextEncoder();
  const joinBytes = (...chunks: Array<string | Uint8Array>): Uint8Array => {
    const encoded = chunks.map((chunk) => typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    const output = new Uint8Array(encoded.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of encoded) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  };

  fs.writeFile("/home/web/empty.txt", new Uint8Array());
  fs.writeFile("/home/web/basic-left.txt", "a x\nb y\n");
  fs.writeFile("/home/web/basic-right.txt", "a 1\nb 2\n");
  fs.writeFile("/home/web/whitespace-left.txt", "  a \t x  \n\tb\t y\t\n");
  fs.writeFile("/home/web/whitespace-right.txt", "a\t1\n b   2 \n");
  fs.writeFile("/home/web/selected-left.csv", "x,k,u\n");
  fs.writeFile("/home/web/selected-right.csv", "k,p\n");
  fs.writeFile("/home/web/empty-key-left.csv", ",L\nk,KL\n");
  fs.writeFile("/home/web/empty-key-right.csv", ",R\nk,KR\n");
  fs.writeFile("/home/web/duplicate-left.txt", "b y\nb z\n");
  fs.writeFile("/home/web/duplicate-right.txt", "b 2\nb 3\n");
  fs.writeFile("/home/web/outer-left.txt", "a L1\nb L2\nd L4\n");
  fs.writeFile("/home/web/outer-right.txt", "a R1\nb R2\nc R3\n");
  fs.writeFile("/home/web/unterminated-left.txt", "a left");
  fs.writeFile("/home/web/unterminated-right.txt", "a right");
  fs.writeFile("/home/web/-join-left", "a dashed-left\n");
  fs.writeFile("/home/web/-join-right", "a dashed-right\n");
  fs.writeFile("/home/web/unsorted.txt", "a one\nc three\nb two\n");
  fs.writeFile("/home/web/missing-field.txt", "a one\nwhitespace-only-key-missing\n");
  fs.writeFile("/home/web/all-whitespace.txt", " \t  \n");
  fs.writeFile("/home/web/tab-left.txt", "a\tleft\n");
  fs.writeFile("/home/web/tab-right.txt", "a\tright\n");

  const thousandLeft = Array.from({ length: 1000 }, (_, index) =>
    index === 999 ? "key" : `l${index + 1}`).join(",") + "\n";
  const thousandRight = Array.from({ length: 1000 }, (_, index) =>
    index === 999 ? "key" : `r${index + 1}`).join(",") + "\n";
  fs.writeFile("/home/web/thousand-left.csv", thousandLeft);
  fs.writeFile("/home/web/thousand-right.csv", thousandRight);

  fs.writeFile(
    "/home/web/raw-left.bin",
    joinBytes(",LE\n", new Uint8Array([0]), ",L0\na,LA\naa,LAA\n", new Uint8Array([0x7f]),
      ",L7\n", new Uint8Array([0xff]), ",LF\n"),
  );
  fs.writeFile(
    "/home/web/raw-right.bin",
    joinBytes(",RE\n", new Uint8Array([0]), ",R0\na,RA\naa,RAA\n", new Uint8Array([0x7f]),
      ",R7\n", new Uint8Array([0xff]), ",RF\n"),
  );

  const exactRecord = new Uint8Array(1024 * 1024).fill(0x61);
  const oversizedRecord = new Uint8Array(1024 * 1024 + 1).fill(0x61);
  fs.writeFile("/home/web/exact-join-record.bin", exactRecord);
  fs.writeFile("/home/web/oversized-join-record.bin", oversizedRecord);
  fs.writeFile("/home/web/exact-join-records.txt", "a\n".repeat(100_000));
  fs.writeFile("/home/web/too-many-join-records.txt", "a\n".repeat(100_001));
  const exactInputUnit = encoder.encode("a".repeat(1024 * 1024 - 1) + "\n");
  const exactInput = new Uint8Array(16 * 1024 * 1024);
  for (let offset = 0; offset < exactInput.byteLength; offset += exactInputUnit.byteLength) {
    exactInput.set(exactInputUnit, offset);
  }
  fs.writeFile("/home/web/exact-join-input.bin", exactInput);
  fs.writeFile("/home/web/oversized-join-input.bin", new Uint8Array(16 * 1024 * 1024 + 1).fill(0x61));

  fs.writeFile("/home/web/product-left.txt",
    Array.from({ length: 250 }, (_, index) => `k l${index}`).join("\n") + "\n");
  fs.writeFile("/home/web/product-right.txt",
    Array.from({ length: 400 }, (_, index) => `k r${index}`).join("\n") + "\n");
  fs.writeFile("/home/web/product-over-left.txt",
    Array.from({ length: 251 }, (_, index) => `k l${index}`).join("\n") + "\n");
  fs.writeFile("/home/web/product-over-right.txt",
    Array.from({ length: 399 }, (_, index) => `k r${index}`).join("\n") + "\n");
  const wide = "x".repeat(200);
  fs.writeFile("/home/web/wide-left.txt", (`k ${wide}\n`).repeat(250));
  fs.writeFile("/home/web/wide-right.txt", (`k ${wide}\n`).repeat(400));
  const exactOutputSide = joinBytes(",", new Uint8Array(1024 * 1024 - 1).fill(0x61));
  fs.writeFile("/home/web/exact-output-left.bin", exactOutputSide);
  fs.writeFile("/home/web/exact-output-right.bin", exactOutputSide);

  const unchangedBefore = createHash("sha256")
    .update(fs.readFile("/home/web/basic-left.txt"))
    .update(fs.readFile("/home/web/basic-right.txt"))
    .digest("hex");
  const run = await runSlop(
    fs,
    [
      "join empty.txt empty.txt > empty.out && echo EMPTY-OK",
      "join basic-left.txt basic-right.txt > basic.out",
      "join whitespace-left.txt whitespace-right.txt > whitespace.out",
      "join -1 2 -2 1 -t , selected-left.csv selected-right.csv > selected.out",
      "join -t , empty-key-left.csv empty-key-right.csv > empty-key.out",
      "join duplicate-left.txt duplicate-right.txt > duplicates.out",
      "join outer-left.txt outer-right.txt > inner.out",
      "join -a 1 outer-left.txt outer-right.txt > left-outer.out",
      "join -a 2 outer-left.txt outer-right.txt > right-outer.out",
      "join -a 1 -a 2 outer-left.txt outer-right.txt > full-outer.out",
      "join -a 1 -a 1 outer-left.txt outer-right.txt > repeated-a.out",
      "join -v 1 outer-left.txt outer-right.txt > left-anti.out",
      "join -v 2 outer-left.txt outer-right.txt > right-anti.out",
      "join unterminated-left.txt unterminated-right.txt > unterminated.out",
      "printf 'a stdin-left\\n' | join - basic-right.txt > stdin-left.out",
      "printf 'a stdin-right\\n' | join basic-left.txt - > stdin-right.out",
      "join -- -join-left -join-right > dashed.out",
      "join -t , raw-left.bin raw-right.bin > raw.out",
      "join -t '	' tab-left.txt tab-right.txt > tab.out",
      "join -1 1000 -2 1000 -t , thousand-left.csv thousand-right.csv > thousand.out",
      "join exact-join-record.bin empty.txt > /dev/null && echo EXACT-RECORD-OK",
      "join exact-join-records.txt empty.txt > /dev/null && echo EXACT-COUNT-OK",
      "join exact-join-input.bin empty.txt > /dev/null && echo EXACT-INPUT-OK",
      "join product-left.txt product-right.txt > exact-product.out && echo EXACT-PRODUCT-OK",
      "join -t , exact-output-left.bin exact-output-right.bin > exact-output-record.out && echo EXACT-OUTPUT-RECORD-OK",
      "join unsorted.txt basic-right.txt > unsorted.out || echo UNSORTED-$?",
      "join -1 2 missing-field.txt basic-right.txt > missing-field.out || echo MISSING-FIELD-$?",
      "join all-whitespace.txt basic-right.txt > whitespace-error.out || echo WHITESPACE-ERROR-$?",
      "join basic-left.txt missing.txt > missing.out || echo MISSING-$?",
      "join oversized-join-record.bin empty.txt > oversized-record.out || echo RECORD-LIMIT-$?",
      "join too-many-join-records.txt empty.txt > oversized-count.out || echo COUNT-LIMIT-$?",
      "join oversized-join-input.bin empty.txt > oversized-input.out || echo INPUT-LIMIT-$?",
      "join product-over-left.txt product-over-right.txt > product-over.out || echo PRODUCT-LIMIT-$?",
      "join wide-left.txt wide-right.txt > output-over.out || echo OUTPUT-LIMIT-$?",
      "join -12 basic-left.txt basic-right.txt > compact.out || echo COMPACT-$?",
      "join -t, selected-left.csv selected-right.csv > compact-delimiter.out || echo COMPACT-DELIMITER-$?",
      "join --ignore-case basic-left.txt basic-right.txt > long-option.out || echo LONG-OPTION-$?",
      "join -1 1 -1 1 basic-left.txt basic-right.txt > duplicate-field.out || echo DUPLICATE-FIELD-$?",
      "join -t , -t : selected-left.csv selected-right.csv > duplicate-delimiter.out || echo DUPLICATE-DELIMITER-$?",
      "join -a 1 -v 1 outer-left.txt outer-right.txt > mixed-outer.out || echo MIXED-OUTER-$?",
      "join -v 1 -v 2 outer-left.txt outer-right.txt > duplicate-v.out || echo DUPLICATE-V-$?",
      "join -a 3 outer-left.txt outer-right.txt > bad-a.out || echo BAD-A-$?",
      "join -1 0 basic-left.txt basic-right.txt > field-zero.out || echo FIELD-ZERO-$?",
      "join -1 01 basic-left.txt basic-right.txt > field-leading-zero.out || echo FIELD-LEADING-ZERO-$?",
      "join -1 1001 basic-left.txt basic-right.txt > field-limit.out || echo FIELD-LIMIT-$?",
      "join -t '' basic-left.txt basic-right.txt > empty-delimiter.out || echo EMPTY-DELIMITER-$?",
      "join -t '🙂' basic-left.txt basic-right.txt > unicode-delimiter.out || echo UNICODE-DELIMITER-$?",
      "join -1 > missing-one-field.out || echo MISSING-ONE-FIELD-$?",
      "join -2 > missing-two-field.out || echo MISSING-TWO-FIELD-$?",
      "join -t > missing-t.out || echo MISSING-T-$?",
      "join -a > missing-a.out || echo MISSING-A-$?",
      "join -v > missing-v.out || echo MISSING-V-$?",
      "join basic-left.txt > one-operand.out || echo ONE-OPERAND-$?",
      "join basic-left.txt basic-right.txt empty.txt > extra-operand.out || echo EXTRA-OPERAND-$?",
      "printf unused | join - - > both-stdin.out || echo BOTH-STDIN-$?",
      "command -v join",
      "join --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.equal(fs.readFile("/home/web/empty.out").byteLength, 0);
  assert.deepEqual(fs.readFile("/home/web/basic.out"), encoder.encode("a x 1\nb y 2\n"));
  assert.deepEqual(fs.readFile("/home/web/whitespace.out"), encoder.encode("a x 1\nb y 2\n"));
  assert.deepEqual(fs.readFile("/home/web/selected.out"), encoder.encode("k,x,u,p\n"));
  assert.deepEqual(fs.readFile("/home/web/empty-key.out"), encoder.encode(",L,R\nk,KL,KR\n"));
  assert.deepEqual(
    fs.readFile("/home/web/duplicates.out"),
    encoder.encode("b y 2\nb y 3\nb z 2\nb z 3\n"),
  );
  assert.deepEqual(fs.readFile("/home/web/inner.out"), encoder.encode("a L1 R1\nb L2 R2\n"));
  assert.deepEqual(fs.readFile("/home/web/left-outer.out"), encoder.encode("a L1 R1\nb L2 R2\nd L4\n"));
  assert.deepEqual(fs.readFile("/home/web/right-outer.out"), encoder.encode("a L1 R1\nb L2 R2\nc R3\n"));
  assert.deepEqual(fs.readFile("/home/web/full-outer.out"), encoder.encode("a L1 R1\nb L2 R2\nc R3\nd L4\n"));
  assert.deepEqual(fs.readFile("/home/web/repeated-a.out"), fs.readFile("/home/web/left-outer.out"));
  assert.deepEqual(fs.readFile("/home/web/left-anti.out"), encoder.encode("d L4\n"));
  assert.deepEqual(fs.readFile("/home/web/right-anti.out"), encoder.encode("c R3\n"));
  assert.deepEqual(fs.readFile("/home/web/unterminated.out"), encoder.encode("a left right\n"));
  assert.deepEqual(fs.readFile("/home/web/stdin-left.out"), encoder.encode("a stdin-left 1\n"));
  assert.deepEqual(fs.readFile("/home/web/stdin-right.out"), encoder.encode("a x stdin-right\n"));
  assert.deepEqual(fs.readFile("/home/web/dashed.out"), encoder.encode("a dashed-left dashed-right\n"));
  assert.deepEqual(
    fs.readFile("/home/web/raw.out"),
    joinBytes(",LE,RE\n", new Uint8Array([0]), ",L0,R0\na,LA,RA\naa,LAA,RAA\n",
      new Uint8Array([0x7f]), ",L7,R7\n", new Uint8Array([0xff]), ",LF,RF\n"),
  );
  assert.deepEqual(fs.readFile("/home/web/tab.out"), encoder.encode("a\tleft\tright\n"));
  const thousand = new TextDecoder().decode(fs.readFile("/home/web/thousand.out")).trim().split(",");
  assert.equal(thousand.length, 1999);
  assert.equal(thousand[0], "key");
  assert.equal(thousand[1], "l1");
  assert.equal(thousand[999], "l999");
  assert.equal(thousand[1000], "r1");
  assert.equal(thousand[1998], "r999");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/exact-product.out")).trim().split("\n").length, 100_000);
  assert.equal(fs.readFile("/home/web/exact-output-record.out").byteLength, 2 * 1024 * 1024 + 1);
  for (const path of [
    "unsorted.out", "missing-field.out", "whitespace-error.out", "missing.out",
    "oversized-record.out", "oversized-count.out", "oversized-input.out", "product-over.out",
    "output-over.out", "compact.out", "compact-delimiter.out", "long-option.out",
    "duplicate-field.out", "duplicate-delimiter.out", "mixed-outer.out", "duplicate-v.out",
    "bad-a.out", "field-zero.out", "field-leading-zero.out", "field-limit.out",
    "empty-delimiter.out", "unicode-delimiter.out", "missing-one-field.out",
    "missing-two-field.out", "missing-t.out", "missing-a.out", "missing-v.out",
    "one-operand.out", "extra-operand.out", "both-stdin.out",
  ]) assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  assert.match(run.stdout, /EMPTY-OK\nEXACT-RECORD-OK\nEXACT-COUNT-OK\nEXACT-INPUT-OK\nEXACT-PRODUCT-OK\nEXACT-OUTPUT-RECORD-OK\n/);
  assert.match(run.stdout, /join: unsorted\.txt: input is not sorted at record 3\nUNSORTED-1\n/);
  assert.match(run.stdout, /join: missing-field\.txt: record 2 has no field 2\nMISSING-FIELD-1\n/);
  assert.match(run.stdout, /join: all-whitespace\.txt: record 1 has no field 1\nWHITESPACE-ERROR-1\n/);
  assert.match(run.stdout, /join: missing\.txt: cannot read\nMISSING-1\n/);
  assert.match(run.stdout, /join: oversized-join-record\.bin: input limit exceeded\nRECORD-LIMIT-1\n/);
  assert.match(run.stdout, /join: too-many-join-records\.txt: input limit exceeded\nCOUNT-LIMIT-1\n/);
  assert.match(run.stdout, /join: oversized-join-input\.bin: input limit exceeded\nINPUT-LIMIT-1\n/);
  assert.match(run.stdout, /join: output record count exceeds 100000\nPRODUCT-LIMIT-1\n/);
  assert.match(run.stdout, /join: output exceeds 33554432 bytes\nOUTPUT-LIMIT-1\n/);
  for (const marker of [
    "COMPACT-2", "COMPACT-DELIMITER-2", "LONG-OPTION-2", "DUPLICATE-FIELD-2",
    "DUPLICATE-DELIMITER-2", "MIXED-OUTER-2", "DUPLICATE-V-2", "BAD-A-2",
    "FIELD-ZERO-2", "FIELD-LEADING-ZERO-2", "FIELD-LIMIT-2", "EMPTY-DELIMITER-2",
    "UNICODE-DELIMITER-2", "MISSING-ONE-FIELD-2", "MISSING-TWO-FIELD-2", "MISSING-T-2",
    "MISSING-A-2", "MISSING-V-2", "ONE-OPERAND-2", "EXTRA-OPERAND-2", "BOTH-STDIN-2",
  ]) assert.match(run.stdout, new RegExp(`(?:^|\\n)${marker}\\n`), marker);
  assert.match(run.stdout, /\/bin\/join\nusage: join \[-1 FIELD\].*output <=32 MiB\/100000 records/);
  const unchangedAfter = createHash("sha256")
    .update(fs.readFile("/home/web/basic-left.txt"))
    .update(fs.readFile("/home/web/basic-right.txt"))
    .digest("hex");
  assert.equal(unchangedAfter, unchangedBefore);
});

test("slop: xxd renders bounded deterministic binary views atomically", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  installShell(fs);
  const encoder = new TextEncoder();
  const formatXxd = (
    input: Uint8Array,
    options: { group?: number; columns?: number; offset?: number; length?: number } = {},
  ): Uint8Array => {
    const group = options.group ?? 2;
    const columns = options.columns ?? 16;
    const offset = options.offset ?? 0;
    const end = Math.min(input.byteLength, offset + (options.length ?? input.byteLength));
    const width = 2 * columns + Math.ceil(columns / group) - 1;
    let output = "";
    for (let position = offset; position < end; position += columns) {
      const row = input.subarray(position, Math.min(end, position + columns));
      const groups: string[] = [];
      for (let index = 0; index < row.byteLength; index += group) {
        groups.push([...row.subarray(index, index + group)]
          .map((byte) => byte.toString(16).padStart(2, "0")).join(""));
      }
      const hexadecimal = groups.join(" ").padEnd(width, " ");
      const printable = [...row]
        .map((byte) => byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ".")
        .join("");
      output += `${position.toString(16).padStart(8, "0")}: ${hexadecimal}  ${printable}\n`;
    }
    return encoder.encode(output);
  };

  const canonical = new Uint8Array([0x00, 0x01, 0x1f, 0x20, 0x41, 0x42, 0x43, 0x7f, 0x80, 0xff, 0x0a]);
  const everyByte = Uint8Array.from({ length: 256 }, (_, index) => index);
  fs.writeFile("/home/web/canonical.bin", canonical);
  fs.writeFile("/home/web/every-byte.bin", everyByte);
  fs.writeFile("/home/web/empty.bin", new Uint8Array());
  fs.writeFile("/home/web/-x", canonical);
  fs.mkdirTree("/home/web/not-a-file");
  for (const length of [1, 15, 16, 17]) {
    fs.writeFile(`/home/web/length-${length}.bin`, everyByte.subarray(0, length));
  }
  const exactInput = new Uint8Array(16 * 1024 * 1024).fill(0x41);
  const oversizedInput = new Uint8Array(16 * 1024 * 1024 + 1).fill(0x41);
  const exactOutputSource = new Uint8Array(1024 * 1024).fill(0x41);
  const oversizedOutputSource = new Uint8Array(1024 * 1024 + 1).fill(0x41);
  fs.writeFile("/home/web/exact-xxd-input.bin", exactInput);
  fs.writeFile("/home/web/oversized-xxd-input.bin", oversizedInput);
  fs.writeFile("/home/web/exact-xxd-output-source.bin", exactOutputSource);
  fs.writeFile("/home/web/oversized-xxd-output-source.bin", oversizedOutputSource);

  const inputHashBefore = createHash("sha256")
    .update(canonical).update(everyByte).update(exactInput).update(oversizedInput)
    .update(exactOutputSource).update(oversizedOutputSource).digest("hex");
  const commands = [
    "xxd canonical.bin > default.out",
    "xxd -g 1 canonical.bin > group-one.out",
    "xxd -g 1 -s 3 -l 5 canonical.bin > selected.out",
    "xxd -g1 -c16 -l5 -s3 canonical.bin > attached.out",
    "xxd every-byte.bin > every-byte.out",
    "xxd empty.bin > empty.out",
    "xxd -l0 canonical.bin > zero-length.out",
    "xxd -s11 canonical.bin > at-eof.out",
    "xxd -s12 canonical.bin > after-eof.out",
    "xxd -s10 -l99 canonical.bin > truncated.out",
    "xxd < canonical.bin > implicit-stdin.out",
    "xxd - < canonical.bin > explicit-stdin.out",
    "xxd -- -x > dashed.out",
    "xxd canonical.bin > repeat-one.out",
    "xxd canonical.bin > repeat-two.out",
    "xxd canonical.bin | grep -F '00000000:' > piped.out",
    ...[1, 2, 15, 16, 17, 255, 256].map((columns) =>
      `xxd -g1 -c${columns} every-byte.bin > columns-${columns}.out`),
    ...[1, 15, 16, 17].map((length) =>
      `xxd length-${length}.bin > length-${length}.out`),
    "xxd -s16777215 -l1 exact-xxd-input.bin > exact-input.out && echo EXACT-INPUT-OK",
    "xxd -s1048575 -l1 - < exact-xxd-output-source.bin > exact-stdin.out && echo EXACT-STDIN-OK",
    "xxd -g1 -c1 exact-xxd-output-source.bin > exact-output.out && echo EXACT-OUTPUT-OK",
    "xxd -l0 oversized-xxd-input.bin > oversized-input.out || echo INPUT-LIMIT-$?",
    "xxd -l0 - < oversized-xxd-output-source.bin > redirect-over.out || echo REDIRECT-LIMIT-$?",
    "xxd -g1 -c1 oversized-xxd-output-source.bin > oversized-output.out || echo OUTPUT-LIMIT-$?",
    "xxd missing.bin > missing.out || echo MISSING-$?",
    "xxd not-a-file > directory.out || echo DIRECTORY-$?",
    "xxd -g1 -g2 missing.bin > duplicate-g.out || echo DUPLICATE-G-$?",
    "xxd -c1 -c2 missing.bin > duplicate-c.out || echo DUPLICATE-C-$?",
    "xxd -l1 -l2 missing.bin > duplicate-l.out || echo DUPLICATE-L-$?",
    "xxd -s1 -s2 missing.bin > duplicate-s.out || echo DUPLICATE-S-$?",
    "xxd -g0 canonical.bin > group-zero.out || echo GROUP-ZERO-$?",
    "xxd -g3 canonical.bin > group-three.out || echo GROUP-THREE-$?",
    "xxd -c0 canonical.bin > columns-zero.out || echo COLUMNS-ZERO-$?",
    "xxd -c257 canonical.bin > columns-limit.out || echo COLUMNS-LIMIT-$?",
    "xxd -l16777217 canonical.bin > length-limit.out || echo LENGTH-LIMIT-$?",
    "xxd -s16777217 canonical.bin > offset-limit.out || echo OFFSET-LIMIT-$?",
    "xxd -c+1 canonical.bin > plus.out || echo PLUS-$?",
    "xxd -c-1 canonical.bin > negative.out || echo NEGATIVE-$?",
    "xxd -c0x10 canonical.bin > hexadecimal.out || echo HEXADECIMAL-$?",
    "xxd -c1k canonical.bin > suffix.out || echo SUFFIX-$?",
    "xxd -c ' 1' canonical.bin > spaced.out || echo SPACED-$?",
    "xxd -c '' canonical.bin > empty-number.out || echo EMPTY-NUMBER-$?",
    "xxd -g > missing-g.out || echo MISSING-G-$?",
    "xxd -c > missing-c.out || echo MISSING-C-$?",
    "xxd -l > missing-l.out || echo MISSING-L-$?",
    "xxd -s > missing-s.out || echo MISSING-S-$?",
    "xxd -gc canonical.bin > bundled.out || echo BUNDLED-$?",
    "xxd -x canonical.bin > unknown.out || echo UNKNOWN-$?",
    "xxd --verbose canonical.bin > long-option.out || echo LONG-OPTION-$?",
    "xxd --version > version-option.out || echo VERSION-OPTION-$?",
    "xxd canonical.bin empty.bin > operands.out || echo OPERANDS-$?",
    "xxd canonical.bin -g1 > option-after.out || echo OPTION-AFTER-$?",
    "xxd -g1 missing.bin extra.bin > preflight.out || echo PREFLIGHT-$?",
    "xxd --help missing.bin > help-extra.out || echo HELP-EXTRA-$?",
    "command -v xxd",
    "xxd --help",
  ];
  const run = await runSlop(fs, commands, { quiet: true });

  assert.equal(run.exitCode, 0);
  assert.deepEqual(fs.readFile("/home/web/default.out"), formatXxd(canonical));
  assert.deepEqual(fs.readFile("/home/web/group-one.out"), formatXxd(canonical, { group: 1 }));
  assert.deepEqual(
    fs.readFile("/home/web/selected.out"),
    encoder.encode("00000003: 20 41 42 43 7f                                    ABC.\n"),
  );
  assert.deepEqual(fs.readFile("/home/web/attached.out"), fs.readFile("/home/web/selected.out"));
  assert.deepEqual(fs.readFile("/home/web/every-byte.out"), formatXxd(everyByte));
  for (const path of ["empty.out", "zero-length.out", "at-eof.out", "after-eof.out"]) {
    assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  }
  assert.deepEqual(fs.readFile("/home/web/truncated.out"), formatXxd(canonical, { offset: 10, length: 99 }));
  assert.deepEqual(fs.readFile("/home/web/implicit-stdin.out"), formatXxd(canonical));
  assert.deepEqual(fs.readFile("/home/web/explicit-stdin.out"), formatXxd(canonical));
  assert.deepEqual(fs.readFile("/home/web/dashed.out"), formatXxd(canonical));
  assert.deepEqual(fs.readFile("/home/web/repeat-one.out"), fs.readFile("/home/web/repeat-two.out"));
  assert.deepEqual(fs.readFile("/home/web/piped.out"), fs.readFile("/home/web/default.out"));
  for (const columns of [1, 2, 15, 16, 17, 255, 256]) {
    assert.deepEqual(
      fs.readFile(`/home/web/columns-${columns}.out`),
      formatXxd(everyByte, { group: 1, columns }),
      `columns ${columns}`,
    );
  }
  for (const length of [1, 15, 16, 17]) {
    assert.deepEqual(
      fs.readFile(`/home/web/length-${length}.out`),
      formatXxd(everyByte.subarray(0, length)),
      `length ${length}`,
    );
  }
  assert.deepEqual(
    fs.readFile("/home/web/exact-input.out"),
    formatXxd(exactInput, { offset: 16 * 1024 * 1024 - 1, length: 1 }),
  );
  assert.deepEqual(
    fs.readFile("/home/web/exact-stdin.out"),
    formatXxd(exactOutputSource, { offset: 1024 * 1024 - 1, length: 1 }),
  );
  assert.equal(fs.readFile("/home/web/exact-output.out").byteLength, 16 * 1024 * 1024);

  const failedOutputs = [
    "oversized-input.out", "oversized-output.out", "missing.out",
    "directory.out", "duplicate-g.out", "duplicate-c.out", "duplicate-l.out", "duplicate-s.out",
    "group-zero.out", "group-three.out", "columns-zero.out", "columns-limit.out",
    "length-limit.out", "offset-limit.out", "plus.out", "negative.out", "hexadecimal.out",
    "suffix.out", "spaced.out", "empty-number.out", "missing-g.out", "missing-c.out",
    "missing-l.out", "missing-s.out", "bundled.out", "unknown.out", "long-option.out",
    "version-option.out",
    "operands.out", "option-after.out", "preflight.out", "help-extra.out",
  ];
  for (const path of failedOutputs) {
    assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  }
  for (const marker of [
    "INPUT-LIMIT-1", "REDIRECT-LIMIT-1", "OUTPUT-LIMIT-1", "MISSING-1", "DIRECTORY-1",
    "DUPLICATE-G-2", "DUPLICATE-C-2", "DUPLICATE-L-2", "DUPLICATE-S-2",
    "GROUP-ZERO-2", "GROUP-THREE-2", "COLUMNS-ZERO-2", "COLUMNS-LIMIT-2",
    "LENGTH-LIMIT-2", "OFFSET-LIMIT-2", "PLUS-2", "NEGATIVE-2", "HEXADECIMAL-2",
    "SUFFIX-2", "SPACED-2", "EMPTY-NUMBER-2", "MISSING-G-2", "MISSING-C-2",
    "MISSING-L-2", "MISSING-S-2", "BUNDLED-2", "UNKNOWN-2", "LONG-OPTION-2",
    "VERSION-OPTION-2",
    "OPERANDS-2", "OPTION-AFTER-2", "PREFLIGHT-2", "HELP-EXTRA-2",
  ]) assert.match(run.stdout, new RegExp(`(?:^|\\n)${marker}\\n`), marker);
  assert.match(run.stdout, /EXACT-INPUT-OK\nEXACT-STDIN-OK\nEXACT-OUTPUT-OK\n/);
  assert.match(run.stdout, /xxd: oversized-xxd-input\.bin: input limit exceeded\nINPUT-LIMIT-1\n/);
  assert.match(run.stdout, /slop: oversized-xxd-output-source\.bin: input exceeds 1048576 bytes\nREDIRECT-LIMIT-1\n/);
  assert.match(run.stdout, /xxd: output exceeds 16777216 bytes\nOUTPUT-LIMIT-1\n/);
  assert.match(run.stdout, /\/bin\/xxd\nusage: xxd \[-g 1\|2\].*input <=16 MiB; output <=16 MiB/);
  const inputHashAfter = createHash("sha256")
    .update(fs.readFile("/home/web/canonical.bin"))
    .update(fs.readFile("/home/web/every-byte.bin"))
    .update(fs.readFile("/home/web/exact-xxd-input.bin"))
    .update(fs.readFile("/home/web/oversized-xxd-input.bin"))
    .update(fs.readFile("/home/web/exact-xxd-output-source.bin"))
    .update(fs.readFile("/home/web/oversized-xxd-output-source.bin"))
    .digest("hex");
  assert.equal(inputHashAfter, inputHashBefore);
  assert.equal(fs.exists("/home/web/redirect-over.out"), false);
});

test("slop: base64 transports bounded binary data with strict atomic decode", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  installShell(fs);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const binary = new Uint8Array([
    0x00, 0x41, 0xff, 0x0a, 0x7f, 0x80, 0x20, 0x42, 0x00, 0xfe, 0x43,
  ]);
  fs.writeFile("/home/web/binary.bin", binary);
  fs.writeFile("/home/web/empty.bin", new Uint8Array());
  fs.writeFile("/home/web/-", "dash-file");
  fs.writeFile("/home/web/-dash", "dash-leading");
  fs.writeFile("/home/web/stdin-source.bin", binary);
  fs.writeFile("/home/web/whitespace.b64", " Q\tU\r\nJ D \n");
  const vectors = new Map([
    ["vector-empty", ""], ["vector-f", "f"], ["vector-fo", "fo"],
    ["vector-foo", "foo"], ["vector-foob", "foob"],
    ["vector-fooba", "fooba"], ["vector-foobar", "foobar"],
  ]);
  for (const [name, value] of vectors) fs.writeFile(`/home/web/${name}.bin`, value);

  const malformed = new Map<string, string | Uint8Array>([
    ["tail-one", "A"], ["tail-three", "AAA"], ["garbage", "QQ$="],
    ["excess-padding", "A==="], ["interior-padding", "AA=A"],
    ["trailing-padding", "AAAA="], ["two-quanta-padding", "AA==AA=="],
    ["only-padding", "===="], ["pad-bits-two", "AB=="],
    ["pad-bits-one", "AAB="], ["url-alphabet", "_w=="],
    ["nul", new Uint8Array([0x51, 0x51, 0x00, 0x3d])],
  ]);
  for (const [name, value] of malformed) fs.writeFile(`/home/web/bad-${name}.b64`, value);

  const exactInput = new Uint8Array(16 * 1024 * 1024);
  const oversizedInput = new Uint8Array(16 * 1024 * 1024 + 1);
  const exactDecodeInput = new Uint8Array(16 * 1024 * 1024).fill(0x41);
  const redirectInput = new Uint8Array(1024 * 1024 + 1).fill(0x41);
  fs.writeFile("/home/web/exact-base64-input.bin", exactInput);
  fs.writeFile("/home/web/oversized-base64-input.bin", oversizedInput);
  fs.writeFile("/home/web/exact-base64-decode.b64", exactDecodeInput);
  fs.writeFile("/home/web/redirect-base64-input.bin", redirectInput);

  const pathParts: string[] = [];
  let pathBytes = 4096 - "/home/web/".length;
  while (pathBytes > 100) { pathParts.push("p".repeat(99)); pathBytes -= 100; }
  pathParts.push("q".repeat(pathBytes));
  const exactPath = `/home/web/${pathParts.join("/")}`;
  assert.equal(exactPath.length, 4096);
  fs.mkdirTree(`/home/web/${pathParts.slice(0, -1).join("/")}`);
  fs.writeFile(exactPath, "x");
  const oversizedPath = `${exactPath}x`;
  const hostileOption = `--SECRET_HOSTILE_OPTION_${"Q".repeat(4080)}`;

  const inputHashBefore = createHash("sha256")
    .update(binary).update(exactInput).update(oversizedInput)
    .update(exactDecodeInput).update(redirectInput).digest("hex");
  const commands = [
    "base64 binary.bin > binary.b64",
    "base64 -d binary.b64 > roundtrip.bin",
    "base64 --decode binary.b64 > roundtrip-long.bin",
    "base64 -d -d binary.b64 > roundtrip-repeat.bin",
    "printf ABC | base64 > piped-encode.b64",
    "printf QUJD | base64 -d > piped-decode.bin",
    "base64 < redirect-base64-input.bin > redirected.b64 && echo REDIRECT-OK",
    "base64 -- - < stdin-source.bin > delimiter-stdin.b64",
    "base64 -- ./- > dash-file.b64",
    "base64 -- -dash > dash-leading.b64",
    "base64 empty.bin > empty-encode.b64",
    "base64 -d empty.bin > empty-decode.bin",
    "base64 -- > empty-delimiter.b64",
    "base64 -d whitespace.b64 > whitespace.bin",
    ...[...vectors.keys()].flatMap((name) => [
      `base64 ${name}.bin > ${name}.b64`,
      `base64 -d ${name}.b64 > ${name}.roundtrip`,
    ]),
    "base64 exact-base64-input.bin > exact-encode.b64 && echo EXACT-ENCODE-OK",
    "base64 -d exact-base64-decode.b64 > exact-decode.bin && echo EXACT-DECODE-OK",
    `base64 '${exactPath}' > exact-path.b64 && echo EXACT-PATH-OK`,
    "base64 oversized-base64-input.bin > oversized-input.out 2> oversized-input.err; echo INPUT-LIMIT-$?",
    "base64 < oversized-base64-input.bin > oversized-redirect.out 2> oversized-redirect.err; echo REDIRECT-LIMIT-$?",
    `base64 '${oversizedPath}' > oversized-path.out 2> oversized-path.err; echo PATH-LIMIT-$?`,
    ...[...malformed.keys()].map((name) =>
      `base64 -d bad-${name}.b64 > bad-${name}.out 2> bad-${name}.err; echo BAD-${name}-$?`),
    "base64 missing.bin > missing.out 2> missing.err; echo MISSING-$?",
    "base64 /home/web > directory.out 2> directory.err; echo DIRECTORY-$?",
    "base64 '' > empty-path.out 2> empty-path.err; echo EMPTY-PATH-$?",
    "base64 binary.bin empty.bin > operands.out 2> operands.err; echo OPERANDS-$?",
    "base64 binary.bin -d > late-option.out 2> late-option.err; echo LATE-OPTION-$?",
    "base64 -w0 binary.bin > wrap.out 2> wrap.err; echo WRAP-$?",
    "base64 --ignore-garbage binary.b64 > ignore.out 2> ignore.err; echo IGNORE-$?",
    "base64 -di binary.b64 > bundled.out 2> bundled.err; echo BUNDLED-$?",
    `base64 '${hostileOption}' > hostile-option.out 2> hostile-option.err; echo HOSTILE-OPTION-$?`,
    "base64 --version > version.out 2> version.err; echo VERSION-$?",
    "base64 --help binary.bin > help-extra.out 2> help-extra.err; echo HELP-EXTRA-$?",
    "base64 -h -d > help-mixed.out 2> help-mixed.err; echo HELP-MIXED-$?",
    "command -v base64",
    "base64 -h",
    "base64 --help",
  ];
  const run = await runSlop(fs, commands, { quiet: true });

  assert.equal(run.exitCode, 0);
  const encodedBinary = encoder.encode(Buffer.from(binary).toString("base64"));
  assert.deepEqual(fs.readFile("/home/web/binary.b64"), encodedBinary);
  for (const path of ["roundtrip.bin", "roundtrip-long.bin", "roundtrip-repeat.bin"]) {
    assert.deepEqual(fs.readFile(`/home/web/${path}`), binary, path);
  }
  assert.equal(decoder.decode(fs.readFile("/home/web/piped-encode.b64")), "QUJD");
  assert.equal(decoder.decode(fs.readFile("/home/web/piped-decode.bin")), "ABC");
  assert.deepEqual(
    fs.readFile("/home/web/redirected.b64"),
    encoder.encode(Buffer.from(redirectInput).toString("base64")),
  );
  assert.deepEqual(fs.readFile("/home/web/delimiter-stdin.b64"), encodedBinary);
  assert.equal(decoder.decode(fs.readFile("/home/web/dash-file.b64")), "ZGFzaC1maWxl");
  assert.equal(decoder.decode(fs.readFile("/home/web/dash-leading.b64")), "ZGFzaC1sZWFkaW5n");
  for (const path of ["empty-encode.b64", "empty-decode.bin", "empty-delimiter.b64"]) {
    assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  }
  assert.equal(decoder.decode(fs.readFile("/home/web/whitespace.bin")), "ABC");
  const canonicalVectors = new Map([
    ["vector-empty", ""], ["vector-f", "Zg=="], ["vector-fo", "Zm8="],
    ["vector-foo", "Zm9v"], ["vector-foob", "Zm9vYg=="],
    ["vector-fooba", "Zm9vYmE="], ["vector-foobar", "Zm9vYmFy"],
  ]);
  for (const [name, encoded] of canonicalVectors) {
    assert.equal(decoder.decode(fs.readFile(`/home/web/${name}.b64`)), encoded, name);
    assert.equal(decoder.decode(fs.readFile(`/home/web/${name}.roundtrip`)), vectors.get(name), name);
  }
  const exactEncoded = fs.readFile("/home/web/exact-encode.b64");
  assert.equal(exactEncoded.byteLength, 22_369_624);
  assert.equal(decoder.decode(exactEncoded.subarray(0, 16)), "AAAAAAAAAAAAAAAA");
  assert.equal(decoder.decode(exactEncoded.subarray(-16)), "AAAAAAAAAAAAAA==");
  const exactDecoded = fs.readFile("/home/web/exact-decode.bin");
  assert.equal(exactDecoded.byteLength, 12_582_912);
  assert.ok(exactDecoded.every((byte) => byte === 0));
  assert.equal(decoder.decode(fs.readFile("/home/web/exact-path.b64")), "eA==");

  for (const name of malformed.keys()) {
    assert.equal(fs.readFile(`/home/web/bad-${name}.out`).byteLength, 0, name);
    assert.equal(decoder.decode(fs.readFile(`/home/web/bad-${name}.err`)), "base64: malformed input\n", name);
    assert.match(run.stdout, new RegExp(`(?:^|\\n)BAD-${name}-3\\n`), name);
  }
  for (const path of [
    "oversized-input.out", "oversized-path.out", "missing.out", "directory.out",
    "empty-path.out", "operands.out", "late-option.out", "wrap.out", "ignore.out",
    "bundled.out", "hostile-option.out", "version.out", "help-extra.out", "help-mixed.out",
  ]) assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  assert.equal(fs.exists("/home/web/oversized-redirect.out"), false);
  assert.equal(fs.exists("/home/web/oversized-redirect.err"), false);
  for (const marker of [
    "INPUT-LIMIT-4", "REDIRECT-LIMIT-4", "PATH-LIMIT-4", "MISSING-1", "DIRECTORY-1",
    "EMPTY-PATH-2", "OPERANDS-2", "LATE-OPTION-2", "WRAP-2", "IGNORE-2",
    "BUNDLED-2", "HOSTILE-OPTION-2", "VERSION-2", "HELP-EXTRA-2", "HELP-MIXED-2",
  ]) assert.match(run.stdout, new RegExp(`(?:^|\\n)${marker}\\n`), marker);
  assert.match(run.stdout, /REDIRECT-OK\nEXACT-ENCODE-OK\nEXACT-DECODE-OK\nEXACT-PATH-OK\n/);
  assert.equal(decoder.decode(fs.readFile("/home/web/oversized-input.err")),
    "base64: oversized-base64-input.bin: input exceeds 16777216 bytes\n");
  assert.match(run.stdout,
    /slop: oversized-base64-input\.bin: input exceeds 16777216 bytes\nREDIRECT-LIMIT-4\n/);
  assert.equal(decoder.decode(fs.readFile("/home/web/oversized-path.err")),
    "base64: input path exceeds 4096 bytes\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/hostile-option.err")),
    "base64: unsupported option\n");
  assert.match(run.stdout,
    /\/bin\/base64\nusage: base64 \[-d\|--decode\].*input <=16777216 bytes; encode <=22369624 bytes; decode <=12582912 bytes/);
  const inputHashAfter = createHash("sha256")
    .update(fs.readFile("/home/web/binary.bin"))
    .update(fs.readFile("/home/web/exact-base64-input.bin"))
    .update(fs.readFile("/home/web/oversized-base64-input.bin"))
    .update(fs.readFile("/home/web/exact-base64-decode.b64"))
    .update(fs.readFile("/home/web/redirect-base64-input.bin"))
    .digest("hex");
  assert.equal(inputHashAfter, inputHashBefore);

  const faultyFs = new LateReadFailureFs();
  installShell(faultyFs);
  faultyFs.writeFile("/home/web/late-read.bin", new Uint8Array(128 * 1024).fill(0x41));
  const failedRead = await runSlop(faultyFs, [
    "base64 late-read.bin > late-read.out 2> late-read.err; echo LATE-READ-$?",
  ], { quiet: true });
  assert.match(failedRead.stdout, /LATE-READ-1\n/);
  assert.equal(faultyFs.readFile("/home/web/late-read.out").byteLength, 0);
  assert.equal(decoder.decode(faultyFs.readFile("/home/web/late-read.err")),
    "base64: late-read.bin: cannot read\n");
});

test("slop: strings extracts bounded maximal ASCII runs atomically", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  installShell(fs);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const joinBytes = (...chunks: Array<string | Uint8Array>): Uint8Array => {
    const encoded = chunks.map((chunk) => typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    const output = new Uint8Array(encoded.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of encoded) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  };

  const sample = joinBytes(
    "ABC", new Uint8Array([0]), "ABCD\nABCDE\tTAB", new Uint8Array([9]),
    "RUN", new Uint8Array([0xff]), "A B C D", new Uint8Array([0x7f]),
    "~tilde~", new Uint8Array([0x80]), "EOF!",
  );
  const sampleDefault = encoder.encode("ABCD\nABCDE\nA B C D\n~tilde~\nEOF!\n");
  fs.writeFile("/home/web/strings-sample.bin", sample);
  fs.writeFile("/home/web/strings-empty.bin", new Uint8Array());
  fs.writeFile("/home/web/strings-short-left.bin", "ABC");
  fs.writeFile("/home/web/strings-short-right.bin", "D");
  fs.writeFile("/home/web/-strings-dash", "one\0two2\0hostile");
  fs.writeFile("/home/web/strings space.bin", "space run");
  fs.writeFile("/home/web/strings\nline.bin", "line\0DATA");
  fs.writeFile("/home/web/strings-all-bytes.bin", Uint8Array.from({ length: 256 }, (_, index) => index));
  fs.writeFile("/home/web/strings-min-exact.bin", new Uint8Array(65_536).fill(0x4d));
  fs.writeFile("/home/web/strings-min-short.bin", new Uint8Array(65_535).fill(0x4d));
  fs.mkdirTree("/home/web/strings-directory");
  fs.symlink("strings-sample.bin", "/home/web/strings-file-link");
  fs.symlink("strings-directory", "/home/web/strings-directory-link");
  fs.symlink("strings-missing-target", "/home/web/strings-broken-link");

  const exactInput = new Uint8Array(16 * 1024 * 1024);
  const oversizedInput = new Uint8Array(16 * 1024 * 1024 + 1);
  const exactOutputInput = new Uint8Array(16 * 1024 * 1024 - 1).fill(0x41);
  const oversizedOutputInput = new Uint8Array(16 * 1024 * 1024).fill(0x42);
  const exactPipeline = new Uint8Array(1024 * 1024);
  const oversizedPipeline = new Uint8Array(1024 * 1024 + 1);
  fs.writeFile("/home/web/strings-exact-input.bin", exactInput);
  fs.writeFile("/home/web/strings-oversized-input.bin", oversizedInput);
  fs.writeFile("/home/web/strings-exact-output-input.bin", exactOutputInput);
  fs.writeFile("/home/web/strings-oversized-output-input.bin", oversizedOutputInput);
  fs.writeFile("/home/web/strings-exact-pipeline.bin", exactPipeline);
  fs.writeFile("/home/web/strings-oversized-pipeline.bin", oversizedPipeline);
  fs.writeFile("/home/web/strings-one-byte.bin", "x");

  const pathParts: string[] = [];
  let pathBytes = 4096 - "/home/web/".length;
  while (pathBytes > 100) { pathParts.push("s".repeat(99)); pathBytes -= 100; }
  pathParts.push("t".repeat(pathBytes));
  const exactPath = `/home/web/${pathParts.join("/")}`;
  assert.equal(exactPath.length, 4096);
  fs.mkdirTree(`/home/web/${pathParts.slice(0, -1).join("/")}`);
  fs.writeFile(exactPath, "PATH");
  const oversizedPath = `${exactPath}x`;

  const inputHashBefore = createHash("sha256")
    .update(sample).update(exactInput).update(oversizedInput)
    .update(exactOutputInput).update(oversizedOutputInput)
    .update(exactPipeline).update(oversizedPipeline).digest("hex");
  const hundredInputs = Array(100).fill("strings-empty.bin").join(" ");
  const hundredOneInputs = `${hundredInputs} strings-empty.bin`;
  const commands = [
    "strings strings-sample.bin > strings-default.out",
    "strings -n 1 strings-sample.bin > strings-min-one.out",
    "strings -n 5 strings-sample.bin > strings-min-five.out",
    "strings -n 00004 strings-sample.bin > strings-leading-zero.out",
    "strings strings-all-bytes.bin > strings-all-bytes.out",
    "strings strings-empty.bin > strings-empty.out",
    "strings strings-short-left.bin strings-short-right.bin > strings-boundary.out",
    "strings strings-sample.bin strings-sample.bin > strings-duplicate.out",
    "strings -- -strings-dash 'strings space.bin' > strings-multi.out",
    "STRINGS_NL=$(printf 'strings\\nline.bin')",
    "strings \"$STRINGS_NL\" > strings-newline-name.out",
    "strings strings-file-link > strings-link.out",
    "printf WXYZ | strings > strings-implicit-stdin.out",
    "printf WXYZ | strings - > strings-explicit-stdin.out",
    "printf WXYZ | strings strings-sample.bin - > strings-mixed-stdin.out",
    "printf WXYZ | strings - strings-sample.bin - > strings-reused-stdin.out 2> strings-reused-stdin.err; echo STDIN-REUSED-$?",
    "strings -n 65536 strings-min-exact.bin > strings-min-exact.out",
    "strings -n 65536 strings-min-short.bin > strings-min-short.out",
    "strings strings-exact-input.bin > strings-exact-input.out && echo EXACT-INPUT-OK",
    "strings < strings-exact-input.bin > strings-exact-stdin.out && echo EXACT-STDIN-OK",
    "strings strings-oversized-input.bin > strings-oversized-input.out 2> strings-oversized-input.err; echo INPUT-LIMIT-$?",
    "strings < strings-oversized-input.bin > strings-oversized-stdin.out 2> strings-oversized-stdin.err; echo STDIN-LIMIT-$?",
    "strings strings-exact-input.bin strings-exact-input.bin strings-exact-input.bin strings-exact-input.bin > strings-aggregate-exact.out && echo AGGREGATE-EXACT-OK",
    "strings strings-exact-input.bin strings-exact-input.bin strings-exact-input.bin strings-exact-input.bin strings-one-byte.bin > strings-aggregate-over.out 2> strings-aggregate-over.err; echo AGGREGATE-LIMIT-$?",
    "strings strings-exact-output-input.bin > strings-exact-output.out && echo EXACT-OUTPUT-OK",
    "strings strings-oversized-output-input.bin > strings-oversized-output.out 2> strings-oversized-output.err; echo OUTPUT-LIMIT-$?",
    "cat strings-exact-pipeline.bin | strings > strings-pipeline-exact.out && echo PIPELINE-EXACT-OK",
    "cat strings-oversized-pipeline.bin | strings > strings-pipeline-over.out || echo PIPELINE-LIMIT-$?",
    `strings '${exactPath}' > strings-exact-path.out && echo EXACT-PATH-OK`,
    `strings '${oversizedPath}' > strings-oversized-path.out 2> strings-oversized-path.err; echo PATH-LIMIT-$?`,
    `strings ${hundredInputs} > strings-hundred.out && echo HUNDRED-OK`,
    `strings ${hundredOneInputs} > strings-hundred-one.out 2> strings-hundred-one.err; echo OPERAND-LIMIT-$?`,
    "strings missing.bin > strings-missing.out 2> strings-missing.err; echo MISSING-$?",
    "strings strings-directory > strings-directory.out 2> strings-directory.err; echo DIRECTORY-$?",
    "strings strings-directory-link > strings-directory-link.out 2> strings-directory-link.err; echo DIRECTORY-LINK-$?",
    "strings strings-broken-link > strings-broken-link.out 2> strings-broken-link.err; echo BROKEN-LINK-$?",
    "strings '' > strings-empty-path.out 2> strings-empty-path.err; echo EMPTY-PATH-$?",
    "strings -n 0 > strings-min-zero.out 2> strings-min-zero.err; echo MIN-ZERO-$?",
    "strings -n 65537 > strings-min-over.out 2> strings-min-over.err; echo MIN-OVER-$?",
    "strings -n +4 > strings-min-plus.out 2> strings-min-plus.err; echo MIN-PLUS-$?",
    "strings -n ' 4' > strings-min-space.out 2> strings-min-space.err; echo MIN-SPACE-$?",
    "strings -n 4k > strings-min-suffix.out 2> strings-min-suffix.err; echo MIN-SUFFIX-$?",
    "strings -n 0x4 > strings-min-hex.out 2> strings-min-hex.err; echo MIN-HEX-$?",
    "strings -n '' > strings-min-empty.out 2> strings-min-empty.err; echo MIN-EMPTY-$?",
    "strings -n > strings-min-missing.out 2> strings-min-missing.err; echo MIN-MISSING-$?",
    "strings -n 4 -n 5 > strings-min-repeat.out 2> strings-min-repeat.err; echo MIN-REPEAT-$?",
    "strings -n4 strings-sample.bin > strings-attached.out 2> strings-attached.err; echo ATTACHED-$?",
    "strings -a strings-sample.bin > strings-unknown.out 2> strings-unknown.err; echo UNKNOWN-$?",
    "strings --version > strings-version.out 2> strings-version.err; echo VERSION-$?",
    "strings --help strings-sample.bin > strings-help-extra.out 2> strings-help-extra.err; echo HELP-EXTRA-$?",
    "strings -strings-dash > strings-undelimited-dash.out 2> strings-undelimited-dash.err; echo UNDELIMITED-DASH-$?",
    "command -v strings",
    "strings --help",
  ];
  const run = await runSlop(fs, commands, { quiet: true });

  assert.equal(run.exitCode, 0);
  assert.deepEqual(fs.readFile("/home/web/strings-default.out"), sampleDefault);
  assert.equal(decoder.decode(fs.readFile("/home/web/strings-min-one.out")),
    "ABC\nABCD\nABCDE\nTAB\nRUN\nA B C D\n~tilde~\nEOF!\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/strings-min-five.out")),
    "ABCDE\nA B C D\n~tilde~\n");
  assert.deepEqual(fs.readFile("/home/web/strings-leading-zero.out"), sampleDefault);
  assert.deepEqual(
    fs.readFile("/home/web/strings-all-bytes.out"),
    Uint8Array.from([...Array.from({ length: 95 }, (_, index) => index + 0x20), 0x0a]),
  );
  for (const path of ["strings-empty.out", "strings-boundary.out", "strings-min-short.out"]) {
    assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  }
  assert.deepEqual(fs.readFile("/home/web/strings-duplicate.out"), joinBytes(sampleDefault, sampleDefault));
  assert.equal(decoder.decode(fs.readFile("/home/web/strings-multi.out")),
    "two2\nhostile\nspace run\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/strings-newline-name.out")), "line\nDATA\n", run.stdout);
  assert.deepEqual(fs.readFile("/home/web/strings-link.out"), sampleDefault);
  assert.equal(decoder.decode(fs.readFile("/home/web/strings-implicit-stdin.out")), "WXYZ\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/strings-explicit-stdin.out")), "WXYZ\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/strings-mixed-stdin.out")),
    `${decoder.decode(sampleDefault)}WXYZ\n`);
  assert.equal(fs.readFile("/home/web/strings-reused-stdin.out").byteLength, 0);
  assert.equal(decoder.decode(fs.readFile("/home/web/strings-reused-stdin.err")),
    "strings: standard input may be used only once\n");
  const minExact = fs.readFile("/home/web/strings-min-exact.out");
  assert.equal(minExact.byteLength, 65_537);
  assert.equal(minExact[0], 0x4d); assert.equal(minExact.at(-1), 0x0a);
  for (const path of [
    "strings-exact-input.out", "strings-exact-stdin.out", "strings-aggregate-exact.out",
    "strings-pipeline-exact.out", "strings-hundred.out",
  ]) assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  const exactOutput = fs.readFile("/home/web/strings-exact-output.out");
  assert.equal(exactOutput.byteLength, 16 * 1024 * 1024);
  assert.equal(exactOutput[0], 0x41); assert.equal(exactOutput.at(-2), 0x41);
  assert.equal(exactOutput.at(-1), 0x0a);
  assert.equal(decoder.decode(fs.readFile("/home/web/strings-exact-path.out")), "PATH\n");

  const failedOutputs = [
    "strings-oversized-input.out", "strings-aggregate-over.out", "strings-oversized-output.out",
    "strings-oversized-path.out", "strings-hundred-one.out", "strings-missing.out",
    "strings-directory.out", "strings-directory-link.out", "strings-broken-link.out",
    "strings-empty-path.out", "strings-min-zero.out", "strings-min-over.out",
    "strings-min-plus.out", "strings-min-space.out", "strings-min-suffix.out",
    "strings-min-hex.out", "strings-min-empty.out", "strings-min-missing.out",
    "strings-min-repeat.out", "strings-attached.out", "strings-unknown.out",
    "strings-version.out", "strings-help-extra.out", "strings-undelimited-dash.out",
  ];
  for (const path of failedOutputs) assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  assert.equal(fs.exists("/home/web/strings-oversized-stdin.out"), false);
  assert.equal(fs.exists("/home/web/strings-oversized-stdin.err"), false);
  assert.equal(fs.exists("/home/web/strings-pipeline-over.out"), false);
  for (const marker of [
    "STDIN-REUSED-1", "INPUT-LIMIT-1", "STDIN-LIMIT-1", "AGGREGATE-LIMIT-1",
    "OUTPUT-LIMIT-1", "PIPELINE-LIMIT-23", "PATH-LIMIT-2", "OPERAND-LIMIT-2",
    "MISSING-1", "DIRECTORY-1", "DIRECTORY-LINK-1", "BROKEN-LINK-1", "EMPTY-PATH-2",
    "MIN-ZERO-2", "MIN-OVER-2", "MIN-PLUS-2", "MIN-SPACE-2", "MIN-SUFFIX-2",
    "MIN-HEX-2", "MIN-EMPTY-2", "MIN-MISSING-2", "MIN-REPEAT-2", "ATTACHED-2",
    "UNKNOWN-2", "VERSION-2", "HELP-EXTRA-2", "UNDELIMITED-DASH-2",
  ]) assert.match(run.stdout, new RegExp(`(?:^|\\n)${marker}\\n`), marker);
  for (const marker of [
    "EXACT-INPUT-OK", "EXACT-STDIN-OK", "AGGREGATE-EXACT-OK", "EXACT-OUTPUT-OK",
    "PIPELINE-EXACT-OK", "EXACT-PATH-OK", "HUNDRED-OK",
  ]) assert.match(run.stdout, new RegExp(`(?:^|\\n)${marker}\\n`), marker);
  assert.equal(decoder.decode(fs.readFile("/home/web/strings-oversized-input.err")),
    "strings: strings-oversized-input.bin: input limit exceeded\n");
  assert.match(run.stdout,
    /slop: strings-oversized-input\.bin: input exceeds 16777216 bytes\nSTDIN-LIMIT-1\n/);
  assert.equal(decoder.decode(fs.readFile("/home/web/strings-aggregate-over.err")),
    "strings: aggregate explicit input limit exceeded\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/strings-oversized-output.err")),
    "strings: output limit exceeded\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/strings-oversized-path.err")),
    "strings: input path exceeds 4096 bytes\n");
  assert.match(run.stdout,
    /\/bin\/strings\nusage: strings \[-n MIN\].*MIN 1\.\.65536; 100 files; 16 MiB\/file\+stdin\+output; 64 MiB files total/);
  const inputHashAfter = createHash("sha256")
    .update(fs.readFile("/home/web/strings-sample.bin"))
    .update(fs.readFile("/home/web/strings-exact-input.bin"))
    .update(fs.readFile("/home/web/strings-oversized-input.bin"))
    .update(fs.readFile("/home/web/strings-exact-output-input.bin"))
    .update(fs.readFile("/home/web/strings-oversized-output-input.bin"))
    .update(fs.readFile("/home/web/strings-exact-pipeline.bin"))
    .update(fs.readFile("/home/web/strings-oversized-pipeline.bin"))
    .digest("hex");
  assert.equal(inputHashAfter, inputHashBefore);

  const faultyFs = new LateReadFailureFs();
  installShell(faultyFs);
  faultyFs.writeFile("/home/web/late-read.bin", joinBytes("VISIBLE", new Uint8Array(128 * 1024), "END!"));
  const failedRead = await runSlop(faultyFs, [
    "strings late-read.bin > late-read.out 2> late-read.err; echo LATE-READ-$?",
  ], { quiet: true });
  assert.match(failedRead.stdout, /LATE-READ-1\n/);
  assert.equal(faultyFs.readFile("/home/web/late-read.out").byteLength, 0);
  assert.equal(decoder.decode(faultyFs.readFile("/home/web/late-read.err")),
    "strings: late-read.bin: cannot read\n");
});

test("slop: truncate performs one bounded in-place resize without following the final symlink", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  const decoder = new TextDecoder();
  const pattern = Uint8Array.from({ length: 1024 }, (_, index) => index & 0xff);

  fs.writeFile("/home/web/truncate-grow.bin", pattern);
  fs.writeFile("/home/web/truncate-shrink.bin", pattern);
  fs.writeFile("/home/web/truncate-same.bin", pattern);
  fs.writeFile("/home/web/truncate-zero.bin", "remove me");
  fs.writeFile("/home/web/truncate-leading.bin", "abcdef");
  fs.writeFile("/home/web/truncate-hard-a.bin", "hard link data");
  fs.link("/home/web/truncate-hard-a.bin", "/home/web/truncate-hard-b.bin");
  const hardInode = fs.stat("/home/web/truncate-hard-a.bin", true).ino;
  fs.writeFile("/home/web/truncate-target.bin", "target must survive");
  fs.symlink("truncate-target.bin", "/home/web/truncate-file-link.bin");
  fs.symlink("truncate-missing-target.bin", "/home/web/truncate-broken-link.bin");
  fs.mkdirTree("/home/web/truncate-directory");
  fs.writeFile("/home/web/-truncate-dash.bin", "dash");
  fs.writeFile("/home/web/truncate space.bin", "space");
  fs.writeFile("/home/web/truncate\nline.bin", "newline");
  fs.writeFile("/home/web/truncate*.bin", "glob");
  fs.mkdirTree("/home/web/truncate-real-parent");
  fs.symlink("truncate-real-parent", "/home/web/truncate-parent-link");

  const exactPath = "x".repeat(4096);
  const oversizedPath = "y".repeat(4097);
  const exactComponents = Array(127).fill("c");
  fs.mkdirTree(`/home/web/${exactComponents.join("/")}`);
  const exactComponentPath = `${exactComponents.join("/")}/file.bin`;
  const oversizedComponentPath = `${Array(128).fill("d").join("/")}/file.bin`;
  fs.mkdirTree("/home/web/truncate-link-target");
  for (let index = 0; index < 40; index++) {
    const target = index === 39 ? "truncate-link-target" : `truncate-link-${index + 1}`;
    fs.symlink(target, `/home/web/truncate-link-${index}`);
  }
  for (let index = 0; index < 41; index++) {
    const target = index === 40 ? "truncate-link-target" : `truncate-over-link-${index + 1}`;
    fs.symlink(target, `/home/web/truncate-over-link-${index}`);
  }

  const accepted = await runSlop(fs, [
    "truncate -s 1030 truncate-grow.bin",
    "truncate -s 17 truncate-shrink.bin",
    "truncate -s 1024 truncate-same.bin",
    "truncate -s 0 truncate-zero.bin",
    "truncate -s 7 truncate-created.bin",
    "truncate -s 0 truncate-created-zero.bin",
    "truncate -s 00000000000000000003 truncate-leading.bin",
    "truncate -s 4 truncate-hard-a.bin",
    "truncate -s 2 -- -truncate-dash.bin",
    "truncate -s 1 'truncate space.bin'",
    "TRUNCATE_NL=$(printf 'truncate\\nline.bin')",
    "truncate -s 5 \"$TRUNCATE_NL\"",
    "truncate -s 2 'truncate*.bin'",
    "truncate -s 6 truncate-parent-link/created.bin",
    `truncate -s 1 '${exactPath}'`,
    `truncate -s 2 '${exactComponentPath}'`,
    "truncate -s 3 truncate-link-0/created.bin",
    "truncate -s 67108864 truncate-max.bin",
  ], { quiet: true });
  assert.equal(accepted.exitCode, 0, accepted.stdout);
  assert.equal(accepted.stdout, "");

  const grown = fs.readFile("/home/web/truncate-grow.bin");
  assert.deepEqual(grown.slice(0, pattern.byteLength), pattern);
  assert.deepEqual(grown.slice(pattern.byteLength), new Uint8Array(6));
  assert.deepEqual(fs.readFile("/home/web/truncate-shrink.bin"), pattern.slice(0, 17));
  assert.deepEqual(fs.readFile("/home/web/truncate-same.bin"), pattern);
  assert.equal(fs.readFile("/home/web/truncate-zero.bin").byteLength, 0);
  assert.deepEqual(fs.readFile("/home/web/truncate-created.bin"), new Uint8Array(7));
  assert.equal(fs.readFile("/home/web/truncate-created-zero.bin").byteLength, 0);
  assert.equal(decoder.decode(fs.readFile("/home/web/truncate-leading.bin")), "abc");
  assert.equal(decoder.decode(fs.readFile("/home/web/truncate-hard-b.bin")), "hard");
  assert.equal(fs.stat("/home/web/truncate-hard-a.bin", true).ino, hardInode);
  assert.equal(fs.stat("/home/web/truncate-hard-b.bin", true).ino, hardInode);
  assert.equal(decoder.decode(fs.readFile("/home/web/-truncate-dash.bin")), "da");
  assert.equal(decoder.decode(fs.readFile("/home/web/truncate space.bin")), "s");
  assert.equal(decoder.decode(fs.readFile("/home/web/truncate\nline.bin")), "newli");
  assert.equal(decoder.decode(fs.readFile("/home/web/truncate*.bin")), "gl");
  assert.deepEqual(fs.readFile("/home/web/truncate-real-parent/created.bin"), new Uint8Array(6));
  assert.deepEqual(fs.readFile(`/home/web/${exactPath}`), new Uint8Array(1));
  assert.deepEqual(fs.readFile(`/home/web/${exactComponentPath}`), new Uint8Array(2));
  assert.deepEqual(fs.readFile("/home/web/truncate-link-target/created.bin"), new Uint8Array(3));
  assert.equal(fs.stat("/home/web/truncate-max.bin", true).size, 67_108_864n);
  fs.truncate("/home/web/truncate-max.bin", 0n);

  const beforeRejected = createHash("sha256")
    .update(fs.readFile("/home/web/truncate-target.bin"))
    .update(fs.readFile("/home/web/truncate-hard-a.bin"))
    .digest("hex");
  const rejected = await runSlop(fs, [
    "truncate 2> truncate-missing-option.err; echo MISSING-OPTION-$?",
    "truncate -s 2> truncate-missing-size.err; echo MISSING-SIZE-$?",
    "truncate -s 1 2> truncate-missing-file.err; echo MISSING-FILE-$?",
    "truncate -s 1 a b 2> truncate-extra-file.err; echo EXTRA-FILE-$?",
    "truncate -s 1 -- 2> truncate-delimiter-missing.err; echo DELIMITER-MISSING-$?",
    "truncate -s1 truncate-grow.bin 2> truncate-attached.err; echo ATTACHED-$?",
    "truncate --size 1 truncate-grow.bin 2> truncate-long.err; echo LONG-$?",
    "truncate -s 1 -truncate-dash.bin 2> truncate-undelimited.err; echo UNDELIMITED-$?",
    "truncate --version 2> truncate-version.err; echo VERSION-$?",
    "truncate --help truncate-grow.bin 2> truncate-help-extra.err; echo HELP-EXTRA-$?",
    "truncate -s '' truncate-grow.bin 2> truncate-size-empty.err; echo SIZE-EMPTY-$?",
    "truncate -s +1 truncate-grow.bin 2> truncate-size-plus.err; echo SIZE-PLUS-$?",
    "truncate -s -1 truncate-grow.bin 2> truncate-size-minus.err; echo SIZE-MINUS-$?",
    "truncate -s ' 1' truncate-grow.bin 2> truncate-size-space.err; echo SIZE-SPACE-$?",
    "truncate -s 1k truncate-grow.bin 2> truncate-size-suffix.err; echo SIZE-SUFFIX-$?",
    "truncate -s 0x1 truncate-grow.bin 2> truncate-size-hex.err; echo SIZE-HEX-$?",
    "truncate -s 000000000000000000000 truncate-grow.bin 2> truncate-size-long.err; echo SIZE-LONG-$?",
    "truncate -s 67108865 truncate-grow.bin 2> truncate-size-over.err; echo SIZE-OVER-$?",
    "truncate -s 1 '' 2> truncate-path-empty.err; echo PATH-EMPTY-$?",
    `truncate -s 1 '${oversizedPath}' 2> truncate-path-over.err; echo PATH-OVER-$?`,
    `truncate -s 1 '${oversizedComponentPath}' 2> truncate-components-over.err; echo COMPONENTS-OVER-$?`,
    "truncate -s 1 truncate-file-link.bin 2> truncate-file-link.err; echo FILE-LINK-$?",
    "truncate -s 1 truncate-broken-link.bin 2> truncate-broken-link.err; echo BROKEN-LINK-$?",
    "truncate -s 1 truncate-directory 2> truncate-directory.err; echo DIRECTORY-$?",
    "truncate -s 1 truncate-grow.bin/ 2> truncate-trailing.err; echo TRAILING-$?",
    "truncate -s 1 truncate-missing-parent/file.bin 2> truncate-parent.err; echo PARENT-$?",
    "truncate -s 1 truncate-over-link-0/file.bin 2> truncate-link-over.err; echo LINK-OVER-$?",
    "truncate -s 67108865 truncate-too-large.bin 2> truncate-over-create.err; echo OVER-CREATE-$?",
  ], { quiet: true });
  assert.equal(rejected.exitCode, 0);
  assert.match(rejected.stdout,
    /MISSING-OPTION-2\nMISSING-SIZE-2\nMISSING-FILE-2\nEXTRA-FILE-2\nDELIMITER-MISSING-2\n/);
  assert.match(rejected.stdout,
    /ATTACHED-2\nLONG-2\nUNDELIMITED-2\nVERSION-2\nHELP-EXTRA-2\n/);
  assert.match(rejected.stdout,
    /SIZE-EMPTY-2\nSIZE-PLUS-2\nSIZE-MINUS-2\nSIZE-SPACE-2\nSIZE-SUFFIX-2\nSIZE-HEX-2\nSIZE-LONG-2\nSIZE-OVER-2\n/);
  assert.match(rejected.stdout,
    /PATH-EMPTY-2\nPATH-OVER-2\nCOMPONENTS-OVER-2\nFILE-LINK-1\nBROKEN-LINK-1\nDIRECTORY-1\nTRAILING-1\nPARENT-1\nLINK-OVER-1\nOVER-CREATE-2\n/);
  assert.equal(decoder.decode(fs.readFile("/home/web/truncate-target.bin")), "target must survive");
  assert.equal(fs.exists("/home/web/truncate-too-large.bin"), false);
  assert.equal(fs.exists("/home/web/truncate-missing-parent"), false);
  assert.equal(fs.exists("/home/web/truncate-link-target/file.bin"), false);
  assert.equal(createHash("sha256")
    .update(fs.readFile("/home/web/truncate-target.bin"))
    .update(fs.readFile("/home/web/truncate-hard-a.bin"))
    .digest("hex"), beforeRejected);
  assert.equal(decoder.decode(fs.readFile("/home/web/truncate-file-link.err")),
    "truncate: truncate-file-link.bin: not a regular file\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/truncate-path-over.err")),
    "truncate: FILE exceeds 4096 bytes\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/truncate-components-over.err")),
    "truncate: FILE exceeds 128 components\n");

  const discovery = await runSlop(fs, ["command -v truncate", "truncate --help"], { quiet: true });
  assert.equal(discovery.exitCode, 0);
  assert.match(discovery.stdout,
    /\/bin\/truncate\nusage: truncate -s SIZE \[--\] FILE.*0\.\.67108864.*final symlinks rejected/);

  const faultyFs = new TruncateFailureFs();
  faultyFs.mkdirTree("/home/web");
  installShell(faultyFs);
  faultyFs.writeFile("/home/web/truncate-fail.bin", "unchanged");
  const failed = await runSlop(faultyFs, [
    "truncate -s 2 truncate-fail.bin 2> truncate-fail.err; echo EXISTING-FAIL-$?",
    "truncate -s 2 truncate-create-fail.bin 2> truncate-create-fail.err; echo CREATE-FAIL-$?",
  ], { quiet: true });
  assert.match(failed.stdout, /EXISTING-FAIL-1\nCREATE-FAIL-1\n/);
  assert.equal(decoder.decode(faultyFs.readFile("/home/web/truncate-fail.bin")), "unchanged");
  assert.equal(faultyFs.readFile("/home/web/truncate-create-fail.bin").byteLength, 0);
  assert.equal(decoder.decode(faultyFs.readFile("/home/web/truncate-fail.err")),
    "truncate: truncate-fail.bin: cannot resize\n");
});

test("slop: grep and rg filter bounded NUL-delimited byte records atomically", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/names");
  installShell(fs);
  const encoder = new TextEncoder();
  const joinBytes = (...chunks: Array<string | Uint8Array>): Uint8Array => {
    const encoded = chunks.map((chunk) => typeof chunk === "string" ? encoder.encode(chunk) : chunk);
    const output = new Uint8Array(encoded.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of encoded) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  };
  fs.writeFile(
    "/home/web/null-records.bin",
    joinBytes(
      "alpha\0\0repeat\0repeat\0line1\nline2\0tab\tfield\0carriage\rreturn\0two words\0bad",
      new Uint8Array([0xff]),
      "utf8\0final-no-nul",
    ),
  );
  fs.writeFile("/home/web/empty-records.bin", encoder.encode("\0a\0\0tail"));
  fs.writeFile("/home/web/match.bin", encoder.encode("hit\0"));
  fs.writeFile("/home/web/line\nfile.bin", encoder.encode("miss\0"));
  fs.writeFile("/home/web/line-mode.txt", "repeat\nplain\n");
  fs.writeFile("/home/web/names/line\nbreak.txt", "one");
  fs.writeFile("/home/web/names/tab\tname.txt", "two");
  fs.writeFile("/home/web/names/other.bin", "three");

  const maxRecord = new Uint8Array(1024 * 1024 + 1).fill(0x61);
  maxRecord[maxRecord.length - 1] = 0;
  fs.writeFile("/home/web/max-null-record.bin", maxRecord);
  const oversizedRecord = new Uint8Array(1024 * 1024 + 2).fill(0x61);
  oversizedRecord[oversizedRecord.length - 1] = 0;
  fs.writeFile("/home/web/oversized-null-record.bin", oversizedRecord);
  fs.writeFile(
    "/home/web/atomic-invalid.bin",
    joinBytes("match\0", oversizedRecord),
  );
  fs.writeFile("/home/web/exact-null-records.bin", new Uint8Array(100_000));
  fs.writeFile("/home/web/too-many-null-records.bin", new Uint8Array(100_001));

  const inputLimit = new Uint8Array(16 * 1024 * 1024).fill(0x78);
  for (let offset = 1024 * 1024 - 1; offset < inputLimit.length; offset += 1024 * 1024) {
    inputLimit[offset] = 0;
  }
  fs.writeFile("/home/web/null-input-limit.bin", inputLimit);
  const overInput = new Uint8Array(inputLimit.length + 1);
  overInput.set(inputLimit);
  overInput[overInput.length - 1] = 0x79;
  fs.writeFile("/home/web/null-input-over.bin", overInput);

  const longOutputName = `${"prefix-"}${"p".repeat(150)}.bin`;
  const outputLimitFixture = new Uint8Array(41 * 100_000).fill(0x78);
  for (let offset = 40; offset < outputLimitFixture.length; offset += 41) outputLimitFixture[offset] = 0;
  fs.writeFile(`/home/web/${longOutputName}`, outputLimitFixture);

  const ordinary = await runSlop(
    fs,
    [
      "grep -zF repeat null-records.bin > grep-short.bin",
      "grep --null-data -F repeat null-records.bin > grep-long.bin",
      "rg --null-data -F repeat null-records.bin > rg-null.bin",
      "rg --null-data -nF repeat null-records.bin > rg-numbered.bin",
      "MULTI=$(printf 'line1\\nline2')",
      "grep -zF \"$MULTI\" null-records.bin > fixed-newline.bin",
      "grep -zE '^line1.line2$' null-records.bin > regex-newline.bin",
      "grep -zE '^line2$' null-records.bin > anchored-none.bin || echo ANCHORED-$?",
      "grep -zF bad null-records.bin > invalid-utf8.bin",
      "grep -zF final null-records.bin > final.bin",
      "grep -zF --regexp= empty-records.bin > empty-selected.bin",
      "grep -znF repeat null-records.bin > numbered.bin",
      "grep -z -m1 -F repeat null-records.bin > max-one.bin",
      "grep -zv -m1 -F repeat null-records.bin > invert-one.bin",
      "grep -zc -m1 -F repeat null-records.bin > count-one.bin",
      "grep -zqF repeat null-records.bin > quiet.bin",
      "LF=$(printf 'line\\nfile.bin')",
      "grep -zlF hit match.bin \"$LF\" > files-with.bin",
      "grep -zLF hit match.bin \"$LF\" > files-without.bin",
      "grep -zF i match.bin \"$LF\" > multiple.bin",
      "grep -zcF i match.bin \"$LF\" > multiple-count.bin",
      "find names -type f -print0 | grep -zF line | sort -z | uniq -z > filtered-find.bin",
      "find names -type f -print0 | rg --null-data -F line - > filtered-rg.bin",
      "cat filtered-find.bin | xargs -0r -n1 printf x > invoked.bin",
      "grep -zF absent null-records.bin > absent.bin || echo ABSENT-$?",
      "grep -F repeat line-mode.txt > line-grep.txt",
      "rg -F repeat line-mode.txt > line-rg.txt",
      "grep -zF absent max-null-record.bin > max-record.out || echo MAX-RECORD-$?",
      "grep -zF --regexp= exact-null-records.bin > exact-records.out",
      "grep -zF absent null-input-limit.bin > exact-input.out || echo EXACT-INPUT-$?",
      "grep --help",
      "rg --help",
    ],
    { quiet: true },
  );

  assert.equal(ordinary.exitCode, 0);
  assert.deepEqual(fs.readFile("/home/web/grep-short.bin"), encoder.encode("repeat\0repeat\0"));
  assert.deepEqual(fs.readFile("/home/web/grep-long.bin"), fs.readFile("/home/web/grep-short.bin"));
  assert.deepEqual(fs.readFile("/home/web/rg-null.bin"), fs.readFile("/home/web/grep-short.bin"));
  assert.deepEqual(
    fs.readFile("/home/web/rg-numbered.bin"),
    encoder.encode("3:repeat\x004:repeat\x00"),
  );
  assert.deepEqual(fs.readFile("/home/web/fixed-newline.bin"), encoder.encode("line1\nline2\0"));
  assert.deepEqual(fs.readFile("/home/web/regex-newline.bin"), encoder.encode("line1\nline2\0"));
  assert.equal(fs.readFile("/home/web/anchored-none.bin").byteLength, 0);
  assert.deepEqual(
    fs.readFile("/home/web/invalid-utf8.bin"),
    joinBytes("bad", new Uint8Array([0xff]), "utf8\0"),
  );
  assert.deepEqual(fs.readFile("/home/web/final.bin"), encoder.encode("final-no-nul\0"));
  assert.deepEqual(fs.readFile("/home/web/empty-selected.bin"), encoder.encode("\0a\0\0tail\0"));
  assert.deepEqual(fs.readFile("/home/web/numbered.bin"), encoder.encode("3:repeat\x004:repeat\x00"));
  assert.deepEqual(fs.readFile("/home/web/max-one.bin"), encoder.encode("repeat\0"));
  assert.deepEqual(fs.readFile("/home/web/invert-one.bin"), encoder.encode("alpha\0"));
  assert.deepEqual(fs.readFile("/home/web/count-one.bin"), encoder.encode("1\0"));
  assert.equal(fs.readFile("/home/web/quiet.bin").byteLength, 0);
  assert.deepEqual(fs.readFile("/home/web/files-with.bin"), encoder.encode("match.bin\0"));
  assert.deepEqual(fs.readFile("/home/web/files-without.bin"), encoder.encode("line\nfile.bin\0"));
  assert.deepEqual(
    fs.readFile("/home/web/multiple.bin"),
    encoder.encode("match.bin:hit\0line\nfile.bin:miss\0"),
  );
  assert.deepEqual(
    fs.readFile("/home/web/multiple-count.bin"),
    encoder.encode("match.bin:1\0line\nfile.bin:1\0"),
  );
  assert.deepEqual(
    fs.readFile("/home/web/filtered-find.bin"),
    encoder.encode("names/line\nbreak.txt\0"),
  );
  assert.deepEqual(fs.readFile("/home/web/filtered-rg.bin"), fs.readFile("/home/web/filtered-find.bin"));
  assert.deepEqual(fs.readFile("/home/web/invoked.bin"), encoder.encode("x"));
  assert.equal(fs.readFile("/home/web/absent.bin").byteLength, 0);
  assert.equal(fs.readFile("/home/web/max-record.out").byteLength, 0);
  assert.equal(fs.readFile("/home/web/exact-records.out").byteLength, 100_000);
  assert.equal(fs.readFile("/home/web/exact-input.out").byteLength, 0);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/line-grep.txt")), "repeat\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/line-rg.txt")), "1:repeat\n");
  assert.match(ordinary.stdout, /ANCHORED-1\n/);
  assert.match(ordinary.stdout, /ABSENT-1\n/);
  assert.match(ordinary.stdout, /MAX-RECORD-1\n/);
  assert.match(ordinary.stdout, /EXACT-INPUT-1\n/);
  assert.match(ordinary.stdout, /grep \[options\].*-z\/--null-data uses NUL records/s);
  assert.match(ordinary.stdout, /rg \[options\].*--null-data \(NUL records; -z is reserved\)/s);

  const rejected = await runSlop(
    fs,
    [
      "grep -zF match atomic-invalid.bin > rejected-atomic.out || echo ATOMIC-$?",
      "grep -zqF match atomic-invalid.bin > rejected-quiet.out || echo QUIET-ATOMIC-$?",
      "grep -zF absent oversized-null-record.bin > rejected-record.out || echo RECORD-$?",
      "grep -zF --regexp= too-many-null-records.bin > rejected-count.out || echo COUNT-$?",
      "grep -zF absent null-input-over.bin > rejected-input.out || echo INPUT-$?",
      `grep -zHF x ${longOutputName} > rejected-output.out || echo OUTPUT-$?`,
      "grep -zF hit match.bin missing.bin > rejected-missing.out || echo MISSING-$?",
      "grep --null-data=1 -F hit match.bin > rejected-option.out || echo GREP-OPTION-$?",
      "rg --null-data=1 -F hit match.bin > rejected-rg-option.out || echo RG-OPTION-$?",
      "rg -z -F hit match.bin > rejected-rg-z.out || echo RG-Z-$?",
      "rg --files --null-data > rejected-files.out || echo RG-FILES-$?",
    ],
    { quiet: true },
  );
  assert.equal(rejected.exitCode, 0);
  for (const path of [
    "rejected-atomic.out", "rejected-quiet.out", "rejected-record.out", "rejected-count.out",
    "rejected-input.out", "rejected-output.out", "rejected-missing.out", "rejected-option.out",
    "rejected-rg-option.out", "rejected-rg-z.out", "rejected-files.out",
  ]) assert.equal(fs.readFile(`/home/web/${path}`).byteLength, 0, path);
  assert.match(rejected.stdout, /grep: null-data record exceeds 1048576\nATOMIC-2\n/);
  assert.match(rejected.stdout, /grep: null-data record exceeds 1048576\nQUIET-ATOMIC-2\n/);
  assert.match(rejected.stdout, /grep: null-data record exceeds 1048576\nRECORD-2\n/);
  assert.match(rejected.stdout, /grep: null-data record count exceeds 100000\nCOUNT-2\n/);
  assert.match(rejected.stdout, /grep: null-data input exceeds 16777216\nINPUT-2\n/);
  assert.match(rejected.stdout, /grep: null-data output exceeds 16777216\nOUTPUT-2\n/);
  assert.match(rejected.stdout, /grep: missing\.bin:.*\nMISSING-2\n/);
  assert.match(rejected.stdout, /grep: option --null-data does not take an argument\nGREP-OPTION-2\n/);
  assert.match(rejected.stdout, /rg: option --null-data does not take an argument\nRG-OPTION-2\n/);
  assert.match(rejected.stdout, /rg: -z is reserved for compressed search; use --null-data\nRG-Z-2\n/);
  assert.match(rejected.stdout, /rg: --null-data cannot be used with --files\nRG-FILES-2\n/);
});

test("slop: realpath -m stages bounded physical missing paths", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  const decoder = new TextDecoder();
  fs.mkdirTree("/home/web/realpath-missing/physical/base/existing");
  fs.mkdirTree("/home/web/realpath-missing/physical/base/other");
  fs.mkdirTree("/home/web/-realpath-start");
  fs.mkdirTree("/home/web/realpath-output");
  installShell(fs);
  fs.writeFile("/home/web/realpath-missing/physical/base/file", "regular\n");
  fs.symlink("physical/base", "/home/web/realpath-missing/alias");
  fs.symlink("existing", "/home/web/realpath-missing/physical/base/final-link");
  fs.symlink("missing-target", "/home/web/realpath-missing/physical/base/dangling");

  for (let index = 39; index >= 0; index--) {
    fs.symlink(
      index === 39 ? "physical/base/existing" : `link-${index + 1}`,
      `/home/web/realpath-missing/link-${index}`,
    );
  }
  for (let index = 40; index >= 0; index--) {
    fs.symlink(
      index === 40 ? "physical/base/existing" : `link-over-${index + 1}`,
      `/home/web/realpath-missing/link-over-${index}`,
    );
  }

  const exactInput = `/${"a".repeat(4_095)}`;
  const overInput = `${exactInput}a`;
  const resultOverInput = "r".repeat(4_090);
  const exactComponents = `/${Array.from({ length: 256 }, () => "m").join("/")}`;
  const overComponents = `${exactComponents}/m`;
  const operands100 = Array.from({ length: 100 }, () => "realpath-missing/planned").join(" ");
  const operands101 = `${operands100} realpath-missing/planned`;

  const run = await runSlop(
    fs,
    [
      "realpath -m realpath-missing/physical/base/existing/new > realpath-output/relative",
      "realpath --canonicalize-missing /home/web/realpath-missing/physical/base/existing/new > realpath-output/absolute",
      "realpath -P -m realpath-missing/physical/base/other/../existing/./new/ > realpath-output/normalized",
      "realpath -m realpath-missing/alias/existing/new > realpath-output/physical-link",
      "realpath -m realpath-missing/physical/base/dangling/../planned > realpath-output/dangling-parent",
      "realpath -m realpath-missing/physical/base/dangling > realpath-output/dangling-final",
      "realpath -m realpath-missing/physical/base/final-link realpath-missing/physical/base/final-link/ > realpath-output/final-link",
      "realpath -m realpath-missing/new-directory/ > realpath-output/missing-slash",
      "realpath -m -- -realpath-start/new > realpath-output/dash",
      "realpath -m realpath-missing/planned -P > realpath-output/late-option",
      "realpath -m realpath-missing/link-0/new > realpath-output/links-exact",
      "realpath -m realpath-missing/link-over-0/new > realpath-output/links-over 2> realpath-output/links-over.err || echo LINKS-OVER-$?",
      "realpath -m realpath-missing/planned realpath-missing/physical/base/file/child > realpath-output/atomic 2> realpath-output/atomic.err || echo ATOMIC-$?",
      "realpath -m realpath-missing/physical/base/file/../planned > realpath-output/non-directory-parent 2> realpath-output/non-directory-parent.err || echo NON-DIRECTORY-PARENT-$?",
      "realpath -m realpath-missing/physical/base/file/ > realpath-output/non-directory-slash 2> realpath-output/non-directory-slash.err || echo NON-DIRECTORY-SLASH-$?",
      "realpath -m -realpath-start/new > realpath-output/dash-rejected 2> realpath-output/dash-rejected.err || echo DASH-REJECTED-$?",
      "realpath -e -m realpath-missing/planned > realpath-output/conflict-em 2> realpath-output/conflict-em.err || echo CONFLICT-EM-$?",
      "realpath -m -e realpath-missing/planned > realpath-output/conflict-me 2> realpath-output/conflict-me.err || echo CONFLICT-ME-$?",
      "realpath -m > realpath-output/missing-operand 2> realpath-output/missing-operand.err || echo MISSING-OPERAND-$?",
      "realpath -m --unknown > realpath-output/unknown 2> realpath-output/unknown.err || echo UNKNOWN-$?",
      `realpath -m ${operands100} > realpath-output/operands-exact && echo OPERANDS-EXACT-$?`,
      `realpath -m ${operands101} > realpath-output/operands-over 2> realpath-output/operands-over.err || echo OPERANDS-OVER-$?`,
      `realpath -m '${exactInput}' > realpath-output/path-exact && echo PATH-EXACT-$?`,
      `realpath -m '${overInput}' > realpath-output/path-over 2> realpath-output/path-over.err || echo PATH-OVER-$?`,
      `realpath -m '${resultOverInput}' > realpath-output/result-over 2> realpath-output/result-over.err || echo RESULT-OVER-$?`,
      `realpath -m '${exactComponents}' > realpath-output/components-exact && echo COMPONENTS-EXACT-$?`,
      `realpath -m '${overComponents}' > realpath-output/components-over 2> realpath-output/components-over.err || echo COMPONENTS-OVER-$?`,
      "cd realpath-missing/alias/existing",
      "realpath -m child > /home/web/realpath-output/cwd-physical",
      "cd /home/web",
      "realpath --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0, run.stdout);
  const read = (name: string) => decoder.decode(fs.readFile(`/home/web/realpath-output/${name}`));
  const physical = "/home/web/realpath-missing/physical/base";
  assert.equal(read("relative"), `${physical}/existing/new\n`);
  assert.equal(read("absolute"), `${physical}/existing/new\n`);
  assert.equal(read("normalized"), `${physical}/existing/new\n`);
  assert.equal(read("physical-link"), `${physical}/existing/new\n`);
  assert.equal(read("dangling-parent"), `${physical}/planned\n`);
  assert.equal(read("dangling-final"), `${physical}/missing-target\n`);
  assert.equal(read("final-link"), `${physical}/existing\n${physical}/existing\n`);
  assert.equal(read("missing-slash"), "/home/web/realpath-missing/new-directory\n");
  assert.equal(read("dash"), "/home/web/-realpath-start/new\n");
  assert.equal(read("late-option"), "/home/web/realpath-missing/planned\n/home/web/-P\n");
  assert.equal(read("links-exact"), `${physical}/existing/new\n`);
  assert.equal(read("cwd-physical"), `${physical}/existing/child\n`);
  assert.equal(read("operands-exact").split("\n").filter(Boolean).length, 100);
  assert.equal(read("path-exact"), `${exactInput}\n`);
  assert.equal(read("components-exact"), `${exactComponents}\n`);
  for (const name of [
    "links-over", "atomic", "non-directory-parent", "non-directory-slash",
    "dash-rejected", "conflict-em", "conflict-me", "missing-operand", "unknown",
    "operands-over", "path-over", "components-over",
    "result-over",
  ]) assert.equal(read(name), "", name);
  assert.match(run.stdout, /LINKS-OVER-1\nATOMIC-1\nNON-DIRECTORY-PARENT-1\nNON-DIRECTORY-SLASH-1\n/);
  assert.match(run.stdout, /DASH-REJECTED-2\nCONFLICT-EM-2\nCONFLICT-ME-2\nMISSING-OPERAND-2\nUNKNOWN-2\n/);
  assert.match(run.stdout, /OPERANDS-EXACT-0\nOPERANDS-OVER-2\nPATH-EXACT-0\nPATH-OVER-1\nRESULT-OVER-1\nCOMPONENTS-EXACT-0\nCOMPONENTS-OVER-1\n/);
  assert.equal(read("operands-over.err"), "realpath: more than 100 operands\n");
  assert.match(read("path-over.err"), /input exceeds 4096 bytes/);
  assert.match(read("result-over.err"), /result exceeds 4096 bytes/);
  assert.match(read("components-over.err"), /^realpath: .*: /);
  assert.match(run.stdout, /usage: realpath .*canonicalize-missing.*stages 1\.\.100 physical results.*4096 input\/result bytes.*256 processed components.*40 symlinks/s);
});

test("slop: du stages bounded logical subtree totals before output", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  const decoder = new TextDecoder();
  fs.mkdirTree("/home/web/du-tree/alpha/nested");
  fs.mkdirTree("/home/web/du-tree/beta");
  fs.mkdirTree("/home/web/du-tree/empty");
  fs.mkdirTree("/home/web/-du-start");
  fs.mkdirTree("/home/web/du-output");
  fs.mkdirTree("/home/web/du-entry-limit/a");
  fs.mkdirTree("/home/web/du-entry-limit/b");
  installShell(fs);

  fs.writeFile("/home/web/du-tree/alpha/a.bin", new Uint8Array(1_000));
  fs.writeFile("/home/web/du-tree/alpha/nested/n.bin", new Uint8Array(3_000));
  fs.writeFile("/home/web/du-tree/beta/b.bin", new Uint8Array(5_000));
  fs.writeFile("/home/web/du-tree/top.bin", new Uint8Array(2_000));
  fs.symlink("../beta", "/home/web/du-tree/alpha/beta-link");
  fs.symlink("missing-target", "/home/web/du-tree/dangling");
  fs.writeFile("/home/web/-du-start/child", new Uint8Array(7));

  const exactComponents = ["d".repeat(32), ...Array.from({ length: 127 }, () => "d".repeat(31))];
  const exactPath = exactComponents.join("/");
  const oversizedPath = `${"d".repeat(33)}/${exactComponents.slice(1).join("/")}`;
  assert.equal(exactPath.length, 4_096);
  assert.equal(oversizedPath.length, 4_097);
  fs.mkdirTree(`/home/web/${exactComponents.slice(0, -1).join("/")}`);
  fs.writeFile(`/home/web/${exactPath}`, new Uint8Array([1]));

  const exactDepthRoot = "du-depth-exact";
  const excessiveDepthRoot = "du-depth-over";
  const exactDepth = [exactDepthRoot, ...Array.from({ length: 128 }, () => "d")].join("/");
  const excessiveDepth = [excessiveDepthRoot, ...Array.from({ length: 129 }, () => "d")].join("/");
  fs.mkdirTree(`/home/web/${exactDepth}`);
  fs.mkdirTree(`/home/web/${excessiveDepth}`);

  for (let index = 0; index < 999; index++)
    fs.writeFile(`/home/web/du-entry-limit/a/f${String(index).padStart(4, "0")}`, new Uint8Array([1]));
  for (let index = 0; index < 998; index++)
    fs.writeFile(`/home/web/du-entry-limit/b/f${String(index).padStart(4, "0")}`, new Uint8Array([1]));
  const paths64 = Array.from({ length: 64 }, () => "du-tree/top.bin").join(" ");
  const paths65 = Array.from({ length: 65 }, () => "du-tree/top.bin").join(" ");
  const aggregateExact = Array.from({ length: 16 }, () => exactPath).join(" ");
  const aggregateOver = `${aggregateExact} x`;
  const entriesExact = Array.from({ length: 50 }, () => "du-entry-limit").join(" ");
  const entriesOver = Array.from({ length: 51 }, () => "du-entry-limit").join(" ");

  const run = await runSlop(
    fs,
    [
      "du -a -d 1 -- du-tree > du-output/main 2> du-output/main.err && echo MAIN-$?",
      "du -a -d 0 du-tree > du-output/depth-zero 2> du-output/depth-zero.err && echo DEPTH-ZERO-$?",
      "du -d 2 -a du-tree > du-output/reverse 2> du-output/reverse.err && echo REVERSE-$?",
      "du -a -d 0 -- du-tree/top.bin du-tree/dangling du-tree/alpha/beta-link/ > du-output/operands 2> du-output/operands.err && echo OPERANDS-$?",
      "du -a -d 1 -- -du-start > du-output/dash 2> du-output/dash.err && echo DASH-$?",
      "du -a -d 1 -du-start > du-output/dash-rejected 2> du-output/dash-rejected.err || echo DASH-REJECTED-$?",
      "du -a -d 1 du-tree missing > du-output/atomic 2> du-output/atomic.err || echo ATOMIC-$?",
      "du -a -d nope du-tree > du-output/depth-invalid 2> du-output/depth-invalid.err || echo DEPTH-INVALID-$?",
      "du -a -d 129 du-tree > du-output/depth-over 2> du-output/depth-over.err || echo DEPTH-OVER-$?",
      "du -a -d -1 du-tree > du-output/depth-negative 2> du-output/depth-negative.err || echo DEPTH-NEGATIVE-$?",
      "du -a du-tree > du-output/missing-depth 2> du-output/missing-depth.err || echo MISSING-DEPTH-$?",
      "du -d 1 du-tree > du-output/missing-all 2> du-output/missing-all.err || echo MISSING-ALL-$?",
      "du -a -a -d 1 du-tree > du-output/duplicate-all 2> du-output/duplicate-all.err || echo DUPLICATE-ALL-$?",
      "du -a -d 1 -d 2 du-tree > du-output/duplicate-depth 2> du-output/duplicate-depth.err || echo DUPLICATE-DEPTH-$?",
      "du -a -d 1 -- > du-output/missing-path 2> du-output/missing-path.err || echo MISSING-PATH-$?",
      "du -a -d 1 du-tree -late > du-output/late 2> du-output/late.err || echo LATE-$?",
      "du -a -d 1 --unknown du-tree > du-output/unknown 2> du-output/unknown.err || echo UNKNOWN-$?",
      `du -a -d 0 ${paths64} > du-output/paths-exact 2> du-output/paths-exact.err && echo PATHS-EXACT-$?`,
      `du -a -d 0 ${paths65} > du-output/paths-over 2> du-output/paths-over.err || echo PATHS-OVER-$?`,
      `du -a -d 0 '${exactPath}' > du-output/path-exact 2> du-output/path-exact.err && echo PATH-EXACT-$?`,
      `du -a -d 0 '${oversizedPath}' > du-output/path-over 2> du-output/path-over.err || echo PATH-OVER-$?`,
      `du -a -d 0 ${aggregateExact} > du-output/aggregate-exact 2> du-output/aggregate-exact.err && echo AGGREGATE-EXACT-$?`,
      `du -a -d 0 ${aggregateOver} > du-output/aggregate-over 2> du-output/aggregate-over.err || echo AGGREGATE-OVER-$?`,
      `du -a -d 0 ${exactDepthRoot} > du-output/traversal-exact 2> du-output/traversal-exact.err; echo TRAVERSAL-EXACT-$?`,
      `du -a -d 0 ${excessiveDepthRoot} > du-output/traversal-over 2> du-output/traversal-over.err; echo TRAVERSAL-OVER-$?`,
      `du -a -d 0 ${entriesExact} > du-output/entries-exact 2> du-output/entries-exact.err && echo ENTRIES-EXACT-$?`,
      `du -a -d 0 ${entriesOver} > du-output/entries-over 2> du-output/entries-over.err; echo ENTRIES-OVER-$?`,
      "du --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /MAIN-0\nDEPTH-ZERO-0\nREVERSE-0\nOPERANDS-0\nDASH-0\n/);
  assert.match(run.stdout, /DASH-REJECTED-2\nATOMIC-1\nDEPTH-INVALID-2\nDEPTH-OVER-2\nDEPTH-NEGATIVE-2\n/);
  assert.match(run.stdout, /MISSING-DEPTH-2\nMISSING-ALL-2\nDUPLICATE-ALL-2\nDUPLICATE-DEPTH-2\nMISSING-PATH-2\nLATE-2\nUNKNOWN-2\n/);
  assert.match(run.stdout, /PATHS-EXACT-0\nPATHS-OVER-2\nPATH-EXACT-0\nPATH-OVER-2\nAGGREGATE-EXACT-0\nAGGREGATE-OVER-2\n/);
  assert.match(run.stdout, /TRAVERSAL-EXACT-0\nTRAVERSAL-OVER-1\nENTRIES-EXACT-0\nENTRIES-OVER-1\n/);
  assert.match(run.stdout, /usage: du -a -d DEPTH .*logical regular-file bytes.*64 paths.*100000 entries\/records.*16 MiB staged output/s);

  assert.equal(decoder.decode(fs.readFile("/home/web/du-output/main")), [
    "4000\tdu-tree/alpha",
    "5000\tdu-tree/beta",
    "0\tdu-tree/dangling",
    "0\tdu-tree/empty",
    "2000\tdu-tree/top.bin",
    "11000\tdu-tree",
    "",
  ].join("\n"));
  assert.equal(decoder.decode(fs.readFile("/home/web/du-output/depth-zero")), "11000\tdu-tree\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/du-output/reverse")), [
    "1000\tdu-tree/alpha/a.bin",
    "0\tdu-tree/alpha/beta-link",
    "3000\tdu-tree/alpha/nested",
    "4000\tdu-tree/alpha",
    "5000\tdu-tree/beta/b.bin",
    "5000\tdu-tree/beta",
    "0\tdu-tree/dangling",
    "0\tdu-tree/empty",
    "2000\tdu-tree/top.bin",
    "11000\tdu-tree",
    "",
  ].join("\n"));
  assert.equal(decoder.decode(fs.readFile("/home/web/du-output/operands")), [
    "2000\tdu-tree/top.bin",
    "0\tdu-tree/dangling",
    "0\tdu-tree/alpha/beta-link/",
    "",
  ].join("\n"));
  assert.equal(decoder.decode(fs.readFile("/home/web/du-output/dash")), "7\t-du-start/child\n7\t-du-start\n");

  for (const name of [
    "dash-rejected", "atomic", "depth-invalid", "depth-over", "depth-negative",
    "missing-depth", "missing-all", "duplicate-all", "duplicate-depth", "missing-path",
    "late", "unknown", "paths-over", "path-over", "aggregate-over", "traversal-over",
    "entries-over",
  ]) assert.equal(fs.readFile(`/home/web/du-output/${name}`).byteLength, 0, name);
  assert.match(decoder.decode(fs.readFile("/home/web/du-output/atomic.err")), /^du: missing: /);
  assert.match(decoder.decode(fs.readFile("/home/web/du-output/dash-rejected.err")), /unsupported option: -du-start/);
  assert.match(decoder.decode(fs.readFile("/home/web/du-output/late.err")), /option-looking path requires --: -late/);
  assert.match(decoder.decode(fs.readFile("/home/web/du-output/paths-over.err")), /expected 1 to 64 paths/);
  assert.match(decoder.decode(fs.readFile("/home/web/du-output/path-over.err")), /path exceeds 4096 bytes/);
  assert.match(decoder.decode(fs.readFile("/home/web/du-output/aggregate-over.err")), /path operands exceed 65536 bytes/);
  assert.match(decoder.decode(fs.readFile("/home/web/du-output/traversal-over.err")), /traversal exceeds 128 levels/);
  assert.match(decoder.decode(fs.readFile("/home/web/du-output/entries-over.err")), /traversal exceeds 100000 entries/);

  assert.equal(fs.readFile("/home/web/du-output/paths-exact").byteLength, "2000\tdu-tree/top.bin\n".length * 64);
  assert.equal(decoder.decode(fs.readFile("/home/web/du-output/path-exact")), `1\t${exactPath}\n`);
  assert.equal(fs.readFile("/home/web/du-output/aggregate-exact").byteLength, (`1\t${exactPath}\n`).length * 16);
  assert.equal(decoder.decode(fs.readFile("/home/web/du-output/traversal-exact")), `0\t${exactDepthRoot}\n`);
  assert.equal(decoder.decode(fs.readFile("/home/web/du-output/entries-exact")).split("\n").filter(Boolean).length, 50);
  assert.deepEqual(fs.readdir("/home/web/du-tree").map((entry) => entry.name).sort(), ["alpha", "beta", "dangling", "empty", "top.bin"]);
});

test("slop: find -delete is terminal, postorder, bounded, and parser-atomic", async () => {
  const fs = new MemoryFs();
  const decoder = new TextDecoder();
  fs.mkdirTree("/home/web/find-delete/files/sub");
  fs.mkdirTree("/home/web/find-delete/directories/a/b");
  fs.mkdirTree("/home/web/find-delete/whole/sub");
  fs.mkdirTree("/home/web/find-delete/links");
  fs.mkdirTree("/home/web/find-delete/link-target");
  fs.mkdirTree("/home/web/find-delete/syntax/sub");
  fs.mkdirTree("/home/web/find-delete/runtime/nonempty");
  installShell(fs);

  fs.writeFile("/home/web/find-delete/files/a.tmp", "a\n");
  fs.writeFile("/home/web/find-delete/files/-dash.tmp", "dash\n");
  fs.writeFile("/home/web/find-delete/files/sub/b.tmp", "b\n");
  fs.writeFile("/home/web/find-delete/files/sub/keep.c", "keep\n");
  fs.writeFile("/home/web/find-delete/whole/sub/value", "whole\n");
  fs.writeFile("/home/web/find-delete/link-target/kept", "target\n");
  fs.symlink("../link-target", "/home/web/find-delete/links/target.tmp");
  fs.writeFile("/home/web/find-delete/syntax/sub/a.tmp", "syntax\n");
  fs.writeFile("/home/web/find-delete/runtime/first.tmp", "first\n");
  fs.writeFile("/home/web/find-delete/runtime/nonempty/kept", "kept\n");

  const exactPaths = Array.from({ length: 100 }, () => "find-delete/syntax").join(" ");
  const tooManyPaths = Array.from({ length: 101 }, () => "find-delete/syntax").join(" ");
  const run = await runSlop(
    fs,
    [
      "find find-delete/files -type f -name '*.tmp' -delete > find-delete/files.out 2> find-delete/files.err && echo FILES-$?",
      "find find-delete/directories -mindepth 1 -type d -delete > find-delete/directories.out 2> find-delete/directories.err && echo DIRECTORIES-$?",
      "find find-delete/whole -delete > find-delete/whole.out 2> find-delete/whole.err && echo WHOLE-$?",
      "find find-delete/links -mindepth 1 -type l -delete > find-delete/links.out 2> find-delete/links.err && echo LINKS-$?",
      "find find-delete/files -type f -print",
      "find find-delete/syntax -delete -type f > find-delete/nonfinal.out 2> find-delete/nonfinal.err || echo NONFINAL-$?",
      "find find-delete/syntax -type f -print -delete > find-delete/mixed.out 2> find-delete/mixed.err || echo MIXED-$?",
      "find find-delete/syntax -type f -delete extra > find-delete/argument.out 2> find-delete/argument.err || echo ARGUMENT-$?",
      "find find-delete/syntax -name > find-delete/missing.out 2> find-delete/missing.err || echo MISSING-$?",
      "find find-delete/syntax -unknown > find-delete/unknown.out 2> find-delete/unknown.err || echo UNKNOWN-$?",
      `find ${exactPaths} -name impossible -delete > find-delete/limit-exact.out 2> find-delete/limit-exact.err && echo LIMIT-EXACT-$?`,
      `find ${tooManyPaths} -delete > find-delete/limit-over.out 2> find-delete/limit-over.err || echo LIMIT-OVER-$?`,
      "find find-delete/runtime/first.tmp find-delete/runtime/nonempty -maxdepth 0 -delete > find-delete/runtime.out 2> find-delete/runtime.err || echo RUNTIME-$?",
      "find --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /FILES-0\nDIRECTORIES-0\nWHOLE-0\nLINKS-0\n/);
  assert.match(run.stdout, /find-delete\/files\/sub\/keep\.c\n/);
  assert.match(run.stdout, /NONFINAL-2\nMIXED-2\nARGUMENT-2\nMISSING-2\nUNKNOWN-2\nLIMIT-EXACT-0\nLIMIT-OVER-2\nRUNTIME-1\n/);
  assert.match(run.stdout, /usage: find .*\[-print\|-print0\|-delete\].*one optional final action.*silent\/postorder/s);

  for (const name of ["files", "directories", "whole", "links"])
    assert.equal(fs.readFile(`/home/web/find-delete/${name}.out`).byteLength, 0, name);
  for (const name of ["files", "directories", "whole", "links"])
    assert.equal(fs.readFile(`/home/web/find-delete/${name}.err`).byteLength, 0, name);
  assert.equal(fs.exists("/home/web/find-delete/files/a.tmp"), false);
  assert.equal(fs.exists("/home/web/find-delete/files/-dash.tmp"), false);
  assert.equal(fs.exists("/home/web/find-delete/files/sub/b.tmp"), false);
  assert.equal(decoder.decode(fs.readFile("/home/web/find-delete/files/sub/keep.c")), "keep\n");
  assert.deepEqual(fs.readdir("/home/web/find-delete/directories"), []);
  assert.equal(fs.exists("/home/web/find-delete/whole"), false);
  assert.deepEqual(fs.readdir("/home/web/find-delete/links"), []);
  assert.equal(decoder.decode(fs.readFile("/home/web/find-delete/link-target/kept")), "target\n");

  for (const name of ["nonfinal", "mixed", "argument", "missing", "unknown", "limit-exact", "limit-over"])
    assert.equal(fs.readFile(`/home/web/find-delete/${name}.out`).byteLength, 0, name);
  assert.equal(decoder.decode(fs.readFile("/home/web/find-delete/syntax/sub/a.tmp")), "syntax\n");
  assert.match(decoder.decode(fs.readFile("/home/web/find-delete/nonfinal.err")), /action must be final: -delete/);
  assert.match(decoder.decode(fs.readFile("/home/web/find-delete/mixed.err")), /action must be final: -print/);
  assert.match(decoder.decode(fs.readFile("/home/web/find-delete/argument.err")), /action must be final: -delete/);
  assert.match(decoder.decode(fs.readFile("/home/web/find-delete/missing.err")), /unsupported expression: -name/);
  assert.match(decoder.decode(fs.readFile("/home/web/find-delete/unknown.err")), /unsupported expression: -unknown/);
  assert.equal(fs.readFile("/home/web/find-delete/limit-exact.err").byteLength, 0);
  assert.match(decoder.decode(fs.readFile("/home/web/find-delete/limit-over.err")), /more than 100 starting paths/);

  assert.equal(fs.exists("/home/web/find-delete/runtime/first.tmp"), false);
  assert.equal(decoder.decode(fs.readFile("/home/web/find-delete/runtime/nonempty/kept")), "kept\n");
  assert.match(decoder.decode(fs.readFile("/home/web/find-delete/runtime.err")), /^find: find-delete\/runtime\/nonempty: /);
});

test("slop: mkdir preflights bounded dependent directory plans", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  for (const order of ["first", "middle", "last"]) {
    fs.mkdirTree(`/home/web/mkdir-missing-${order}`);
  }
  fs.mkdirTree("/home/web/mkdir-control");
  fs.mkdirTree("/home/web/mkdir-dependent");
  fs.mkdirTree("/home/web/mkdir-reversed");
  fs.mkdirTree("/home/web/mkdir-duplicate");
  fs.mkdirTree("/home/web/mkdir-existing/existing-directory");
  fs.mkdirTree("/home/web/mkdir-links/target-directory");
  fs.mkdirTree("/home/web/mkdir-bypass");
  fs.mkdirTree("/home/web/mkdir-count-exact");
  fs.mkdirTree("/home/web/mkdir-count-over");
  fs.mkdirTree("/home/web/mkdir-aggregate");
  fs.mkdirTree("/home/web/mkdir-plan-exact");
  fs.mkdirTree("/home/web/mkdir-plan-over");
  installShell(fs);

  fs.writeFile("/home/web/mkdir-existing/blocker", "blocker\n");
  fs.writeFile("/home/web/mkdir-existing/final-file", "final\n");
  fs.symlink("target-directory", "/home/web/mkdir-links/final-directory-link");
  fs.symlink("missing-target", "/home/web/mkdir-links/dangling");
  fs.symlink("missing-target", "/home/web/mkdir-bypass/dangling");
  for (let index = 39; index >= 0; index--) {
    fs.symlink(
      index === 39 ? "target-directory" : `link-${index + 1}`,
      `/home/web/mkdir-links/link-${index}`,
    );
  }
  for (let index = 40; index >= 0; index--) {
    fs.symlink(
      index === 40 ? "target-directory" : `over-${index + 1}`,
      `/home/web/mkdir-links/over-${index}`,
    );
  }

  const exactOperands = Array.from({ length: 100 }, (_, index) =>
    `mkdir-count-exact/d${String(index).padStart(3, "0")}`);
  const overOperands = Array.from({ length: 101 }, (_, index) =>
    `mkdir-count-over/d${String(index).padStart(3, "0")}`);

  const exactComponents = ["m".repeat(32), ...Array.from({ length: 127 }, () => "m".repeat(31))];
  const exactPath = exactComponents.join("/");
  const oversizedPath = `${"m".repeat(33)}/${exactComponents.slice(1).join("/")}`;
  const excessiveComponents = Array.from({ length: 129 }, () => "c").join("/");
  assert.equal(exactPath.length, 4096);
  assert.equal(oversizedPath.length, 4097);
  fs.mkdirTree(`/home/web/${exactComponents.slice(0, -1).join("/")}`);

  const aggregatePaths = Array.from({ length: 17 }, (_, index) => {
    const prefix = `mkdir-aggregate/${String(index).padStart(2, "0")}`;
    const path = `${prefix}${"a".repeat(3855 - prefix.length)}`;
    assert.equal(path.length, 3855);
    fs.mkdirTree(`/home/web/${path}`);
    return path;
  });
  assert.equal(aggregatePaths.reduce((sum, path) => sum + path.length, 0) + 1, 65_536);

  const nestedPath = (root: string, serial: string, planned: number): string =>
    [root, serial, ...Array.from({ length: planned - 1 }, () => "d")].join("/");
  const exactPlanPaths = [
    ...Array.from({ length: 8 }, (_, index) => nestedPath("mkdir-plan-exact", `p${index}`, 127)),
    nestedPath("mkdir-plan-exact", "tail", 8),
  ];
  const overPlanPaths = [
    ...Array.from({ length: 8 }, (_, index) => nestedPath("mkdir-plan-over", `p${index}`, 127)),
    nestedPath("mkdir-plan-over", "tail", 9),
  ];

  const run = await runSlop(
    fs,
    [
      "mkdir mkdir-missing-first/unavailable/child mkdir-missing-first/a mkdir-missing-first/b || echo MISSING-FIRST-$?",
      "mkdir mkdir-missing-middle/a mkdir-missing-middle/unavailable/child mkdir-missing-middle/b || echo MISSING-MIDDLE-$?",
      "mkdir mkdir-missing-last/a mkdir-missing-last/b mkdir-missing-last/unavailable/child || echo MISSING-LAST-$?",
      "mkdir mkdir-control/a mkdir-control/b mkdir-control/c && echo CONTROL-$?",
      "mkdir mkdir-dependent/a mkdir-dependent/a/b && echo DEPENDENT-$?",
      "mkdir mkdir-reversed/a/b mkdir-reversed/a || echo REVERSED-$?",
      "mkdir mkdir-duplicate/a mkdir-duplicate/a || echo DUPLICATE-$?",
      "mkdir -p mkdir-duplicate/p mkdir-duplicate/p && echo DUPLICATE-P-$?",
      "mkdir -p mkdir-parents/reversed/a/b mkdir-parents/reversed/a && echo PARENTS-$?",
      "mkdir mkdir-existing/new mkdir-existing/blocker/child || echo BLOCKER-$?",
      "mkdir mkdir-existing/new-final mkdir-existing/existing-directory || echo EXISTING-$?",
      "mkdir -p mkdir-existing/new-p mkdir-existing/final-file || echo EXISTING-P-$?",
      "mkdir -p mkdir-links/final-directory-link && echo FINAL-LINK-P-$?",
      "mkdir mkdir-links/final-marker mkdir-links/final-directory-link || echo FINAL-LINK-$?",
      "mkdir -p mkdir-links/dangling-marker mkdir-links/dangling || echo DANGLING-$?",
      "mkdir mkdir-links/link-0/exact && echo LINK-EXACT-$?",
      "mkdir mkdir-links/link-marker mkdir-links/over-0/over || echo LINK-OVER-$?",
      "mkdir mkdir-bypass/independent mkdir-bypass/dangling/../escaped || echo PARENT-BYPASS-$?",
      "mkdir mkdir-options/good -Z || echo LATE-OPTION-$?",
      "mkdir -- -mkdir-dash && echo TERMINATOR-$?",
      "mkdir --unsupported mkdir-option-marker || echo OPTION-$?",
      "mkdir '' || echo EMPTY-$?",
      "mkdir || echo ARITY-$?",
      `mkdir ${exactOperands.join(" ")} && echo COUNT-EXACT-$?`,
      `mkdir ${overOperands.join(" ")} || echo COUNT-OVER-$?`,
      `mkdir '${exactPath}' && echo PATH-EXACT-$?`,
      `mkdir mkdir-path-marker '${oversizedPath}' || echo PATH-OVER-$?`,
      `mkdir mkdir-component-marker '${excessiveComponents}' || echo COMPONENT-OVER-$?`,
      "mkdir -p mkdir-aggregate/* x && echo AGGREGATE-EXACT-$?",
      "mkdir -p mkdir-aggregate/* yy || echo AGGREGATE-OVER-$?",
      `mkdir -p ${exactPlanPaths.join(" ")} && echo PLAN-EXACT-$?`,
      `mkdir -p ${overPlanPaths.join(" ")} || echo PLAN-OVER-$?`,
      "mkdir --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0, run.stdout);
  for (const marker of [
    "MISSING-FIRST-1", "MISSING-MIDDLE-1", "MISSING-LAST-1", "CONTROL-0",
    "DEPENDENT-0", "REVERSED-1", "DUPLICATE-1", "DUPLICATE-P-0", "PARENTS-0",
    "BLOCKER-1", "EXISTING-1", "EXISTING-P-1", "FINAL-LINK-P-0", "FINAL-LINK-1",
    "DANGLING-1", "LINK-EXACT-0", "LINK-OVER-1", "PARENT-BYPASS-1",
    "LATE-OPTION-2", "TERMINATOR-0", "OPTION-2", "EMPTY-2", "ARITY-2",
    "COUNT-EXACT-0", "COUNT-OVER-2", "PATH-EXACT-0", "PATH-OVER-2",
    "COMPONENT-OVER-2", "AGGREGATE-EXACT-0", "AGGREGATE-OVER-2",
    "PLAN-EXACT-0", "PLAN-OVER-2",
  ]) assert.match(run.stdout, new RegExp(`(^|\\n)${marker}\\n`), marker);

  for (const order of ["first", "middle", "last"]) {
    assert.deepEqual(fs.readdir(`/home/web/mkdir-missing-${order}`), [], order);
  }
  for (const name of ["a", "b", "c"]) assert.equal(fs.exists(`/home/web/mkdir-control/${name}`), true);
  assert.equal(fs.exists("/home/web/mkdir-dependent/a/b"), true);
  assert.deepEqual(fs.readdir("/home/web/mkdir-reversed"), []);
  assert.equal(fs.exists("/home/web/mkdir-duplicate/a"), false);
  assert.equal(fs.exists("/home/web/mkdir-duplicate/p"), true);
  assert.equal(fs.exists("/home/web/mkdir-parents/reversed/a/b"), true);
  for (const path of [
    "mkdir-existing/new", "mkdir-existing/new-final", "mkdir-existing/new-p",
    "mkdir-links/final-marker", "mkdir-links/dangling-marker", "mkdir-links/link-marker",
    "mkdir-bypass/independent", "mkdir-bypass/escaped", "mkdir-options/good",
    "mkdir-path-marker", "mkdir-component-marker", "yy",
  ]) assert.equal(fs.exists(`/home/web/${path}`), false, path);
  assert.equal(fs.readlink("/home/web/mkdir-links/final-directory-link"), "target-directory");
  assert.equal(fs.exists("/home/web/mkdir-links/target-directory/exact"), true);
  assert.equal(fs.exists("/home/web/mkdir-links/target-directory/over"), false);
  assert.equal(fs.exists("/home/web/-mkdir-dash"), true);
  for (const path of exactOperands) assert.equal(fs.exists(`/home/web/${path}`), true, path);
  assert.deepEqual(fs.readdir("/home/web/mkdir-count-over"), []);
  assert.equal(fs.exists(`/home/web/${exactPath}`), true);
  assert.equal(fs.exists("/home/web/x"), true);
  assert.equal(fs.exists(`/home/web/${exactPlanPaths.at(-1)}`), true);
  assert.deepEqual(fs.readdir("/home/web/mkdir-plan-over"), []);
  assert.match(run.stdout, /mkdir: too many operands \(max 100\)/);
  assert.match(run.stdout, /mkdir: path operand exceeds 4096 bytes/);
  assert.match(run.stdout, /mkdir: path operands exceed 65536 bytes/);
  assert.match(run.stdout, /mkdir: path has more than 128 components/);
  assert.match(run.stdout, /mkdir: planned creations exceed 1024/);
  assert.match(run.stdout, /usage: mkdir .*options precede operands; invocation preflight.*max 100 operands.*1024 planned creations/s);
});

test("slop: mktemp accepts compact flags and validates bounded templates before creation", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  const decoder = new TextDecoder();
  for (const name of ["compact-dt", "compact-td", "separate", "reverse", "file", "relative"]) {
    fs.mkdirTree(`/home/web/mktemp-tmp/${name}`);
  }
  fs.mkdirTree("/home/web/mktemp-links/target-directory");
  fs.mkdirTree("/home/web/mktemp-collision");
  fs.mkdirTree("/home/web/mktemp-output");
  fs.mkdirTree("/tmp");
  installShell(fs);

  fs.writeFile("/home/web/mktemp-tmp/not-directory", "not a directory\n");
  fs.symlink("missing-target", "/home/web/mktemp-links/dangling");
  for (let index = 39; index >= 0; index--) {
    fs.symlink(
      index === 39 ? "target-directory" : `link-${index + 1}`,
      `/home/web/mktemp-links/link-${index}`,
    );
  }
  for (let index = 40; index >= 0; index--) {
    fs.symlink(
      index === 40 ? "target-directory" : `over-${index + 1}`,
      `/home/web/mktemp-links/over-${index}`,
    );
  }

  const exactComponent = `${"c".repeat(1018)}XXXXXX`;
  const oversizedComponent = `${"c".repeat(1019)}XXXXXX`;
  assert.equal(exactComponent.length, 1024);
  assert.equal(oversizedComponent.length, 1025);
  const exactComponents = [
    "q".repeat(32),
    ...Array.from({ length: 126 }, () => "q".repeat(31)),
    `${"q".repeat(25)}XXXXXX`,
  ];
  const exactPath = exactComponents.join("/");
  const oversizedPath = `${"q".repeat(33)}/${exactComponents.slice(1).join("/")}`;
  assert.equal(exactComponents.length, 128);
  assert.equal(exactPath.length, 4096);
  assert.equal(oversizedPath.length, 4097);
  fs.mkdirTree(`/home/web/${exactComponents.slice(0, -1).join("/")}`);
  const excessiveComponents = [
    ...Array.from({ length: 128 }, () => "z"),
    "tmp.XXXXXX",
  ].join("/");

  const collisionCommands = Array.from(
    { length: 10 },
    () => "mktemp mktemp-collision/value.XXXXXX >> mktemp-output/collisions",
  );
  const run = await runSlop(
    fs,
    [
      "TMPDIR=mktemp-tmp/compact-dt mktemp -dt agent.XXXXXX > mktemp-output/compact-dt && echo COMPACT-DT-$?",
      "TMPDIR=mktemp-tmp/compact-td mktemp -td agent.XXXXXX > mktemp-output/compact-td && echo COMPACT-TD-$?",
      "TMPDIR=mktemp-tmp/separate mktemp -d -t agent.XXXXXX > mktemp-output/separate && echo SEPARATE-$?",
      "TMPDIR=mktemp-tmp/reverse mktemp -t -d agent.XXXXXX > mktemp-output/reverse && echo REVERSE-$?",
      "TMPDIR=mktemp-tmp/file mktemp -t file.XXXXXX > mktemp-output/file && echo FILE-$?",
      "TMPDIR=mktemp-tmp/relative mktemp -t relative.XXXXXX > mktemp-output/relative && echo RELATIVE-$?",
      "TMPDIR=mktemp-tmp/missing mktemp -t missing.XXXXXX > mktemp-output/missing || echo MISSING-TMPDIR-$?",
      "TMPDIR=mktemp-tmp/not-directory mktemp -t nondir.XXXXXX > mktemp-output/nondir || echo NONDIR-TMPDIR-$?",
      "TMPDIR= mktemp -t empty-env.XXXXXX > mktemp-output/empty-env && echo EMPTY-ENV-$?",
      "TMPDIR=mktemp-tmp/missing mktemp local.XXXXXX > mktemp-output/local && echo LOCAL-$?",
      "mktemp -- -dash.XXXXXX > mktemp-output/dash && echo TERMINATOR-$?",
      "mktemp late.XXXXXX -d > mktemp-output/late || echo LATE-OPTION-$?",
      "mktemp --unsupported marker.XXXXXX > mktemp-output/option || echo OPTION-$?",
      "mktemp one.XXXXXX two.XXXXXX > mktemp-output/arity || echo ARITY-$?",
      "mktemp '' > mktemp-output/empty || echo EMPTY-$?",
      "mktemp missing-template > mktemp-output/grammar || echo GRAMMAR-$?",
      "mktemp -t path/template.XXXXXX > mktemp-output/slash || echo SLASH-$?",
      "TMPDIR=mktemp-links/link-0 mktemp -t exact.XXXXXX > mktemp-output/link-exact && echo LINK-EXACT-$?",
      "TMPDIR=mktemp-links/over-0 mktemp -t over.XXXXXX > mktemp-output/link-over || echo LINK-OVER-$?",
      "TMPDIR=mktemp-links/dangling/.. mktemp -t escaped.XXXXXX > mktemp-output/bypass || echo PARENT-BYPASS-$?",
      `mktemp '${exactComponent}' > mktemp-output/component-exact && echo COMPONENT-EXACT-$?`,
      `mktemp '${oversizedComponent}' > mktemp-output/component-over || echo COMPONENT-OVER-$?`,
      `mktemp '${exactPath}' > mktemp-output/path-exact && echo PATH-EXACT-$?`,
      `mktemp '${oversizedPath}' > mktemp-output/path-over || echo PATH-OVER-$?`,
      `mktemp '${excessiveComponents}' > mktemp-output/components-over || echo COMPONENTS-OVER-$?`,
      ...collisionCommands,
      "mktemp --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0, run.stdout);
  for (const marker of [
    "COMPACT-DT-0", "COMPACT-TD-0", "SEPARATE-0", "REVERSE-0", "FILE-0",
    "RELATIVE-0", "MISSING-TMPDIR-1", "NONDIR-TMPDIR-1", "EMPTY-ENV-0", "LOCAL-0",
    "TERMINATOR-0", "LATE-OPTION-2", "OPTION-2", "ARITY-2", "EMPTY-2",
    "GRAMMAR-2", "SLASH-2", "LINK-EXACT-0", "LINK-OVER-1", "PARENT-BYPASS-1",
    "COMPONENT-EXACT-0", "COMPONENT-OVER-2", "PATH-EXACT-0", "PATH-OVER-2",
    "COMPONENTS-OVER-2",
  ]) assert.match(run.stdout, new RegExp(`(^|\\n)${marker}\\n`), marker);

  const captured = (name: string): string => {
    const output = decoder.decode(fs.readFile(`/home/web/mktemp-output/${name}`));
    assert.match(output, /^[^\n]+\n$/, name);
    return output.slice(0, -1);
  };
  const absolute = (path: string): string => path.startsWith("/") ? path : `/home/web/${path}`;
  for (const name of ["compact-dt", "compact-td", "separate", "reverse"]) {
    const path = absolute(captured(name));
    assert.deepEqual(fs.readdir(path), [], name);
  }
  for (const name of [
    "file", "relative", "empty-env", "local", "dash",
    "component-exact", "path-exact",
  ]) {
    assert.equal(fs.readFile(absolute(captured(name))).byteLength, 0, name);
  }
  const linkedOutput = captured("link-exact");
  assert.match(linkedOutput, /^mktemp-links\/link-0\/exact\.[0-9a-f]{6}$/);
  assert.equal(
    fs.readFile(`/home/web/mktemp-links/target-directory/${linkedOutput.slice(linkedOutput.lastIndexOf("/") + 1)}`).byteLength,
    0,
  );
  for (const name of [
    "missing", "nondir", "late", "option", "arity", "empty", "grammar", "slash",
    "link-over", "bypass", "component-over", "path-over", "components-over",
  ]) assert.equal(fs.readFile(`/home/web/mktemp-output/${name}`).byteLength, 0, name);

  const collisionOutput = decoder.decode(fs.readFile("/home/web/mktemp-output/collisions"));
  const collisionPaths = collisionOutput.trimEnd().split("\n");
  assert.equal(collisionPaths.length, 10);
  assert.equal(new Set(collisionPaths).size, 10);
  for (const path of collisionPaths) assert.equal(fs.readFile(absolute(path)).byteLength, 0, path);
  assert.match(run.stdout, /mktemp: template component exceeds 1024 bytes/);
  assert.match(run.stdout, /mktemp: final path exceeds 4096 bytes/);
  assert.match(run.stdout, /mktemp: path has more than 128 components/);
  assert.match(run.stdout, /usage: mktemp .*\[-dt\|-td\].*final component <=1024 bytes.*128 collision attempts/s);
});

test("slop: touch preflights bounded multi-operand mutations", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/touch-plan/control");
  fs.mkdirTree("/home/web/touch-links/referents");
  fs.mkdirTree("/home/web/touch-count");
  fs.mkdirTree("/home/web/touch-count-over");
  fs.mkdirTree("/home/web/touch-aggregate");
  installShell(fs);

  fs.writeFile("/home/web/touch-plan/existing", "preserve\n");
  fs.utimes("/home/web/touch-plan/existing", null, 123n);
  fs.writeFile("/home/web/touch-links/target", "target\n");
  fs.utimes("/home/web/touch-links/target", null, 456n);
  for (let index = 0; index < 40; index++) {
    fs.symlink(
      index === 39 ? "target" : `link-${index + 1}`,
      `/home/web/touch-links/link-${index}`,
    );
  }
  for (let index = 0; index < 41; index++) {
    fs.symlink(
      index === 40 ? "target" : `link-over-${index + 1}`,
      `/home/web/touch-links/link-over-${index}`,
    );
  }
  fs.symlink("referents/new-target", "/home/web/touch-links/broken-create");
  fs.symlink("referents/no-create-target", "/home/web/touch-links/broken-no-create");

  const exactComponents = ["p".repeat(32), ...Array.from({ length: 127 }, () => "p".repeat(31))];
  const exactPath = exactComponents.join("/");
  const oversizedPath = `${"p".repeat(33)}/${exactComponents.slice(1).join("/")}`;
  const excessiveComponents = Array.from({ length: 129 }, () => "c").join("/");
  assert.equal(new TextEncoder().encode(exactPath).byteLength, 4096);
  assert.equal(new TextEncoder().encode(oversizedPath).byteLength, 4097);
  fs.mkdirTree(`/home/web/${exactComponents.slice(0, -1).join("/")}`);

  const countExact = Array.from({ length: 100 }, (_, index) =>
    `touch-count/f${String(index).padStart(3, "0")}`);
  const countOver = Array.from({ length: 101 }, (_, index) =>
    `touch-count-over/f${String(index).padStart(3, "0")}`);

  const aggregatePaths: string[] = [];
  for (let index = 0; index < 17; index++) {
    const pathLength = index === 0 ? 3856 : 3855;
    const prefix = "touch-aggregate/";
    const serial = String(index).padStart(2, "0");
    const path = `${prefix}${serial}${"a".repeat(pathLength - prefix.length - serial.length)}`;
    assert.equal(path.length, pathLength);
    aggregatePaths.push(path);
    fs.writeFile(`/home/web/${path}`, "aggregate\n");
    fs.utimes(`/home/web/${path}`, null, 789n);
  }
  assert.equal(aggregatePaths.reduce((sum, path) => sum + path.length, 0), 65_536);

  const run = await runSlop(
    fs,
    [
      "touch touch-plan/first touch-plan/missing/child touch-plan/last || echo MISSING-$?",
      "touch touch-plan/control/a touch-plan/control/b && echo CONTROL-$?",
      "touch touch-plan/existing touch-plan/missing/again || echo EXISTING-$?",
      "touch touch-plan/existing -c || echo LATE-OPTION-$?",
      "touch -c touch-plan/no-create && echo NO-CREATE-$?",
      "touch -c touch-plan/missing/no-create || echo NO-CREATE-PARENT-$?",
      "touch touch-links/broken-create && echo BROKEN-CREATE-$?",
      "touch -c touch-links/broken-no-create && echo BROKEN-NO-CREATE-$?",
      "touch touch-links/link-0 && echo LINK-EXACT-$?",
      "touch touch-links/link-marker touch-links/link-over-0 || echo LINK-OVER-$?",
      "touch touch-links/directory-marker touch-links || echo DIRECTORY-$?",
      `touch ${exactPath} && echo PATH-EXACT-$?`,
      `touch touch-plan/path-marker ${oversizedPath} || echo PATH-OVER-$?`,
      `touch touch-plan/component-marker ${excessiveComponents} || echo COMPONENT-OVER-$?`,
      `touch ${countExact.join(" ")} && echo COUNT-EXACT-$?`,
      `touch ${countOver.join(" ")} || echo COUNT-OVER-$?`,
      "touch touch-aggregate/* && echo AGGREGATE-EXACT-$?",
      "touch -- -dash && echo TERMINATOR-$?",
      "touch --bogus touch-plan/option-marker || echo OPTION-$?",
      "touch || echo EMPTY-$?",
      "touch --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  for (const marker of [
    "MISSING-1", "CONTROL-0", "EXISTING-1", "LATE-OPTION-2", "NO-CREATE-0", "NO-CREATE-PARENT-1",
    "BROKEN-CREATE-0", "BROKEN-NO-CREATE-0", "LINK-EXACT-0", "LINK-OVER-1",
    "DIRECTORY-1", "PATH-EXACT-0", "PATH-OVER-2", "COMPONENT-OVER-2",
    "COUNT-EXACT-0", "COUNT-OVER-2", "AGGREGATE-EXACT-0", "TERMINATOR-0",
    "OPTION-2", "EMPTY-2",
  ]) assert.match(run.stdout, new RegExp(`(^|\\n)${marker}\\n`), marker);
  assert.match(run.stdout, /touch: path operand exceeds 4096 bytes/);
  assert.match(run.stdout, /touch: path has more than 128 components/);
  assert.match(run.stdout, /touch: too many operands \(max 100\)/);
  assert.match(run.stdout, /usage: touch .*options precede operands; invocation preflight; max 100 operands, 4096 bytes\/path, 65536 path bytes, 128 components, 40 symlinks/);

  for (const path of [
    "touch-plan/first", "touch-plan/last", "touch-plan/path-marker",
    "touch-plan/component-marker", "touch-links/link-marker", "touch-links/directory-marker",
  ]) assert.equal(fs.exists(`/home/web/${path}`), false, path);
  assert.equal(fs.readFile("/home/web/touch-plan/existing").toString(), new TextEncoder().encode("preserve\n").toString());
  assert.equal(fs.stat("/home/web/touch-plan/existing", true).mtim, 123n);
  assert.equal(fs.exists("/home/web/touch-plan/no-create"), false);
  assert.equal(fs.exists("/home/web/touch-links/referents/new-target"), true);
  assert.equal(fs.exists("/home/web/touch-links/referents/no-create-target"), false);
  assert.equal(fs.stat("/home/web/touch-links/target", true).mtim > 456n, true);
  assert.equal(fs.exists(`/home/web/${exactPath}`), true);
  assert.equal(fs.exists("/home/web/-dash"), true);
  for (const path of countExact) assert.equal(fs.exists(`/home/web/${path}`), true, path);
  for (const path of countOver) assert.equal(fs.exists(`/home/web/${path}`), false, path);
  for (const path of aggregatePaths) assert.equal(fs.stat(`/home/web/${path}`, true).mtim > 789n, true, path);

  for (const path of aggregatePaths) fs.utimes(`/home/web/${path}`, null, 987n);
  const aggregateRejected = await runSlop(
    fs,
    ["touch touch-aggregate/* x || echo AGGREGATE-OVER-$?"],
    { quiet: true },
  );
  assert.equal(aggregateRejected.exitCode, 0);
  assert.match(aggregateRejected.stdout, /touch: path operands exceed 65536 bytes\nAGGREGATE-OVER-2\n/);
  assert.equal(fs.exists("/home/web/x"), false);
  for (const path of aggregatePaths) assert.equal(fs.stat(`/home/web/${path}`, true).mtim, 987n, path);
});

test("slop: ln rejects hard links before mutation and bounds symbolic links", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  const decoder = new TextDecoder();
  fs.mkdirTree("/home/web/ln-case/physical-parent");
  fs.mkdirTree("/home/web/ln-case/directory");
  fs.mkdirTree("/home/web/ln-links/target-directory");
  installShell(fs);

  fs.writeFile("/home/web/ln-case/source", "source\n");
  fs.writeFile("/home/web/ln-case/hard-missing-dest", "keep missing\n");
  fs.writeFile("/home/web/ln-case/hard-existing-dest", "keep existing\n");
  fs.writeFile("/home/web/ln-case/force-dest", "replace me\n");
  fs.writeFile("/home/web/ln-case/no-force", "do not replace\n");
  fs.writeFile("/home/web/ln-case/referent", "keep referent\n");
  fs.writeFile("/home/web/ln-case/guard", "keep guard\n");
  fs.symlink("referent", "/home/web/ln-case/destination-link");
  fs.symlink("physical-parent", "/home/web/ln-case/parent-link");
  fs.symlink("missing-parent", "/home/web/ln-case/dangling-parent");
  for (let index = 39; index >= 0; index--) {
    fs.symlink(
      index === 39 ? "target-directory" : `link-${index + 1}`,
      `/home/web/ln-links/link-${index}`,
    );
  }
  for (let index = 40; index >= 0; index--) {
    fs.symlink(
      index === 40 ? "target-directory" : `over-${index + 1}`,
      `/home/web/ln-links/over-${index}`,
    );
  }

  const exactComponents = ["l".repeat(32), ...Array.from({ length: 127 }, () => "l".repeat(31))];
  const exactLinkPath = exactComponents.join("/");
  const oversizedLinkPath = `${"l".repeat(33)}/${exactComponents.slice(1).join("/")}`;
  const excessiveComponents = Array.from({ length: 129 }, () => "c").join("/");
  assert.equal(exactLinkPath.length, 4096);
  assert.equal(oversizedLinkPath.length, 4097);
  fs.mkdirTree(`/home/web/${exactComponents.slice(0, -1).join("/")}`);
  const exactTarget = "t".repeat(4096);
  const oversizedTarget = `${exactTarget}t`;

  const run = await runSlop(
    fs,
    [
      "ln -f ln-case/absent ln-case/hard-missing-dest || echo HARD-MISSING-$?",
      "ln -f ln-case/source ln-case/hard-existing-dest || echo HARD-EXISTING-$?",
      "ln ln-case/source ln-case/hard-new || echo HARD-PLAIN-$?",
      "ln -sf intended-target ln-case/force-dest && echo FORCE-$?",
      "ln -fs replacement-target ln-case/destination-link && echo FORCE-LINK-$?",
      "ln -s other-target ln-case/no-force || echo NO-FORCE-$?",
      "ln -sf target ln-case/directory || echo DIRECTORY-$?",
      "ln -s parent-target ln-case/parent-link/created && echo PARENT-LINK-$?",
      "ln -s exact-target ln-links/link-0/created && echo LINK-EXACT-$?",
      "ln -s over-target ln-links/over-0/over-created || echo LINK-OVER-$?",
      "ln -s -- -target -dash-link && echo TERMINATOR-$?",
      "ln -s late-target -late-link && echo LATE-LINK-$?",
      "ln --unsupported target ln-case/option-marker || echo OPTION-$?",
      "ln -s target || echo ARITY-$?",
      "ln -s target ln-case/trailing/ || echo TRAILING-$?",
      "ln -sf target ln-case/missing-parent/child || echo MISSING-PARENT-$?",
      "ln -sf replacement ln-case/dangling-parent/../guard || echo PARENT-BYPASS-$?",
      `ln -s '${exactTarget}' ln-case/target-exact && echo TARGET-EXACT-$?`,
      `ln -s '${oversizedTarget}' ln-case/target-over || echo TARGET-OVER-$?`,
      `ln -s target '${exactLinkPath}' && echo PATH-EXACT-$?`,
      `ln -s target '${oversizedLinkPath}' || echo PATH-OVER-$?`,
      `ln -s target '${excessiveComponents}' || echo COMPONENT-OVER-$?`,
      "ln --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0, run.stdout);
  for (const marker of [
    "HARD-MISSING-2", "HARD-EXISTING-2", "HARD-PLAIN-2", "FORCE-0", "FORCE-LINK-0",
    "NO-FORCE-1", "DIRECTORY-1", "PARENT-LINK-0", "LINK-EXACT-0", "LINK-OVER-1",
    "TERMINATOR-0", "LATE-LINK-0", "OPTION-2", "ARITY-2", "TRAILING-2",
    "MISSING-PARENT-1", "PARENT-BYPASS-1", "TARGET-EXACT-0", "TARGET-OVER-2", "PATH-EXACT-0",
    "PATH-OVER-2", "COMPONENT-OVER-2",
  ]) assert.match(run.stdout, new RegExp(`(^|\\n)${marker}\\n`), marker);

  assert.equal(decoder.decode(fs.readFile("/home/web/ln-case/hard-missing-dest")), "keep missing\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/ln-case/hard-existing-dest")), "keep existing\n");
  assert.equal(fs.exists("/home/web/ln-case/hard-new"), false);
  assert.equal(fs.readlink("/home/web/ln-case/force-dest"), "intended-target");
  assert.equal(fs.readlink("/home/web/ln-case/destination-link"), "replacement-target");
  assert.equal(decoder.decode(fs.readFile("/home/web/ln-case/referent")), "keep referent\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/ln-case/no-force")), "do not replace\n");
  assert.equal(fs.readdir("/home/web/ln-case/directory").length, 0);
  assert.equal(fs.readlink("/home/web/ln-case/physical-parent/created"), "parent-target");
  assert.equal(fs.readlink("/home/web/ln-links/target-directory/created"), "exact-target");
  assert.equal(fs.exists("/home/web/ln-links/target-directory/over-created"), false);
  assert.equal(fs.readlink("/home/web/-dash-link"), "-target");
  assert.equal(fs.readlink("/home/web/-late-link"), "late-target");
  assert.equal(fs.exists("/home/web/ln-case/option-marker"), false);
  assert.equal(fs.exists("/home/web/ln-case/missing-parent"), false);
  assert.equal(decoder.decode(fs.readFile("/home/web/ln-case/guard")), "keep guard\n");
  assert.equal(fs.readlink("/home/web/ln-case/target-exact"), exactTarget);
  assert.equal(fs.exists("/home/web/ln-case/target-over"), false);
  assert.equal(fs.readlink(`/home/web/${exactLinkPath}`), "target");
  assert.match(run.stdout, /ln: hard links are unsupported; use -s/);
  assert.match(run.stdout, /ln: path operand exceeds 4096 bytes/);
  assert.match(run.stdout, /ln: link path has more than 128 components/);
  assert.match(run.stdout, /usage: ln -s .*initial options only; hard links unavailable.*target\/link <=4096 bytes.*parent traversal <=40 symlinks/s);
});

test("slop: install preflights bounded file and directory batches", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  const decoder = new TextDecoder();
  installShell(fs);

  for (const order of ["first", "middle", "last"]) {
    fs.mkdirTree(`/home/web/install-missing-${order}/src`);
    fs.mkdirTree(`/home/web/install-missing-${order}/dest`);
    fs.writeFile(`/home/web/install-missing-${order}/src/a`, "a\n");
    fs.writeFile(`/home/web/install-missing-${order}/src/b`, "b\n");
  }
  fs.mkdirTree("/home/web/install-control/src");
  fs.mkdirTree("/home/web/install-control/dest");
  fs.writeFile("/home/web/install-control/src/a", "control a\n");
  fs.writeFile("/home/web/install-control/src/b", "control b\n");

  fs.mkdirTree("/home/web/install-reject/src/dir");
  fs.mkdirTree("/home/web/install-reject/dest");
  fs.mkdirTree("/home/web/install-reject/left");
  fs.mkdirTree("/home/web/install-reject/right");
  fs.mkdirTree("/home/web/install-reject/physical-parent");
  fs.writeFile("/home/web/install-reject/src/first", "first\n");
  fs.writeFile("/home/web/install-reject/src/second", "second\n");
  fs.writeFile("/home/web/install-reject/src/self", "self\n");
  fs.writeFile("/home/web/install-reject/src/linked", "linked\n");
  fs.writeFile("/home/web/install-reject/left/same", "left\n");
  fs.writeFile("/home/web/install-reject/right/same", "right\n");
  fs.writeFile("/home/web/install-reject/referent", "referent\n");
  fs.writeFile("/home/web/install-reject/inside-referent", "inside referent\n");
  fs.writeFile("/home/web/install-reject/not-directory", "not a directory\n");
  fs.symlink("referent", "/home/web/install-reject/final-link");
  fs.symlink("../inside-referent", "/home/web/install-reject/dest/linked");
  fs.symlink("physical-parent", "/home/web/install-reject/parent-link");
  fs.symlink("physical-parent", "/home/web/install-reject/final-directory-link");
  fs.symlink("missing-target", "/home/web/install-reject/broken-source");

  fs.mkdirTree("/home/web/install-links");
  fs.writeFile("/home/web/install-links/target", "forty links\n");
  for (let index = 39; index >= 0; index--) {
    fs.symlink(index === 39 ? "target" : `link-${index + 1}`, `/home/web/install-links/link-${index}`);
  }
  for (let index = 40; index >= 0; index--) {
    fs.symlink(index === 40 ? "target" : `over-${index + 1}`, `/home/web/install-links/over-${index}`);
  }

  fs.mkdirTree("/home/web/install-count/source-exact");
  fs.mkdirTree("/home/web/install-count/source-over");
  fs.mkdirTree("/home/web/install-count/dest-exact");
  fs.mkdirTree("/home/web/install-count/dest-over");
  const exactSources = Array.from({ length: 100 }, (_, index) =>
    `install-count/source-exact/f${String(index).padStart(3, "0")}`);
  const overSources = Array.from({ length: 101 }, (_, index) =>
    `install-count/source-over/f${String(index).padStart(3, "0")}`);
  for (const path of [...exactSources, ...overSources]) fs.writeFile(`/home/web/${path}`, `${path}\n`);

  const exactComponents = ["p".repeat(32), ...Array.from({ length: 127 }, () => "p".repeat(31))];
  const exactPath = exactComponents.join("/");
  const oversizedPath = `${"p".repeat(33)}/${exactComponents.slice(1).join("/")}`;
  const excessiveComponents = Array.from({ length: 129 }, () => "c").join("/");
  assert.equal(exactPath.length, 4096);
  assert.equal(oversizedPath.length, 4097);
  fs.mkdirTree(`/home/web/${exactComponents.slice(0, -1).join("/")}`);
  fs.writeFile(`/home/web/${exactPath}`, "exact path\n");

  fs.mkdirTree("/home/web/ia");
  fs.mkdirTree("/home/web/q");
  fs.mkdirTree("/home/web/qq");
  const aggregateSources = Array.from({ length: 17 }, (_, index) => {
    const prefix = `ia/${String(index).padStart(2, "0")}`;
    const path = `${prefix}${"a".repeat(3855 - prefix.length)}`;
    assert.equal(path.length, 3855);
    fs.writeFile(`/home/web/${path}`, `aggregate ${index}\n`);
    return path;
  });
  assert.equal(aggregateSources.reduce((sum, path) => sum + path.length, 0) + "q".length, 65_536);

  fs.writeFile("/home/web/-install-source", "dash\n");

  const run = await runSlop(
    fs,
    [
      "install install-missing-first/src/missing install-missing-first/src/a install-missing-first/src/b install-missing-first/dest || echo MISSING-FIRST-$?",
      "install install-missing-middle/src/a install-missing-middle/src/missing install-missing-middle/src/b install-missing-middle/dest || echo MISSING-MIDDLE-$?",
      "install install-missing-last/src/a install-missing-last/src/b install-missing-last/src/missing install-missing-last/dest || echo MISSING-LAST-$?",
      "install install-control/src/a install-control/src/b install-control/dest && echo CONTROL-$?",
      "install install-reject/src/first install-reject/src/missing install-reject/dest || echo LATE-MISSING-$?",
      "install install-reject/src/first install-reject/src/dir install-reject/dest || echo DIRECTORY-SOURCE-$?",
      "install install-reject/src/first install-reject/broken-source install-reject/dest || echo BROKEN-SOURCE-$?",
      "install install-reject/left/same install-reject/right/same install-reject/dest || echo DUPLICATE-$?",
      "install install-reject/src/self install-reject/src/self || echo SELF-$?",
      "install install-reject/src/first install-reject/final-link || echo FINAL-LINK-$?",
      "install install-reject/src/first install-reject/src/linked install-reject/dest || echo INNER-LINK-$?",
      "install install-reject/src/first install-reject/src/second install-reject/not-directory || echo MULTI-NONDIR-$?",
      "install install-reject/src/first install-reject/parent-link/copied && echo PARENT-LINK-$?",
      "install install-links/link-0 install-links/copied && echo LINK-EXACT-$?",
      "install install-reject/src/first install-links/over-0 install-reject/dest || echo LINK-OVER-$?",
      "install -- -install-source -install-output && echo TERMINATOR-$?",
      "install install-reject/src/first -- install-reject/late-option || echo LATE-OPTION-$?",
      "install --unsupported install-reject/src/first install-reject/option-marker || echo OPTION-$?",
      "install install-reject/src/first || echo ARITY-$?",
      "install -d || echo DIRECTORY-ARITY-$?",
      "install -d install-directory/good install-reject/not-directory/child || echo DIRECTORY-PREFLIGHT-$?",
      "install -d install-reject/final-directory-link || echo DIRECTORY-LINK-$?",
      "install -d install-directory/control/deep install-directory/control/sibling && echo DIRECTORY-CONTROL-$?",
      `install ${exactSources.join(" ")} install-count/dest-exact && echo COUNT-EXACT-$?`,
      `install ${overSources.join(" ")} install-count/dest-over || echo COUNT-OVER-$?`,
      `install '${exactPath}' install-exact-output && echo PATH-EXACT-$?`,
      `install install-reject/src/first '${oversizedPath}' || echo PATH-OVER-$?`,
      `install install-reject/src/first '${excessiveComponents}' || echo COMPONENT-OVER-$?`,
      "install ia/* q && echo AGGREGATE-EXACT-$?",
      "install ia/* qq || echo AGGREGATE-OVER-$?",
      "install --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0, run.stdout);
  for (const marker of [
    "MISSING-FIRST-1", "MISSING-MIDDLE-1", "MISSING-LAST-1", "CONTROL-0",
    "LATE-MISSING-1", "DIRECTORY-SOURCE-1", "BROKEN-SOURCE-1", "DUPLICATE-1",
    "SELF-1", "FINAL-LINK-1", "INNER-LINK-1", "MULTI-NONDIR-1", "PARENT-LINK-0",
    "LINK-EXACT-0", "LINK-OVER-1", "TERMINATOR-0", "LATE-OPTION-2", "OPTION-2",
    "ARITY-2", "DIRECTORY-ARITY-2", "DIRECTORY-PREFLIGHT-1", "DIRECTORY-LINK-1",
    "DIRECTORY-CONTROL-0",
    "COUNT-EXACT-0", "COUNT-OVER-2", "PATH-EXACT-0", "PATH-OVER-2",
    "COMPONENT-OVER-2", "AGGREGATE-EXACT-0", "AGGREGATE-OVER-2",
  ]) assert.match(run.stdout, new RegExp(`(^|\\n)${marker}\\n`), marker);

  for (const order of ["first", "middle", "last"]) {
    assert.deepEqual(fs.readdir(`/home/web/install-missing-${order}/dest`), [], order);
  }
  assert.equal(decoder.decode(fs.readFile("/home/web/install-control/dest/a")), "control a\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/install-control/dest/b")), "control b\n");
  assert.equal(fs.exists("/home/web/install-reject/dest/first"), false);
  assert.equal(fs.exists("/home/web/install-reject/dest/same"), false);
  assert.equal(decoder.decode(fs.readFile("/home/web/install-reject/src/self")), "self\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/install-reject/referent")), "referent\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/install-reject/inside-referent")), "inside referent\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/install-reject/physical-parent/copied")), "first\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/install-links/copied")), "forty links\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/-install-output")), "dash\n");
  assert.equal(fs.exists("/home/web/install-reject/late-option"), false);
  assert.equal(fs.exists("/home/web/install-reject/option-marker"), false);
  assert.equal(fs.exists("/home/web/install-directory/good"), false);
  assert.equal(fs.exists("/home/web/install-directory/control/deep"), true);
  assert.equal(fs.exists("/home/web/install-directory/control/sibling"), true);
  for (const source of exactSources) {
    assert.equal(fs.exists(`/home/web/install-count/dest-exact/${source.slice(source.lastIndexOf("/") + 1)}`), true);
  }
  assert.deepEqual(fs.readdir("/home/web/install-count/dest-over"), []);
  assert.equal(decoder.decode(fs.readFile("/home/web/install-exact-output")), "exact path\n");
  assert.equal(fs.exists("/home/web/q/00" + "a".repeat(3850)), true);
  assert.deepEqual(fs.readdir("/home/web/qq"), []);
  assert.match(run.stdout, /install: multiple sources map to the same target/);
  assert.match(run.stdout, /install: destination may not be a symbolic link/);
  assert.match(run.stdout, /install: too many sources \(max 100\)/);
  assert.match(run.stdout, /install: path operand exceeds 4096 bytes/);
  assert.match(run.stdout, /install: path operands exceed 65536 bytes/);
  assert.match(run.stdout, /install: path has more than 128 components/);
  assert.match(run.stdout, /usage: install .*invocation preflight.*final destination symlinks rejected.*max 100 sources\/directories.*40 symlinks/s);
});

test("slop: rm preflights complete bounded deletion plans before mutation", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  const decoder = new TextDecoder();
  for (const path of [
    "rm-atomic/late",
    "rm-atomic/directory/tree/sub",
    "rm-atomic/recursive/tree/sub",
    "rm-atomic/force",
    "rm-atomic/overlap/tree/sub",
    "rm-atomic/referent",
    "rm-atomic/intermediate-target",
    "rm-atomic/strict",
    "rm-logs",
  ]) fs.mkdirTree(`/home/web/${path}`);
  installShell(fs);
  fs.writeFile("/home/web/rm-atomic/late/victim", "late victim\n");
  fs.writeFile("/home/web/rm-atomic/directory/victim", "directory victim\n");
  fs.writeFile("/home/web/rm-atomic/directory/tree/sub/value", "directory tree\n");
  fs.writeFile("/home/web/rm-atomic/recursive/tree/sub/value", "recursive tree\n");
  fs.writeFile("/home/web/rm-atomic/force/victim", "force victim\n");
  fs.writeFile("/home/web/rm-atomic/overlap/tree/sub/value", "overlap\n");
  fs.writeFile("/home/web/-rm-dash", "dash\n");
  fs.writeFile("/home/web/rm\ttab", "tab\n");
  fs.writeFile("/home/web/rm\nline", "line\n");
  fs.writeFile("/home/web/rm-atomic/referent/kept", "referent\n");
  fs.symlink("referent", "/home/web/rm-atomic/final-link");
  fs.writeFile("/home/web/rm-atomic/intermediate-target/value", "intermediate\n");
  fs.symlink("intermediate-target", "/home/web/rm-atomic/intermediate");
  fs.writeFile("/home/web/rm-atomic/strict/victim", "strict victim\n");

  const run = await runSlop(
    fs,
    [
      "rm -- rm-atomic/late/victim rm-atomic/late/missing 2> rm-logs/late.err || echo LATE-$?",
      "rm -- rm-atomic/directory/victim rm-atomic/directory/tree 2> rm-logs/directory.err || echo DIRECTORY-$?",
      "rm -r -- rm-atomic/recursive/tree rm-atomic/recursive/missing 2> rm-logs/recursive.err || echo RECURSIVE-$?",
      "rm -f -- rm-atomic/force/victim rm-atomic/force/missing && echo FORCE-$?",
      "rm -rf -- rm-atomic/overlap/tree rm-atomic/overlap/tree/sub rm-atomic/overlap/tree/sub/value && echo OVERLAP-$?",
      "TAB=$(printf 'rm\\ttab')",
      "LINE=$(printf 'rm\\nline')",
      "rm -- -rm-dash \"$TAB\" \"$LINE\" && echo RAW-$?",
      "rm -r -- rm-atomic/final-link && echo FINAL-LINK-$?",
      "rm -- rm-atomic/intermediate/value && echo INTERMEDIATE-$?",
      "rm --help",
    ],
    { quiet: true },
  );
  assert.equal(run.exitCode, 0, run.stdout);
  for (const marker of [
    "LATE-1", "DIRECTORY-1", "RECURSIVE-1", "FORCE-0", "OVERLAP-0",
    "RAW-0", "FINAL-LINK-0", "INTERMEDIATE-0",
  ]) assert.match(run.stdout, new RegExp(`(^|\\n)${marker}\\n`), marker);
  assert.match(
    run.stdout,
    /usage: rm .*compact -rf\/-fr.*preflight.*max 100 operands.*4096 bytes per path.*65536 path bytes.*128 components.*40 symlinks.*100000 scanned\/planned entries/s,
  );

  assert.equal(decoder.decode(fs.readFile("/home/web/rm-atomic/late/victim")), "late victim\n");
  assert.equal(
    decoder.decode(fs.readFile("/home/web/rm-atomic/directory/victim")),
    "directory victim\n",
  );
  assert.equal(
    decoder.decode(fs.readFile("/home/web/rm-atomic/directory/tree/sub/value")),
    "directory tree\n",
  );
  assert.equal(
    decoder.decode(fs.readFile("/home/web/rm-atomic/recursive/tree/sub/value")),
    "recursive tree\n",
  );
  assert.equal(fs.exists("/home/web/rm-atomic/force/victim"), false);
  assert.equal(fs.exists("/home/web/rm-atomic/overlap/tree"), false);
  assert.equal(fs.exists("/home/web/-rm-dash"), false);
  assert.equal(fs.exists("/home/web/rm\ttab"), false);
  assert.equal(fs.exists("/home/web/rm\nline"), false);
  assert.equal(fs.exists("/home/web/rm-atomic/final-link"), false);
  assert.equal(decoder.decode(fs.readFile("/home/web/rm-atomic/referent/kept")), "referent\n");
  assert.equal(fs.exists("/home/web/rm-atomic/intermediate"), true);
  assert.equal(fs.exists("/home/web/rm-atomic/intermediate-target/value"), false);
  assert.equal(
    decoder.decode(fs.readFile("/home/web/rm-logs/late.err")),
    "rm: rm-atomic/late/missing: No such file or directory\n",
  );
  assert.match(decoder.decode(fs.readFile("/home/web/rm-logs/directory.err")), /Is a directory/);
  assert.match(decoder.decode(fs.readFile("/home/web/rm-logs/recursive.err")), /No such file/);

  const strict = await runSlop(
    fs,
    [
      "set -e",
      "rm -- rm-atomic/strict/victim rm-atomic/strict/missing",
      "printf SHOULD_NOT_RUN",
    ],
    { quiet: true },
  );
  assert.equal(strict.exitCode, 1);
  assert.doesNotMatch(strict.stdout, /SHOULD_NOT_RUN/);
  assert.equal(decoder.decode(fs.readFile("/home/web/rm-atomic/strict/victim")), "strict victim\n");
});

test("slop: rm planner enforces exact published limits before deletion", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  const decoder = new TextDecoder();
  for (const path of [
    "rm-limits/exact",
    "rm-limits/over",
    "rm-depth/exact",
    "rm-depth/over",
    "rm-links/target",
    "rm-links/over-target",
    "rm-logs",
  ]) fs.mkdirTree(`/home/web/${path}`);
  installShell(fs);

  const exactOperands = Array.from({ length: 100 }, (_, index) => `rm-limits/exact/f${index}`);
  const overOperands = Array.from({ length: 101 }, (_, index) => `rm-limits/over/f${index}`);
  for (const path of [...exactOperands, ...overOperands]) fs.writeFile(`/home/web/${path}`, `${path}\n`);
  fs.writeFile("/home/web/rm-limits/path-victim", "path victim\n");
  fs.writeFile("/home/web/rm-limits/aggregate-victim", "aggregate victim\n");
  fs.writeFile("/home/web/rm-limits/component-victim", "component victim\n");
  fs.writeFile("/home/web/rm-limits/option-victim", "option victim\n");
  fs.writeFile("/home/web/rm-limits/root-victim", "root victim\n");
  fs.writeFile("/home/web/rm-depth/victim", "depth victim\n");
  fs.writeFile("/home/web/rm-links/victim", "link victim\n");

  const exactPath = `p${"x".repeat(4095)}`;
  const overPath = `${exactPath}x`;
  const aggregateExact = Array.from({ length: 16 }, (_, index) =>
    `${String(index).padStart(2, "0")}${"a".repeat(4094)}`);
  const component128 = Array.from({ length: 128 }, (_, index) => `c${index}`).join("/");
  const component129 = `${component128}/overflow`;

  const exactDepthParts = Array.from({ length: 127 }, (_, index) => `d${index}`);
  const overDepthParts = Array.from({ length: 128 }, (_, index) => `e${index}`);
  fs.mkdirTree(`/home/web/rm-depth/exact/${exactDepthParts.join("/")}`);
  fs.writeFile(
    `/home/web/rm-depth/exact/${exactDepthParts.join("/")}/value`,
    "exact depth\n",
  );
  fs.mkdirTree(`/home/web/rm-depth/over/${overDepthParts.join("/")}`);
  fs.writeFile(
    `/home/web/rm-depth/over/${overDepthParts.join("/")}/value`,
    "over depth\n",
  );

  fs.writeFile("/home/web/rm-links/target/value", "forty links\n");
  for (let index = 39; index >= 0; index--) {
    fs.symlink(index === 39 ? "target" : `link-${index + 1}`, `/home/web/rm-links/link-${index}`);
  }
  fs.writeFile("/home/web/rm-links/over-target/value", "forty-one links\n");
  for (let index = 40; index >= 0; index--) {
    fs.symlink(
      index === 40 ? "over-target" : `over-link-${index + 1}`,
      `/home/web/rm-links/over-link-${index}`,
    );
  }

  const run = await runSlop(
    fs,
    [
      `rm -- ${exactOperands.join(" ")} && echo COUNT-EXACT-$?`,
      `rm -- ${overOperands.join(" ")} 2> rm-logs/count-over.err || echo COUNT-OVER-$?`,
      `rm -f -- '${exactPath}' && echo PATH-EXACT-$?`,
      `rm -- rm-limits/path-victim '${overPath}' 2> rm-logs/path-over.err || echo PATH-OVER-$?`,
      `rm -f -- ${aggregateExact.join(" ")} && echo TOTAL-EXACT-$?`,
      `rm -f -- rm-limits/aggregate-victim ${aggregateExact.join(" ")} x 2> rm-logs/total-over.err || echo TOTAL-OVER-$?`,
      `rm -f -- '${component128}' && echo COMPONENT-EXACT-$?`,
      `rm -- rm-limits/component-victim '${component129}' 2> rm-logs/component-over.err || echo COMPONENT-OVER-$?`,
      "rm -r -- rm-depth/exact && echo DEPTH-EXACT-$?",
      "rm -r -- rm-depth/victim rm-depth/over 2> rm-logs/depth-over.err || echo DEPTH-OVER-$?",
      "rm -- rm-links/link-0/value && echo LINKS-EXACT-$?",
      "rm -- rm-links/victim rm-links/over-link-0/value 2> rm-logs/links-over.err || echo LINKS-OVER-$?",
      "rm rm-limits/option-victim -late 2> rm-logs/late-option.err || echo LATE-OPTION-$?",
      "rm -rf -- rm-limits/root-victim . 2> rm-logs/dot.err || echo DOT-$?",
      "rm -rf -- rm-limits/root-victim / 2> rm-logs/root.err || echo ROOT-$?",
      "rm -f 2> rm-logs/missing.err || echo MISSING-$?",
      "rm --help",
    ],
    { quiet: true },
  );
  assert.equal(run.exitCode, 0, run.stdout);
  for (const marker of [
    "COUNT-EXACT-0", "COUNT-OVER-2", "PATH-EXACT-0", "PATH-OVER-2",
    "TOTAL-EXACT-0", "TOTAL-OVER-2", "COMPONENT-EXACT-0", "COMPONENT-OVER-2",
    "DEPTH-EXACT-0", "DEPTH-OVER-2", "LINKS-EXACT-0", "LINKS-OVER-2",
    "LATE-OPTION-2", "DOT-1", "ROOT-1", "MISSING-2",
  ]) assert.match(run.stdout, new RegExp(`(^|\\n)${marker}\\n`), marker);

  assert.deepEqual(fs.readdir("/home/web/rm-limits/exact"), []);
  assert.equal(fs.readdir("/home/web/rm-limits/over").length, 101);
  for (const [path, contents] of [
    ["rm-limits/path-victim", "path victim\n"],
    ["rm-limits/aggregate-victim", "aggregate victim\n"],
    ["rm-limits/component-victim", "component victim\n"],
    ["rm-limits/option-victim", "option victim\n"],
    ["rm-limits/root-victim", "root victim\n"],
    ["rm-depth/victim", "depth victim\n"],
    ["rm-links/victim", "link victim\n"],
  ]) assert.equal(decoder.decode(fs.readFile(`/home/web/${path}`)), contents, path);
  assert.equal(fs.exists("/home/web/rm-depth/exact"), false);
  assert.equal(
    decoder.decode(fs.readFile(`/home/web/rm-depth/over/${overDepthParts.join("/")}/value`)),
    "over depth\n",
  );
  assert.equal(fs.exists("/home/web/rm-links/target/value"), false);
  assert.equal(decoder.decode(fs.readFile("/home/web/rm-links/over-target/value")), "forty-one links\n");

  assert.equal(decoder.decode(fs.readFile("/home/web/rm-logs/count-over.err")), "rm: too many operands (max 100)\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/rm-logs/path-over.err")), "rm: path operand exceeds 4096 bytes\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/rm-logs/total-over.err")), "rm: path operands exceed 65536 bytes\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/rm-logs/component-over.err")), "rm: path has more than 128 components\n");
  assert.match(decoder.decode(fs.readFile("/home/web/rm-logs/depth-over.err")), /recursion exceeds depth 128/);
  assert.match(decoder.decode(fs.readFile("/home/web/rm-logs/links-over.err")), /path resolution limit exceeded/);
  assert.equal(decoder.decode(fs.readFile("/home/web/rm-logs/late-option.err")), "rm: unsupported option: -late\n");
  assert.match(decoder.decode(fs.readFile("/home/web/rm-logs/dot.err")), /refusing '\.' or '\.\.' operand/);
  assert.equal(decoder.decode(fs.readFile("/home/web/rm-logs/root.err")), "rm: refusing to remove root directory\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/rm-logs/missing.err")), "rm: missing operand\n");
});

test("slop: rmdir simulates ordered multi-operand removals before mutation", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  for (const path of [
    "rmdir-atomic/late",
    "rmdir-atomic/nonempty-ok",
    "rmdir-atomic/nonempty/tree",
    "rmdir-atomic/duplicate",
    "rmdir-atomic/ordered/parent/child",
    "rmdir-atomic/reverse/parent/child",
    "rmdir-atomic/regular-ok",
    "rmdir-atomic/link-ok",
    "rmdir-atomic/link-target",
    "rmdir-atomic/intermediate-target/empty",
    "rmdir-atomic/strict",
    "rmdir-atomic/dot-victim",
    "rmdir-atomic/root-victim",
    "rmdir-logs",
    "-rmdir-dash",
    "rmdir\ttab",
    "rmdir\nline",
  ]) fs.mkdirTree(`/home/web/${path}`);
  installShell(fs);
  fs.writeFile("/home/web/rmdir-atomic/nonempty/tree/value", "nonempty\n");
  fs.writeFile("/home/web/rmdir-atomic/regular", "regular\n");
  fs.symlink("link-target", "/home/web/rmdir-atomic/final-link");
  fs.symlink("intermediate-target", "/home/web/rmdir-atomic/intermediate");

  const run = await runSlop(
    fs,
    [
      "rmdir rmdir-atomic/late rmdir-atomic/missing 2> rmdir-logs/late.err || echo LATE-$?",
      "rmdir rmdir-atomic/nonempty-ok rmdir-atomic/nonempty/tree 2> rmdir-logs/nonempty.err || echo NONEMPTY-$?",
      "rmdir rmdir-atomic/duplicate rmdir-atomic/duplicate 2> rmdir-logs/duplicate.err || echo DUPLICATE-$?",
      "rmdir rmdir-atomic/ordered/parent/child rmdir-atomic/ordered/parent && echo ORDERED-$?",
      "rmdir rmdir-atomic/reverse/parent rmdir-atomic/reverse/parent/child 2> rmdir-logs/reverse.err || echo REVERSE-$?",
      "rmdir rmdir-atomic/regular-ok rmdir-atomic/regular 2> rmdir-logs/regular.err || echo REGULAR-$?",
      "rmdir rmdir-atomic/link-ok rmdir-atomic/final-link 2> rmdir-logs/link.err || echo LINK-$?",
      "rmdir -- rmdir-atomic/intermediate/empty && echo INTERMEDIATE-$?",
      "TAB=$(printf 'rmdir\\ttab')",
      "LINE=$(printf 'rmdir\\nline')",
      "rmdir -- -rmdir-dash \"$TAB\" \"$LINE\" && echo RAW-$?",
      "rmdir rmdir-atomic/dot-victim . 2> rmdir-logs/dot.err || echo DOT-$?",
      "rmdir rmdir-atomic/root-victim / 2> rmdir-logs/root.err || echo ROOT-$?",
      "rmdir rmdir-atomic/late -later 2> rmdir-logs/option.err || echo OPTION-$?",
      "rmdir 2> rmdir-logs/missing.err || echo MISSING-$?",
      "rmdir --help",
    ],
    { quiet: true },
  );
  assert.equal(run.exitCode, 0, run.stdout);
  for (const marker of [
    "LATE-1", "NONEMPTY-1", "DUPLICATE-1", "ORDERED-0", "REVERSE-1",
    "REGULAR-1", "LINK-1", "INTERMEDIATE-0", "RAW-0", "DOT-1",
    "ROOT-1", "OPTION-2", "MISSING-2",
  ]) assert.match(run.stdout, new RegExp(`(^|\\n)${marker}\\n`), marker);
  assert.match(
    run.stdout,
    /usage: rmdir .*complete ordered multi-operand preflight.*nonzero preflight leaves selected directories unchanged.*max 100 operands.*4096 bytes per path.*65536 path bytes.*128 components.*40 symlinks/s,
  );

  for (const path of [
    "rmdir-atomic/late",
    "rmdir-atomic/nonempty-ok",
    "rmdir-atomic/duplicate",
    "rmdir-atomic/reverse/parent/child",
    "rmdir-atomic/regular-ok",
    "rmdir-atomic/link-ok",
    "rmdir-atomic/dot-victim",
    "rmdir-atomic/root-victim",
  ]) assert.equal(fs.exists(`/home/web/${path}`), true, path);
  assert.equal(fs.exists("/home/web/rmdir-atomic/ordered/parent"), false);
  assert.equal(fs.exists("/home/web/rmdir-atomic/intermediate"), true);
  assert.equal(fs.exists("/home/web/rmdir-atomic/intermediate-target/empty"), false);
  assert.equal(fs.exists("/home/web/rmdir-atomic/final-link"), true);
  assert.equal(fs.exists("/home/web/rmdir-atomic/link-target"), true);
  assert.equal(fs.exists("/home/web/-rmdir-dash"), false);
  assert.equal(fs.exists("/home/web/rmdir\ttab"), false);
  assert.equal(fs.exists("/home/web/rmdir\nline"), false);
  assert.equal(fs.exists("/home/web/rmdir-atomic/nonempty/tree/value"), true);
  assert.equal(fs.exists("/home/web/rmdir-atomic/regular"), true);

  const decoder = new TextDecoder();
  assert.match(decoder.decode(fs.readFile("/home/web/rmdir-logs/late.err")), /No such file/);
  assert.match(decoder.decode(fs.readFile("/home/web/rmdir-logs/nonempty.err")), /Directory not empty/);
  assert.match(decoder.decode(fs.readFile("/home/web/rmdir-logs/duplicate.err")), /No such file/);
  assert.match(decoder.decode(fs.readFile("/home/web/rmdir-logs/reverse.err")), /Directory not empty/);
  assert.match(decoder.decode(fs.readFile("/home/web/rmdir-logs/regular.err")), /Not a directory/);
  assert.match(decoder.decode(fs.readFile("/home/web/rmdir-logs/link.err")), /Not a directory/);
  assert.match(decoder.decode(fs.readFile("/home/web/rmdir-logs/dot.err")), /refusing '\.' or '\.\.' operand/);
  assert.equal(decoder.decode(fs.readFile("/home/web/rmdir-logs/root.err")), "rmdir: refusing to remove root directory\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/rmdir-logs/option.err")), "rmdir: unsupported option: -later\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/rmdir-logs/missing.err")), "rmdir: missing operand\n");

  const strict = await runSlop(
    fs,
    [
      "set -e",
      "rmdir rmdir-atomic/strict rmdir-atomic/strict-missing",
      "printf SHOULD_NOT_RUN",
    ],
    { quiet: true },
  );
  assert.equal(strict.exitCode, 1);
  assert.doesNotMatch(strict.stdout, /SHOULD_NOT_RUN/);
  assert.equal(fs.exists("/home/web/rmdir-atomic/strict"), true);
});

test("slop: rmdir enforces exact path bounds and rolls back commit failures", { timeout: 120_000 }, async () => {
  const fs = new RmdirCommitFailureFs();
  for (const path of [
    "rmdir-limits/exact",
    "rmdir-limits/over",
    "rmdir-links/target/empty",
    "rmdir-links/over-target/empty",
    "rmdir-rollback/first",
    "rmdir-rollback/second",
    "rmdir-logs",
  ]) fs.mkdirTree(`/home/web/${path}`);
  installShell(fs);
  const exactOperands = Array.from({ length: 100 }, (_, index) => `rmdir-limits/exact/d${index}`);
  const overOperands = Array.from({ length: 101 }, (_, index) => `rmdir-limits/over/d${index}`);
  for (const path of [...exactOperands, ...overOperands]) fs.mkdirTree(`/home/web/${path}`);
  for (const path of ["path", "aggregate", "component", "link"])
    fs.mkdirTree(`/home/web/rmdir-limits/${path}-victim`);

  const exactPath = `p${"x".repeat(4095)}`;
  const overPath = `${exactPath}x`;
  const aggregateExact = Array.from({ length: 16 }, (_, index) =>
    `${String(index).padStart(2, "0")}${"a".repeat(4094)}`);
  const component128 = Array.from({ length: 128 }, (_, index) => `c${index}`).join("/");
  const component129 = `${component128}/overflow`;
  for (let index = 39; index >= 0; index--)
    fs.symlink(index === 39 ? "target" : `link-${index + 1}`, `/home/web/rmdir-links/link-${index}`);
  for (let index = 40; index >= 0; index--)
    fs.symlink(index === 40 ? "over-target" : `over-link-${index + 1}`, `/home/web/rmdir-links/over-link-${index}`);

  const run = await runSlop(
    fs,
    [
      `rmdir -- ${exactOperands.join(" ")} && echo COUNT-EXACT-$?`,
      `rmdir -- ${overOperands.join(" ")} 2> rmdir-logs/count-over.err || echo COUNT-OVER-$?`,
      `rmdir -- '${exactPath}' 2> rmdir-logs/path-exact.err || echo PATH-EXACT-$?`,
      `rmdir rmdir-limits/path-victim '${overPath}' 2> rmdir-logs/path-over.err || echo PATH-OVER-$?`,
      `rmdir -- ${aggregateExact.join(" ")} 2> rmdir-logs/total-exact.err || echo TOTAL-EXACT-$?`,
      `rmdir -- rmdir-limits/aggregate-victim ${aggregateExact.join(" ")} x 2> rmdir-logs/total-over.err || echo TOTAL-OVER-$?`,
      `rmdir -- '${component128}' 2> rmdir-logs/component-exact.err || echo COMPONENT-EXACT-$?`,
      `rmdir rmdir-limits/component-victim '${component129}' 2> rmdir-logs/component-over.err || echo COMPONENT-OVER-$?`,
      "rmdir -- rmdir-links/link-0/empty && echo LINKS-EXACT-$?",
      "rmdir rmdir-limits/link-victim rmdir-links/over-link-0/empty 2> rmdir-logs/links-over.err || echo LINKS-OVER-$?",
      "rmdir rmdir-rollback/first rmdir-rollback/second 2> rmdir-logs/rollback.err || echo ROLLBACK-$?",
    ],
    { quiet: true },
  );
  assert.equal(run.exitCode, 0, run.stdout);
  for (const marker of [
    "COUNT-EXACT-0", "COUNT-OVER-2", "PATH-EXACT-1", "PATH-OVER-2",
    "TOTAL-EXACT-1", "TOTAL-OVER-2", "COMPONENT-EXACT-1", "COMPONENT-OVER-2",
    "LINKS-EXACT-0", "LINKS-OVER-2", "ROLLBACK-1",
  ]) assert.match(run.stdout, new RegExp(`(^|\\n)${marker}\\n`), marker);

  assert.deepEqual(fs.readdir("/home/web/rmdir-limits/exact"), []);
  assert.equal(fs.readdir("/home/web/rmdir-limits/over").length, 101);
  for (const path of ["path", "aggregate", "component", "link"])
    assert.equal(fs.exists(`/home/web/rmdir-limits/${path}-victim`), true, path);
  assert.equal(fs.exists("/home/web/rmdir-links/target/empty"), false);
  assert.equal(fs.exists("/home/web/rmdir-links/over-target/empty"), true);
  assert.equal(fs.exists("/home/web/rmdir-rollback/first"), true);
  assert.equal(fs.exists("/home/web/rmdir-rollback/second"), true);

  const decoder = new TextDecoder();
  assert.equal(decoder.decode(fs.readFile("/home/web/rmdir-logs/count-over.err")), "rmdir: too many operands (max 100)\n");
  assert.match(decoder.decode(fs.readFile("/home/web/rmdir-logs/path-exact.err")), /No such file/);
  assert.equal(decoder.decode(fs.readFile("/home/web/rmdir-logs/path-over.err")), "rmdir: path operand exceeds 4096 bytes\n");
  assert.match(decoder.decode(fs.readFile("/home/web/rmdir-logs/total-exact.err")), /No such file/);
  assert.equal(decoder.decode(fs.readFile("/home/web/rmdir-logs/total-over.err")), "rmdir: path operands exceed 65536 bytes\n");
  assert.match(decoder.decode(fs.readFile("/home/web/rmdir-logs/component-exact.err")), /No such file/);
  assert.equal(decoder.decode(fs.readFile("/home/web/rmdir-logs/component-over.err")), "rmdir: path has more than 128 components\n");
  assert.match(decoder.decode(fs.readFile("/home/web/rmdir-logs/links-over.err")), /path resolution limit exceeded/);
  assert.match(decoder.decode(fs.readFile("/home/web/rmdir-logs/rollback.err")), /I\/O error/);
  assert.doesNotMatch(decoder.decode(fs.readFile("/home/web/rmdir-logs/rollback.err")), /rollback failed/);
});

test("slop: cp no-clobber is ordered, recursive, and non-destructive", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/source-tree/sub");
  fs.mkdirTree("/home/web/dest-root/source-tree/sub");
  installShell(fs);
  fs.writeFile("/home/web/source.txt", "source\n");
  fs.writeFile("/home/web/dest.txt", "keep\n");
  fs.writeFile("/home/web/source-tree/sub/existing.txt", "new existing\n");
  fs.writeFile("/home/web/source-tree/sub/fresh.txt", "fresh\n");
  fs.writeFile("/home/web/dest-root/source-tree/sub/existing.txt", "old existing\n");

  const run = await runSlop(
    fs,
    [
      "cp -n source.txt dest.txt && echo CP-N-$?",
      "cp -f source.txt dest.txt",
      "printf 'keep again\\n' > dest.txt",
      "cp -fn source.txt dest.txt",
      "cat dest.txt",
      "cp -nf source.txt dest.txt",
      "cat dest.txt",
      "printf 'long keep\\n' > dest.txt",
      "cp --no-clobber source.txt dest.txt",
      "cat dest.txt",
      "cp -Rn source-tree dest-root",
      "cp --unsupported source.txt dest.txt || echo CP-OPTION-$?",
      "cp --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /CP-N-0\nkeep again\nsource\nlong keep\n/);
  assert.match(run.stdout, /CP-OPTION-2\n/);
  assert.match(run.stdout, /usage: cp .*\[-f\|-n\|--force\|--no-clobber\]/);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/dest.txt")), "long keep\n");
  assert.equal(
    new TextDecoder().decode(fs.readFile("/home/web/dest-root/source-tree/sub/existing.txt")),
    "old existing\n",
  );
  assert.equal(
    new TextDecoder().decode(fs.readFile("/home/web/dest-root/source-tree/sub/fresh.txt")),
    "fresh\n",
  );
  assert.equal(fs.exists("/home/web/dest-root/source-tree/sub/sub"), false);
});

test("slop: recursive cp rejects physical destinations within a source before mutation", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  const decoder = new TextDecoder();
  fs.mkdirTree("/home/web/cp-containment/source/sub");
  fs.mkdirTree("/home/web/cp-containment/safe-source");
  fs.mkdirTree("/home/web/cp-containment/src2");
  fs.mkdirTree("/home/web/cp-containment/outside");
  fs.mkdirTree("/home/web/cp-containment/outside-alias-target");
  fs.mkdirTree("/home/web/cp-logs");
  installShell(fs);
  fs.writeFile("/home/web/cp-containment/source/file.txt", "source\n");
  fs.writeFile("/home/web/cp-containment/source/sub/nested.txt", "nested\n");
  fs.writeFile("/home/web/cp-containment/safe-source/safe.txt", "safe\n");
  fs.writeFile("/home/web/cp-containment/same-file.txt", "same\n");
  fs.symlink("source/sub", "/home/web/cp-containment/inside-alias");
  fs.symlink("outside-alias-target", "/home/web/cp-containment/outside-alias");
  fs.symlink("source", "/home/web/cp-containment/source-alias");
  fs.symlink(".", "/home/web/cp-containment/parent-alias");
  fs.symlink("same-file.txt", "/home/web/cp-containment/same-alias");

  const snapshot = (root: string): string => {
    const rows: Array<[string, string, string]> = [];
    const visit = (path: string, relative: string): void => {
      for (const entry of fs.readdir(path).sort((left, right) => left.name.localeCompare(right.name))) {
        const child = `${path}/${entry.name}`;
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.filetype === FILETYPE.DIRECTORY) {
          rows.push(["d", childRelative, ""]);
          visit(child, childRelative);
        } else if (entry.filetype === FILETYPE.SYMBOLIC_LINK) {
          rows.push(["l", childRelative, fs.readlink(child)]);
        } else {
          rows.push(["f", childRelative, Buffer.from(fs.readFile(child)).toString("hex")]);
        }
      }
    };
    visit(root, "");
    return JSON.stringify(rows);
  };
  const before = snapshot("/home/web/cp-containment");
  const rejectedCommands = [
    "cp -r cp-containment/source cp-containment/source/new",
    "cp -R cp-containment/source cp-containment/source",
    "cp -r cp-containment/source cp-containment/source/sub",
    "cp -r cp-containment/source cp-containment/source/../source/./normalized",
    "cp -r cp-containment/source cp-containment/source//./nested",
    "cp -rn cp-containment/source cp-containment/source/no-clobber",
    "cp -rf cp-containment/source cp-containment/source/force",
    "cp -r cp-containment/source cp-containment/inside-alias",
    "cp -r cp-containment/source-alias cp-containment/source/alias-copy",
    "cp -r cp-containment/source cp-containment/parent-alias",
    "cp -r cp-containment/safe-source cp-containment/source cp-containment/source/sub",
  ];
  const rejected = await runSlop(
    fs,
    rejectedCommands.map((command, index) =>
      `${command} > cp-logs/reject-${index}.out 2> cp-logs/reject-${index}.err || echo $? > cp-logs/reject-${index}.status`
    ),
    { quiet: true },
  );
  assert.equal(rejected.exitCode, 0);
  assert.equal(snapshot("/home/web/cp-containment"), before);
  for (let index = 0; index < rejectedCommands.length; index++) {
    assert.equal(fs.readFile(`/home/web/cp-logs/reject-${index}.out`).byteLength, 0);
    assert.equal(decoder.decode(fs.readFile(`/home/web/cp-logs/reject-${index}.err`)),
      "cp: recursive destination is within source\n");
    assert.equal(decoder.decode(fs.readFile(`/home/web/cp-logs/reject-${index}.status`)), "1\n");
  }
  const sameFile = await runSlop(
    fs,
    [
      "cp cp-containment/same-file.txt cp-containment/same-alias > cp-logs/same.out 2> cp-logs/same.err || echo $? > cp-logs/same.status",
    ],
    { quiet: true },
  );
  assert.equal(sameFile.exitCode, 0);
  assert.equal(snapshot("/home/web/cp-containment"), before);
  assert.equal(fs.readFile("/home/web/cp-logs/same.out").byteLength, 0);
  assert.equal(decoder.decode(fs.readFile("/home/web/cp-logs/same.err")),
    "cp: 'cp-containment/same-file.txt' and 'cp-containment/same-alias' are the same file\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/cp-logs/same.status")), "1\n");

  fs.mkdirTree("/home/web/cp-containment/existing-outside");
  fs.mkdirTree("/home/web/-lead dir");
  fs.mkdirTree("/home/web/odd\nsource");
  fs.mkdirTree("/home/web/tab\tsource");
  fs.writeFile("/home/web/-lead dir/line\nname", "odd\n");
  fs.writeFile("/home/web/odd\nsource/value.txt", "newline\n");
  fs.writeFile("/home/web/tab\tsource/value.txt", "tab\n");
  const successful = await runSlop(
    fs,
    [
      "set -e",
      "cp -r cp-containment/source cp-containment/outside-new",
      "cp -r cp-containment/source cp-containment/existing-outside",
      "cp -r cp-containment/source/ cp-containment/src2",
      "cp -r cp-containment/source cp-containment/outside-alias",
      "cp -r cp-containment/source cp-containment/src2-prefix-copy",
      "cp -r -- '-lead dir' 'odd destination'",
      "ODD=$(printf 'odd\\nsource')",
      "cp -r -- \"$ODD\" odd-newline-dest",
      "TAB=$(printf 'tab\\tsource')",
      "cp -r -- \"$TAB\" odd-tab-dest",
    ],
    { quiet: true },
  );
  assert.equal(successful.exitCode, 0, successful.stdout);
  for (const path of [
    "/home/web/cp-containment/outside-new/file.txt",
    "/home/web/cp-containment/existing-outside/source/sub/nested.txt",
    "/home/web/cp-containment/src2/source/file.txt",
    "/home/web/cp-containment/outside-alias-target/source/file.txt",
    "/home/web/cp-containment/src2-prefix-copy/file.txt",
  ]) assert.equal(fs.exists(path), true, `${path}\n${snapshot("/home/web/cp-containment")}\n${successful.stdout}`);
  assert.equal(decoder.decode(fs.readFile("/home/web/odd destination/line\nname")), "odd\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/odd-newline-dest/value.txt")), "newline\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/odd-tab-dest/value.txt")), "tab\n");

  const limitRoot = "/home/web/cp-limits";
  fs.mkdirTree(`${limitRoot}/exact-destination`);
  fs.mkdirTree(`${limitRoot}/over-destination`);
  const sources = Array.from({ length: 101 }, (_, index) => `cp-limits/source-${index}`);
  for (const source of sources) fs.writeFile(`/home/web/${source}`, `${source}\n`);
  const component128 = Array.from({ length: 128 }, (_, index) => `c${index}`).join("/");
  const component129 = `${component128}/overflow`;
  fs.mkdirTree(`/home/web/${component128}`);
  fs.writeFile(`/home/web/${component128}/value.txt`, "deep\n");
  const exactBytesSources = [
    ...Array.from({ length: 15 }, (_, index) => `${String(index).padStart(2, "0")}${"x".repeat(4094)}`),
    `z${"x".repeat(4090)}`,
  ];
  const overBytesSources = [...exactBytesSources.slice(0, -1), `z${"x".repeat(4091)}`];
  const exactPath = `p${"x".repeat(4095)}`;
  const overPath = `${exactPath}x`;
  fs.mkdirTree(`${limitRoot}/link-target`);
  fs.writeFile(`${limitRoot}/link-target/value.txt`, "links\n");
  for (let index = 39; index >= 0; index--) {
    fs.symlink(index === 39 ? "link-target" : `link-${index + 1}`, `${limitRoot}/link-${index}`);
  }
  for (let index = 40; index >= 0; index--) {
    fs.symlink(index === 40 ? "link-target" : `link-over-${index + 1}`, `${limitRoot}/link-over-${index}`);
  }

  const limits = await runSlop(
    fs,
    [
      `cp ${sources.slice(0, 100).join(" ")} cp-limits/exact-destination`,
      `cp ${sources.join(" ")} cp-limits/over-destination > cp-logs/sources.out 2> cp-logs/sources.err || echo SOURCES-$?`,
      `cp -r ${component128} cp-limits/component-copy`,
      `cp -r ${component129} cp-limits/component-over > cp-logs/components.out 2> cp-logs/components.err || echo COMPONENTS-$?`,
      `cp '${exactPath}' cp-limits/path-exact > cp-logs/path-exact.out 2> cp-logs/path-exact.err || echo PATH-EXACT-$?`,
      `cp '${overPath}' cp-limits/path-over > cp-logs/path-over.out 2> cp-logs/path-over.err || echo PATH-OVER-$?`,
      `cp ${exactBytesSources.join(" ")} total > cp-logs/total-exact.out 2> cp-logs/total-exact.err || echo TOTAL-EXACT-$?`,
      `cp ${overBytesSources.join(" ")} total > cp-logs/total-over.out 2> cp-logs/total-over.err || echo TOTAL-OVER-$?`,
      "cp -r cp-limits/link-0 cp-limits/link-copy",
      "cp -r cp-limits/link-over-0 cp-limits/link-over-copy > cp-logs/links.out 2> cp-logs/links.err || echo LINKS-$?",
      "cp --help",
    ],
    { quiet: true },
  );
  assert.equal(limits.exitCode, 0, limits.stdout);
  assert.equal(fs.exists("/home/web/cp-limits/exact-destination/source-99"), true);
  assert.equal(fs.readdir("/home/web/cp-limits/over-destination").length, 0);
  assert.equal(decoder.decode(fs.readFile("/home/web/cp-limits/component-copy/value.txt")), "deep\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/cp-limits/link-copy/value.txt")), "links\n");
  assert.equal(fs.exists("/home/web/cp-limits/link-over-copy"), false);
  assert.match(limits.stdout, /SOURCES-2\n/);
  assert.equal(decoder.decode(fs.readFile("/home/web/cp-logs/sources.err")), "cp: too many sources (max 100)\n");
  assert.match(limits.stdout, /COMPONENTS-1\n/);
  assert.equal(decoder.decode(fs.readFile("/home/web/cp-logs/components.err")), "cp: path has too many components\n");
  assert.match(limits.stdout, /PATH-EXACT-1\n/);
  assert.match(decoder.decode(fs.readFile("/home/web/cp-logs/path-exact.err")), /^cp: .*: /);
  assert.match(limits.stdout, /PATH-OVER-2\n/);
  assert.equal(decoder.decode(fs.readFile("/home/web/cp-logs/path-over.err")), "cp: path operand exceeds 4096 bytes\n");
  assert.match(limits.stdout, /TOTAL-EXACT-1\n/);
  assert.match(limits.stdout, /TOTAL-OVER-2\n/);
  assert.equal(decoder.decode(fs.readFile("/home/web/cp-logs/total-over.err")), "cp: path operands exceed 65536 bytes\n");
  assert.match(limits.stdout, /LINKS-1\n/);
  assert.match(decoder.decode(fs.readFile("/home/web/cp-logs/links.err")), /^cp: cp-limits\/link-over-0: /);
  assert.match(limits.stdout, /usage: cp .*max 100 sources.*4096 bytes per path.*65536 path bytes/s);
});

test("slop: mv batches mixed sources with invocation-wide preflight", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  const decoder = new TextDecoder();
  fs.mkdirTree("/home/web/mv-batch/tree/sub");
  fs.mkdirTree("/home/web/mv-batch/dest");
  fs.mkdirTree("/home/web/mv-batch/merge-source/sub");
  fs.mkdirTree("/home/web/mv-batch/dest/merge-source");
  fs.mkdirTree("/home/web/mv-reject/tree/sub");
  fs.mkdirTree("/home/web/mv-reject/dest");
  fs.mkdirTree("/home/web/mv-reject/left");
  fs.mkdirTree("/home/web/mv-reject/right");
  fs.mkdirTree("/home/web/mv-reject/overlap/sub");
  fs.mkdirTree("/home/web/mv-reject/typed");
  fs.mkdirTree("/home/web/mv-logs");
  installShell(fs);

  fs.writeFile("/home/web/mv-batch/alpha.txt", "alpha\n");
  fs.writeFile("/home/web/mv-batch/b space.txt", "space\n");
  fs.writeFile("/home/web/mv-batch/tree/sub/nested.txt", "nested\n");
  fs.symlink("alpha.txt", "/home/web/mv-batch/link");
  fs.writeFile("/home/web/mv-batch/merge-source/sub/new.txt", "merged\n");
  fs.writeFile("/home/web/mv-batch/dest/merge-source/existing.txt", "existing\n");
  fs.symlink("sub/new.txt", "/home/web/mv-batch/merge-source/new-link");
  fs.writeFile("/home/web/mv-batch/no-clobber-one", "new one\n");
  fs.writeFile("/home/web/mv-batch/no-clobber-two", "new two\n");
  fs.writeFile("/home/web/mv-batch/dest/no-clobber-one", "old one\n");
  fs.writeFile("/home/web/mv-batch/force-source", "forced\n");
  fs.writeFile("/home/web/mv-batch/dest/force-source", "old force\n");
  fs.writeFile("/home/web/mv-batch/long-skip", "skip source\n");
  fs.writeFile("/home/web/mv-batch/dest/long-skip", "skip target\n");
  fs.writeFile("/home/web/-leading", "leading\n");
  fs.writeFile("/home/web/line\nname", "newline\n");

  const successful = await runSlop(
    fs,
    [
      "set -e",
      "mv -- mv-batch/alpha.txt 'mv-batch/b space.txt' mv-batch/link mv-batch/tree mv-batch/dest",
      "mv --no-clobber mv-batch/no-clobber-one mv-batch/no-clobber-two mv-batch/dest",
      "mv -nf mv-batch/force-source mv-batch/dest",
      "mv --force --no-clobber mv-batch/long-skip mv-batch/dest",
      "mv mv-batch/merge-source mv-batch/dest",
      "NL=$(printf 'line\\nname')",
      "mv -- -leading \"$NL\" mv-batch/dest",
      "mv --help",
    ],
    { quiet: true },
  );
  assert.equal(successful.exitCode, 0, successful.stdout);
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-batch/dest/alpha.txt")), "alpha\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-batch/dest/b space.txt")), "space\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-batch/dest/tree/sub/nested.txt")), "nested\n");
  assert.equal(fs.readlink("/home/web/mv-batch/dest/link"), "alpha.txt");
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-batch/no-clobber-one")), "new one\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-batch/dest/no-clobber-one")), "old one\n");
  assert.equal(fs.exists("/home/web/mv-batch/no-clobber-two"), false);
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-batch/dest/no-clobber-two")), "new two\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-batch/dest/force-source")), "forced\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-batch/long-skip")), "skip source\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-batch/dest/long-skip")), "skip target\n");
  assert.equal(fs.exists("/home/web/mv-batch/merge-source"), false);
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-batch/dest/merge-source/existing.txt")), "existing\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-batch/dest/merge-source/sub/new.txt")), "merged\n");
  assert.equal(fs.readlink("/home/web/mv-batch/dest/merge-source/new-link"), "sub/new.txt");
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-batch/dest/-leading")), "leading\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-batch/dest/line\nname")), "newline\n");
  assert.match(successful.stdout, /usage: mv .*SOURCE\.\.\. DEST.*max 100 sources/s);

  fs.writeFile("/home/web/mv-reject/safe", "safe\n");
  fs.writeFile("/home/web/mv-reject/not-dir", "not a directory\n");
  fs.writeFile("/home/web/mv-reject/tree/sub/value", "tree\n");
  fs.symlink("tree/sub", "/home/web/mv-reject/inside-alias");
  fs.writeFile("/home/web/mv-reject/left/x", "left\n");
  fs.writeFile("/home/web/mv-reject/right/x", "right\n");
  fs.writeFile("/home/web/mv-reject/overlap/sub/item", "overlap\n");
  fs.writeFile("/home/web/mv-reject/typed/value", "directory\n");
  fs.writeFile("/home/web/mv-reject/dest/typed", "target file\n");
  fs.writeFile("/home/web/mv-reject/dest/already", "already there\n");
  fs.writeFile("/home/web/mv-reject/other", "other\n");

  const snapshot = (root: string): string => {
    const rows: Array<[string, string, string]> = [];
    const visit = (path: string, relative: string): void => {
      for (const entry of fs.readdir(path).sort((left, right) => left.name.localeCompare(right.name))) {
        const child = `${path}/${entry.name}`;
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.filetype === FILETYPE.DIRECTORY) {
          rows.push(["d", childRelative, ""]);
          visit(child, childRelative);
        } else if (entry.filetype === FILETYPE.SYMBOLIC_LINK) {
          rows.push(["l", childRelative, fs.readlink(child)]);
        } else {
          rows.push(["f", childRelative, Buffer.from(fs.readFile(child)).toString("hex")]);
        }
      }
    };
    visit(root, "");
    return JSON.stringify(rows);
  };
  const before = snapshot("/home/web/mv-reject");
  const rejectedCommands = [
    "mv mv-reject/safe mv-reject/tree mv-reject/not-dir",
    "mv mv-reject/safe mv-reject/missing mv-reject/dest",
    "mv mv-reject/safe mv-reject/tree mv-reject/tree/sub",
    "mv mv-reject/safe mv-reject/tree mv-reject/inside-alias",
    "mv mv-reject/left/x mv-reject/right/x mv-reject/dest",
    "mv mv-reject/overlap mv-reject/overlap/sub/item mv-reject/dest",
    "mv mv-reject/dest/already mv-reject/other mv-reject/dest",
    "mv mv-reject/safe mv-reject/typed mv-reject/dest",
  ];
  const rejected = await runSlop(
    fs,
    [
      ...rejectedCommands.map((command, index) =>
        `${command} > mv-logs/reject-${index}.out 2> mv-logs/reject-${index}.err || echo $? > mv-logs/reject-${index}.status`),
      "mv --unsupported mv-reject/safe mv-reject/dest || echo OPTION-$?",
      "mv mv-reject/safe || echo ARITY-$?",
    ],
    { quiet: true },
  );
  assert.equal(rejected.exitCode, 0);
  assert.equal(snapshot("/home/web/mv-reject"), before);
  const diagnostics = [
    "mv: destination must be a directory\n",
    null,
    "mv: destination is within source\n",
    "mv: destination is within source\n",
    "mv: multiple sources map to the same target\n",
    "mv: source operands overlap\n",
    "mv: source and target operands overlap\n",
    "mv: incompatible source and target types\n",
  ];
  for (let index = 0; index < rejectedCommands.length; index++) {
    assert.equal(fs.readFile(`/home/web/mv-logs/reject-${index}.out`).byteLength, 0);
    assert.equal(decoder.decode(fs.readFile(`/home/web/mv-logs/reject-${index}.status`)), "1\n");
    const stderr = decoder.decode(fs.readFile(`/home/web/mv-logs/reject-${index}.err`));
    if (diagnostics[index]) assert.equal(stderr, diagnostics[index]);
    else assert.match(stderr, /^mv: mv-reject\/missing: /);
  }
  assert.match(rejected.stdout, /OPTION-2\n/);
  assert.match(rejected.stdout, /ARITY-1\n/);
});

test("slop: mv planner enforces exact published limits before mutation", { timeout: 120_000 }, async () => {
  const fs = new MemoryFs();
  const decoder = new TextDecoder();
  fs.mkdirTree("/home/web/mv-limits/exact-destination");
  fs.mkdirTree("/home/web/mv-limits/over-destination");
  fs.mkdirTree("/home/web/mv-limits/deep-destination");
  fs.mkdirTree("/home/web/mv-limits/link-target");
  fs.mkdirTree("/home/web/mv-logs");
  fs.mkdirTree("/home/web/t");
  fs.mkdirTree("/home/web/u");
  installShell(fs);

  const exactSources = Array.from({ length: 100 }, (_, index) => `mv-limits/source-${index}`);
  const overSources = Array.from({ length: 101 }, (_, index) => `mv-limits/over-source-${index}`);
  for (const source of exactSources) fs.writeFile(`/home/web/${source}`, `${source}\n`);
  for (const source of overSources) fs.writeFile(`/home/web/${source}`, `${source}\n`);
  const component128 = Array.from({ length: 128 }, (_, index) => `m${index}`).join("/");
  const component129 = `${component128}/overflow`;
  fs.mkdirTree(`/home/web/${component128.slice(0, component128.lastIndexOf("/"))}`);
  fs.writeFile(`/home/web/${component128}`, "deep\n");
  const exactPath = `p${"x".repeat(4095)}`;
  const overPath = `${exactPath}x`;
  const exactBytesSources = [
    ...Array.from({ length: 15 }, (_, index) => `${String(index).padStart(2, "0")}${"x".repeat(4094)}`),
    `z${"x".repeat(4094)}`,
  ];
  const overBytesSources = [...exactBytesSources.slice(0, -1), `z${"x".repeat(4095)}`];
  fs.writeFile("/home/web/mv-limits/link-exact-source", "links\n");
  fs.writeFile("/home/web/mv-limits/link-over-source", "over links\n");
  for (let index = 39; index >= 0; index--) {
    fs.symlink(index === 39 ? "link-target" : `link-${index + 1}`, `/home/web/mv-limits/link-${index}`);
  }
  for (let index = 40; index >= 0; index--) {
    fs.symlink(index === 40 ? "link-target" : `link-over-${index + 1}`, `/home/web/mv-limits/link-over-${index}`);
  }

  const limits = await runSlop(
    fs,
    [
      `mv ${exactSources.join(" ")} mv-limits/exact-destination`,
      `mv ${overSources.join(" ")} mv-limits/over-destination > mv-logs/sources.out 2> mv-logs/sources.err || echo SOURCES-$?`,
      `mv ${component128} mv-limits/deep-destination`,
      `mv ${component129} mv-limits/deep-destination > mv-logs/components.out 2> mv-logs/components.err || echo COMPONENTS-$?`,
      `mv '${exactPath}' mv-limits/path-exact > mv-logs/path-exact.out 2> mv-logs/path-exact.err || echo PATH-EXACT-$?`,
      `mv '${overPath}' mv-limits/path-over > mv-logs/path-over.out 2> mv-logs/path-over.err || echo PATH-OVER-$?`,
      `mv ${exactBytesSources.join(" ")} t > mv-logs/total-exact.out 2> mv-logs/total-exact.err || echo TOTAL-EXACT-$?`,
      `mv ${overBytesSources.join(" ")} u > mv-logs/total-over.out 2> mv-logs/total-over.err || echo TOTAL-OVER-$?`,
      "mv mv-limits/link-exact-source mv-limits/link-0",
      "mv mv-limits/link-over-source mv-limits/link-over-0 > mv-logs/links.out 2> mv-logs/links.err || echo LINKS-$?",
      "mv --help",
    ],
    { quiet: true },
  );
  assert.equal(limits.exitCode, 0, limits.stdout);
  assert.equal(fs.exists("/home/web/mv-limits/exact-destination/source-99"), true);
  assert.equal(fs.readdir("/home/web/mv-limits/over-destination").length, 0);
  assert.equal(fs.exists("/home/web/mv-limits/over-source-100"), true);
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-limits/deep-destination/m127")), "deep\n");
  assert.equal(
    fs.exists("/home/web/mv-limits/link-target/link-exact-source"),
    true,
    `${limits.stdout}\n${fs.readdir("/home/web/mv-limits").map((entry) => `${entry.name}:${entry.filetype}`).join("\n")}`,
  );
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-limits/link-target/link-exact-source")), "links\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-limits/link-over-source")), "over links\n");
  assert.match(limits.stdout, /SOURCES-2\n/);
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-logs/sources.err")), "mv: too many sources (max 100)\n");
  assert.match(limits.stdout, /COMPONENTS-1\n/);
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-logs/components.err")), "mv: path has too many components\n");
  assert.match(limits.stdout, /PATH-EXACT-1\n/);
  assert.match(decoder.decode(fs.readFile("/home/web/mv-logs/path-exact.err")), /^mv: .*: /);
  assert.match(limits.stdout, /PATH-OVER-2\n/);
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-logs/path-over.err")), "mv: path operand exceeds 4096 bytes\n");
  assert.match(limits.stdout, /TOTAL-EXACT-1\n/);
  assert.match(limits.stdout, /TOTAL-OVER-2\n/);
  assert.equal(decoder.decode(fs.readFile("/home/web/mv-logs/total-over.err")), "mv: path operands exceed 65536 bytes\n");
  assert.match(limits.stdout, /LINKS-1\n/);
  assert.match(decoder.decode(fs.readFile("/home/web/mv-logs/links.err")), /^mv: mv-limits\/link-over-0: /);
  assert.match(limits.stdout, /usage: mv .*max 100 sources.*4096 bytes per path.*65536 path bytes/s);
});

test("slop: common bounded utility forms are compatible and explicit", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/tree/sub");
  installShell(fs);
  fs.writeFile("/home/web/tree/a.txt", "10\n2\n30\n");
  fs.writeFile("/home/web/tree/sub/b.txt", "header\nsecond\nthird\n");
  fs.symlink("../a.txt", "/home/web/tree/sub/a-link");
  fs.symlink("loop-b", "/home/web/tree/sub/loop-a");
  fs.symlink("loop-a", "/home/web/tree/sub/loop-b");

  const run = await runSlop(
    fs,
    [
      "cp -R tree tree-copy",
      "cp -a tree archive-copy || echo CP-ARCHIVE-$?",
      "cp -p tree/a.txt preserved.txt || echo CP-PRESERVE-$?",
      "install -m 755 tree/a.txt installed.txt || echo INSTALL-MODE-$?",
      "head -c 4 tree/a.txt; echo",
      "tail -n +2 tree/sub/b.txt",
      "sort -n tree/a.txt",
      "printf 'left:right\\n' | cut -d: -f1",
      "find tree -maxdepth 1 -type f -name '*.txt'",
      "find tree -type f -print0 | xargs -0 -n 1 basename | sort",
      "readlink tree/sub/a-link",
      "readlink -f tree/sub/a-link",
      "readlink --canonicalize tree/sub/../a.txt",
      "readlink -f missing-link || echo READLINK-MISSING-$?",
      "readlink -f tree/sub/loop-a || echo READLINK-LOOP-$?",
      "readlink --unsupported tree/sub/a-link || echo READLINK-OPTION-$?",
      "printf '' | xargs -r echo SHOULD-NOT-RUN",
      "printf 'x' | xargs definitely-missing || echo XARGS-MISSING-$?",
      "rm --definitely-unsupported tree/a.txt || echo RM-STRICT-$?",
      "head --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/tree-copy/sub/b.txt")), "header\nsecond\nthird\n");
  assert.match(run.stdout, /10\n2\nsecond\nthird\n2\n10\n30\nleft\n/);
  assert.match(run.stdout, /tree\/a\.txt\n/);
  assert.match(run.stdout, /a\.txt\nb\.txt\n/);
  assert.match(run.stdout, /\.\.\/a\.txt\n\/home\/web\/tree\/a\.txt\n\/home\/web\/tree\/a\.txt\n/);
  assert.match(run.stdout, /READLINK-MISSING-1\n/);
  assert.match(run.stdout, /READLINK-LOOP-1\n/);
  assert.match(run.stdout, /READLINK-OPTION-2\n/);
  assert.doesNotMatch(run.stdout, /SHOULD-NOT-RUN/);
  assert.match(run.stdout, /xargs: command not found: definitely-missing\nXARGS-MISSING-127\n/);
  assert.match(run.stdout, /rm: unsupported option: --definitely-unsupported/);
  assert.match(run.stdout, /RM-STRICT-2\n/);
  assert.match(run.stdout, /CP-ARCHIVE-2\n/);
  assert.match(run.stdout, /CP-PRESERVE-2\n/);
  assert.match(run.stdout, /INSTALL-MODE-2\n/);
  assert.match(run.stdout, /usage: head/);
  assert.equal(fs.exists("/home/web/archive-copy"), false);
  assert.equal(fs.exists("/home/web/preserved.txt"), false);
  assert.equal(fs.exists("/home/web/installed.txt"), false);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/tree/a.txt")), "10\n2\n30\n");
});

test("slop: agent filesystem queries are structured, composable, and bounded", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/tree/sub");
  installShell(fs);
  fs.writeFile("/home/web/tree/a.txt", "10\n2\n30\n");
  fs.writeFile("/home/web/tree/sub/b.txt", "header\nsecond\nthird\n");
  fs.symlink("../a.txt", "/home/web/tree/sub/a-link");

  const run = await runSlop(
    fs,
    [
      "echo FIND-PATH",
      "find tree -mindepth 2 -path 'tree/sub/*.txt' -type f",
      "find tree -type q || echo FIND-TYPE-$?",
      "echo WC-MULTI",
      "wc -l tree/a.txt tree/sub/b.txt",
      "echo STAT-FORMATS",
      "stat -c '%s %n %F' tree/a.txt",
      "stat -c '%F %n' tree/sub/a-link",
      "stat -L -c '%F %n' tree/sub/a-link",
      "stat -c '%a' tree/a.txt || echo STAT-MODE-$?",
      "stat -c '%Q' tree/a.txt || echo STAT-FORMAT-$?",
      "TMPDIR=$PWD mktemp -t agent.XXXXXX > temp-name",
      "test -f \"$(cat temp-name)\" && echo MKTEMP-T-OK",
      "mktemp -t nested/agent.XXXXXX || echo MKTEMP-TEMPLATE-$?",
      "command -v stat",
      "stat --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /FIND-PATH\ntree\/sub\/b\.txt\n/);
  assert.match(run.stdout, /FIND-TYPE-2\n/);
  assert.match(
    run.stdout,
    /WC-MULTI\n3 tree\/a\.txt\n3 tree\/sub\/b\.txt\n6 total\n/,
  );
  assert.match(run.stdout, /STAT-FORMATS\n8 tree\/a\.txt regular file\n/);
  assert.match(run.stdout, /symbolic link tree\/sub\/a-link\nregular file tree\/sub\/a-link\n/);
  assert.match(run.stdout, /STAT-MODE-2\n/);
  assert.match(run.stdout, /STAT-FORMAT-2\n/);
  assert.match(run.stdout, /MKTEMP-T-OK\n/);
  assert.match(run.stdout, /MKTEMP-TEMPLATE-2\n/);
  assert.match(run.stdout, /\/bin\/stat\nusage: stat/);
  assert.match(run.stdout, /formats: %%, %s %n %F %i %d %h %Y; permission modes unavailable/);
});

test("slop: bounded diff emits usable unified output and conventional statuses", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile("/home/web/expected.txt", "same\nold\ntail\n");
  fs.writeFile("/home/web/actual.txt", "same\nnew\ntail\n");
  fs.writeFile("/home/web/no-newline.txt", "same\nnew\ntail");

  const run = await runSlop(
    fs,
    [
      "diff -u expected.txt expected.txt && echo DIFF-EQUAL-$?",
      "diff -U 1 expected.txt actual.txt || echo DIFF-CHANGED-$?",
      "diff -q expected.txt actual.txt || echo DIFF-BRIEF-$?",
      "diff -u actual.txt no-newline.txt || echo DIFF-NO-NEWLINE-$?",
      "diff --recursive expected.txt actual.txt || echo DIFF-OPTION-$?",
      "diff missing.txt actual.txt || echo DIFF-TROUBLE-$?",
      "command -v diff",
      "diff --help",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /DIFF-EQUAL-0\n/);
  assert.match(
    run.stdout,
    /--- expected\.txt\n\+\+\+ actual\.txt\n@@ -1,3 \+1,3 @@\n same\n-old\n\+new\n tail\nDIFF-CHANGED-1\n/,
  );
  assert.match(run.stdout, /Files expected\.txt and actual\.txt differ\nDIFF-BRIEF-1\n/);
  assert.match(run.stdout, /\\ No newline at end of file\nDIFF-NO-NEWLINE-1\n/);
  assert.match(run.stdout, /DIFF-OPTION-2\n/);
  assert.match(run.stdout, /DIFF-TROUBLE-2\n/);
  assert.match(run.stdout, /\/bin\/diff\nusage: diff/);
  assert.equal(fs.exists("/home/web/missing.txt"), false);
});

test("slop: common text inspection and Make workflows", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/project");
  installShell(fs);
  fs.writeFile("/home/web/project/input.txt", "alpha\nbeta\ngamma\ndelta\n");
  fs.writeFile("/home/web/project/--needle.txt", "needle dash\n");
  fs.writeFile("/home/web/project/matches.txt", "needle one\nneedle two\nplain\n");
  fs.writeFile("/home/web/project/member.o", "bounded-object\n");
  fs.writeFile(
    "/home/web/project/Makefile",
    "OUTPUT := output.txt\n.PHONY: all check\nall: $(OUTPUT)\n$(OUTPUT): input.txt\n\tcp $< $@\ncheck: $(OUTPUT)\n\tgrep -Eq '^beta$$' $(OUTPUT)\n",
  );

  const run = await runSlop(
    fs,
    [
      "cd project",
      "printf '%s\\n' one two",
      "sed -n '2,3p' input.txt",
      "grep needle -- --needle.txt && echo GREP-DASH-OK",
      "rg needle -- --needle.txt && echo RG-DASH-OK",
      "sed 's/needle/NEEDLE/' -- --needle.txt",
      "tail -n 1 -- --needle.txt",
      "grep --help | grep -F '[--]' >/dev/null",
      "rg --help | grep -F '[--]' >/dev/null",
      "grep --help | grep -F -- '--max-count' >/dev/null",
      "rg --help | grep -F -- '--max-count' >/dev/null",
      "sed --help | grep -F '[--]' >/dev/null",
      "tail --help | grep -F '[--]' >/dev/null",
      "echo GREP-MAX",
      "grep -m 1 needle matches.txt",
      "echo GREP-WITHOUT",
      "grep -L needle matches.txt input.txt",
      "echo RG-MAX",
      "rg --max-count 1 needle matches.txt",
      "echo RG-WITHOUT",
      "rg --files-without-match needle matches.txt input.txt",
      "grep -m nope needle matches.txt || echo GREP-MAX-BAD-$?",
      "rg -L needle matches.txt || echo RG-SYMLINK-BAD-$?",
      "cp input.txt editable.txt",
      "sed -i 's/beta/BETA/' editable.txt",
      "cat editable.txt",
      "cp input.txt backup-edit.txt",
      "sed -i.bak 's/gamma/GAMMA/' backup-edit.txt",
      "cat backup-edit.txt backup-edit.txt.bak",
      "grep -Eq '^beta$' input.txt && echo GREP-QUIET-OK",
      "printf 'a  b   c\\n' | tr -s ' '",
      "printf 'AbC\\r\\n' | tr '[:upper:]' '[:lower:]' | tr -d '\\r'",
      "ar rcs libdemo.a member.o",
      "ar t libdemo.a",
      "make check",
      "cat output.txt",
      "make -q output.txt && echo MAKE-CURRENT",
      "make missing || echo MAKE-MISSING-$?",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /^one\ntwo\nbeta\ngamma\n/m);
  assert.match(run.stdout, /GREP-QUIET-OK\na b c\nabc\n/);
  assert.match(run.stdout, /needle dash\nGREP-DASH-OK\n1:needle dash\nRG-DASH-OK\nNEEDLE dash\nneedle dash\n/);
  assert.match(run.stdout, /alpha\nBETA\ngamma\ndelta\nalpha\nbeta\nGAMMA\ndelta\nalpha\nbeta\ngamma\ndelta\n/);
  assert.match(run.stdout, /GREP-MAX\nneedle one\nGREP-WITHOUT\ninput\.txt\nRG-MAX\n1:needle one\nRG-WITHOUT\ninput\.txt\n/);
  assert.match(run.stdout, /GREP-MAX-BAD-2\n/);
  assert.match(run.stdout, /rg: -L symlink traversal is unavailable/);
  assert.match(run.stdout, /RG-SYMLINK-BAD-2\n/);
  assert.match(run.stdout, /cp input\.txt output\.txt/);
  assert.match(run.stdout, /member\.o\n/);
  assert.match(run.stdout, /alpha\nbeta\ngamma\ndelta\n/);
  assert.match(run.stdout, /MAKE-CURRENT\n/);
  assert.match(run.stdout, /MAKE-MISSING-[12]\n/);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/project/output.txt")), "alpha\nbeta\ngamma\ndelta\n");
});

test("slop: Make uses conservative full-subsecond prerequisite freshness", async () => {
  const fs = new MemoryFs();
  const decoder = new TextDecoder();
  fs.mkdirTree("/home/web/make-time");
  installShell(fs);
  fs.writeFile(
    "/home/web/make-time/Makefile",
    [
      "equal-result: equal-source",
      "\tcp $< $@",
      "nano-result: nano-source",
      "\tcp $< $@",
      "fresh-result: fresh-source",
      "\tcp $< $@",
      "order-result: | order-source",
      "\tprintf 'rebuilt\\n' > $@",
      "linked-result: linked-source",
      "\tcp $< $@",
      "auto-result: auto-source | auto-order",
      "\tprintf '%s\\n' '$?' > auto-newer",
      "dry-result: dry-source",
      "\tcp $< $@",
      "",
    ].join("\n"),
  );
  for (const [name, content] of [
    ["equal-source", "equal source\n"], ["equal-result", "stale equal\n"],
    ["nano-source", "nano source\n"], ["nano-result", "stale nano\n"],
    ["fresh-source", "older source\n"], ["fresh-result", "fresh target\n"],
    ["order-source", "order source\n"], ["order-result", "order target\n"],
    ["real-source", "linked source\n"], ["linked-result", "stale linked\n"],
    ["auto-source", "auto source\n"], ["auto-order", "auto order\n"], ["auto-result", "stale auto\n"],
    ["dry-source", "dry source\n"], ["dry-result", "stale dry\n"],
    ["touch-source", "touch source\n"], ["touch-result", "touch target\n"],
  ] as const) fs.writeFile(`/home/web/make-time/${name}`, content);
  fs.symlink("real-source", "/home/web/make-time/linked-source");

  const setTimes = (left: string, leftTime: bigint, right: string, rightTime: bigint): void => {
    fs.utimes(`/home/web/make-time/${left}`, null, leftTime);
    fs.utimes(`/home/web/make-time/${right}`, null, rightTime);
  };
  setTimes("equal-source", 10_000_000_123n, "equal-result", 10_000_000_123n);
  setTimes("nano-source", 20_000_000_200n, "nano-result", 20_000_000_100n);
  setTimes("fresh-source", 30_000_000_100n, "fresh-result", 30_000_000_200n);
  setTimes("order-source", 40_000_000_500n, "order-result", 40_000_000_500n);
  setTimes("real-source", 50_000_000_700n, "linked-result", 50_000_000_700n);
  setTimes("auto-source", 60_000_000_900n, "auto-result", 60_000_000_900n);
  fs.utimes("/home/web/make-time/auto-order", null, 60_000_000_900n);
  setTimes("dry-source", 70_000_000_111n, "dry-result", 70_000_000_111n);
  setTimes("touch-source", 80_000_000_222n, "touch-result", 80_000_000_222n);
  fs.writeFile("/home/web/make-time/Touchfile", "touch-result: touch-source\n");
  const touchBefore = fs.stat("/home/web/make-time/touch-result", true).mtim;

  const run = await runSlop(fs, [
    "make -C make-time -q fresh-result equal-result > multi-q.out 2> multi-q.err; echo MULTI-Q-$?",
    "make -C make-time -q equal-result > equal-q.out 2> equal-q.err; echo EQUAL-Q-$?",
    "make -C make-time equal-result > equal-build.out 2> equal-build.err; echo EQUAL-BUILD-$?",
    "make -C make-time -q equal-result > equal-current.out 2> equal-current.err; echo EQUAL-CURRENT-$?",
    "make -C make-time -q nano-result > nano-q.out 2> nano-q.err; echo NANO-Q-$?",
    "make -C make-time nano-result > nano-build.out 2> nano-build.err; echo NANO-BUILD-$?",
    "make -C make-time -q fresh-result > fresh-q.out 2> fresh-q.err; echo FRESH-Q-$?",
    "make -C make-time fresh-result > fresh-build.out 2> fresh-build.err; echo FRESH-BUILD-$?",
    "make -C make-time -q order-result > order-q.out 2> order-q.err; echo ORDER-Q-$?",
    "make -C make-time order-result > order-build.out 2> order-build.err; echo ORDER-BUILD-$?",
    "make -C make-time -q linked-result > linked-q.out 2> linked-q.err; echo LINKED-Q-$?",
    "make -C make-time linked-result > linked-build.out 2> linked-build.err; echo LINKED-BUILD-$?",
    "make -C make-time auto-result > auto-build.out 2> auto-build.err; echo AUTO-BUILD-$?",
    "make -C make-time -n dry-result > dry-run.out 2> dry-run.err; echo DRY-RUN-$?",
    "make -C make-time -f Touchfile -t touch-result > touch.out 2> touch.err; echo TOUCH-$?",
    "make --help",
  ], { quiet: true });

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /MULTI-Q-1\nEQUAL-Q-1\nEQUAL-BUILD-0\nEQUAL-CURRENT-0\n/);
  assert.match(run.stdout, /NANO-Q-1\nNANO-BUILD-0\nFRESH-Q-0\nFRESH-BUILD-0\n/);
  assert.match(run.stdout, /ORDER-Q-0\nORDER-BUILD-0\nLINKED-Q-1\nLINKED-BUILD-0\nAUTO-BUILD-0\nDRY-RUN-0\nTOUCH-0\n/);
  for (const path of ["multi-q", "equal-q", "equal-current", "nano-q", "fresh-q", "fresh-build", "order-q", "order-build", "linked-q"])
    assert.equal(fs.readFile(`/home/web/${path}.out`).byteLength, 0, path);
  for (const path of ["multi-q", "equal-q", "equal-build", "equal-current", "nano-q", "nano-build", "fresh-q", "fresh-build", "order-q", "order-build", "linked-q", "linked-build", "auto-build", "dry-run", "touch"])
    assert.equal(fs.readFile(`/home/web/${path}.err`).byteLength, 0, path);
  assert.equal(decoder.decode(fs.readFile("/home/web/equal-build.out")), "cp equal-source equal-result\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/nano-build.out")), "cp nano-source nano-result\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/linked-build.out")), "cp linked-source linked-result\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/auto-build.out")),
    "printf '%s\\n' 'auto-source' > auto-newer\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/dry-run.out")), "cp dry-source dry-result\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/make-time/equal-result")), "equal source\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/make-time/nano-result")), "nano source\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/make-time/fresh-result")), "fresh target\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/make-time/order-result")), "order target\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/make-time/linked-result")), "linked source\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/make-time/auto-newer")), "auto-source\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/make-time/dry-result")), "stale dry\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/touch.out")), "touch touch-result\n");
  assert.equal(decoder.decode(fs.readFile("/home/web/make-time/touch-result")), "touch target\n");
  assert.ok(fs.stat("/home/web/make-time/touch-result", true).mtim > touchBefore);
  assert.match(run.stdout, /full filesystem subsecond mtimes; equal normal prerequisites are stale/);
});

test("slop: sed in-place mode prevalidates every input before writing", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/sed-atomic/not-a-file");
  installShell(fs);
  fs.writeFile("/home/web/sed-atomic/first.txt", "red\nblue\n");
  fs.writeFile("/home/web/sed-atomic/second.txt", "red\nyellow\n");

  const rejected = await runSlop(
    fs,
    [
      "sed --help > sed-help.txt",
      "sed -i.bak 's/red/green/' sed-atomic/first.txt sed-atomic/missing.txt 2> sed-missing.err || echo MISSING-$?",
      "sed -i 's/red/green/' sed-atomic/first.txt sed-atomic/not-a-file 2> sed-directory.err || echo DIRECTORY-$?",
      "printf 'red\\n' | sed -i 's/red/green/' sed-atomic/first.txt - 2> sed-stdin.err || echo STDIN-$?",
    ],
    { quiet: true },
  );

  assert.equal(rejected.exitCode, 0);
  assert.match(rejected.stdout, /^MISSING-2\nDIRECTORY-2\nSTDIN-2\n$/);
  assert.match(
    new TextDecoder().decode(fs.readFile("/home/web/sed-help.txt")),
    /every explicit regular input is validated before temporary files or writes/,
  );
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/sed-atomic/first.txt")), "red\nblue\n");
  assert.equal(fs.exists("/home/web/sed-atomic/first.txt.bak"), false);
  assert.deepEqual(
    fs.readdir("/home/web/sed-atomic").map((entry) => entry.name).sort(),
    ["first.txt", "not-a-file", "second.txt"],
  );
  assert.equal(
    new TextDecoder().decode(fs.readFile("/home/web/sed-missing.err")),
    "sed: sed-atomic/missing.txt: cannot open\n",
  );
  assert.equal(
    new TextDecoder().decode(fs.readFile("/home/web/sed-directory.err")),
    "sed: sed-atomic/not-a-file: cannot inspect for in-place edit\n",
  );
  assert.equal(
    new TextDecoder().decode(fs.readFile("/home/web/sed-stdin.err")),
    "sed: -i cannot edit standard input\n",
  );

  const accepted = await runSlop(
    fs,
    ["sed -i.bak 's/red/green/' sed-atomic/first.txt sed-atomic/second.txt"],
    { quiet: true },
  );
  assert.equal(accepted.exitCode, 0, accepted.stdout);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/sed-atomic/first.txt")), "green\nblue\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/sed-atomic/second.txt")), "green\nyellow\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/sed-atomic/first.txt.bak")), "red\nblue\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/sed-atomic/second.txt.bak")), "red\nyellow\n");
  assert.equal(
    fs.readdir("/home/web/sed-atomic").some((entry) => entry.name.includes("piodide-sed-")),
    false,
  );
});

test("slop: Make recipes inherit caller stdout and stderr routing", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web/project");
  installShell(fs);
  fs.writeFile(
    "/home/web/project/Makefile",
    ".PHONY: capture\ncapture:\n\techo recipe-output\n\t-cat missing-input\n",
  );

  const run = await runSlop(
    fs,
    ["cd project", "make capture > make.log 2>&1", "echo MAKE-STATUS-$?"],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.equal(run.stdout, "MAKE-STATUS-0\n");
  const log = new TextDecoder().decode(fs.readFile("/home/web/project/make.log"));
  assert.match(log, /echo recipe-output\nrecipe-output\n/);
  assert.match(log, /cat missing-input\ncat: missing-input:/);
});

test("slop: command-prefixed assignments are temporary", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(
    fs,
    [
      "PERSISTED=outer",
      "PERSISTED=inner env | grep PERSISTED",
      "TEMP_ONLY=yes env | grep TEMP_ONLY",
      "echo AFTER-$PERSISTED-${TEMP_ONLY-unset}",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /PERSISTED=inner\n/);
  assert.match(run.stdout, /TEMP_ONLY=yes\n/);
  assert.match(run.stdout, /AFTER-outer-unset\n/);
});

test("slop: cp refuses to truncate the same file", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile("/home/web/same.txt", "keep\n");

  const run = await runSlop(fs, ["cp same.txt same.txt", "echo COPY-STATUS-$?"], { quiet: true });

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /same file\n/);
  assert.match(run.stdout, /COPY-STATUS-1\n/);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/same.txt")), "keep\n");
});

test("slop: builtins, PATH lookup, spawning, and cwd", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  // Install the shell commands like the browser session does on first run.
  installShell(fs);
  fs.writeFile("/home/web/hello.txt", "hello from memfs\n");
  fs.writeFile("/home/web/demo.c", "int main(void) { return 0; }\n");
  fs.mkdirTree("/home/web/subdir");
  fs.writeFile("/home/web/subdir/nested.txt", "nested file\n");
  fs.writeFile("/home/web/subdir/other.c", "int main;\n");
  fs.mkdirTree("/outside");
  fs.writeFile("/outside/escaped-needle.txt", "must not be traversed\n");
  fs.symlink("/outside", "/home/web/subdir/loop");

  const run = await runSlop(fs, [
    "pwd",
    "ls",
    "cat hello.txt",
    "fd-find nested",
    "fd-find escaped-needle",
    "cd subdir",
    "pwd",
    "echo $PWD",
    "ls -l",
    "ls -l nested.txt",
    "cat nested.txt",
    "cd ..",
    "pwd",
    "cd ..",        // /home — the reported regression
    "pwd",
    "cd web",       // back down to /home/web
    "pwd",
    "echo hello slop",
    "env",
    "grep nested hello.txt subdir/nested.txt",
    "grep -in NESTED subdir/nested.txt",
    "grep -c nested subdir/nested.txt",
    "grep -v nested hello.txt",
    "nosuchcmd",
    "cat /missing.txt",
    "cat /missing-again.txt > cat-errors.txt",
    "ls /",
    // expansion
    "echo $PWD",
    "echo ${PATH}",
    "echo $NOPE",
    "echo $?",
    // pipes
    "cat hello.txt | grep memfs",
    "cat hello.txt | grep memfs | grep -v nomatch",
    "cat hello.txt | grep nothing",
    "pwd | grep web",
    "echo $PWD | grep home",
    // redirects
    "echo first > pipe-out.txt",
    "echo second >> pipe-out.txt",
    "cat pipe-out.txt",
    "cat hello.txt | grep memfs > found.txt",
    "cat found.txt",
    "pwd > cwd.txt",
    "cat cwd.txt",
    "cc -c -std=c17 -O3 -Wall -DVALUE=7 -I . demo.c -o demo.o",
    "ld -s --export=main demo.o -o demo.wasm",
    "compile demo.c -o alias.o",
    "link alias.o -o alias.wasm",
    "exit",
  ]);

  assert.equal(run.exitCode, 0);
  const out = run.stdout;

  // pwd prints the shell cwd
  assert.match(out, /❯ \/home\/web\r?\n/);
  // ls at root shows hello.txt and subdir/
  assert.match(out, /hello\.txt\n/);
  assert.match(out, /subdir\/\n/);
  // cat via exact-name PATH lookup (/bin/cat)
  assert.match(out, /hello from memfs\n/);
  // fd-find locates the nested file (printed relative to cwd)
  assert.match(out, /subdir\/nested\.txt\n/);
  assert.doesNotMatch(out, /escaped-needle/);
  // cd + pwd + relative cat exercise the child's adopted PWD cwd
  assert.match(out, /❯ \/home\/web\/subdir\r?\n/);
  assert.match(out, /❯ \/home\/web\/subdir\r?\n[\s\S]*❯\s+\d+ nested\.txt\n/);
  assert.match(out, /nested file\n/);
  // ls -l shows sizes
  assert.match(out, /\d+ nested\.txt\n/);
  assert.doesNotMatch(out, /ls: nested\.txt: Not a directory/);
  // cd .. twice: /home/web/subdir -> /home/web -> /home (was the regression)
  assert.match(out, /❯ \/home\r?\n/);
  // cd web from /home: relative path walking back down
  assert.match(out, /❯ \/home\r?\n[\s\S]*❯ \/home\/web\r?\n/);
  // echo joins args with spaces
  assert.match(out, /hello slop\n/);
  // env shows the exported shell environment
  assert.match(out, /PATH=\/bin\n/);
  assert.match(out, /PWD=\/home\/web\n/);
  // grep: multi-file prefix, case-insensitive, count, invert
  assert.match(out, /subdir\/nested\.txt:nested file\n/);
  assert.match(out, /NESTED/i);
  assert.match(out, /❯ 1\n/); // grep -c prints the count right after the prompt
  // unknown command and missing file surface as errors with exit codes
  assert.match(out, /slop: command not found: nosuchcmd\n/);
  assert.match(out, /cat: \/missing\.txt: .*\n/);
  assert.match(out, /cat: \/missing-again\.txt: .*\n/);
  assert.match(out, /↳ exit 1/);
  // ls / lists the actual root (not the cwd)
  assert.match(out, /bin\//);
  assert.match(out, /home\//);
  // expansion: $VAR, ${VAR}, empty for unknown, $? for last exit code
  assert.match(out, /❯ \/home\/web\r?\n/);
  assert.match(out, /❯ \/bin\r?\n/);
  assert.match(out, /❯ \r?\n/); // echo $NOPE prints an empty line
  assert.match(out, /❯ 0\r?\n/); // $? after the successful echo
  // pipes: consumer gets producer stdout, chains work, builtin pipes work
  assert.match(out, /hello from memfs\n/);
  assert.match(out, /↳ exit 1/); // grep nothing matched nothing
  // redirects: > truncates, >> appends, pipe+redirect combos, builtin redirect
  assert.match(out, /first\nsecond\n/);
  assert.match(out, /hello from memfs\n/);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/pipe-out.txt")), "first\nsecond\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/found.txt")), "hello from memfs\n");
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/cwd.txt")), "/home/web\n");
  assert.equal(fs.readFile("/home/web/cat-errors.txt").byteLength, 0);
  assert.deepEqual(run.toolchainCommands, [
    ["cc", "-c", "-std=c17", "-O3", "-Wall", "-DVALUE=7", "-I", ".", "demo.c", "-o", "demo.o"],
    ["ld", "-s", "--export=main", "demo.o", "-o", "demo.wasm"],
    ["compile", "demo.c", "-o", "alias.o"],
    ["link", "alias.o", "-o", "alias.wasm"],
  ]);
});

test("slop: conditional and sequential command lists", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile("/home/web/hello.txt", "hello from memfs\n");

  const run = await runSlop(fs, [
    "echo AND-A && echo AND-B",
    "grep missing hello.txt && echo AND-SKIP",
    "grep missing hello.txt || echo OR-RUN",
    "echo OR-OK || echo OR-SKIP",
    "echo OR-OK-REDIR || echo BAD > skipped.txt",
    "echo SEMI-A ; echo SEMI-B",
    "echo TRAILING-SEMI ;",
    "grep missing hello.txt || echo RECOVER-$? && echo LEFT-ASSOC",
    "echo PIPE | grep PIPE && echo PIPE-OK",
    "echo nope | grep yes || echo PIPE-FAIL",
    "echo REDIR > list.txt && cat list.txt",
    "nosuchcmd ; echo STATUS-$?",
    "echo '$? && ; ||' ; echo \"Q&&Q\" ; echo 'L;L'",
    "echo GLUED-A&&echo GLUED-B;echo GLUED-C",
    "grep missing hello.txt && echo BAD-$? ; echo AFTER-$?",
    "grep missing hello.txt || echo FIRST-$? ; echo SECOND-$?",
    "grep missing hello.txt && exit ; echo SURVIVED",
    "echo BEFORE-EXIT && exit ; echo AFTER-EXIT",
    "echo UNREACHABLE",
  ]);

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /AND-A\n[\s\S]*AND-B\n/);
  assert.doesNotMatch(run.stdout, /AND-SKIP/);
  assert.match(run.stdout, /OR-RUN\n/);
  assert.match(run.stdout, /OR-OK\n/);
  assert.doesNotMatch(run.stdout, /OR-SKIP/);
  assert.equal(fs.exists("/home/web/skipped.txt"), false);
  assert.match(run.stdout, /SEMI-A\n[\s\S]*SEMI-B\n/);
  assert.match(run.stdout, /TRAILING-SEMI\n/);
  assert.match(run.stdout, /RECOVER-1\n[\s\S]*LEFT-ASSOC\n/);
  assert.match(run.stdout, /PIPE\n[\s\S]*PIPE-OK\n/);
  assert.match(run.stdout, /PIPE-FAIL\n/);
  assert.match(run.stdout, /REDIR\n/);
  assert.equal(new TextDecoder().decode(fs.readFile("/home/web/list.txt")), "REDIR\n");
  assert.match(run.stdout, /slop: command not found: nosuchcmd\n/);
  assert.match(run.stdout, /STATUS-127\n/);
  assert.match(run.stdout, /\$\? && ; \|\|\n/);
  assert.match(run.stdout, /Q&&Q\n/);
  assert.match(run.stdout, /L;L\n/);
  assert.match(run.stdout, /GLUED-A\n[\s\S]*GLUED-B\n[\s\S]*GLUED-C\n/);
  assert.doesNotMatch(run.stdout, /BAD-/);
  assert.match(run.stdout, /AFTER-1\n/);
  assert.match(run.stdout, /FIRST-1\n[\s\S]*SECOND-0\n/);
  assert.match(run.stdout, /SURVIVED\n/);
  assert.match(run.stdout, /BEFORE-EXIT\n/);
  assert.doesNotMatch(run.stdout, /AFTER-EXIT|UNREACHABLE/);
});

test("slop: process status follows the final command list", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile("/home/web/hello.txt", "hello from memfs\n");

  assert.equal((await runSlop(fs, ["nosuchcmd"])).exitCode, 127);
  assert.equal((await runSlop(fs, ["grep missing hello.txt && echo no"])).exitCode, 1);
  assert.equal((await runSlop(fs, ["grep missing hello.txt || echo recovered"])).exitCode, 0);
  assert.equal((await runSlop(fs, ["echo nope ||"])).exitCode, 2);
});

test("slop: oversized expanded spawn arguments fail before the host call", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);
  fs.writeFile("/home/web/oversized.sh", `cat ${"x".repeat(1024 * 1024 + 1)}\n`);

  const run = await runSlop(fs, ["sh oversized.sh"]);

  assert.equal(run.exitCode, 2);
  assert.match(run.stdout, /argument list too long/);
});

test("slop: command-list syntax errors have no side effects", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(fs, [
    "echo TOUCHED > touched.txt ; && echo nope",
    "&& echo nope",
    "echo nope ||",
    "echo nope ; ; echo nope",
    "echo nope & echo nope",
    "echo \"unterminated",
    "echo SYNTAX-STATUS-$?",
    "exit",
  ]);

  assert.equal(run.exitCode, 0);
  assert.equal(fs.exists("/home/web/touched.txt"), false);
  assert.doesNotMatch(run.stdout, /TOUCHED/);
  assert.match(run.stdout, /empty command before &&/);
  assert.match(run.stdout, /empty command after \|\|/);
  assert.match(run.stdout, /empty command before ;/);
  assert.match(run.stdout, /unsupported operator &/);
  assert.match(run.stdout, /unterminated \" quote/);
  assert.match(run.stdout, /SYNTAX-STATUS-2\n/);
});
