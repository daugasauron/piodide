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

interface SlopRun {
  stdout: string;
  exitCode: number;
}

async function runSlop(fs: MemoryFs, script: string[]): Promise<SlopRun> {
  // Pre-compile child modules (instantiation itself is synchronous).
  const modules = new Map<string, WebAssembly.Module>();
  for (const [name, bytes] of [
    ["slop.wasm", shellBin("slop.wasm")],
    ["cat.wasm", shellBin("cat.wasm")],
    ["ls.wasm", shellBin("ls.wasm")],
    ["fd-find.wasm", shellBin("fd-find.wasm")],
  ] as const) {
    modules.set(name, await WebAssembly.compile(bytes as BufferSource));
  }

  let stdout = "";
  const decoder = new TextDecoder();
  const lines = [...script];
  const encoder = new TextEncoder();

  const runProgram = (name: string, args: string[], cwd: string, stdinText: string): number => {
    const module = modules.get(name);
    if (!module) return 127;
    let stdinSent = stdinText.length === 0;
    const host = new WasiHost({
      args,
      env: { PATH: "/bin", PWD: cwd, TERM: "ghostty" },
      fs,
      preopens: ["/home/web", "/", "/bin", { name: ".", path: cwd }],
      stdin: () => {
        if (stdinSent) return null;
        stdinSent = true;
        return encoder.encode(stdinText);
      },
      stdout: (chunk) => {
        stdout += decoder.decode(chunk, { stream: true });
      },
      stderr: (chunk) => {
        stdout += decoder.decode(chunk, { stream: true });
      },
      extendImports: (childHost) => ({
        piodide: {
          spawn: (pathPtr: number, argvPtr: number, cwdPtr: number): number => {
            const path = childHost.readCString(pathPtr);
            const childArgs = childHost.readCStringArray(argvPtr);
            const childCwd = childHost.readCString(cwdPtr);
            const childName = path.split("/").pop() ?? path;
            return runProgram(childName, childArgs, childCwd, "");
          },
        },
      }),
    });
    const instance = new WebAssembly.Instance(module, host.getImportObject());
    return host.start(instance);
  };

  const stdin = () => {
    const next = lines.shift();
    return next === undefined ? null : encoder.encode(`${next}\n`);
  };

  const slopHost = new WasiHost({
    args: ["/bin/slop.wasm"],
    env: { PATH: "/bin", PWD: "/home/web", TERM: "ghostty" },
    fs,
    preopens: ["/home/web", "/", "/bin", { name: ".", path: "/home/web" }],
    stdin,
    stdout: (chunk) => {
      stdout += decoder.decode(chunk, { stream: true });
    },
    stderr: (chunk) => {
      stdout += decoder.decode(chunk, { stream: true });
    },
    extendImports: (host) => ({
      piodide: {
        spawn: (pathPtr: number, argvPtr: number, cwdPtr: number): number => {
          const path = host.readCString(pathPtr);
          const childArgs = host.readCStringArray(argvPtr);
          const childCwd = host.readCString(cwdPtr);
          const childName = path.split("/").pop() ?? path;
          return runProgram(childName, childArgs, childCwd, "");
        },
      },
    }),
  });
  const slopModule = modules.get("slop.wasm")!;
  const exitCode = slopHost.start(new WebAssembly.Instance(slopModule, slopHost.getImportObject()));
  return { stdout, exitCode };
}

test("slop: builtins, PATH lookup, spawning, and cwd", async () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  // Install the shell commands like the browser session does on first run.
  for (const name of ["slop.wasm", "ls.wasm", "cat.wasm", "fd-find.wasm"]) {
    fs.writeFile(`/bin/${name}`, shellBin(name));
  }
  fs.writeFile("/home/web/hello.txt", "hello from memfs\n");
  fs.mkdirTree("/home/web/subdir");
  fs.writeFile("/home/web/subdir/nested.txt", "nested file\n");
  fs.writeFile("/home/web/subdir/other.c", "int main;\n");

  const run = await runSlop(fs, [
    "pwd",
    "ls",
    "cat hello.txt",
    "fd-find nested",
    "cd subdir",
    "pwd",
    "ls -l",
    "cat nested.txt",
    "cd ..",
    "pwd",
    "nosuchcmd",
    "cat /missing.txt",
    "exit",
  ]);

  assert.equal(run.exitCode, 0);
  const out = run.stdout;

  // pwd prints the shell cwd
  assert.match(out, /❯ \/home\/web\r?\n/);
  // ls at root shows hello.txt and subdir/
  assert.match(out, /hello\.txt\n/);
  assert.match(out, /subdir\/\n/);
  // cat via PATH lookup (/bin/cat.wasm)
  assert.match(out, /hello from memfs\n/);
  // fd-find locates the nested file (printed relative to cwd)
  assert.match(out, /subdir\/nested\.txt\n/);
  // cd + pwd + relative cat exercise the child's "." preopen
  assert.match(out, /❯ \/home\/web\/subdir\r?\n/);
  assert.match(out, /nested file\n/);
  // ls -l shows sizes
  assert.match(out, /\d+ nested\.txt\n/);
  // unknown command and missing file surface as errors with exit codes
  assert.match(out, /slop: command not found: nosuchcmd\n/);
  assert.match(out, /cat: \/missing\.txt: .*\n/);
  assert.match(out, /↳ exit 1/);
});
