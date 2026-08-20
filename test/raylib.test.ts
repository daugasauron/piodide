import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryFs } from "../src/wasi/memory-fs.ts";
import { runToolchain } from "../src/wasi/toolchain.ts";
import { WasiHost } from "../src/wasi/host.ts";
import { createRaylibDemoSource } from "../src/raylib-demo-source.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const toolchainDir = join(here, "toolchain-assets");
const raylibDir = join(root, "public", "raylib");
const toolchainAvailable = ["clang.wasm", "wasm-ld.wasm", "clang-fs.tar.gz"]
  .every((name) => existsSync(join(toolchainDir, name)));

function arrayBuffer(path: string): ArrayBuffer {
  const data = readFileSync(path);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

const GAME_SOURCE = `
#include "raylib.h"
void game_init(void) {}
void game_frame(float delta_seconds) {
    (void)delta_seconds;
    BeginDrawing();
    ClearBackground((Color){ 12, 34, 56, 255 });
    DrawRectangle(4, 4, 8, 8, (Color){ 240, 40, 80, 255 });
    EndDrawing();
}
`;

test(
  "raylib: built-in demo source is compact and compiles",
  { timeout: 300_000, skip: !toolchainAvailable },
  async () => {
    const source = createRaylibDemoSource(1400);
    assert.ok(source.length <= 6_000);
    assert.ok(source.split("\n").length <= 120);
    assert.match(source, /#define PARTICLE_COUNT 1400/);
    assert.doesNotMatch(source, /InitWindow|SetTargetFPS|CloseWindow/);

    const fs = new MemoryFs();
    fs.mkdirTree("/home/web/raylib");
    fs.writeFile("/home/web/raylib/demo.c", source);
    fs.writeFile("/home/web/raylib/raylib.h", readFileSync(join(raylibDir, "raylib.h")));
    const compiled = await runToolchain(
      {
        operation: "compile",
        sourcePath: "/home/web/raylib/demo.c",
        outputPath: "/home/web/raylib/demo.o",
        options: {
          standard: "c17",
          optimization: "3",
          includePaths: ["/home/web/raylib"],
          functionSections: true,
        },
      },
      fs,
      {
        toolchain: arrayBuffer(join(toolchainDir, "clang.wasm")),
        sysrootTar: arrayBuffer(join(toolchainDir, "clang-fs.tar.gz")),
      },
    );
    assert.equal(compiled.exitCode, 0, compiled.diagnostics);
  },
);

test(
  "raylib: WASI memory backend renders a packed BGRA framebuffer",
  { timeout: 300_000, skip: !toolchainAvailable },
  async () => {
    const fs = new MemoryFs();
    fs.mkdirTree("/home/web/raylib");
    fs.writeFile("/home/web/raylib/game.c", GAME_SOURCE);
    fs.writeFile("/home/web/raylib/raylib.h", readFileSync(join(raylibDir, "raylib.h")));
    for (const name of ["rcore", "rshapes", "rtextures", "rtext", "piodide-raylib"]) {
      fs.writeFile(`/home/web/raylib/${name}.o`, readFileSync(join(raylibDir, `${name}.o`)));
    }

    const sysrootTar = arrayBuffer(join(toolchainDir, "clang-fs.tar.gz"));
    const compiled = await runToolchain(
      {
        operation: "compile",
        sourcePath: "/home/web/raylib/game.c",
        outputPath: "/home/web/raylib/game.o",
        options: {
          standard: "c17",
          optimization: "s",
          includePaths: ["/home/web/raylib"],
          functionSections: true,
        },
      },
      fs,
      { toolchain: arrayBuffer(join(toolchainDir, "clang.wasm")), sysrootTar },
    );
    assert.equal(compiled.exitCode, 0, compiled.diagnostics);

    const exports = [
      "PiodideRaylibInit",
      "PiodideRaylibFrame",
      "PiodideRaylibClose",
      "PiodideGetFramebuffer",
      "PiodideGetFramebufferWidth",
      "PiodideGetFramebufferHeight",
      "PiodideSetTime",
      "PiodideSetKey",
      "PiodideSetChar",
      "PiodideSetMouse",
      "PiodideSetMouseWheel",
      "PiodideSetTouch",
    ];
    const linked = await runToolchain(
      {
        operation: "link",
        objectPaths: [
          "/home/web/raylib/game.o",
          "/home/web/raylib/piodide-raylib.o",
          "/home/web/raylib/rcore.o",
          "/home/web/raylib/rshapes.o",
          "/home/web/raylib/rtextures.o",
          "/home/web/raylib/rtext.o",
        ],
        outputPath: "/home/web/raylib/game.wasm",
        options: { exports, strip: true, reactor: true, systemLibraries: ["m"] },
      },
      fs,
      { toolchain: arrayBuffer(join(toolchainDir, "wasm-ld.wasm")), sysrootTar },
    );
    assert.equal(linked.exitCode, 0, linked.diagnostics);

    const module = await WebAssembly.compile(fs.readFile("/home/web/raylib/game.wasm") as BufferSource);
    const host = new WasiHost({ fs, preopens: ["/home/web", "/"] });
    const instance = await WebAssembly.instantiate(module, host.getImportObject());
    host.bind(instance);
    const api = instance.exports as Record<string, WebAssembly.ExportValue>;
    const call = (name: string, ...args: number[]) => (api[name] as Function)(...args) as number;
    call("PiodideSetTime", 0);
    call("PiodideRaylibInit", 24, 16);
    call("PiodideSetTime", 1 / 60);
    call("PiodideRaylibFrame", 1 / 60);

    assert.equal(call("PiodideGetFramebufferWidth"), 24);
    assert.equal(call("PiodideGetFramebufferHeight"), 16);
    const pointer = call("PiodideGetFramebuffer");
    const memory = api.memory as WebAssembly.Memory;
    const pixels = new Uint8Array(memory.buffer, pointer, 24 * 16 * 4);
    assert.deepEqual([...pixels.slice(0, 4)], [56, 34, 12, 255]);
    assert.deepEqual([...pixels.slice((4 * 24 + 4) * 4, (4 * 24 + 4) * 4 + 4)], [80, 40, 240, 255]);

    call("PiodideRaylibClose");
    host.close();
  },
);
