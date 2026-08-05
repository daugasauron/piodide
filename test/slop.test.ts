/**
 * slop shell test: drives the real slop.wasm REPL with scripted input.
 * The "piodide" spawn import is mocked with a synchronous runner that
 * executes child programs (cat.wasm, ls.wasm, fd-find.wasm) against the
 * same MemoryFs with the child's cwd preopen — mirroring the browser's
 * nested-spawn behavior.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MemoryFs } from "../src/wasi/memory-fs.ts";
import { WasiHost } from "../src/wasi/host.ts";

const here = dirname(fileURLToPath(import.meta.url));
const shellBin = (name: string) =>
  new Uint8Array(readFileSync(join(here, "..", "shell", "bin", name)));
const COREUTILS = [
  "rm", "cp", "mv", "mkdir", "rmdir", "touch", "ln", "head", "tail", "wc", "sort",
  "cut", "tr", "tee", "basename", "dirname", "seq", "cmp", "install", "readlink", "find", "mktemp",
  "chmod", "uniq", "xargs",
];

interface SlopRun {
  stdout: string;
  exitCode: number;
  toolchainCommands: string[][];
  pythonCommands: string[][];
  curlCommands: string[][];
  gitCommands: Array<{ args: string[]; cwd: string }>;
}

function installShell(fs: MemoryFs): void {
  for (const name of ["slop", "make", "sed", "ar", "ls", "cat", "fd-find", "echo", "env", "grep"]) {
    fs.writeFile(`/bin/${name}`, shellBin(`${name}.wasm`));
  }
  fs.writeFile("/bin/sh", shellBin("slop.wasm"));
  fs.writeFile("/bin/python", "piodide host-backed Python entrypoint\n");
  fs.writeFile("/bin/python3", "piodide host-backed Python entrypoint\n");
  fs.writeFile("/bin/git", shellBin("git.wasm"));
  fs.writeFile("/bin/curl", "piodide browser-hosted command\n");
  const coreutils = shellBin("coreutils.wasm");
  for (const name of COREUTILS) fs.writeFile(`/bin/${name}`, coreutils);
}

async function runSlop(
  fs: MemoryFs,
  script: string[],
  options: { quiet?: boolean } = {},
): Promise<SlopRun> {
  // Pre-compile child modules (instantiation itself is synchronous).
  const modules = new Map<string, WebAssembly.Module>();
  for (const name of ["slop", "make", "sed", "ar", "git", "cat", "ls", "fd-find", "echo", "env", "grep"] as const) {
    modules.set(name, await WebAssembly.compile(shellBin(`${name}.wasm`) as BufferSource));
  }
  const coreutilsModule = await WebAssembly.compile(shellBin("coreutils.wasm") as BufferSource);
  for (const name of COREUTILS) modules.set(name, coreutilsModule);
  modules.set("sh", modules.get("slop")!);

  let stdout = "";
  const decoder = new TextDecoder();
  const lines = [...script];
  const encoder = new TextEncoder();
  const toolchainCommands: string[][] = [];
  const pythonCommands: string[][] = [];
  const curlCommands: string[][] = [];
  const gitCommands: Array<{ args: string[]; cwd: string }> = [];

  interface SpawnIo {
    stdinText?: Uint8Array;
    capture?: { ptr: number; cap: number; lenPtr: number };
    outFile?: string;
    append?: boolean;
    errFile?: string;
    errAppend?: boolean;
    stderrToStdout?: boolean;
    env?: Record<string, string>;
  }

  const runProgram = (
    name: string,
    args: string[],
    cwd: string,
    io: SpawnIo,
    callerHost?: WasiHost,
  ): number => {
    const module = modules.get(name);
    if (!module) return 127;
    let stdinSent = io.stdinText === undefined;
    const captured: Uint8Array[] = [];
    const fileChunks: Uint8Array[] = [];
    const errorChunks: Uint8Array[] = [];
    const writeStdout = (chunk: Uint8Array) => {
      if (io.capture) captured.push(chunk.slice());
      else if (io.outFile) fileChunks.push(chunk.slice());
      else stdout += decoder.decode(chunk, { stream: true });
    };
    const host = new WasiHost({
      args,
      env: { PATH: "/bin", PWD: cwd, TERM: "ghostty", ...(io.env ?? {}) },
      fs,
      preopens: [{ name: ".", path: cwd }, "/home/web", "/", "/bin"],
      stdin: () => {
        if (stdinSent) return null;
        stdinSent = true;
        return io.stdinText ?? null;
      },
      stdout: writeStdout,
      stderr: (chunk) => {
        if (io.stderrToStdout) writeStdout(chunk);
        else if (io.errFile) errorChunks.push(chunk.slice());
        else stdout += decoder.decode(chunk, { stream: true });
      },
      extendImports: (childHost) => ({
        piodide: {
          spawn: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
            handleSpawn(childHost, pathPtr, argvPtr, cwdPtr, ioPtr, false, false),
          spawn_v3: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
            handleSpawn(childHost, pathPtr, argvPtr, cwdPtr, ioPtr, true, false),
          spawn_v4: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
            handleSpawn(childHost, pathPtr, argvPtr, cwdPtr, ioPtr, true, true),
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
  ): number => {
    const path = callerHost.readCString(pathPtr);
    const childArgs = callerHost.readCStringArray(argvPtr);
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
      const value = childArgs[1] === "--version"
        ? encoder.encode("git version 2.0.0-piodide (libgit2 + isomorphic-git)\n")
        : new Uint8Array();
      if (ioPtr !== 0) {
        const capturePtr = callerHost.readUint32(ioPtr + 8);
        const captureCap = callerHost.readUint32(ioPtr + 12);
        const captureLenPtr = callerHost.readUint32(ioPtr + 16);
        if (capturePtr) callerHost.writeBytes(capturePtr, value.subarray(0, captureCap));
        if (captureLenPtr) callerHost.writeUint32(captureLenPtr, value.byteLength);
      }
      return 0;
    }

    const io: SpawnIo = {};
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
    }
    return runProgram(childName, childArgs, childCwd, io, callerHost);
  };

  const stdin = () => {
    const next = lines.shift();
    return next === undefined ? null : encoder.encode(`${next}\n`);
  };

  const slopHost = new WasiHost({
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
      stdout += decoder.decode(chunk, { stream: true });
    },
    extendImports: (host) => ({
      piodide: {
        spawn: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
          handleSpawn(host, pathPtr, argvPtr, cwdPtr, ioPtr, false, false),
        spawn_v3: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
          handleSpawn(host, pathPtr, argvPtr, cwdPtr, ioPtr, true, false),
        spawn_v4: (pathPtr: number, argvPtr: number, cwdPtr: number, ioPtr: number): number =>
          handleSpawn(host, pathPtr, argvPtr, cwdPtr, ioPtr, true, true),
      },
    }),
  });
  const slopModule = modules.get("slop")!;
  const exitCode = slopHost.start(new WebAssembly.Instance(slopModule, slopHost.getImportObject()));
  return { stdout, exitCode, toolchainCommands, pythonCommands, curlCommands, gitCommands };
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

test("slop: native git and host curl are discoverable commands", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(
    fs,
    ["type git", "command -v curl", "git --version", "/bin/curl -I https://example.com"],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /git is \/bin\/git/);
  assert.match(run.stdout, /\/bin\/curl/);
  assert.match(run.stdout, /git version 2\.0\.0-piodide/);
  assert.deepEqual(run.gitCommands, [{ args: ["git-engine", "--version"], cwd: "/home/web" }]);
  assert.deepEqual(run.curlCommands, [["/bin/curl", "-I", "https://example.com"]]);
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
      '  echo "HELLO-$1-$2"',
      "  return 7",
      "  echo FUNCTION-WRONG",
      "}",
      "greet one two || echo RETURN-$?",
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
  assert.match(run.stdout, /RETURN-7\n/);
  assert.match(run.stdout, /greet is a function\n/);
  assert.doesNotMatch(run.stdout, /FUNCTION-WRONG/);
  assert.match(run.stdout, /return: not in a function\n/);
  assert.match(run.stdout, /OUTSIDE-RETURN-2\n/);
});

test("slop: stderr redirects apply to builtins and spawned programs", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  installShell(fs);

  const run = await runSlop(
    fs,
    [
      "cd /missing 2> builtin.err",
      "cat /missing-one 2> child.err",
      "cat /missing-two 2>> child.err",
      "cat /missing-three 2>&1 | grep missing-three",
      "cat /missing-four &> both.txt",
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
  assert.match(builtinError, /cd: \/missing/);
  assert.match(childError, /missing-one/);
  assert.match(childError, /missing-two/);
  assert.match(run.stdout, /missing-three/);
  assert.match(both, /missing-four/);
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
      "chmod 755 present.txt",
      "chmod 755 missing.txt || echo CHMOD-$?",
    ],
    { quiet: true },
  );

  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /\s+2 a\n\s+1 b\n/);
  assert.match(run.stdout, /ITEM a b\nITEM c\n/);
  assert.match(run.stdout, /chmod: missing\.txt:/);
  assert.match(run.stdout, /CHMOD-1\n/);
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

  const run = await runSlop(fs, [`cat ${"$PWD".repeat(2000)}`]);

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
