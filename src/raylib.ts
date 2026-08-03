import type { Pyodide } from "./pyodide-host.ts";
import { fsExists } from "./pyodide-host.ts";
import { EmscriptenFs } from "./wasi/emscripten-fs.ts";
import { WasiHost } from "./wasi/host.ts";

const RAYLIB_ASSETS = [
  "raylib.h",
  "rcore.o",
  "rshapes.o",
  "rtextures.o",
  "rtext.o",
  "piodide-raylib.o",
] as const;
const RAYLIB_ROOT = "/opt/raylib";
const MAX_RAYLIB_WASM_BYTES = 12 * 1024 * 1024;
const MAX_FRAMEBUFFER_PIXELS = 1280 * 720;

export const RAYLIB_OBJECT_PATHS = [
  `${RAYLIB_ROOT}/lib/piodide-raylib.o`,
  `${RAYLIB_ROOT}/lib/rcore.o`,
  `${RAYLIB_ROOT}/lib/rshapes.o`,
  `${RAYLIB_ROOT}/lib/rtextures.o`,
  `${RAYLIB_ROOT}/lib/rtext.o`,
] as const;

export const RAYLIB_WASM_EXPORTS = [
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
] as const;

let installPromise: Promise<void> | null = null;

export function ensureRaylibInstalled(py: Pyodide): Promise<void> {
  if (!installPromise) {
    installPromise = (async () => {
      if (RAYLIB_ASSETS.every((name) => fsExists(py, raylibAssetPath(name)))) return;
      py.FS.mkdirTree(`${RAYLIB_ROOT}/include`);
      py.FS.mkdirTree(`${RAYLIB_ROOT}/lib`);
      const base = `${import.meta.env.BASE_URL}raylib/`;
      await Promise.all(RAYLIB_ASSETS.map(async (name) => {
        const response = await fetch(`${base}${name}`);
        if (!response.ok) throw new Error(`Could not load raylib ${name} (HTTP ${response.status})`);
        py.FS.writeFile(raylibAssetPath(name), new Uint8Array(await response.arrayBuffer()));
      }));
    })();
    installPromise.catch(() => {
      installPromise = null;
    });
  }
  return installPromise;
}

export function raylibIncludePath(): string {
  return `${RAYLIB_ROOT}/include`;
}

function raylibAssetPath(name: (typeof RAYLIB_ASSETS)[number]): string {
  return name === "raylib.h" ? `${RAYLIB_ROOT}/include/${name}` : `${RAYLIB_ROOT}/lib/${name}`;
}

type RaylibFunction = (...args: number[]) => number;

interface RaylibApi {
  memory: WebAssembly.Memory;
  init: RaylibFunction;
  frame: RaylibFunction;
  close: RaylibFunction;
  framebuffer: RaylibFunction;
  width: RaylibFunction;
  height: RaylibFunction;
  setTime: RaylibFunction;
  setKey: RaylibFunction;
  setChar: RaylibFunction;
  setMouse: RaylibFunction;
  setWheel: RaylibFunction;
  setTouch: RaylibFunction;
}

interface RaylibInstance {
  host: WasiHost;
  api: RaylibApi;
}

function framebufferSize(width: number, height: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64) {
    throw new Error("Raylib dimensions must be integers of at least 64×64.");
  }
  if (width * height > MAX_FRAMEBUFFER_PIXELS) {
    throw new Error(`Raylib framebuffer exceeds ${MAX_FRAMEBUFFER_PIXELS.toLocaleString()} pixels.`);
  }
  return width * height * 4;
}

function exportedFunction(
  exports: WebAssembly.Exports,
  name: (typeof RAYLIB_WASM_EXPORTS)[number],
): RaylibFunction {
  const value = exports[name];
  if (typeof value !== "function") throw new Error(`Raylib module is missing export: ${name}`);
  return value as RaylibFunction;
}

