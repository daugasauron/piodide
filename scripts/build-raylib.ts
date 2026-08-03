import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryFs } from "../src/wasi/memory-fs.ts";
import { runToolchain } from "../src/wasi/toolchain.ts";

const RAYLIB_VERSION = "6.0";
const RAYLIB_ARCHIVE_SHA256 = "2b3ee1e2120c7a0796b33062c7e9a694dd8a8caa56a96319ac8c8ecf54a90d0b";
const RAYLIB_URL = `https://github.com/raysan5/raylib/archive/refs/tags/${RAYLIB_VERSION}.tar.gz`;
const MODULES = ["rcore", "rshapes", "rtextures", "rtext"] as const;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir = join(root, "test", "toolchain-assets");
const outputDir = join(root, "public", "raylib");
const check = process.argv.includes("--check");
const sourceArgument = process.argv.indexOf("--source");

function bytes(path: string): ArrayBuffer {
  const data = readFileSync(path);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function allFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...allFiles(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

function replaceOnce(source: string, before: string, after: string, label: string): string {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Raylib patch did not find exactly one ${label}`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function patchMemoryBackend(source: string): string {
  source = source.replace(
    "*   rcore_memory - Functions to manage window, graphics device and inputs",
    "*   rcore_memory - Functions to manage window, graphics device and inputs\n*\n*   MODIFIED FOR PIODIDE: WASI timing plus browser-injected keyboard, mouse and touch input",
  );
  source = replaceOnce(
    source,
    `#if defined(_WIN32)\n    #include <conio.h>              // Required for: kbhit()\n#else\n    // Provide kbhit() function in non-Windows platforms\n    #include <termios.h>\n    #include <unistd.h>\n    #include <fcntl.h>\n#endif`,
    `#if defined(_WIN32)\n    #include <conio.h>              // Required for: kbhit()\n#elif !defined(__wasi__)\n    // Provide kbhit() function in non-Windows platforms\n    #include <termios.h>\n    #include <unistd.h>\n    #include <fcntl.h>\n#endif`,
    "terminal includes",
  );
  source = source.replaceAll(
    "#if !defined(_WIN32)",
    "#if !defined(_WIN32) && !defined(__wasi__)",
  );
  source = replaceOnce(
    source,
    `    // TODO: Poll input events for current platform\n\n    // Check for key pressed to exit\n    if (kbhit())\n    {\n        int key = getch();\n        if (key == 27) CORE.Window.shouldClose = true; // KEY_SCAPE\n    }`,
    `    // Browser events are injected through the Piodide* functions below.\n+#if !defined(__wasi__)\n+    // Check for key pressed to exit\n+    if (kbhit())\n+    {\n+        int key = getch();\n+        if (key == 27) CORE.Window.shouldClose = true; // KEY_SCAPE\n+    }\n+#endif`,
    "terminal polling block",
  );
  source = replaceOnce(
    source,
    `// Register all input events\nvoid PollInputEvents(void)`,
    `// Piodide browser bridge. These symbols are explicitly exported by the linker.\n+unsigned int *PiodideGetFramebuffer(void) { return platform.pixels; }\n+int PiodideGetFramebufferWidth(void) { return CORE.Window.render.width; }\n+int PiodideGetFramebufferHeight(void) { return CORE.Window.render.height; }\n+\n+void PiodideSetKey(int key, int down)\n+{\n+    if ((key < 0) || (key >= MAX_KEYBOARD_KEYS)) return;\n+    if (down && !CORE.Input.Keyboard.currentKeyState[key] &&\n+        (CORE.Input.Keyboard.keyPressedQueueCount < MAX_KEY_PRESSED_QUEUE))\n+    {\n+        CORE.Input.Keyboard.keyPressedQueue[CORE.Input.Keyboard.keyPressedQueueCount++] = key;\n+    }\n+    CORE.Input.Keyboard.currentKeyState[key] = down ? 1 : 0;\n+}\n+\n+void PiodideSetChar(int codepoint)\n+{\n+    if ((codepoint > 0) && (CORE.Input.Keyboard.charPressedQueueCount < MAX_CHAR_PRESSED_QUEUE))\n+        CORE.Input.Keyboard.charPressedQueue[CORE.Input.Keyboard.charPressedQueueCount++] = codepoint;\n+}\n+\n+void PiodideSetMouse(float x, float y, int button, int down)\n+{\n+    CORE.Input.Mouse.currentPosition = (Vector2){ x, y };\n+    CORE.Input.Mouse.cursorOnScreen = true;\n+    if ((button >= 0) && (button < MAX_MOUSE_BUTTONS))\n+        CORE.Input.Mouse.currentButtonState[button] = down ? 1 : 0;\n+}\n+\n+void PiodideSetMouseWheel(float x, float y)\n+{\n+    CORE.Input.Mouse.currentWheelMove.x += x;\n+    CORE.Input.Mouse.currentWheelMove.y += y;\n+}\n+\n+void PiodideSetTouch(int index, int identifier, float x, float y, int down)\n+{\n+    if ((index < 0) || (index >= MAX_TOUCH_POINTS)) return;\n+    CORE.Input.Touch.pointId[index] = identifier;\n+    CORE.Input.Touch.position[index] = (Vector2){ x, y };\n+    CORE.Input.Touch.currentTouchState[index] = down ? 1 : 0;\n+    CORE.Input.Touch.pointCount = down ? ((index + 1 > CORE.Input.Touch.pointCount) ? index + 1 : CORE.Input.Touch.pointCount) : 0;\n+}\n+\n+// Register all input events\n+void PollInputEvents(void)`,
    "browser input bridge insertion point",
  );
  source = replaceOnce(
    source,
    `    // Register previous touch states\n    for (int i = 0; i < MAX_TOUCH_POINTS; i++) CORE.Input.Touch.previousTouchState[i] = CORE.Input.Touch.currentTouchState[i];`,
    `    CORE.Input.Mouse.previousPosition = CORE.Input.Mouse.currentPosition;\n+    for (int i = 0; i < MAX_MOUSE_BUTTONS; i++) CORE.Input.Mouse.previousButtonState[i] = CORE.Input.Mouse.currentButtonState[i];\n+    CORE.Input.Mouse.previousWheelMove = CORE.Input.Mouse.currentWheelMove;\n+    CORE.Input.Mouse.currentWheelMove = (Vector2){ 0.0f, 0.0f };\n+\n+    // Register previous touch states\n+    for (int i = 0; i < MAX_TOUCH_POINTS; i++)\n+    {\n+        CORE.Input.Touch.previousTouchState[i] = CORE.Input.Touch.currentTouchState[i];\n+        CORE.Input.Touch.previousPosition[i] = CORE.Input.Touch.position[i];\n+    }`,
    "previous input state block",
  );
  source = replaceOnce(
    source,
    "static PlatformData platform = { 0 };   // Platform specific data",
    "static PlatformData platform = { 0 };   // Platform specific data\nstatic double piodideTime = 0.0;              // Browser monotonic time",
    "browser clock storage",
  );
  source = replaceOnce(
    source,
    "double GetTime(void)\n{\n    double time = 0.0;",
    "double GetTime(void)\n{\n#if defined(__wasi__)\n    return piodideTime;\n#endif\n    double time = 0.0;",
    "browser clock",
  );
  // Leading '+' markers make the multi-line additions above easy to audit.
  source = source.replaceAll("\n+", "\n");
  source = replaceOnce(
    source,
    "    CORE.Input.Touch.pointCount = down ? ((index + 1 > CORE.Input.Touch.pointCount) ? index + 1 : CORE.Input.Touch.pointCount) : 0;",
    `    CORE.Input.Touch.pointCount = 0;
    for (int i = 0; i < MAX_TOUCH_POINTS; i++)
        if (CORE.Input.Touch.currentTouchState[i]) CORE.Input.Touch.pointCount++;`,
    "touch point count",
  );
  return replaceOnce(
    source,
    "int PiodideGetFramebufferHeight(void) { return CORE.Window.render.height; }\n",
    "int PiodideGetFramebufferHeight(void) { return CORE.Window.render.height; }\nvoid PiodideSetTime(double seconds) { piodideTime = seconds; }\n",
    "browser clock setter",
  );
}

function patchCore(source: string): string {
  return replaceOnce(
    source,
    `void WaitTime(double seconds)
{
    if (seconds < 0) return;    // Security check`,
    `void WaitTime(double seconds)
{
#if defined(__wasi__)
    // The browser schedules frames. Its injected clock cannot advance while a
    // Wasm frame is executing, so waiting here would busy-loop forever.
    (void)seconds;
    return;
#endif
    if (seconds < 0) return;    // Security check`,
    "frame wait function",
  );
}

const runtimeSource = `/* Piodide raylib 6 framebuffer runtime (zlib/libpng-compatible glue). */
#include "raylib.h"
#include <errno.h>
#include <stddef.h>
#include <string.h>

extern void game_init(void);
extern void game_frame(float delta_seconds);

static int piodide_ready = 0;

// The legacy WASI libc used by the in-browser compiler omits process cwd and
// shell functions. Raylib only needs getcwd() to establish its asset base.
char *getcwd(char *buffer, size_t size)
{
    static const char path[] = "/home/web";
    if ((buffer == 0) || (size < sizeof(path))) { errno = ERANGE; return 0; }
    memcpy(buffer, path, sizeof(path));
    return buffer;
}

int chdir(const char *path) { (void)path; errno = ENOSYS; return -1; }
int system(const char *command) { (void)command; errno = ENOSYS; return -1; }

void PiodideRaylibInit(int width, int height)
{
    if (piodide_ready) return;
    SetTraceLogLevel(LOG_WARNING);
    InitWindow(width, height, "Piodide raylib");
    piodide_ready = IsWindowReady();
    if (piodide_ready) game_init();
}

void PiodideRaylibFrame(float delta_seconds)
{
    if (piodide_ready) game_frame(delta_seconds);
}

void PiodideRaylibClose(void)
{
    if (!piodide_ready) return;
    CloseWindow();
    piodide_ready = 0;
}
`;

async function sourceDirectory(temp: string): Promise<string> {
  if (sourceArgument >= 0) {
    const supplied = process.argv[sourceArgument + 1];
    if (!supplied) throw new Error("--source requires a raylib source directory");
    return resolve(supplied);
  }
  const response = await fetch(RAYLIB_URL);
  if (!response.ok) throw new Error(`Could not download ${RAYLIB_URL} (HTTP ${response.status})`);
  const archive = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(archive);
  if (actual !== RAYLIB_ARCHIVE_SHA256) {
    throw new Error(`raylib archive SHA-256 mismatch: expected ${RAYLIB_ARCHIVE_SHA256}, received ${actual}`);
  }
  const archivePath = join(temp, `raylib-${RAYLIB_VERSION}.tar.gz`);
  writeFileSync(archivePath, archive);
  const extracted = spawnSync("tar", ["-xzf", archivePath, "-C", temp], { encoding: "utf8" });
  if (extracted.status !== 0) throw new Error(extracted.stderr || "Could not extract raylib");
  return join(temp, `raylib-${RAYLIB_VERSION}`);
}

for (const asset of ["clang.wasm", "wasm-ld.wasm", "clang-fs.tar.gz"]) {
  if (!existsSync(join(assetsDir, asset))) {
    throw new Error("Missing toolchain assets. Run: npm run test:fetch-toolchain");
  }
}

const temp = mkdtempSync(join(tmpdir(), "piodide-raylib-build-"));
try {
  const sourceRoot = await sourceDirectory(temp);
  const raylibSrc = join(sourceRoot, "src");
  if (!existsSync(join(raylibSrc, "raylib.h"))) throw new Error(`Invalid raylib source: ${sourceRoot}`);

  const workspace = new MemoryFs();
  workspace.mkdirTree("/home/web/raylib/src");
  for (const path of allFiles(raylibSrc)) {
    if (basename(path) === "miniaudio.h" || basename(path) === "raudio.c") continue;
    const destination = `/home/web/raylib/src/${relative(raylibSrc, path).replaceAll("\\", "/")}`;
    workspace.writeFile(destination, readFileSync(path));
  }
  const platformPath = "/home/web/raylib/src/platforms/rcore_memory.c";
  workspace.writeFile(platformPath, patchMemoryBackend(new TextDecoder().decode(workspace.readFile(platformPath))));
  const corePath = "/home/web/raylib/src/rcore.c";
  workspace.writeFile(corePath, patchCore(new TextDecoder().decode(workspace.readFile(corePath))));
  workspace.writeFile("/home/web/raylib/piodide-raylib.c", runtimeSource);

  const clang = await WebAssembly.compile(bytes(join(assetsDir, "clang.wasm")) as BufferSource);
  const sysroot = bytes(join(assetsDir, "clang-fs.tar.gz"));
  const definitions = [
    "PLATFORM_MEMORY",
    "GRAPHICS_API_OPENGL_SOFTWARE",
    "SUPPORT_MODULE_RAUDIO=0",
    "SUPPORT_MODULE_RMODELS=0",
    "SUPPORT_SCREEN_CAPTURE=0",
    "SUPPORT_CLIPBOARD_IMAGE=0",
    "SUPPORT_AUTOMATION_EVENTS=0",
    "SUPPORT_SSH_KEYBOARD_RPI=0",
  ];
  for (const module of MODULES) {
    const result = await runToolchain(
      {
        operation: "compile",
        sourcePath: `/home/web/raylib/src/${module}.c`,
        outputPath: `/home/web/raylib/${module}.o`,
        options: {
          standard: "c17",
          optimization: "s",
          defines: definitions,
          includePaths: ["/home/web/raylib/src"],
          functionSections: true,
        },
      },
      workspace,
      { toolchain: clang, sysrootTar: sysroot },
    );
    if (result.exitCode !== 0) throw new Error(`Compiling raylib ${module} failed:\n${result.diagnostics}`);
  }
  const runtime = await runToolchain(
    {
      operation: "compile",
      sourcePath: "/home/web/raylib/piodide-raylib.c",
      outputPath: "/home/web/raylib/piodide-raylib.o",
      options: {
        standard: "c17",
        optimization: "s",
        includePaths: ["/home/web/raylib/src"],
        functionSections: true,
      },
    },
    workspace,
    { toolchain: clang, sysrootTar: sysroot },
  );
  if (runtime.exitCode !== 0) throw new Error(`Compiling Piodide raylib runtime failed:\n${runtime.diagnostics}`);

  const generated = new Map<string, Uint8Array>();
  generated.set("raylib.h", workspace.readFile("/home/web/raylib/src/raylib.h"));
  const license = readFileSync(join(sourceRoot, "LICENSE"), "utf8").replace(/[ \t]+$/gm, "");
  generated.set("LICENSE", new TextEncoder().encode(license));
  for (const module of MODULES) generated.set(`${module}.o`, workspace.readFile(`/home/web/raylib/${module}.o`));
  generated.set("piodide-raylib.o", workspace.readFile("/home/web/raylib/piodide-raylib.o"));
  const manifest = {
    version: RAYLIB_VERSION,
    archiveSha256: RAYLIB_ARCHIVE_SHA256,
    files: Object.fromEntries(
      [...generated].map(([name, data]) => [name, { bytes: data.byteLength, sha256: sha256(data) }]),
    ),
  };
  generated.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n"));

  const mismatches: string[] = [];
  for (const [name, data] of generated) {
    const destination = join(outputDir, name);
    if (check) {
      if (!existsSync(destination) || !Buffer.from(readFileSync(destination)).equals(Buffer.from(data))) {
        mismatches.push(destination);
      }
    } else {
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(destination, data);
    }
  }
  if (check) {
    const expected = new Set(generated.keys());
    if (existsSync(outputDir)) {
      for (const name of readdirSync(outputDir)) if (!expected.has(name)) mismatches.push(join(outputDir, name));
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`Generated raylib files are stale:\n${mismatches.map((path) => `  ${path}`).join("\n")}`);
  }
  console.log(check ? "raylib assets are reproducible." : "Built raylib framebuffer assets.");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
