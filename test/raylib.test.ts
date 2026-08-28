import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryFs } from "../src/wasi/memory-fs.ts";
import { runToolchain } from "../src/wasi/toolchain.ts";
import { WasiHost } from "../src/wasi/host.ts";
import { createRaylibDemoRequest } from "../src/raylib-demo.ts";

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

test("raylib: /demo creates ambitious device-specific visible requests", () => {
  const desktop = createRaylibDemoRequest({
    phone: false,
    viewportWidth: 1440,
    viewportHeight: 900,
  });
  assert.match(desktop, /desktop\/laptop.*1440×900/);
  assert.match(desktop, /mouse movement\/clicks/);
  assert.match(desktop, /640×360 \(width 640, height 360\)/);

  const phone = createRaylibDemoRequest({
    phone: true,
    viewportWidth: 390,
    viewportHeight: 844,
  });
  assert.match(phone, /phone\/touch device.*390×844/);
  assert.match(phone, /touch as the primary interaction/);
  assert.match(phone, /360×640 \(width 360, height 640\)/);

  for (const request of [desktop, phone]) {
    assert.match(request, /original, unusually polished/);
    assert.match(request, /at least three cohesive visual systems/);
    assert.match(request, /write.*\/home\/web\/raylib-demo\.c/is);
    assert.match(request, /compile_raylib/);
    assert.match(request, /call raylib exactly once/);
    assert.doesNotMatch(request, /prepared .*source/i);
  }
});

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