async function instantiateRaylib(
  py: Pyodide,
  path: string,
  output?: (channel: "stdout" | "stderr", text: string) => void,
): Promise<RaylibInstance> {
  const binary = py.FS.readFile(path) as Uint8Array;
  if (binary.byteLength > MAX_RAYLIB_WASM_BYTES) {
    throw new Error(`Raylib module exceeds ${MAX_RAYLIB_WASM_BYTES / 1024 / 1024} MiB.`);
  }
  const module = await WebAssembly.compile(binary as BufferSource);
  const decoder = new TextDecoder();
  const host = new WasiHost({
    fs: new EmscriptenFs(py.FS),
    args: [path],
    env: { PWD: "/home/web" },
    preopens: [{ name: ".", path: "/home/web" }, "/home/web", "/"],
    stdout: (chunk) => output?.("stdout", decoder.decode(chunk, { stream: true })),
    stderr: (chunk) => output?.("stderr", decoder.decode(chunk, { stream: true })),
  });
  try {
    const instance = await WebAssembly.instantiate(module, host.getImportObject());
    host.bind(instance);
    const exports = instance.exports;
    const memory = exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) throw new Error("Raylib module does not export memory.");
    return {
      host,
      api: {
        memory,
        init: exportedFunction(exports, "PiodideRaylibInit"),
        frame: exportedFunction(exports, "PiodideRaylibFrame"),
        close: exportedFunction(exports, "PiodideRaylibClose"),
        framebuffer: exportedFunction(exports, "PiodideGetFramebuffer"),
        width: exportedFunction(exports, "PiodideGetFramebufferWidth"),
        height: exportedFunction(exports, "PiodideGetFramebufferHeight"),
        setTime: exportedFunction(exports, "PiodideSetTime"),
        setKey: exportedFunction(exports, "PiodideSetKey"),
        setChar: exportedFunction(exports, "PiodideSetChar"),
        setMouse: exportedFunction(exports, "PiodideSetMouse"),
        setWheel: exportedFunction(exports, "PiodideSetMouseWheel"),
        setTouch: exportedFunction(exports, "PiodideSetTouch"),
      },
    };
  } catch (error) {
    host.close();
    throw error;
  }
}

function checkFramebuffer(api: RaylibApi, expectedWidth: number, expectedHeight: number): number {
  const width = api.width();
  const height = api.height();
  const bytes = framebufferSize(width, height);
  if (width !== expectedWidth || height !== expectedHeight) {
    throw new Error(`Raylib initialized ${width}×${height}, expected ${expectedWidth}×${expectedHeight}.`);
  }
  const pointer = api.framebuffer();
  if (pointer <= 0 || pointer + bytes > api.memory.buffer.byteLength) {
    throw new Error("Raylib returned an invalid framebuffer.");
  }
  return pointer;
}

export async function validateRaylibModule(
  py: Pyodide,
  path: string,
  width: number,
  height: number,
): Promise<void> {
  framebufferSize(width, height);
  const runtime = await instantiateRaylib(py, path);
  try {
    runtime.api.setTime(0);
    runtime.api.init(width, height);
    runtime.api.setTime(1 / 60);
    runtime.api.frame(1 / 60);
    checkFramebuffer(runtime.api, width, height);
    runtime.api.close();
  } finally {
    runtime.host.close();
  }
}

const SPECIAL_KEYS: Readonly<Record<string, number>> = {
  Escape: 256,
  Enter: 257,
  Tab: 258,
  Backspace: 259,
  Insert: 260,
  Delete: 261,
  ArrowRight: 262,
  ArrowLeft: 263,
  ArrowDown: 264,
  ArrowUp: 265,
  PageUp: 266,
  PageDown: 267,
  Home: 268,
  End: 269,
  CapsLock: 280,
  ScrollLock: 281,
  NumLock: 282,
  PrintScreen: 283,
  Pause: 284,
  ShiftLeft: 340,
  ControlLeft: 341,
  AltLeft: 342,
  MetaLeft: 343,
  ShiftRight: 344,
  ControlRight: 345,
  AltRight: 346,
  MetaRight: 347,
};

