/**
 * End-to-end toolchain test: the real clang.wasm / wasm-ld.wasm (downloaded
 * from runno.dev, the same assets the browser fetches) run on our WASI host
 * against a MemoryFs workspace — compile, link, then execute the result on
 * the same host. Requires the assets in test/toolchain-assets/ (see
 * test/README.md); skipped when absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MemoryFs } from "../src/wasi/memory-fs.ts";
import { runToolchain } from "../src/wasi/toolchain.ts";
import { executeWasi } from "../src/wasi/runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, "toolchain-assets");
const clangPath = join(assetsDir, "clang.wasm");
const wasmLdPath = join(assetsDir, "wasm-ld.wasm");
const sysrootPath = join(assetsDir, "clang-fs.tar.gz");
const assetsAvailable = [clangPath, wasmLdPath, sysrootPath].every(existsSync);

function assetBytes(path: string): ArrayBuffer {
  const buffer = readFileSync(path);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

const GREETER_C = `
#include "msg.h"
const char *greeting(void) { return "hello from compiled wasm"; }
`;

const MAIN_C = `
#include <stdio.h>
#include <fcntl.h>
#include <unistd.h>
#include <string.h>
#include <errno.h>
#include "msg.h"
#if BUILD_VALUE != 7
#error "the requested -D definition was not applied"
#endif
#if __STDC_VERSION__ < 201710L
#error "the requested C17 language mode was not applied"
#endif
unsigned long long high_half_product(unsigned long long left, unsigned long long right);
int main(void) {
  if (high_half_product(0xffffffffffffffffULL, 2) != 1) return 2;
  errno = 0;
  if (open("/home/web/definitely-missing", O_RDONLY) != -1 || errno == 0) return 3;
  printf("%s\\n", greeting());
  int fd = open("/home/web/result.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) return 1;
  const char *text = "produced by clang-compiled program\\n";
  write(fd, text, strlen(text));
  close(fd);
  fd = open("relative.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) return 4;
  write(fd, text, strlen(text));
  close(fd);
  return 0;
}
`;

const MSG_H = `
#pragma once
const char *greeting(void);
`;

// Full-width 128-bit multiplication lowers to __multi3 with this Clang target.
// Keeping it in a separate object prevents the call from being optimized away
// and verifies that the compiler-rt builtins archive participates in linking.
const COMPILER_RT_C = `
unsigned long long high_half_product(unsigned long long left, unsigned long long right) {
  volatile unsigned __int128 product = (unsigned __int128)left * right;
  return (unsigned long long)(product >> 64);
}
`;

test(
  "toolchain: clang compiles, wasm-ld links, host runs the binary",
  { timeout: 300_000, skip: !assetsAvailable },
  async () => {
    const workspace = new MemoryFs();
    workspace.mkdirTree("/home/web/proj");
    workspace.writeFile("/home/web/proj/greeter.c", GREETER_C);
    workspace.writeFile("/home/web/proj/main.c", MAIN_C);
    workspace.mkdirTree("/home/web/proj/include");
    workspace.writeFile("/home/web/proj/include/msg.h", MSG_H);
    workspace.writeFile("/home/web/proj/compiler-rt.c", COMPILER_RT_C);

    const clang = assetBytes(clangPath);
    const sysrootTar = assetBytes(sysrootPath);

    for (const source of ["greeter", "main", "compiler-rt"]) {
      const compiled = await runToolchain(
        {
          operation: "compile",
          sourcePath: `/home/web/proj/${source}.c`,
          outputPath: `/home/web/proj/${source}.o`,
          options:
            source === "main"
              ? {
                  standard: "c17",
                  optimization: "0",
                  debug: true,
                  warnings: true,
                  warningsAsErrors: true,
                  defines: ["BUILD_VALUE=7"],
                  includePaths: ["/home/web/proj/include"],
                }
              : source === "greeter"
                ? {
                    standard: "c11",
                    optimization: "3",
                    includePaths: ["/home/web/proj/include"],
                  }
                : { optimization: "s" },
        },
        workspace,
        { toolchain: clang, sysrootTar },
      );
      assert.equal(compiled.exitCode, 0, compiled.diagnostics);
      assert.ok(workspace.exists(`/home/web/proj/${source}.o`), `missing ${source}.o`);
    }

    const linked = await runToolchain(
      {
        operation: "link",
        objectPaths: [
          "/home/web/proj/greeter.o",
          "/home/web/proj/main.o",
          "/home/web/proj/compiler-rt.o",
        ],
        outputPath: "/home/web/proj/app.wasm",
        options: { exports: ["greeting"], strip: true },
      },
      workspace,
      { toolchain: assetBytes(wasmLdPath), sysrootTar },
    );
    assert.equal(linked.exitCode, 0, linked.diagnostics);
    assert.ok(workspace.exists("/home/web/proj/app.wasm"), "missing app.wasm");
    const linkedModule = await WebAssembly.compile(
      workspace.readFile("/home/web/proj/app.wasm") as BufferSource,
    );
    assert.ok(
      WebAssembly.Module.exports(linkedModule).some(({ name }) => name === "greeting"),
      "missing explicitly exported greeting symbol",
    );

    let stdout = "";
    const decoder = new TextDecoder();
    const run = await executeWasi({
      binary: workspace.readFile("/home/web/proj/app.wasm"),
      args: ["app.wasm"],
      env: { PWD: "/home/web/proj" },
      fs: workspace,
      preopens: [{ name: ".", path: "/home/web/proj" }, "/home/web", "/"],
      stdout: (chunk) => {
        stdout += decoder.decode(chunk, { stream: true });
      },
    });
    assert.equal(run.exitCode, 0);
    assert.equal(stdout, "hello from compiled wasm\n");
    assert.equal(
      new TextDecoder().decode(workspace.readFile("/home/web/result.txt")),
      "produced by clang-compiled program\n",
    );
    assert.equal(
      new TextDecoder().decode(workspace.readFile("/home/web/proj/relative.txt")),
      "produced by clang-compiled program\n",
    );
  },
);
