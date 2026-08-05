import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryFs } from "../src/wasi/memory-fs.ts";
import { runToolchain } from "../src/wasi/toolchain.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(root, "shell", "src");
const publicSourceDir = join(root, "public", "slop", "src");
const shellBinDir = join(root, "shell", "bin");
const publicBinDir = join(root, "public", "slop", "bin");
const assetsDir = join(root, "test", "toolchain-assets");
const check = process.argv.includes("--check");
const programs = [
  "slop", "make", "coreutils", "sed", "ar", "git",
  "ls", "cat", "fd-find", "echo", "env", "grep",
] as const;
const spawnPrograms = new Set(["slop", "make", "coreutils", "git"]);

function bytes(path: string): ArrayBuffer {
  const data = readFileSync(path);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

function equalFile(path: string, expected: Uint8Array): boolean {
  return existsSync(path) && Buffer.from(readFileSync(path)).equals(Buffer.from(expected));
}

for (const asset of ["clang.wasm", "wasm-ld.wasm", "clang-fs.tar.gz"]) {
  if (!existsSync(join(assetsDir, asset))) {
    throw new Error("Missing toolchain assets. Run: npm run test:fetch-toolchain");
  }
}

const workspace = new MemoryFs();
workspace.mkdirTree("/home/web/build");
for (const file of [...programs.map((name) => name + ".c"), "spawn_stub.c"]) {
  workspace.writeFile("/home/web/build/" + file, readFileSync(join(sourceDir, file)));
}

const clang = await WebAssembly.compile(bytes(join(assetsDir, "clang.wasm")) as BufferSource);
const linker = await WebAssembly.compile(bytes(join(assetsDir, "wasm-ld.wasm")) as BufferSource);
const sysroot = bytes(join(assetsDir, "clang-fs.tar.gz"));

async function compile(name: string): Promise<void> {
  const result = await runToolchain(
    {
      operation: "compile",
      sourcePath: "/home/web/build/" + name + ".c",
      outputPath: "/home/web/build/" + name + ".o",
      options: { standard: "c17", optimization: "2", warnings: true },
    },
    workspace,
    { toolchain: clang, sysrootTar: sysroot },
  );
  if (result.exitCode !== 0) throw new Error("Compiling " + name + " failed:\n" + result.diagnostics);
  if (result.diagnostics.trim()) process.stderr.write(result.diagnostics);
}

await compile("spawn_stub");
for (const program of programs) await compile(program);

const built = new Map<string, Uint8Array>();
const temp = mkdtempSync(join(tmpdir(), "piodide-slop-build-"));
try {
  for (const program of programs) {
    const output = "/home/web/build/" + program + ".unpatched.wasm";
    const objectPaths = spawnPrograms.has(program)
      ? ["/home/web/build/spawn_stub.o", "/home/web/build/" + program + ".o"]
      : ["/home/web/build/" + program + ".o"];
    const result = await runToolchain(
      {
        operation: "link",
        objectPaths,
        outputPath: output,
        options: {
          exports: spawnPrograms.has(program) ? ["piodide_spawn"] : undefined,
          strip: true,
        },
      },
      workspace,
      { toolchain: linker, sysrootTar: sysroot },
    );
    if (result.exitCode !== 0) throw new Error("Linking " + program + " failed:\n" + result.diagnostics);
    let outputBytes = workspace.readFile(output);
    if (spawnPrograms.has(program)) {
      const inputPath = join(temp, program + ".unpatched.wasm");
      const outputPath = join(temp, program + ".wasm");
      writeFileSync(inputPath, outputBytes);
      const patched = spawnSync(
        "python3",
        [join(sourceDir, "patch_import.py"), inputPath, outputPath],
        { encoding: "utf8" },
      );
      if (patched.status !== 0) {
        throw new Error("Patching " + program + " failed:\n" + (patched.stderr || patched.stdout));
      }
      outputBytes = new Uint8Array(readFileSync(outputPath));
    }
    built.set(program, outputBytes);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const mismatches: string[] = [];
for (const [program, output] of built) {
  const shellPath = join(shellBinDir, program + ".wasm");
  const publicPath = join(publicBinDir, program);
  if (check) {
    if (!equalFile(shellPath, output)) mismatches.push(shellPath);
    if (!equalFile(publicPath, output)) mismatches.push(publicPath);
  } else {
    writeFileSync(shellPath, output);
    writeFileSync(publicPath, output);
  }
}

for (const file of readdirSync(sourceDir).sort()) {
  const canonical = readFileSync(join(sourceDir, file));
  const mirror = join(publicSourceDir, file);
  if (check) {
    if (!equalFile(mirror, canonical)) mismatches.push(mirror);
  } else {
    writeFileSync(mirror, canonical);
  }
}

if (mismatches.length > 0) {
  throw new Error("Generated Slop files are stale:\n" + mismatches.map((path) => "  " + path).join("\n"));
}
console.log(check ? "Slop sources and binaries are reproducible." : "Rebuilt Slop sources and binaries.");