function raylibKey(event: KeyboardEvent): number | null {
  if (event.code.startsWith("Key") && event.code.length === 4) return event.code.charCodeAt(3);
  if (event.code.startsWith("Digit") && event.code.length === 6) return event.code.charCodeAt(5);
  if (/^F(?:[1-9]|1[0-2])$/.test(event.code)) return 289 + Number(event.code.slice(1));
  if (event.code === "Space") return 32;
  return SPECIAL_KEYS[event.code] ?? SPECIAL_KEYS[event.key] ?? null;
}

function raylibMouseButton(button: number): number {
  if (button === 2) return 1;
  if (button === 1) return 2;
  return button;
}

export interface RaylibCanvasOptions {
  py: Pyodide;
  path: string;
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
  status: HTMLElement;
  onError: (error: unknown) => void;
}

export class RaylibCanvasSession {
  private options: RaylibCanvasOptions;
  private runtime: RaylibInstance | null = null;
  private animationFrame = 0;
  private events = new AbortController();
  private pressedKeys = new Set<number>();
  private touches = new Map<number, { x: number; y: number }>();
  private rgba: Uint8ClampedArray<ArrayBuffer> | null = null;
  private image: ImageData | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private lastTime = 0;
  private frames = 0;
  private fpsTime = 0;

  constructor(options: RaylibCanvasOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    const { py, path, width, height, canvas } = this.options;
    framebufferSize(width, height);
    this.runtime = await instantiateRaylib(py, path, (channel, output) => {
      if (channel === "stderr") this.options.status.textContent = output.trim().slice(0, 160);
    });
    const { api } = this.runtime;
    api.setTime(0);
    api.init(width, height);
    checkFramebuffer(api, width, height);

    canvas.width = width;
    canvas.height = height;
    canvas.tabIndex = 0;
    this.context = canvas.getContext("2d", { alpha: false });
    if (!this.context) throw new Error("Canvas 2D is unavailable.");
    this.rgba = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
    this.image = new ImageData(this.rgba, width, height);
    this.resizeObserver = new ResizeObserver(this.fitCanvas);
    if (canvas.parentElement) this.resizeObserver.observe(canvas.parentElement);
    this.fitCanvas();
    this.attachInput();
    this.lastTime = performance.now();
    this.fpsTime = this.lastTime;
    this.animationFrame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    cancelAnimationFrame(this.animationFrame);
    this.events.abort();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.runtime) {
      try {
        this.runtime.api.close();
      } catch {
        // Closing a trapped game should still release its host resources.
      }
      this.runtime.host.close();
    }
    this.runtime = null;
    this.rgba = null;
    this.image = null;
    this.context = null;
  }

  private tick = (now: number) => {
    if (!this.runtime) return;
    try {
      const delta = Math.min(0.1, Math.max(0, (now - this.lastTime) / 1000));
      this.lastTime = now;
      this.runtime.api.setTime(now / 1000);
      this.runtime.api.frame(delta);
      this.drawFramebuffer();
      this.frames++;
      if (now - this.fpsTime >= 1000) {
        const fps = Math.round(this.frames * 1000 / (now - this.fpsTime));
        this.options.status.textContent = `${this.options.width}×${this.options.height} · ${fps} fps · CPU framebuffer`;
        this.frames = 0;
        this.fpsTime = now;
      }
      this.animationFrame = requestAnimationFrame(this.tick);
    } catch (error) {
      this.stop();
      this.options.onError(error);
    }
  };

  private drawFramebuffer(): void {
    if (!this.runtime || !this.rgba || !this.image) return;
    const { api } = this.runtime;
    const pointer = checkFramebuffer(api, this.options.width, this.options.height);
    const source = new Uint8Array(api.memory.buffer, pointer, this.rgba.byteLength);
    // raylib's packed software framebuffer is BGRA in little-endian wasm memory.
    for (let index = 0; index < source.length; index += 4) {
      this.rgba[index] = source[index + 2];
      this.rgba[index + 1] = source[index + 1];
      this.rgba[index + 2] = source[index];
      this.rgba[index + 3] = source[index + 3];
    }
    if (!this.context) throw new Error("Canvas 2D is unavailable.");
    this.context.putImageData(this.image, 0, 0);
  }

  private fitCanvas = () => {
    const { canvas, width, height } = this.options;
    const stage = canvas.parentElement;
    if (!stage) return;
    const scale = Math.min(stage.clientWidth / width, stage.clientHeight / height);
    if (!Number.isFinite(scale) || scale <= 0) return;
    canvas.style.width = `${Math.max(1, Math.floor(width * scale))}px`;
    canvas.style.height = `${Math.max(1, Math.floor(height * scale))}px`;
  };

  private position(event: PointerEvent | WheelEvent): [number, number] {
    const bounds = this.options.canvas.getBoundingClientRect();
    return [
      Math.max(0, Math.min(this.options.width - 1, (event.clientX - bounds.left) * this.options.width / bounds.width)),
      Math.max(0, Math.min(this.options.height - 1, (event.clientY - bounds.top) * this.options.height / bounds.height)),
    ];
  }

  private attachInput(): void {
    if (!this.runtime) return;
    const { canvas } = this.options;
    const signal = this.events.signal;
    const api = this.runtime.api;
    const keydown = (event: KeyboardEvent) => {
      const key = raylibKey(event);
      if (key === null) return;
      event.preventDefault();
      api.setKey(key, 1);
      this.pressedKeys.add(key);
      if (!event.repeat && !event.ctrlKey && !event.metaKey && event.key.length === 1) {
        api.setChar(event.key.codePointAt(0) ?? 0);
      }
    };
    const keyup = (event: KeyboardEvent) => {
      const key = raylibKey(event);
      if (key === null) return;
      event.preventDefault();
      api.setKey(key, 0);
      this.pressedKeys.delete(key);
    };
    const releaseKeys = () => {
      for (const key of this.pressedKeys) api.setKey(key, 0);
      this.pressedKeys.clear();
    };
    window.addEventListener("keydown", keydown, { signal });
    window.addEventListener("keyup", keyup, { signal });
    window.addEventListener("blur", releaseKeys, { signal });

    const pointer = (event: PointerEvent, down: boolean | null) => {
      event.preventDefault();
      const [x, y] = this.position(event);
      if (event.pointerType === "touch") {
        if (down === false) this.touches.delete(event.pointerId);
        else if (down === true || this.touches.has(event.pointerId)) {
          this.touches.set(event.pointerId, { x, y });
        }
        let slot = 0;
        for (const [identifier, position] of this.touches) {
          if (slot >= 10) break;
          api.setTouch(slot++, identifier, position.x, position.y, 1);
        }
        while (slot < 10) api.setTouch(slot++, 0, 0, 0, 0);
      } else {
        api.setMouse(x, y, down === null ? -1 : raylibMouseButton(event.button), down === false ? 0 : 1);
      }
    };
    canvas.addEventListener("pointerdown", (event) => {
      canvas.focus();
      canvas.setPointerCapture(event.pointerId);
      pointer(event, true);
    }, { signal });
    canvas.addEventListener("pointermove", (event) => pointer(event, null), { signal });
    canvas.addEventListener("pointerup", (event) => pointer(event, false), { signal });
    canvas.addEventListener("pointercancel", (event) => pointer(event, false), { signal });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      api.setWheel(-event.deltaX / 100, -event.deltaY / 100);
    }, { signal, passive: false });
    canvas.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });
  }
}
