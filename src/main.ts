import "./style.css";

import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type ImageContent,
  type Message,
  type Usage,
} from "@earendil-works/pi-ai";

import {
  createTerminal,
  PromptLine,
  Spinner,
  type CommandSuggestion,
  type TermWriter,
  type TerminalHandle,
} from "./termui.ts";
import {
  formatWasmHeapUsage,
  fsExists,
  fsIsDir,
  fsReadText,
  fsResolve,
  fsWriteText,
  loadPyodideRuntime,
  type Pyodide,
} from "./pyodide-host.ts";
import { BrowserSessions, type BrowserSession } from "./browser-sessions.ts";
import { deleteKittyImages, renderKittyImage } from "./kitty-image.ts";
import { AssistantMarkdown } from "./markdown.ts";
import { makeModel } from "./model.ts";
import { streamDispatch } from "./stream.ts";
import {
  PROVIDERS,
  getLoadedModelInfo,
  getProvider,
  type ProviderDef,
} from "./providers.ts";
import {
  estimateWebGpuKvCacheBytes,
  formatContextSize,
  formatModelBytes,
  getBrowserModel,
} from "./browser-models.ts";
import { getLocalProviderBinding } from "./local-provider.ts";
import type { LocalModelRuntime, LocalModelStatus } from "./local-model.ts";
import { browserModelRuntime } from "./browser-model-runtime.ts";
import { webLLMRuntime } from "./webllm-runtime.ts";
import { createAllTools, createHtmlTool, createImageTool } from "./tools.ts";
import type { NeovimController } from "./neovim.ts";
import {
  normalizeGitHubApiUrl,
  verifyGitHubCredentials,
  type GitHubCredentials,
} from "./git-tool.ts";
import {
  downloadPyodideFile,
  pickHostFiles,
  resolveUploadDirectory,
  uploadConflicts,
  uploadHostFiles,
} from "./file-transfer.ts";
import { makeJsRunner, startWasiProgram, supportsWorkerWasi } from "./wasi/browser-runner.ts";
import { installWasiPythonModule } from "./wasi/python-module.ts";
import { SlopSession } from "./slop.ts";
import { MobileCommandUi } from "./mobile-command-ui.ts";
import { normalizeApiKey, verifyApiKey } from "./provider-auth.ts";
import { RaylibCanvasSession } from "./raylib.ts";

const NEOVIM_ENABLED = import.meta.env.VITE_ENABLE_NEOVIM !== "0";

/* ------------------------------------------------------------------ */
/* system prompt                                                       */
/* ------------------------------------------------------------------ */

const REMOTE_SYSTEM_PROMPT = `You are pi, a coding assistant running entirely inside the user's web browser. You have no access to the host machine. Your only runtime is one long-lived Pyodide CPython instance backed by an in-memory filesystem at /home/web.

Tools:
- python: run focused, valid CPython 3 code; stdout/stderr is shown live and returned to you. Never use notebook ! commands, pip, os.system, or subprocess. Install a pure-Python package only when needed with: import micropip; await micropip.install("pkg").
- compile_c: compile one bounded C source file to a wasm32-wasi .o object. It supports C11/C17, -O0/-O1/-O2/-O3/-Os, DWARF debug info, warnings/-Werror, -D definitions, and additional /home/web include directories.
- link_wasi: link one or more .o files into a WASI .wasm executable with wasm-ld and WASI libc. It can export selected symbols and optionally strip the result. The compiler, linker, and sysroot assets are lazily downloaded.
- run_wasi: run a WASI .wasm file from /home/web with arguments, stdin, and environment variables. The program shares the live Pyodide filesystem (no copying): files it creates, edits, or deletes are immediately visible everywhere. Relative paths start at /home/web, and absolute /home/web paths also work. Use this tool directly to verify a linked executable; do not route ordinary WASI execution through Python.
- compile_raylib: compile one C file into a raylib 6 game using the WASI software framebuffer. Include raylib.h and define game_init(void) and game_frame(float delta_seconds). The browser owns InitWindow and the frame loop, and the raylib tool supplies the WASI imports; never create an HTML/JavaScript host for it. 2D shapes, text, textures, keyboard, mouse, and touch are supported; audio and rmodels are not.
- raylib: validate and open a compile_raylib-produced game in the full-screen canvas. Choose a bounded internal resolution and call it exactly once after compilation succeeds.
- slop: run a command or newline-delimited script in the Slop build shell. It supports buffered pipes, redirects, &&/|| lists, variables, substitution, globbing, functions, set -euo pipefail, and line-oriented if/for/while/case blocks. Put compound blocks on separate lines; one-line Bash compounds, heredocs, subshells, and background jobs are unavailable. Prefer rg for recursive regex/file search. /bin includes make, sh, Git, curl, Python, grep, sed, find, and bounded file utilities. Use Python instead of guessing awk, jq, tar, or other uninstalled commands. Each tool call uses a fresh shell — files persist, shell variables and cwd do not (pass cwd; default /home/web). Run COMMAND --help for supported option subsets.
- Browser curl handles one HTTP(S) URL, follows redirects only with -L, and needs CORS to read cross-origin responses. A simple side-effecting request may still reach its server before CORS blocks the response. Use -o FILE for output above the 1 MiB pipeline limit; never place secrets in curl command arguments.
- read: read a text file with line numbers; offset (1-based) and limit paginate large files.
- write: create or overwrite a file; parent directories are created automatically.
- edit: apply exact, unique string replacements (each oldText must match exactly once).
- download: save one file from Pyodide to the user's browser downloads. Call it only when the user asks to download or save a file locally.
- git: use Slop's compiled frontend in /home/web. Local operations combine libgit2 Wasm with a browser-native Git layer over canonical objects, refs, config, and indexes. Full smart-HTTP history/branches/tags work when the server allows CORS or the user supplies a trusted --cors-proxy. Direct GitHub is an explicit snapshot mode: it has synthetic local commits, no remote-tracking refs or upstream history, and no fetch; use git snapshot info, git ls-remote, and git pull. Private access is registered by the user with /github and is never visible to you.
- fetch: fetch a URL via the browser's native fetch (CORS-limited); set path to save a binary response in /home/web. Saving a file does not display it.
- image: display a PNG, JPEG, GIF, or WebP file from /home/web directly in the terminal. This is the only display path; call it exactly once.
- html_debug: run a self-contained HTML file invisibly in the same opaque-origin sandbox and report console errors, uncaught exceptions, rejected promises, and resource failures. Use it after writing or editing HTML, fix every reported error, then call html.
- html: open a self-contained HTML file from /home/web in a closeable browser preview only after html_debug passes. Write one file with inline CSS and JavaScript, then call html exactly once. The sandboxed srcdoc has an opaque origin: localStorage, sessionStorage, IndexedDB, relative fetches, and relative MEMFS assets are unavailable. Keep state in JavaScript memory and embed every required asset, including Wasm bytes, in the HTML.

Environment and memory constraints:
- Pyodide, Python objects, loaded packages, and MEMFS files all consume the page's WebAssembly memory. It can grow toward a hard wasm32 ceiling of about 4 GB and cannot be safely recovered after exhaustion.
- The runtime and filesystem persist for this page only. A refresh destroys them. There are no subprocesses, native host commands, or host files.
- The user can import host files with /upload [directory]. This opens a browser file picker and cannot be initiated by you; tell the user to run it when host input is needed.
- Git metadata is local to MEMFS. GitHub tokens live only in browser page memory; never ask the user to reveal a token in chat or write one into a file, URL, command, or tool argument.
- Never create unbounded lists, arrays, recursion, exhaustive Cartesian products, or whole-file/network copies when a bounded or streaming approach works.
- Estimate memory before large work. Avoid any single allocation above roughly 128 MB or total planned working data above roughly 512 MB unless the user explicitly requires it and accepts the risk.
- Process large inputs incrementally, sample first, cap iteration counts and output, and keep generated files small. Do not print huge datasets.
- Delete large temporary objects and run \`import gc; gc.collect()\` after memory-heavy work. Avoid installing large package stacks speculatively.
- If a request could exhaust memory, say so and use a bounded alternative instead of attempting it.

Files written by write are immediately visible to python and vice versa. The current working directory is /home/web.

C/WASI toolchain:
- Prefer compile_c and link_wasi when you want structured validation, separate diagnostics, and explicit inputs/outputs. Prefer slop's cc/ld commands for familiar command lines, cwd-relative paths, or && workflows. Both interfaces use exactly the same backend and cache.
- Slop examples: cc -c -std=c17 -O2 -Wall -Wextra main.c -o main.o; ld main.o util.o --export=main -o app.wasm; ./app.wasm. The older names compile and link remain aliases for cc and ld. Run cc --help or ld --help for the accepted flags.
- cc and ld are host-routed Slop pseudo-commands, not WASI files in /bin. cc compiles exactly one .c source to one .o object; invoke it once per translation unit, then pass objects to ld in link order.
- The first toolchain use downloads and compiles roughly 52 MB of Clang 8, wasm-ld, and sysroot assets. Reuse the cache and avoid speculative compiles. Compilation runs in a disposable worker when cross-origin isolation is available and may take materially longer than Python or the small /bin commands.
- Defaults are C11 and -O2. This is a legacy WASI libc/toolchain: C11 and C17 are supported, direct errno access is compatibility-patched, and relative file paths start at the supplied cwd. chdir/getcwd, native subprocesses, threads, sockets, dynamic loading, and host OS access are unavailable. Generated modules currently use the legacy wasi_unstable namespace, which this runtime supports alongside wasi_snapshot_preview1.
- Keep sources and outputs small. A serial, practical Make subset and a basic ar utility are installed, but there is no package manager or native executable output. The host linker still consumes explicit .o inputs rather than ar archives. Use run_wasi as the default way to execute and verify a linked module. Use ./path inside slop only when execution belongs in a shell workflow. Python's wasi.run_wasi bridge exists for explicit Python/WASI integration, but its async boundary is awkward and unnecessary for normal execution.

Extending the shell (self-hosting):
- You can add commands: write a small C program with the write tool, compile it with cc -c file.c -o file.o, then link it with ld file.o -o /bin/name (or use compile_c + link_wasi). It runs immediately by exact name through slop. Relative paths automatically start at the cwd supplied by slop.
- The shell, Make, and utility sources are installed in /home/web/slop/ with a README and Makefile. You can rebuild and extend them, but replacing /bin/slop while it is in use requires care.
To show an image, save it as a file and then call the image tool exactly once. A fetch,
python, or reasoning result does not display the file. Do not print binary image bytes or
base64 into the terminal, and do not call image again for the same display request.
To show an interactive page, write a self-contained .html file, run html_debug until it passes,
then call the html tool exactly once. Keep its CSS and JavaScript inline. Never add
allow-same-origin or depend on browser storage in the preview.

Be concise and pragmatic. Prefer running code over long prose. Use python for math, data, and exploration. Use write/edit to change files, then confirm briefly.`;

const LOCAL_SYSTEM_PROMPT = `You are pi, a tool-using coding assistant running entirely in the user's browser. Work directly on the persistent in-memory filesystem rooted at /home/web. You cannot access host files, native processes, or the host shell.

Working method:
- Inspect relevant files before editing. Use tools for actions; never claim that you ran or changed something without a successful tool result.
- Prefer small, focused changes. Verify important work by reading it back or running a bounded check.
- Call one tool at a time unless independent calls are clearly safe. After a tool error, inspect the error and adjust instead of repeating the same call.
- Keep answers concise. When the task asks for implementation, finish the implementation rather than only explaining it.

Tools:
- read, write, and edit operate on text files in /home/web. edit requires an exact unique oldText match.
- slop runs one command or newline-delimited script in the Slop build shell, with pipes, redirects, variables, substitution, globbing, set -euo pipefail, Make, rg/grep, sed, find, bounded file utilities, and Git. Prefer rg for recursive regex/file search. Put compound blocks on separate lines. It has no heredocs, subshells, background jobs, awk, jq, or tar; use write/edit or Python for those jobs. cc/ld, Python, browser curl, and GitHub transfer use browser host services. Each call has fresh cwd and shell state; pass cwd when needed. Run COMMAND --help for exact option subsets. It is not Bash and cannot access the host OS.
- Browser curl handles one HTTP(S) URL, follows redirects only with -L, and needs CORS to read cross-origin responses. A simple request may reach its server before CORS blocks the response. Use -o for responses above the 1 MiB pipeline limit and never put secrets in curl arguments.
- python runs focused, valid CPython 3 in the long-lived Pyodide runtime. Never use notebook ! commands, pip, os.system, or subprocess. Pure-Python packages can be installed with micropip when necessary.
- compile_c compiles one C11/C17 source to a wasm32-wasi object. link_wasi links objects with WASI libc. run_wasi directly executes the resulting module and is the default way to verify it. Do not run WASI through Python unless the user specifically asks for Python/WASI integration. The first compile downloads about 52 MB; avoid speculative builds.
- compile_raylib builds one C source containing game_init(void) and game_frame(float) against raylib 6's CPU framebuffer; raylib supplies the WASI imports, validates the module, and opens it with browser keyboard, mouse, and touch input. Never build an HTML/JavaScript host for it. Use BeginDrawing/EndDrawing inside game_frame. Do not call SetTargetFPS; the browser schedules frames. Audio and rmodels are unavailable. Call raylib exactly once at the end.
- git creates canonical loose or packed repositories through the compiled Slop frontend. Browser smart HTTP preserves history, branches, and tags on CORS-enabled servers or through a user-supplied trusted proxy. Direct GitHub is a bounded snapshot with synthetic local commits and no materialized remote refs/history; use git snapshot info, git ls-remote, and git pull. Credentials are registered separately by the user.
- fetch is browser fetch and is CORS-limited. download exports a file only when the user asks. image displays an image exactly once. html_debug invisibly checks one self-contained HTML file for startup errors; use it before html. html opens that file only after the check passes. The sandboxed srcdoc has an opaque origin, so browser storage and relative MEMFS fetches do not work; inline every dependency and keep runtime state in JavaScript memory.

Constraints:
- Pyodide objects and /home/web files consume a wasm32 heap with a hard ceiling near 4 GB. Avoid unbounded work, large copies, and speculative package installs.
- The user must run /upload to import host files. Never ask for secrets in chat or write tokens into files, commands, or URLs.
- Files written by any tool are immediately visible to every other tool.

Choose the narrowest useful tool, inspect before changing, and verify after changing.`;

const BANNER = [
  "\x1b[35m❯\x1b[0m \x1b[1mpiodide\x1b[0m — pi in the browser",
  "\x1b[2mghostty-web · pyodide · pi-agent-core\x1b[0m",
  "",
  `\x1b[2mCommands:\x1b[0m  /provider   /model   /github   /new   /tree   /thinking${NEOVIM_ENABLED ? "   /nvim" : ""}   /help`,
  NEOVIM_ENABLED
    ? "\x1b[2mViews:\x1b[0m     Ctrl+Shift+E toggles agent ↔ Neovim · Ctrl+Shift+S toggles slop shell"
    : "\x1b[2mView:\x1b[0m      Ctrl+Shift+S toggles the slop shell",
  "\x1b[2mStart with:\x1b[0m /provider  →  choose one  →  /login when required  →  type.",
  "\x1b[2mTry:\x1b[0m        /demo  →  launch a raylib/Wasm performance showcase.",
  "",
].join("\r\n");

const NEOVIM_COMMANDS: readonly CommandSuggestion[] = NEOVIM_ENABLED
  ? [{ name: "/nvim", description: "open Neovim (Ctrl+Shift+E)" }]
  : [];

const COMMANDS: readonly CommandSuggestion[] = [
  { name: "/provider", description: "choose the API provider" },
  { name: "/model", description: "choose the active model" },
  { name: "/login", description: "set the provider API key" },
  { name: "/logout", description: "remove the current provider API key" },
  { name: "/github", description: "register a session-only GitHub access token" },
  { name: "/new", description: "start a new page-local session" },
  { name: "/tree", description: "navigate page-local session branches" },
  { name: "/resume", description: "resume another page-local session" },
  { name: "/fork", description: "fork from a previous user turn" },
  { name: "/clone", description: "clone the current session" },
  { name: "/name", description: "set the current session name" },
  { name: "/session", description: "show current session info and stats" },
  { name: "/copy", description: "copy the last assistant message" },
  { name: "/export", description: "download the current session as JSON" },
  { name: "/thinking", description: "select model thinking level" },
  { name: "/download", description: "save a Pyodide file to the host" },
  { name: "/upload", description: "import host files into /home/web" },
  { name: "/run", description: "run a WASI program from /home/web" },
  { name: "/image", description: "display an image file from /home/web" },
  { name: "/html", description: "open an HTML file from /home/web" },
  { name: "/demo", description: "launch a raylib/Wasm performance showcase" },
  ...NEOVIM_COMMANDS,
  { name: "/hotkeys", description: "show keyboard shortcuts" },
  { name: "/settings", description: "show current browser settings" },
  { name: "/status", description: "show detailed session status" },
  { name: "/clear", description: "clear terminal output" },
  { name: "/help", description: "show command help" },
];

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

const mount = document.getElementById("terminal") as HTMLElement;
const agentViewEl = document.getElementById("agent-view") as HTMLElement;
const slopViewEl = document.getElementById("slop-view") as HTMLElement;
const slopMountEl = document.getElementById("slop-terminal") as HTMLElement;
const neovimViewEl = document.getElementById("neovim-view") as HTMLElement;
const neovimEditorEl = document.getElementById("neovim-editor") as HTMLElement;
const neovimCommandlineEl = document.getElementById("neovim-commandline") as HTMLElement;
const neovimStatusEl = document.getElementById("neovim-status") as HTMLElement;
const commandMenuEl = document.getElementById("command-menu") as HTMLElement;
const mobileCommandLayerEl = document.getElementById("mobile-command-layer") as HTMLElement;
const mobileCommandDrawerEl = document.getElementById("mobile-command-drawer") as HTMLElement;
const mobileCommandBackdropEl = document.getElementById(
  "mobile-command-backdrop",
) as HTMLButtonElement;
const mobileCommandTriggerEl = document.getElementById(
  "mobile-command-trigger",
) as HTMLButtonElement;
const mobileCommandCloseEl = document.getElementById(
  "mobile-command-close",
) as HTMLButtonElement;
const mobileCommandTitleEl = document.getElementById("mobile-command-title") as HTMLElement;
const mobileCommandContentEl = document.getElementById(
  "mobile-command-content",
) as HTMLElement;
const htmlPreviewEl = document.getElementById("html-preview") as HTMLElement;
const htmlPreviewTitleEl = document.getElementById("html-preview-title") as HTMLElement;
const htmlPreviewFrameEl = document.getElementById("html-preview-frame") as HTMLIFrameElement;
const htmlPreviewCloseEl = document.getElementById("html-preview-close") as HTMLButtonElement;
const raylibPreviewEl = document.getElementById("raylib-preview") as HTMLElement;
const raylibPreviewTitleEl = document.getElementById("raylib-preview-title") as HTMLElement;
const raylibPreviewStatusEl = document.getElementById("raylib-preview-status") as HTMLElement;
const raylibPreviewCanvasEl = document.getElementById("raylib-preview-canvas") as HTMLCanvasElement;
const raylibPreviewCloseEl = document.getElementById("raylib-preview-close") as HTMLButtonElement;
const footerLocationEl = document.getElementById("footer-location") as HTMLElement;
const footerUsageEl = document.getElementById("footer-usage") as HTMLElement;
const footerModelEl = document.getElementById("footer-model") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;

let handle!: TerminalHandle;
let slopHandle: TerminalHandle | null = null;
let slopTerminalStarting: Promise<TerminalHandle> | null = null;
let writer!: TermWriter;
let prompt!: PromptLine;
let mobileCommands!: MobileCommandUi;
let markdown!: AssistantMarkdown;
let spinner!: Spinner;

let agent: Agent | null = null;
let py: Pyodide | null = null;
let pyReady = false;
let activeView: "agent" | "nvim" | "slop" = "agent";
let neovim: NeovimController | null = null;
let slop: SlopSession | null = null;
let raylibPreview: RaylibCanvasSession | null = null;
let raylibLaunchCount = 0;
let neovimStarting: Promise<NeovimController> | null = null;
let viewToggleRunning = false;

let provider: ProviderDef | null = null;
const apiKeys = new Map<string, string>();

/**
 * Terminal input routing. The prompt owns keystrokes by default; an
 * interactive WASI program (/run) temporarily takes them over.
 */
let inputHandler: (data: string) => void = (data) => prompt.feed(data);
let gitHubCredentials: GitHubCredentials | null = null;
let modelOverride: string | null = null;
const sessions = new BrowserSessions();

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const magenta = (s: string) => `\x1b[35m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

let viewportSyncFrame = 0;

function syncVisualViewport() {
  const viewport = window.visualViewport;
  const height = viewport?.height ?? window.innerHeight;
  const width = viewport?.width ?? window.innerWidth;
  document.documentElement.style.setProperty("--app-height", `${Math.round(height)}px`);
  document.documentElement.style.setProperty("--app-width", `${Math.round(width)}px`);
  // The app owns all scrolling inside its terminal/menu surfaces. Some mobile
  // browsers leave the layout viewport slightly panned after dismissing the
  // keyboard; pin it back so the fixed shell cannot reopen clipped at an edge.
  if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  window.cancelAnimationFrame(viewportSyncFrame);
  viewportSyncFrame = window.requestAnimationFrame(() => {
    const terminal = activeView === "slop" ? slopHandle : handle;
    if (!terminal) return;
    terminal.fit.fit();
    terminal.term.scrollToBottom();
  });
}

function say(line: string) {
  writer.ensureNewline();
  writer.writeln(line);
}

function openHtmlPreview(path: string) {
  if (!py) throw new Error("Python filesystem is not ready.");
  closeRaylibPreview();
  htmlPreviewTitleEl.textContent = path;
  htmlPreviewFrameEl.srcdoc = fsReadText(py, path);
  htmlPreviewEl.hidden = false;
  document.body.classList.add("html-preview-open");
  htmlPreviewCloseEl.focus();
}

async function openRaylibPreview(
  path: string,
  width: number,
  height: number,
  title: string,
) {
  if (!py) throw new Error("Python filesystem is not ready.");
  closeHtmlPreview();
  closeRaylibPreview();
  raylibPreviewTitleEl.textContent = title;
  raylibPreviewStatusEl.textContent = `${width}×${height} · starting…`;
  raylibPreviewEl.hidden = false;
  document.body.classList.add("raylib-preview-open");
  const session = new RaylibCanvasSession({
    py,
    path,
    width,
    height,
    canvas: raylibPreviewCanvasEl,
    status: raylibPreviewStatusEl,
    onError: (error) => {
      closeRaylibPreview();
      say(red(`  ↳ raylib preview failed: ${error instanceof Error ? error.message : String(error)}`));
    },
  });
  raylibPreview = session;
  try {
    await session.start();
    raylibLaunchCount++;
    raylibPreviewStatusEl.textContent = `${width}×${height} · CPU framebuffer`;
    raylibPreviewCanvasEl.focus();
  } catch (error) {
    closeRaylibPreview();
    throw error;
  }
}

function closeRaylibPreview() {
  raylibPreview?.stop();
  raylibPreview = null;
  raylibPreviewEl.hidden = true;
  raylibPreviewCanvasEl.width = 1;
  raylibPreviewCanvasEl.height = 1;
  document.body.classList.remove("raylib-preview-open");
  if (handle) handle.term.focus();
}

function closeHtmlPreview() {
  if (htmlPreviewEl.hidden) return;
  htmlPreviewEl.hidden = true;
  htmlPreviewFrameEl.srcdoc = "";
  document.body.classList.remove("html-preview-open");
  handle.term.focus();
}

htmlPreviewCloseEl.addEventListener("click", closeHtmlPreview);
htmlPreviewEl.addEventListener("click", (event) => {
  if (event.target === htmlPreviewEl) closeHtmlPreview();
});
raylibPreviewCloseEl.addEventListener("click", closeRaylibPreview);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !htmlPreviewEl.hidden) {
    event.preventDefault();
    closeHtmlPreview();
    return;
  }
  if (
    htmlPreviewEl.hidden &&
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    event.code === "KeyE"
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void toggleNeovim();
  }
  if (
    htmlPreviewEl.hidden &&
    event.ctrlKey &&
    event.shiftKey &&
    !event.altKey &&
    !event.metaKey &&
    event.code === "KeyS"
  ) {
    event.preventDefault();
    event.stopImmediatePropagation();
    void toggleSlop();
  }
}, true);

function currentModelId() {
  return modelOverride ?? provider?.defaultModel ?? "";
}

function currentApiKey() {
  return provider ? (apiKeys.get(provider.name) ?? "") : "";
}

function currentLocalProvider() {
  return getLocalProviderBinding(provider);
}

function currentSystemPrompt() {
  const base = provider?.transport === "browser"
    ? LOCAL_SYSTEM_PROMPT
    : REMOTE_SYSTEM_PROMPT;
  return `${base}\n\n${clientEnvironmentDescription()}`;
}

function isPhoneClient(): boolean {
  return (
    window.innerWidth <= 960 &&
    (navigator.maxTouchPoints > 0 || matchMedia("(any-pointer: coarse)").matches)
  );
}

function clientEnvironmentDescription(): string {
  const kind = isPhoneClient() ? "phone with a touch screen" : "desktop/laptop";
  return `Current client: ${kind}, ${window.innerWidth}×${window.innerHeight} CSS pixels. Adapt interactive HTML controls and layout to this device.`;
}

function demoRequest(): string {
  const phone = isPhoneClient();
  const controls = phone
    ? "Make touch the primary control and keep every instruction readable in portrait."
    : "Use keyboard and mouse interaction and make good use of the landscape screen.";
  const framebuffer = phone ? "320×568 (width 320, height 568)" : "640×360 (width 640, height 360)";
  const movingObjects = phone ? 500 : 1400;
  return `Build and launch an original raylib performance showcase. This is an execution task: use the tools and finish with the running game, not a code listing or explanation. You have creative freedom over the concept, art direction, motion, and game rules.

The current client is a ${phone ? "phone/touch device" : "desktop/laptop"} at ${window.innerWidth}×${window.innerHeight} CSS pixels. ${controls}

The result must visibly demonstrate browser Wasm performance: continuously simulate and draw at least ${movingObjects} independently moving particles, projectiles, boids, trail segments, or similarly meaningful objects every frame. Add layered procedural effects, interaction, and a small HUD showing the live object count and controls. It must be a playable, changing scene—not a static picture or mostly text. Use fixed-size bounded arrays and delta_seconds; avoid unbounded allocation.

Use exactly this runtime contract:
- Write one C17 source file to /home/web/raylib-demo.c. Include raylib.h and define void game_init(void) plus void game_frame(float delta_seconds).
- Do not define main or call InitWindow, CloseWindow, SetTargetFPS, or create a frame loop. The browser owns those. Put BeginDrawing() and EndDrawing() inside game_frame.
- Prefer dependable raylib 6 2D APIs such as DrawPixel, DrawRectangle, DrawLineV, DrawCircleV, DrawText, GetMousePosition, GetTouchPosition, and IsKeyDown. Audio and rmodels are unavailable.
- The raylib preview already supplies every WASI import and instantiates the module. Do not create HTML, JavaScript, a WebAssembly.instantiate call, or a wasi_snapshot_preview1 import object. Do not use compile_c, link_wasi, run_wasi, Python, or slop for this demo.

Required tool sequence:
1. write /home/web/raylib-demo.c
2. compile_raylib with path /home/web/raylib-demo.c, output /home/web/raylib-demo.wasm, and optimization "3"
3. If compilation fails, read the diagnostics, edit the C source, and retry compile_raylib until it succeeds. Never launch a failed build.
4. Call raylib exactly once with path /home/web/raylib-demo.wasm, framebuffer ${framebuffer}, and a short title.

Do not stop before the raylib tool succeeds and opens the game.`;
}

function consumeLocalCodexProxyToken(): string {
  const url = new URL(location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get("codex_proxy_token")?.trim() ?? "";
  if (!token) return "";
  fragment.delete("codex_proxy_token");
  url.hash = fragment.toString();
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return token;
}

async function verifyLocalCodexProxyToken(
  candidate: ProviderDef,
  token: string,
): Promise<void> {
  const response = await fetch(`${candidate.baseUrl}/auth/status`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `local Codex proxy returned HTTP ${response.status}`);
  }
}

async function verifyLocalCodexProxyAvailable(candidate: ProviderDef): Promise<void> {
  const response = await fetch(`${candidate.baseUrl}/health`);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail || `local Codex proxy returned HTTP ${response.status}`);
  }
}

function currentHeapUsage() {
  return py ? formatWasmHeapUsage(py) : "loading";
}

function currentMessages(): AgentMessage[] {
  return agent?.state.messages ?? [];
}

function renderFooter() {
  const model = currentModelId() || "no model";
  const thinking = agent?.state.thinkingLevel ?? "off";
  const localProvider = currentLocalProvider();
  const browserStatus = localProvider?.runtime.status ?? { phase: "idle" };
  const usage = sessionUsage();
  const contextWindow = agent?.state.model.contextWindow || 200_000;
  const contextTokens = currentContextTokens();
  const contextPercent = Math.min(999, (contextTokens / contextWindow) * 100);
  const cacheTotal = usage.input + usage.cacheRead;
  const cacheHit = cacheTotal > 0 ? `${((usage.cacheRead / cacheTotal) * 100).toFixed(1)}%` : "—";

  const location =
    activeView === "nvim"
      ? "/home/web (nvim)"
      : activeView === "slop"
        ? "/home/web (slop)"
        : "/home/web";
  const browserProgress =
    provider?.transport === "browser" &&
    (browserStatus.phase === "downloading" || browserStatus.phase === "loading")
      ? ` · model ${formatBrowserStatus(browserStatus)}`
      : "";
  footerLocationEl.textContent = location + browserProgress;
  footerUsageEl.textContent =
    `↑${formatTokenCount(usage.input)} ↓${formatTokenCount(usage.output)} ` +
    `R${formatTokenCount(usage.reasoning)} CH${cacheHit} ` +
    `${contextPercent.toFixed(1)}%/${formatTokenCount(contextWindow)}`;
  const backend =
    provider?.transport === "browser" &&
    browserStatus.modelId === model &&
    browserStatus.backend
      ? ` • ${browserStatus.backend}`
      : "";
  footerModelEl.textContent =
    `(${provider?.name ?? "no provider"}) ${model} • ${thinking}${backend}`;
}

function sessionUsage() {
  const total = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const messages = [...(agent?.state.messages ?? [])];
  const streaming = agent?.state.streamingMessage;
  if (streaming) messages.push(streaming);
  for (const message of messages) {
    if (!isAssistantMessage(message)) continue;
    total.input += message.usage.input;
    total.output += message.usage.output;
    total.reasoning += message.usage.reasoning ?? 0;
    total.cacheRead += message.usage.cacheRead;
    total.cacheWrite += message.usage.cacheWrite;
  }
  return total;
}

function currentContextTokens(): number {
  const messages = [...(agent?.state.messages ?? [])];
  const streaming = agent?.state.streamingMessage;
  if (streaming) messages.push(streaming);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isAssistantMessage(message)) continue;
    const tokens = usageTokens(message.usage);
    if (tokens > 0) return tokens;
  }
  const chars =
    (agent?.state.systemPrompt ?? currentSystemPrompt()).length +
    messages.reduce((sum, message) => sum + safeStringify(message).length, 0);
  return Math.ceil(chars / 4);
}

function isAssistantMessage(message: unknown): message is Extract<Message, { role: "assistant" }> {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { role?: string }).role === "assistant"
  );
}

function usageTokens(usage: Usage): number {
  return (
    usage.totalTokens ||
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return Math.round(value).toString();
}

function formatBrowserStatus(status: LocalModelStatus): string {
  if (
    status.phase === "downloading" &&
    status.loadedBytes !== undefined &&
    status.totalBytes
  ) {
    return `${Math.min(100, Math.round((status.loadedBytes / status.totalBytes) * 100))}%`;
  }
  return status.phase;
}

function onBrowserModelStatus(runtime: LocalModelRuntime, status: LocalModelStatus) {
  if (currentLocalProvider()?.runtime !== runtime) {
    renderFooter();
    return;
  }
  if (
    agent?.state.isStreaming &&
    (status.phase === "preparing" ||
      status.phase === "downloading" ||
      status.phase === "loading")
  ) {
    spinner.start(`local model · ${formatBrowserStatus(status)}`);
  } else if (agent?.state.isStreaming && status.phase === "generating") {
    spinner.start("thinking locally");
  }
  renderFooter();
}

function applyConfigToAgent() {
  if (agent && provider) {
    const modelId = currentModelId();
    const loadedInfo = getLoadedModelInfo(provider.name, modelId);
    const info =
      provider.api === "browser-wllama" && loadedInfo
        ? {
            ...loadedInfo,
            contextWindow: browserModelRuntime.contextSize(modelId),
          }
        : loadedInfo;
    const model = makeModel({
      baseUrl: provider.baseUrl,
      modelId,
      api: provider.api,
      provider: provider.name,
      extraBody: provider.extraBody,
      info,
    });
    agent.state.model = model;
    agent.state.systemPrompt = currentSystemPrompt();
    agent.state.thinkingLevel = clampThinkingLevel(
      model,
      agent.state.thinkingLevel,
    ) as ThinkingLevel;
  }
  renderFooter();
}

function availableThinkingLevels(): ThinkingLevel[] {
  if (!agent) return ["off"];
  return getSupportedThinkingLevels(agent.state.model) as ThinkingLevel[];
}

function setThinkingLevel(level: ThinkingLevel, announce = true): boolean {
  if (!agent) return false;
  const levels = availableThinkingLevels();
  if (!levels.includes(level)) return false;
  agent.state.thinkingLevel = level;
  renderFooter();
  if (announce) say(cyan(`  ◇ thinking: ${level}`));
  return true;
}

function cycleThinkingLevel() {
  if (!agent) return;
  const levels = availableThinkingLevels();
  if (levels.length <= 1) return;
  const index = levels.indexOf(agent.state.thinkingLevel);
  agent.state.thinkingLevel = levels[(index + 1) % levels.length];
  renderFooter();
}

/* ------------------------------------------------------------------ */
/* Neovim view                                                        */
/* ------------------------------------------------------------------ */

function setNeovimStatus(message: string, warning = false) {
  neovimStatusEl.textContent = message.replace(/\s+/g, " ").trim();
  neovimStatusEl.classList.toggle("warning", warning);
}

async function getNeovim(): Promise<NeovimController> {
  if (!NEOVIM_ENABLED) throw new Error("Neovim is not included in this build.");
  if (neovim) return neovim;
  if (!py) throw new Error("Python filesystem is not ready.");
  if (!neovimStarting) {
    setNeovimStatus("loading Neovim WASM…");
    neovimStarting = import("./neovim.ts")
      .then(({ createNeovimController }) =>
        createNeovimController(
          py!,
          neovimEditorEl,
          neovimCommandlineEl,
          setNeovimStatus,
        ),
      )
      .then((controller) => {
        neovim = controller;
        return controller;
      })
      .finally(() => {
        neovimStarting = null;
      });
  }
  return neovimStarting;
}

async function toggleNeovim() {
  if (!NEOVIM_ENABLED) {
    footerLocationEl.textContent = "Neovim is not included in this build";
    window.setTimeout(renderFooter, 1500);
    return;
  }
  if (viewToggleRunning) return;
  if (activeView === "slop") return;
  if (activeView === "agent" && (!pyReady || !py)) {
    footerLocationEl.textContent = "Neovim will be available when Python is ready";
    window.setTimeout(renderFooter, 1500);
    return;
  }
  if (activeView === "agent" && prompt.isOccupied()) {
    footerLocationEl.textContent = "Finish the current run or menu before opening Neovim";
    window.setTimeout(renderFooter, 1500);
    return;
  }

  viewToggleRunning = true;
  try {
    if (activeView === "agent") {
      activeView = "nvim";
      agentViewEl.hidden = true;
      neovimViewEl.hidden = false;
      renderFooter();

      const alreadyRunning = neovim !== null;
      const controller = await getNeovim();
      if (alreadyRunning) {
        setNeovimStatus("syncing from /home/web…");
        setNeovimStatus(await controller.syncFromPyodide());
      }
      requestAnimationFrame(() => controller.focus());
      return;
    }

    if (neovim) {
      setNeovimStatus("saving to /home/web…");
      try {
        setNeovimStatus(await neovim.syncToPyodide());
      } catch (error) {
        setNeovimStatus(
          `sync failed: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
        return;
      }
    }
    activeView = "agent";
    neovimViewEl.hidden = true;
    agentViewEl.hidden = false;
    renderFooter();
    requestAnimationFrame(() => {
      handle.fit.fit();
      handle.term.focus();
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setNeovimStatus(`failed: ${message}`, true);
    if (!neovim) {
      activeView = "agent";
      neovimViewEl.hidden = true;
      agentViewEl.hidden = false;
      renderFooter();
      say(red(`  Neovim failed to start: ${message}`));
      requestAnimationFrame(() => {
        handle.fit.fit();
        handle.term.focus();
      });
    }
  } finally {
    viewToggleRunning = false;
  }
}

/* ------------------------------------------------------------------ */
/* slop shell view (Ctrl+Shift+S)                                      */
/* ------------------------------------------------------------------ */

async function toggleSlop() {
  if (viewToggleRunning) return;
  viewToggleRunning = true;
  try {
    if (activeView === "slop") {
      activeView = "agent";
      slopViewEl.hidden = true;
      agentViewEl.hidden = false;
      renderFooter();
      requestAnimationFrame(() => {
        handle.fit.fit();
        handle.term.focus();
      });
      return;
    }
    if (activeView !== "agent") return;
    if (!pyReady || !py) {
      footerLocationEl.textContent = "slop will be available when Python is ready";
      window.setTimeout(renderFooter, 1500);
      return;
    }
    if (prompt.isOccupied()) {
      footerLocationEl.textContent = "Finish the current run or menu before opening slop";
      window.setTimeout(renderFooter, 1500);
      return;
    }
    if (!supportsWorkerWasi()) {
      say(
        yellow(
          "  slop needs cross-origin isolation (npm run dev / vite preview / coi service worker)",
        ),
      );
      return;
    }

    activeView = "slop";
    agentViewEl.hidden = true;
    slopViewEl.hidden = false;
    renderFooter();

    const terminal = await getSlopTerminal();
    if (!slop || !slop.alive) {
      slop = new SlopSession({
        py,
        writeOut: writeSlopOutput,
        note: writeSlopNote,
        getGitHubCredentials: () => gitHubCredentials,
        onExit: () => {
          if (activeView === "slop") {
            activeView = "agent";
            slopViewEl.hidden = true;
            agentViewEl.hidden = false;
            renderFooter();
            requestAnimationFrame(() => {
              handle.fit.fit();
              handle.term.focus();
            });
          }
        },
      });
      await slop.start();
    }
    requestAnimationFrame(() => {
      terminal.fit.fit();
      terminal.term.focus();
    });
  } catch (error) {
    activeView = "agent";
    slopViewEl.hidden = true;
    agentViewEl.hidden = false;
    renderFooter();
    say(
      red(
        `  slop failed to start: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    if (!prompt.isOccupied()) prompt.start();
    requestAnimationFrame(() => {
      handle.fit.fit();
      handle.term.focus();
    });
  } finally {
    viewToggleRunning = false;
  }
}

async function getSlopTerminal(): Promise<TerminalHandle> {
  if (slopHandle) return slopHandle;
  if (!slopTerminalStarting) {
    slopTerminalStarting = createTerminal(slopMountEl)
      .then((terminal) => {
        slopHandle = terminal;
        slopMountEl.addEventListener("click", () => terminal.term.focus());
        terminal.term.onData((data: string) => {
          if (activeView === "slop") slop?.feed(data);
        });
        return terminal;
      })
      .finally(() => {
        slopTerminalStarting = null;
      });
  }
  return slopTerminalStarting;
}

/* ------------------------------------------------------------------ */
/* input dispatch                                                      */
/* ------------------------------------------------------------------ */

function onSubmit(text: string) {
  void handleSubmit(text);
}

function onAbort() {
  agent?.abort();
}

async function handleSubmit(text: string) {
  const t = text.trim();
  if (!t) {
    prompt.start();
    return;
  }
  if (t.startsWith("/")) {
    try {
      await runSlash(t);
    } catch (error) {
      say(red(`  command failed: ${error instanceof Error ? error.message : String(error)}`));
      prompt.start();
    }
    return;
  }

  if (!pyReady || !agent) {
    say(yellow("  python is still loading — try again in a moment."));
    prompt.start();
    return;
  }
  if (!provider) {
    say(yellow("  no provider. start with: /provider <name>   (try /provider openai)"));
    prompt.start();
    return;
  }
  if (provider.auth !== "none" && !currentApiKey()) {
    say(yellow(`  not logged in. run: /login   (to use ${provider.label})`));
    prompt.start();
    return;
  }

  if (provider.transport === "browser") {
    try {
      if (!(await confirmBrowserModelDownload())) {
        prompt.start();
        return;
      }
    } catch (error) {
      say(
        red(
          `  local model unavailable: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      prompt.start();
      return;
    }
  }

  prompt.setBusy(true);
  try {
    agent.state.systemPrompt = currentSystemPrompt();
    await agent.prompt(t);
  } catch (err) {
    say(red(`  agent error: ${err instanceof Error ? err.message : String(err)}`));
    prompt.setBusy(false);
    prompt.start();
  }
  // agent_end restarts the prompt in the normal case.
}

async function confirmBrowserModelDownload(): Promise<boolean> {
  const localProvider = currentLocalProvider();
  if (!localProvider) throw new Error("No local browser provider is active.");
  const model = localProvider.getModel(currentModelId());
  if (!model) throw new Error(`Unknown browser model: ${currentModelId()}`);
  if (await localProvider.runtime.isCached(model.id)) return true;

  const headroom = await localProvider.runtime.storageHeadroom();
  const storage =
    headroom === undefined
      ? ""
      : ` · ${formatModelBytes(headroom)} browser storage available`;
  const answer = await prompt.ask(
    `  Download ${model.label} ${model.quantization} (${formatModelBytes(model.bytes)})?${storage} [y/N] `,
  );
  if (!/^(y|yes)$/i.test(answer.trim())) {
    say(yellow("  local model download cancelled"));
    return false;
  }
  const persistent = await localProvider.runtime.requestPersistentStorage().catch(() => undefined);
  if (persistent === false) {
    say(dim("  browser storage is not persistent; the cached model may be evicted"));
  }
  return true;
}

async function activateProvider(next: ProviderDef) {
  const previousProvider = provider;
  const previousModel = currentModelId();
  const previousLocal = getLocalProviderBinding(previousProvider);
  const nextLocal = getLocalProviderBinding(next);
  if (
    previousLocal &&
    (previousLocal.runtime !== nextLocal?.runtime || previousModel !== next.defaultModel)
  ) {
    await previousLocal.runtime.unload();
  }
  provider = next;
  modelOverride = null;
  await next.loadModels();
  applyConfigToAgent();
  say(cyan(`  ◇ provider: ${next.label}   model: ${currentModelId()}`));
  if (next.note) say(dim(`    ${next.note}`));
  if (next.auth === "none") {
    say(green("  ◆ no login required · use /model to inspect local downloads"));
  } else if (!currentApiKey()) {
    say(yellow("  now run /login to set your API key"));
  }
}

async function activateModel(modelId: string, contextSize?: number) {
  const localProvider = currentLocalProvider();
  if (localProvider && !localProvider.getModel(modelId)) {
    throw new Error(`Unknown browser model: ${modelId}`);
  }
  if (
    localProvider &&
    modelId !== currentModelId()
  ) {
    await localProvider.runtime.unload();
  }
  if (provider?.api === "browser-wllama" && contextSize !== undefined) {
    await browserModelRuntime.setContextSize(modelId, contextSize);
  }
  modelOverride = modelId === provider?.defaultModel ? null : modelId;
  applyConfigToAgent();
  const context =
    provider?.api === "browser-wllama"
      ? `   context: ${formatContextSize(browserModelRuntime.contextSize(modelId))}`
      : "";
  say(cyan(`  ◇ model: ${modelId}${context}`));
}

async function selectBrowserContextSize(modelId: string): Promise<number | null> {
  const model = getBrowserModel(modelId);
  if (!model) throw new Error(`Unknown Wllama model: ${modelId}`);
  return prompt.select({
    title: `Select context / KV cache · ${model.label}`,
    active: browserModelRuntime.contextSize(modelId),
    options: model.contextOptions.map((contextSize) => {
      const estimate = estimateWebGpuKvCacheBytes(model, contextSize);
      const sizeHint =
        contextSize === model.load.contextSize
          ? "recommended · default"
          : contextSize < model.load.contextSize
            ? "lower memory"
            : "larger working context";
      return {
        value: contextSize,
        label: `${formatContextSize(contextSize)} context`,
        description: [
          sizeHint,
          estimate === undefined
            ? ""
            : `~${formatModelBytes(estimate)} WebGPU KV cache`,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    }),
  });
}

async function showBrowserModels(): Promise<void> {
  const localProvider = currentLocalProvider();
  if (!localProvider) throw new Error("No local browser provider is active.");
  const cached = await localProvider.runtime.cachedModelIds();
  const status = localProvider.runtime.status;
  say(
    `  runtime: ${formatBrowserStatus(status)}` +
      `${status.backend ? ` · ${status.backend}` : ""}` +
      `${status.contextSize ? ` · ${formatContextSize(status.contextSize)} context` : ""}`,
  );
  for (const model of localProvider.models) {
    const active = model.id === currentModelId() ? cyan("active") : "";
    const details = localProvider.describeModel(model, cached.has(model.id));
    const context =
      provider?.api === "browser-wllama"
        ? `${formatContextSize(browserModelRuntime.contextSize(model.id))} selected context`
        : "";
    say(`  ${model.label.padEnd(24)} ${model.id}`);
    say(
      dim(
        `    ${[active, details, context, model.license].filter(Boolean).join(" · ")}`,
      ),
    );
  }
}

/* ------------------------------------------------------------------ */
/* interactive WASI programs (/run)                                    */
/* ------------------------------------------------------------------ */

function splitArgs(input: string): string[] {
  const args: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }
  return args;
}

function writeProgramOutput(text: string) {
  writer.write(text.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"));
}

function writeSlopOutput(text: string) {
  slopHandle?.writer.write(
    text.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"),
  );
}

function writeSlopNote(text: string) {
  if (!slopHandle) return;
  slopHandle.writer.ensureNewline();
  slopHandle.writer.writeln(dim(text));
}

async function runInteractive(argline: string) {
  if (!py) return;
  const parts = splitArgs(argline);
  if (parts.length === 0) return;
  const path = fsResolve(py, parts[0]);
  if (!fsExists(py, path)) {
    say(red(`  not found: ${path}`));
    return;
  }
  if (fsIsDir(py, path)) {
    say(red(`  is a directory: ${path}`));
    return;
  }

  const handle = startWasiProgram(py, {
    executablePath: path,
    args: parts.slice(1),
    interactiveStdin: true,
    timeoutMs: 0,
    onStdout: writeProgramOutput,
    onStderr: writeProgramOutput,
  });
  prompt.setBusy(true);
  writer.write(dim("  stdin: line-buffered with echo · Ctrl+C kills · Ctrl+D sends EOF\r\n"));

  const encoder = new TextEncoder();
  let line = "";
  const previousHandler = inputHandler;
  inputHandler = (data: string) => {
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        writer.writeln("");
        handle.stdin?.push(encoder.encode(`${line}\n`));
        line = "";
      } else if (ch === "\x7f" || ch === "\b") {
        if (line.length > 0) {
          line = line.slice(0, -1);
          writer.write("\b \b");
        }
      } else if (ch === "\x03") {
        handle.kill();
        return;
      } else if (ch === "\x04") {
        if (line.length === 0) handle.stdin?.close();
        else {
          handle.stdin?.push(encoder.encode(line));
          line = "";
        }
      } else if (ch >= " ") {
        line += ch;
        writer.write(ch);
      }
    }
  };

  try {
    const result = await handle.result;
    writer.ensureNewline();
    say(dim(`  ↳ exit ${result.exitCode}`));
  } catch (error) {
    writer.ensureNewline();
    say(red(`  program stopped: ${error instanceof Error ? error.message : String(error)}`));
  } finally {
    inputHandler = previousHandler;
    prompt.setBusy(false);
  }
}

/* ------------------------------------------------------------------ */
/* slash commands                                                      */
/* ------------------------------------------------------------------ */

function showStatus() {
  const browserStatus = currentLocalProvider()?.runtime.status ?? { phase: "idle" };
  const authStatus =
    provider?.auth === "none"
      ? green("not required")
      : currentApiKey()
        ? green("set")
        : dim("(none — /login)");
  const lines = [
    `  python : ${pyReady ? green("ready") : yellow("loading…")}`,
    `  heap   : ${pyReady ? currentHeapUsage() : dim("unavailable")}`,
    `  view   : ${activeView}${neovim ? " · Neovim loaded" : ""}`,
    `  provider: ${
      provider
        ? `${provider.label} (${agent?.state.model.api ?? provider.api})`
        : dim("(none — /provider)")
    }`,
    `  model  : ${currentModelId() || dim("(none)")}`,
    `  thinking: ${agent?.state.thinkingLevel ?? "off"}`,
    ...(provider?.transport === "browser"
      ? [
          `  runtime: ${formatBrowserStatus(browserStatus)}${
            browserStatus.backend ? ` · ${browserStatus.backend}` : ""
          }${browserStatus.threads ? ` · ${browserStatus.threads} threads` : ""}${
            browserStatus.contextSize
              ? ` · ${formatContextSize(browserStatus.contextSize)} context`
              : ""
          }`,
        ]
      : []),
    `  ${provider?.localCodexProxy ? "proxy  " : "auth   "}: ${authStatus}`,
    `  github : ${
      gitHubCredentials
        ? `${green("connected")} · ${gitHubCredentials.login}@${gitHubCredentials.apiBaseUrl}`
        : dim("(none — /github)")
    }`,
  ];
  for (const line of lines) say(line);
}

function resetToMessages(messages: AgentMessage[]) {
  if (!agent) return;
  agent.reset();
  agent.state.messages = messages;
  renderFooter();
}

async function selectSession(title: string) {
  if (!agent) return;
  const choices = sessions.list(currentMessages());
  const id = await prompt.select({
    title,
    active: sessions.current.id,
    options: choices.map((session) => ({
      value: session.id,
      label: sessions.label(session),
      description: sessionDescription(session),
    })),
  });
  if (!id || id === sessions.current.id) return;
  const messages = sessions.switchTo(id, currentMessages());
  if (!messages) return;
  resetToMessages(messages);
  say(cyan(`  ◇ session: ${sessions.label(sessions.current)}`));
}

function sessionDescription(session: BrowserSession): string {
  const current = session.id === sessions.current.id ? "current · " : "";
  const branch = session.parentId ? "branch" : "root";
  return `${current}${branch} · ${session.messages.length} messages`;
}

function userMessageText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((content): content is Extract<(typeof message.content)[number], { type: "text" }> =>
      content.type === "text",
    )
    .map((content) => content.text)
    .join(" ");
}

function lastAssistantText(): string {
  const messages = currentMessages();
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    return message.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("");
  }
  return "";
}

function downloadSession() {
  const session = sessions.exportCurrent(currentMessages());
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${(session.name || session.id).replace(/[^a-z0-9_-]+/gi, "-")}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function uploadFromHost(directoryArg: string) {
  if (!pyReady || !py) throw new Error("Python filesystem is still loading.");
  const directory = resolveUploadDirectory(py, directoryArg || undefined);
  prompt.setBusy(true);
  let files: File[];
  try {
    files = await pickHostFiles();
  } finally {
    prompt.setBusy(false);
  }
  if (files.length === 0) {
    say(yellow("  upload cancelled"));
    return;
  }

  const conflicts = uploadConflicts(py, directory, files);
  let overwrite = false;
  if (conflicts.length > 0) {
    const answer = await prompt.ask(
      `  ${conflicts.length} file${conflicts.length === 1 ? "" : "s"} already exist. Overwrite? [y/N] `,
    );
    overwrite = /^(y|yes)$/i.test(answer.trim());
  }
  const result = await uploadHostFiles(py, directory, files, overwrite);
  if (result.paths.length > 0) {
    const destination =
      result.paths.length === 1 ? result.paths[0] : `${result.directory}/`;
    say(
      green(
        `  ◆ uploaded ${result.paths.length} file${result.paths.length === 1 ? "" : "s"} · ${result.bytes} bytes → ${destination}`,
      ),
    );
  }
  if (result.skipped.length > 0) {
    say(
      yellow(
        `  skipped ${result.skipped.length} existing file${result.skipped.length === 1 ? "" : "s"}`,
      ),
    );
  }
}

async function runSlash(input: string) {
  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ").trim();

  switch (cmd) {
    case "help":
      say(dim("  /provider  /model  /login  /logout       provider configuration"));
      say(dim("  /model status|unload|remove|clear-cache   local model storage"));
      say(dim("  /github [api-url|status|logout]           session-only GitHub access"));
      say(dim("  /new  /tree  /resume  /fork  /clone     page-local sessions"));
      say(dim("  /name  /session  /copy  /export          session utilities"));
      say(dim("  /thinking [level]                         model effort (Shift+Tab cycles)"));
      say(dim("  /download <path>  /upload [directory]      host file transfer"));
      say(dim("  /run <prog.wasm> [args]                    run a WASI program (live filesystem)"));
      say(dim("  /image <path>  /html <path>                browser previews"));
      say(dim("  /demo                                      raylib/Wasm performance showcase"));
      if (NEOVIM_ENABLED) {
        say(dim("  /nvim                                      open Neovim editor"));
      }
      say(dim("  /status  /clear  /hotkeys                  terminal utilities"));
      break;

    case "demo":
      say(cyan(`  ◇ demo target: ${isPhoneClient() ? "phone · touch" : "desktop · keyboard/mouse"}`));
      {
        const messagesBefore = agent?.state.messages.length ?? 0;
        const launchesBefore = raylibLaunchCount;
        await handleSubmit(demoRequest());
        const messages = agent?.state.messages ?? [];
        let lastAssistant: AgentMessage | undefined;
        for (let index = messages.length - 1; index >= 0; index--) {
          if (messages[index].role === "assistant") {
            lastAssistant = messages[index];
            break;
          }
        }
        const stopReason = (lastAssistant as { stopReason?: string } | undefined)?.stopReason;
        if (
          messages.length > messagesBefore &&
          raylibLaunchCount === launchesBefore &&
          stopReason !== "error" &&
          stopReason !== "aborted"
        ) {
          say(yellow("  ◇ demo did not launch · requesting one repair pass"));
          await handleSubmit(
            "The raylib demo has not opened. Continue the existing task: inspect /home/web/raylib-demo.c and the previous compiler diagnostics, create or repair the source, run compile_raylib at optimization 3 until it succeeds, then call raylib exactly once. Do not switch to compile_c, link_wasi, run_wasi, HTML, JavaScript, Python, or slop, and do not stop with an explanation.",
          );
        }
      }
      return;

    case "provider": {
      if (!arg) {
        const name = await prompt.select({
          title: "Select provider",
          active: provider?.name,
          options: Object.values(PROVIDERS).map((candidate) => ({
            value: candidate.name,
            label: candidate.label,
            description: candidate.note,
          })),
        });
        if (name) await activateProvider(PROVIDERS[name]);
      } else {
        const next = getProvider(arg);
        if (!next) {
          say(red(`  unknown provider: ${arg}`));
        } else {
          await activateProvider(next);
        }
      }
      break;
    }

    case "model": {
      const localProvider = currentLocalProvider();
      if (!provider) {
        say(yellow("  pick a provider first: /provider"));
      } else if (provider.transport === "browser" && arg.toLowerCase() === "status") {
        await showBrowserModels();
      } else if (provider.transport === "browser" && arg.toLowerCase() === "unload") {
        await localProvider!.runtime.unload();
        say(green("  ◆ local model unloaded; its browser cache was kept"));
      } else if (provider.transport === "browser" && arg.toLowerCase() === "clear-cache") {
        const answer = await prompt.ask(
          "  Unload local inference and remove every downloaded model? [y/N] ",
        );
        if (/^(y|yes)$/i.test(answer.trim())) {
          await localProvider!.runtime.clearCache();
          say(green("  ◆ local model cache cleared"));
        } else {
          say(yellow("  cache removal cancelled"));
        }
      } else if (
        provider.transport === "browser" &&
        /^remove(?:\s|$)/i.test(arg)
      ) {
        const modelId = arg.replace(/^remove\s*/i, "") || currentModelId();
        const descriptor = localProvider!.getModel(modelId);
        if (!descriptor) {
          say(red(`  unknown browser model: ${modelId}`));
          break;
        }
        const answer = await prompt.ask(
          `  Remove cached ${descriptor.label} (${formatModelBytes(descriptor.bytes)})? [y/N] `,
        );
        if (/^(y|yes)$/i.test(answer.trim())) {
          await localProvider!.runtime.removeCached(modelId);
          say(green(`  ◆ removed cached ${descriptor.label}`));
        } else {
          say(yellow("  cache removal cancelled"));
        }
      } else if (!arg) {
        const models = await provider.loadModels();
        const cached =
          provider.transport === "browser"
            ? await localProvider!.runtime.cachedModelIds()
            : new Set<string>();
        const modelId = await prompt.select({
          title: `Select model · ${provider.label}`,
          active: currentModelId(),
          options: models.map((id) => {
            const local = localProvider?.getModel(id);
            return {
              value: id,
              label: local?.label ?? id,
              description: local
                ? [
                    id === provider!.defaultModel ? "default" : "",
                    localProvider!.describeModel(local, cached.has(id)),
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : id === provider!.defaultModel
                  ? "default"
                  : undefined,
            };
          }),
        });
        if (modelId) {
          const contextSize =
            provider.api === "browser-wllama"
              ? await selectBrowserContextSize(modelId)
              : undefined;
          if (contextSize !== null) await activateModel(modelId, contextSize);
        }
      } else {
        await activateModel(arg);
      }
      break;
    }

    case "login": {
      if (!provider) {
        say(yellow("  pick a provider first: /provider <name>"));
        break;
      }
      if (provider.auth === "none") {
        say(green(`  ◆ ${provider.label} runs locally and needs no login`));
        break;
      }
      if (provider.localCodexProxy) {
        say(dim("  checking local Codex proxy…"));
        try {
          await verifyLocalCodexProxyAvailable(provider);
          say(dim("  reconnecting through the local proxy…"));
          location.assign(`${provider.baseUrl}/connect`);
        } catch (error) {
          say(
            red(
              `  local Codex proxy unavailable; run npm run codex-proxy${
                error instanceof Error ? ` (${error.message})` : ""
              }`,
            ),
          );
        }
        break;
      }
      const key = await prompt.ask(`  API key for ${provider.label} (hidden): `, true);
      const normalized = normalizeApiKey(key);
      if (normalized) {
        const verification = await verifyApiKey(provider, normalized);
        apiKeys.set(provider.name, normalized);
        say(
          green(
            `  ◆ key ${verification === "verified" ? "verified and " : ""}set for ${
              provider.label
            }`,
          ),
        );
      } else {
        say(yellow("  login cancelled"));
      }
      break;
    }

    case "logout":
      if (!provider) {
        say(yellow("  no provider selected"));
      } else if (provider.auth === "none") {
        say(green(`  ◆ ${provider.label} stores no login credentials`));
      } else if (provider.localCodexProxy) {
        const token = currentApiKey();
        apiKeys.delete(provider.name);
        if (token) {
          try {
            await fetch(`${provider.baseUrl}/shutdown`, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}` },
            });
          } catch {
            // It may already have been stopped with Ctrl-C.
          }
        }
        say(green("  ◆ local Codex proxy disconnected and stopped"));
      } else {
        apiKeys.delete(provider.name);
        say(green(`  ◆ key removed for ${provider.label}`));
      }
      break;

    case "github": {
      if (arg.toLowerCase() === "logout") {
        gitHubCredentials = null;
        say(green("  ◆ GitHub token removed"));
        break;
      }
      if (arg.toLowerCase() === "status") {
        if (gitHubCredentials) {
          say(
            `  github : ${green("connected")} · ${gitHubCredentials.login}@${gitHubCredentials.apiBaseUrl}`,
          );
        } else {
          say(dim("  github : (none — run /github)"));
        }
        break;
      }
      const apiBaseUrl = normalizeGitHubApiUrl(
        arg || gitHubCredentials?.apiBaseUrl || "https://api.github.com",
      );
      const token = (
        await prompt.ask(
          `  GitHub token for ${apiBaseUrl} (Contents write; hidden): `,
          true,
        )
      ).trim();
      if (!token) {
        say(yellow("  GitHub login cancelled"));
        break;
      }
      say(dim("  verifying GitHub token…"));
      gitHubCredentials = await verifyGitHubCredentials(apiBaseUrl, token);
      say(
        green(
          `  ◆ GitHub connected · ${gitHubCredentials.login}@${gitHubCredentials.apiBaseUrl}`,
        ),
      );
      break;
    }

    case "new":
      if (!agent) break;
      sessions.startNew(currentMessages());
      resetToMessages([]);
      say(cyan("  ◇ new session"));
      break;

    case "tree":
    case "resume":
      await selectSession(cmd === "tree" ? "Session tree" : "Resume session");
      break;

    case "clone":
      if (!agent) break;
      sessions.clone(currentMessages());
      resetToMessages([...currentMessages()]);
      say(cyan("  ◇ cloned current session"));
      break;

    case "fork": {
      if (!agent) break;
      const messages = currentMessages();
      const turns = messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message.role === "user");
      if (turns.length === 0) {
        say(yellow("  no user turns to fork"));
        break;
      }
      const selected = await prompt.select({
        title: "Fork after user turn",
        options: turns.map(({ message }, turnIndex) => {
          const nextUser = turns[turnIndex + 1]?.index ?? messages.length;
          return {
            value: { messageCount: nextUser, turnNumber: turnIndex + 1 },
            label: truncateText(userMessageText(message), 58) || "(empty user message)",
            description: `turn ${turnIndex + 1}`,
          };
        }),
      });
      if (selected) {
        const branchMessages = messages.slice(0, selected.messageCount);
        sessions.fork(messages, selected.messageCount);
        resetToMessages(branchMessages);
        say(cyan(`  ◇ forked after turn ${selected.turnNumber}`));
      }
      break;
    }

    case "name": {
      const value = arg || (await prompt.ask("  Session name: "));
      if (value.trim()) {
        sessions.save(currentMessages());
        sessions.rename(value);
        say(cyan(`  ◇ session named: ${value.trim()}`));
      }
      break;
    }

    case "session":
      sessions.save(currentMessages());
      say(`  name    : ${sessions.label(sessions.current)}`);
      say(`  id      : ${sessions.current.id}`);
      say(`  parent  : ${sessions.current.parentId ?? dim("(root)")}`);
      say(`  messages: ${currentMessages().length}`);
      break;

    case "copy": {
      const text = lastAssistantText();
      if (!text) {
        say(yellow("  no assistant text to copy"));
      } else {
        await navigator.clipboard.writeText(text);
        say(green(`  ◆ copied ${text.length} characters`));
      }
      break;
    }

    case "export":
      downloadSession();
      say(green("  ◆ downloaded current session JSON"));
      break;

    case "download": {
      if (!pyReady || !py) {
        say(yellow("  python filesystem is still loading"));
      } else if (!arg) {
        say(yellow("  usage: /download <path>"));
      } else {
        const result = downloadPyodideFile(py, arg);
        say(green(`  ◆ downloading ${result.path} · ${result.bytes} bytes`));
      }
      break;
    }

    case "upload":
      await uploadFromHost(arg);
      break;

    case "run": {
      if (!pyReady || !py) {
        say(yellow("  python filesystem is still loading"));
      } else if (!arg) {
        say(yellow("  usage: /run <program.wasm> [args...]"));
      } else {
        await runInteractive(arg);
      }
      break;
    }

    case "thinking": {
      if (!agent) break;
      const levels = availableThinkingLevels();
      if (levels.length === 1) {
        say(yellow(`  ${currentModelId() || "current model"} does not support thinking`));
        break;
      }
      let level = arg as ThinkingLevel;
      if (!arg) {
        const selected = await prompt.select({
          title: "Select thinking level",
          active: agent.state.thinkingLevel,
          options: levels.map((candidate) => ({
            value: candidate,
            label: candidate,
            description: candidate === "off" ? "disable reasoning" : "model effort",
          })),
        });
        if (!selected) break;
        level = selected;
      }
      if (!setThinkingLevel(level)) {
        say(red(`  unsupported thinking level: ${arg} (${levels.join(", ")})`));
      }
      break;
    }

    case "image": {
      if (!pyReady || !py) {
        say(yellow("  python filesystem is still loading"));
      } else if (!arg) {
        say(yellow("  usage: /image <path>"));
      } else {
        const result = await createImageTool(py).execute("slash-image", { path: arg });
        for (const content of result.content) {
          if (content.type === "image") await renderKittyImage(writer, content);
        }
      }
      break;
    }

    case "html": {
      if (!pyReady || !py) {
        say(yellow("  python filesystem is still loading"));
      } else if (!arg) {
        say(yellow("  usage: /html <path>"));
      } else {
        const result = await createHtmlTool(py).execute("slash-html", { path: arg });
        openHtmlPreview(result.details.path);
      }
      break;
    }

    case "nvim":
      // Leave a ready prompt behind for when the terminal view is restored.
      prompt.start();
      await toggleNeovim();
      return;

    case "hotkeys":
      if (NEOVIM_ENABLED) {
        say(dim("  Ctrl+Shift+E  toggle agent / Neovim"));
      }
      say(dim("  Ctrl+Shift+S  toggle agent / slop shell"));
      say(dim("  Ctrl+Shift+C  copy terminal selection"));
      say(dim("  Ctrl+Shift+V  paste clipboard text"));
      say(dim("  Shift+Tab  cycle thinking level"));
      say(dim("  ↑/↓        history or menu selection"));
      say(dim("  Tab        complete selected slash command"));
      say(dim("  Ctrl+C     clear input / abort running agent"));
      say(dim("  Ctrl+A/E   beginning/end of input"));
      say(dim("  Ctrl+U/K   delete to beginning/end"));
      break;

    case "settings":
    case "status":
      showStatus();
      break;

    case "clear":
      deleteKittyImages(writer);
      handle.term.clear();
      renderFooter();
      prompt.start();
      return; // prompt.start already drew the prompt

    default:
      say(red(`  unknown command: /${cmd}   (try /help)`));
  }

  prompt.start();
}

/* ------------------------------------------------------------------ */
/* agent event rendering                                               */
/* ------------------------------------------------------------------ */

function toolCallLabel(name: string, args: unknown): string {
  if (typeof args !== "object" || args === null) return name;
  const values = args as Record<string, unknown>;
  if (name === "fetch") {
    const method = typeof values.method === "string" ? values.method.toUpperCase() : "GET";
    const url = typeof values.url === "string" ? values.url.replaceAll("\x1b", "\\x1b") : "";
    const maxUrlLength = Math.max(24, Math.min(96, writer.cols - method.length - 14));
    return `${name} ${method}${url ? ` ${truncateText(url, maxUrlLength)}` : ""}`;
  }
  if (name === "git") {
    const operation = typeof values.operation === "string" ? values.operation : "";
    const target =
      operation === "clone" && typeof values.project === "string"
        ? values.project
        : typeof values.cwd === "string"
          ? values.cwd
          : "";
    return `${name}${operation ? ` ${operation}` : ""}${
      target ? ` ${truncateText(target, Math.max(24, writer.cols - 18))}` : ""
    }`;
  }
  if (name !== "python" && typeof values.path === "string") {
    return `${name} ${truncateText(values.path, Math.max(24, writer.cols - name.length - 8))}`;
  }
  return name;
}

function pythonSource(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const code = (args as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

function truncateText(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) return singleLine;
  return singleLine.slice(0, Math.max(1, maxLength - 1)) + "…";
}

function truncateLine(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, Math.max(1, maxLength - 1)) + "…";
}

function exactStringPreview(value: string, maxLength: number): string {
  const serialized = JSON.stringify(value);
  if (serialized.length <= maxLength) return serialized;

  const suffix = " … [truncated]";
  const budget = Math.max(2, maxLength - suffix.length);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(value.slice(0, middle)).length <= budget) low = middle;
    else high = middle - 1;
  }
  return `${JSON.stringify(value.slice(0, low))}${suffix}`;
}

function slopCommandPreview(value: string, maxLength: number): string {
  const safe = value
    .replaceAll("\x1b", "\\x1b")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t");
  const preview = truncateLine(safe, maxLength);
  const tokens = preview.match(
    /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\$\{[^}]*\}|\$[A-Za-z_?][A-Za-z0-9_?]*|&&|\|\||[|;&<>]+|\s+|[^\s'"$|;&<>]+|./g,
  ) ?? [];
  let expectsCommand = true;

  return tokens.map((token) => {
    if (/^\s+$/.test(token)) return token;
    if (/^(?:&&|\|\||[|;&]+)$/.test(token)) {
      expectsCommand = true;
      return magenta(token);
    }
    if (/^[<>]+$/.test(token)) return magenta(token);
    if (token.startsWith("\"") || token.startsWith("'")) return green(token);
    if (token.startsWith("$")) return magenta(token);
    if (expectsCommand && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      return magenta(token);
    }
    if (expectsCommand) {
      expectsCommand = false;
      return cyan(token);
    }
    if (token.startsWith("-")) return yellow(token);
    return token;
  }).join("");
}

function printSlopCall(args: unknown) {
  const values =
    typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const command = typeof values.command === "string" ? values.command : "";
  const cwd = typeof values.cwd === "string" ? values.cwd : "/home/web";
  const valueWidth = Math.max(32, writer.cols - 15);

  writer.writeln(`  ${cyan("⏺ slop")}`);
  writer.writeln(`    ${dim("cwd  ")} ${exactStringPreview(cwd, valueWidth)}`);
  writer.writeln(`    ${yellow("input")} ${slopCommandPreview(command, valueWidth)}`);
}

function legacySlopOutputText(result: any, exitCode: unknown): string {
  const text = toolResultText(result);
  const marker = `[exit ${exitCode ?? "?"}]\n`;
  return text.endsWith(marker) ? text.slice(0, -marker.length) : text;
}

function slopOutputChannels(result: any, exitCode: unknown) {
  const details = result?.details;
  if (typeof details?.stdout === "string" && typeof details?.stderr === "string") {
    return { stdout: details.stdout, stderr: details.stderr };
  }
  return { stdout: legacySlopOutputText(result, exitCode), stderr: "" };
}

function printSlopChannel(
  name: "stdout" | "stderr",
  output: string,
) {
  const headerColor = name === "stdout" ? green : red;
  const textColor = name === "stdout" ? green : yellow;
  writer.writeln(`    ${headerColor(name)}`);
  if (!output) {
    writer.writeln(`    ${headerColor("│")} ${dim("(empty)")}`);
    return;
  }

  const normalized = output.replace(/\r\n/g, "\n").replace(/\r/g, "\\r");
  const lines = normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
  const headCount = 12;
  const tailCount = 4;
  const maxLineLength = Math.max(24, writer.cols - 8);
  const printLine = (line: string) => {
    const safe = line.replaceAll("\x1b", "\\x1b");
    writer.writeln(
      `    ${headerColor("│")} ${textColor(truncateLine(safe, maxLineLength))}`,
    );
  };

  if (lines.length <= headCount + tailCount + 1) {
    for (const line of lines) printLine(line);
    return;
  }
  for (const line of lines.slice(0, headCount)) printLine(line);
  writer.writeln(
    `    ${headerColor("│")} ${dim(`… ${lines.length - headCount - tailCount} lines omitted`)}`,
  );
  for (const line of lines.slice(-tailCount)) printLine(line);
}

function printSlopOutput(result: any, exitCode: unknown) {
  const channels = slopOutputChannels(result, exitCode);
  printSlopChannel("stdout", channels.stdout);
  printSlopChannel("stderr", channels.stderr);
  if (result?.details?.truncated) {
    writer.writeln(yellow("    … slop output truncated"));
  }
}

function printPythonPreview(code: string) {
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  const visible = lines.slice(0, 10);
  const maxLineLength = Math.max(24, writer.cols - 12);
  for (let index = 0; index < visible.length; index++) {
    const line = visible[index].replaceAll("\x1b", "\\x1b");
    const number = String(index + 1).padStart(2);
    writer.writeln(dim(`    ${number} │ ${truncateLine(line, maxLineLength)}`));
  }
  if (lines.length > visible.length) {
    writer.writeln(dim(`       … ${lines.length - visible.length} more line(s)`));
  }
}

function toolResultText(result: any): string {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content.filter((c: any) => c && c.type === "text").map((c: any) => c.text).join("");
}

function toolResultImages(result: any): ImageContent[] {
  if (!result || !Array.isArray(result.content)) return [];
  return result.content.filter(
    (content: any): content is ImageContent =>
      content?.type === "image" &&
      typeof content.data === "string" &&
      typeof content.mimeType === "string",
  );
}

function printCapped(text: string, maxLines: number) {
  const lines = text.replace(/\s+$/, "").split("\n").slice(0, maxLines);
  for (const line of lines) writer.writeln(dim(`    ${line}`));
}

async function renderEvent(event: AgentEvent) {
  switch (event.type) {
    case "agent_start":
      prompt.setBusy(true);
      markdown.reset();
      spinner.start();
      break;

    case "message_start":
      if (event.message.role === "assistant") spinner.stop();
      markdown.reset();
      break;

    case "message_end": {
      markdown.finish();
      // Streamed text already went out via text_delta; only surface failures
      // here (errors/aborts are not streamed as text deltas).
      const m = event.message as any;
      if (m && (m.stopReason === "error" || m.stopReason === "aborted")) {
        spinner.stop();
        writer.ensureNewline();
        const msg = m.errorMessage || (m.content?.[0]?.text) || m.stopReason;
        printCapped(String(msg), 12);
      }
      break;
    }

    case "message_update": {
      spinner.stop();
      const e = event.assistantMessageEvent;
      if (e.type === "text_delta") markdown.push("text", e.delta);
      else if (e.type === "thinking_delta") markdown.push("thinking", e.delta);
      break;
    }

    case "tool_execution_start": {
      spinner.stop();
      writer.ensureNewline();
      if (event.toolName === "slop") {
        printSlopCall(event.args);
      } else {
        writer.writeln(dim(`  ⏺ ${toolCallLabel(event.toolName, event.args)}`));
      }
      if (event.toolName === "python") {
        const code = pythonSource(event.args);
        if (code) printPythonPreview(code);
      }
      break;
    }

    case "tool_execution_update":
      if (event.toolName === "python" || event.toolName === "run_wasi") {
        for (const c of event.partialResult?.content ?? []) if (c?.type === "text") writer.write(c.text);
      }
      break;

    case "tool_execution_end": {
      writer.ensureNewline();
      if (event.isError) {
        if (event.toolName === "slop") {
          printSlopOutput(event.result, event.result?.details?.exitCode);
        }
        writer.writeln(red(`  ↳ ${event.toolName} failed`));
        const msg = toolResultText(event.result);
        if (msg && event.toolName !== "slop") printCapped(msg, 8);
        if (event.toolName === "python") {
          writer.writeln(dim(`  ↳ heap ${currentHeapUsage()}`));
        }
      } else {
        const d = event.result?.details ?? {};
        // Keep terminal rendering single-owner: fetch may return an image for
        // model inspection, but only the explicit image tool displays one.
        const images = event.toolName === "image" ? toolResultImages(event.result) : [];
        let footer = "";
        switch (event.toolName) {
          case "python":
            footer = `  ↳ python · ${d.bytes ?? 0} bytes · heap ${currentHeapUsage()}`;
            break;
          case "compile_c":
            footer = `  ↳ compiled ${d.bytes ?? 0} bytes${d.output ? ` · ${d.output}` : ""} · ${((d.durationMs ?? 0) / 1000).toFixed(1)}s`;
            break;
          case "link_wasi":
            footer = `  ↳ linked ${d.objects ?? 0} object${d.objects === 1 ? "" : "s"} · ${d.bytes ?? 0} bytes${d.output ? ` · ${d.output}` : ""} · ${((d.durationMs ?? 0) / 1000).toFixed(1)}s`;
            break;
          case "run_wasi":
            footer = `  ↳ WASI exit ${d.exitCode ?? "?"} · ${d.outputBytes ?? 0} output bytes`;
            break;
          case "compile_raylib":
            footer = `  ↳ raylib compiled · ${d.bytes ?? 0} bytes · ${((d.durationMs ?? 0) / 1000).toFixed(1)}s${d.output ? ` · ${d.output}` : ""}`;
            break;
          case "raylib":
            footer = `  ↳ raylib · ${d.width ?? "?"}×${d.height ?? "?"} · ${d.bytes ?? 0} bytes`;
            break;
          case "slop":
            printSlopOutput(event.result, d.exitCode);
            footer = `  ↳ slop exit ${d.exitCode ?? "?"} · ${d.outputBytes ?? 0} output bytes`;
            break;
          case "read": footer = `  ↳ read ${d.lines ?? 0} lines${d.path ? ` · ${d.path}` : ""}`; break;
          case "write": footer = `  ↳ wrote ${d.bytes ?? 0} bytes${d.path ? ` · ${d.path}` : ""}`; break;
          case "edit": footer = `  ↳ edited${d.path ? ` · ${d.path}` : ""} (${d.edits ?? 0})`; break;
          case "download": footer = `  ↳ download · ${d.bytes ?? 0} bytes${d.path ? ` · ${d.path}` : ""}`; break;
          case "git": footer = `  ↳ git ${d.operation ?? "done"}${d.cwd ? ` · ${d.cwd}` : ""}`; break;
          case "fetch": footer = `  ↳ fetch · HTTP ${d.status ?? "?"} · ${d.bytes ?? 0} bytes`; break;
          case "image": footer = `  ↳ image · ${d.bytes ?? 0} bytes${d.path ? ` · ${d.path}` : ""}`; break;
          case "html_debug": footer = `  ↳ html debug · ${d.bytes ?? 0} bytes · ${((d.durationMs ?? 0) / 1000).toFixed(1)}s${d.path ? ` · ${d.path}` : ""}`; break;
          case "html": footer = `  ↳ html · ${d.bytes ?? 0} bytes${d.path ? ` · ${d.path}` : ""}`; break;
          default: footer = `  ↳ ${event.toolName} done`;
        }
        if (event.toolName === "slop") {
          writer.writeln((d.exitCode ?? 1) === 0 ? green(footer) : red(footer));
        } else {
          writer.writeln(dim(footer));
        }
        for (const image of images) {
          try {
            await renderKittyImage(writer, image);
          } catch (error) {
            writer.writeln(
              red(`  ↳ image failed: ${error instanceof Error ? error.message : String(error)}`),
            );
          }
        }
        if (event.toolName === "html" && typeof d.path === "string") {
          try {
            openHtmlPreview(d.path);
          } catch (error) {
            writer.writeln(
              red(`  ↳ html preview failed: ${error instanceof Error ? error.message : String(error)}`),
            );
          }
        }
        if (
          event.toolName === "raylib" &&
          typeof d.path === "string" &&
          typeof d.width === "number" &&
          typeof d.height === "number"
        ) {
          try {
            await openRaylibPreview(d.path, d.width, d.height, String(d.title ?? d.path));
          } catch (error) {
            writer.writeln(
              red(`  ↳ raylib preview failed: ${error instanceof Error ? error.message : String(error)}`),
            );
          }
        }
      }
      spinner.start();
      break;
    }

    case "agent_end":
      spinner.stop();
      markdown.finish();
      writer.ensureNewline();
      prompt.setBusy(false);
      prompt.start();
      break;
  }
  renderFooter();
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

function seedWelcome(p: Pyodide) {
  fsWriteText(
    p,
    "/home/web/README.md",
    `# piodide workspace

This is the shared in-browser filesystem. Python, the agent tools, Git, and
Neovim all read and write these same files under \`/home/web\`. Everything is
held in memory and disappears when the page is refreshed.

## Neovim

Press \`Ctrl+Shift+E\` (or run \`/nvim\`) to toggle between the agent and
Neovim. Neovim itself runs as WebAssembly; its editor buffers are synchronized
with Pyodide whenever the view changes.

Run \`:Ex\` to browse the actual Pyodide filesystem. The explorer header shows
Neovim's working directory and the full directory path. Use \`..\` to navigate
all the way to \`/\`, Enter to open a file or directory, \`%\` to create a file,
\`d\` to create a directory, and \`D\` to delete an entry.

## Git

The agent's \`git\` tool creates standard Git repositories through Slop and
libgit2 WebAssembly. GitHub clone/pull/push use browser fetch; register private
access for the current page with \`/github\`.

## Host files

Run \`/upload\` to import files from the host into \`/home/web\`. Run
\`/download <path>\`, or ask the agent to download a file, to save it through
the browser.
`,
  );
  fsWriteText(
    p,
    "/home/web/demo.py",
    '# Run me with the python tool.\nimport math\nprint("sum of squares 1..10:", sum(x*x for x in range(1, 11)))\nprint("pi ~=", math.pi)\n',
  );
}

/**
 * GitHub Pages cannot send COOP/COEP headers, so register a service worker
 * that adds them; one reload later the page is cross-origin isolated and the
 * WASI worker mode (interactive slop, killable runs) works in production.
 */
async function ensureCrossOriginIsolation(): Promise<boolean> {
  if (typeof crossOriginIsolated === "undefined") return false;
  if (!("serviceWorker" in navigator)) return false;
  const scriptUrl = new URL(
    `${import.meta.env.BASE_URL}coi-serviceworker.js`,
    location.href,
  ).href;
  try {
    const current = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
    const loopbackHost =
      location.hostname === "localhost" ||
      location.hostname === "127.0.0.1" ||
      location.hostname === "[::1]";
    if (
      crossOriginIsolated &&
      loopbackHost &&
      current?.active?.scriptURL === scriptUrl
    ) {
      // Dev and preview servers already send COOP/COEP. Detach an older COI
      // worker so Firefox loads Slop/WASI workers directly from Vite.
      await current.unregister();
      if (
        navigator.serviceWorker.controller &&
        !sessionStorage.getItem("coi-local-unregistered")
      ) {
        sessionStorage.setItem("coi-local-unregistered", "1");
        location.reload();
        return true;
      }
      return false;
    }
    if (!current) sessionStorage.removeItem("coi-local-unregistered");
    if (current?.active?.scriptURL === scriptUrl) {
      // Existing controlled pages may already be isolated by an older worker.
      // Check for the narrowed fetch handler instead of returning early.
      await current.update();
    }
    if (crossOriginIsolated) return false;
    await navigator.serviceWorker.register(scriptUrl, { updateViaCache: "none" });
    // register() may resolve while a new worker is still installing. Reloading
    // before activation produces an uncontrolled page; the session guard then
    // prevents the reload that would actually add COOP/COEP. Wait for active.
    await navigator.serviceWorker.ready;
    if (!sessionStorage.getItem("coi-reloaded")) {
      sessionStorage.setItem("coi-reloaded", "1");
      location.reload();
      return true;
    }
  } catch {
    // No isolation: everything still works in main-thread fallback mode.
  }
  return false;
}

async function main() {
  // Finish any service-worker transition before consuming a temporary launch
  // token. A required reload must preserve the fragment for the stable page.
  if (await ensureCrossOriginIsolation()) return;
  const localCodexProxyToken = consumeLocalCodexProxyToken();
  window.addEventListener("resize", syncVisualViewport);
  window.visualViewport?.addEventListener("resize", syncVisualViewport);
  window.visualViewport?.addEventListener("scroll", syncVisualViewport);
  syncVisualViewport();
  handle = await createTerminal(mount);
  writer = handle.writer;
  markdown = new AssistantMarkdown(writer);
  spinner = new Spinner(writer);
  browserModelRuntime.subscribe((status) =>
    onBrowserModelStatus(browserModelRuntime, status),
  );
  webLLMRuntime.subscribe((status) =>
    onBrowserModelStatus(webLLMRuntime, status),
  );
  const term = handle.term;

  mount.addEventListener("click", () => term.focus());

  mobileCommands = new MobileCommandUi({
    layer: mobileCommandLayerEl,
    drawer: mobileCommandDrawerEl,
    backdrop: mobileCommandBackdropEl,
    trigger: mobileCommandTriggerEl,
    close: mobileCommandCloseEl,
    title: mobileCommandTitleEl,
    content: mobileCommandContentEl,
    onCommand: (command) => prompt.submitExternal(command),
  });
  prompt = new PromptLine({
    writer,
    onSubmit,
    onAbort,
    onCycleThinking: cycleThinkingLevel,
    commands: COMMANDS,
    commandMenu: commandMenuEl,
    mobilePrompt: mobileCommands,
  });
  term.onData((data: string) => inputHandler(data));

  renderFooter();
  window.setInterval(renderFooter, 1000);
  writer.write(BANNER);
  writer.writeln(dim("Loading Python…"));
  prompt.setBusy(true);
  term.focus();

  // Load Python in the background; build the agent once it's ready.
  loadPyodideRuntime()
    .then(async (p) => {
      py = p;
      seedWelcome(p);
      installWasiPythonModule(p, makeJsRunner(p));
      agent = new Agent({
        initialState: {
          systemPrompt: currentSystemPrompt(),
          model: makeModel({ baseUrl: "", modelId: "", api: "openai-completions", provider: "none" }),
          thinkingLevel: "off",
          tools: createAllTools(p, () => gitHubCredentials),
          messages: [],
        },
        streamFn: streamDispatch,
        convertToLlm: (m) => m as Message[],
        getApiKey: async () => currentApiKey(),
        toolExecution: "sequential",
      });
      agent.subscribe(renderEvent);
      pyReady = true;
      renderFooter();
      say(green(`  ◆ python ready · heap ${currentHeapUsage()} · filesystem at /home/web`));
      applyConfigToAgent();

      // A proxy launch URL connects without exposing its non-OpenAI capability
      // in terminal logs. OAuth credentials never enter the browser.
      if (localCodexProxyToken) {
        const localCodex = getProvider("codex-local");
        if (localCodex) {
          try {
            await verifyLocalCodexProxyToken(localCodex, localCodexProxyToken);
            apiKeys.set(localCodex.name, localCodexProxyToken);
            provider = localCodex;
            modelOverride = null;
            await localCodex.loadModels();
            applyConfigToAgent();
            say(green(`  ◆ connected to ${localCodex.label}`));
          } catch (error) {
            say(
              red(
                `  local Codex proxy unavailable: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }
        }
      }

      prompt.setBusy(false);
      prompt.start();

      // Headless self-test mode.
      const qp = new URLSearchParams(location.search);
      if (qp.get("e2e") || qp.get("dbg")) {
        (globalThis as any).__pi = {
          agent,
          py,
          prompt,
          spinner,
          term,
          writer,
          run: (text: string) => handleSubmit(text),
          toggleEditor: () => toggleNeovim(),
          toggleSlop: () => toggleSlop(),
          openRaylib: (path: string, width: number, height: number, title = path) =>
            openRaylibPreview(path, width, height, title),
          closeRaylib: () => closeRaylibPreview(),
          get neovim() {
            return neovim;
          },
          get slop() {
            return slop;
          },
          get slopTerminal() {
            return slopHandle;
          },
          get raylibPreview() {
            return raylibPreview;
          },
          browserModelRuntime,
          webLLMRuntime,
          get view() {
            return activeView;
          },
          get heap() {
            return currentHeapUsage();
          },
          get config() {
            return { provider: provider?.name ?? null, model: currentModelId() };
          },
        };
      }
      if (qp.get("e2e")) {
        const baseProvider = getProvider(qp.get("provider") || "openai");
        if (baseProvider) {
          provider = { ...baseProvider, baseUrl: qp.get("baseUrl") || baseProvider.baseUrl };
          await baseProvider.loadModels();
        }
        // E2E mode is for loopback mock servers only. Never accept credentials
        // through the URL: query strings leak into browser history and logs.
        if (provider) apiKeys.set(provider.name, "test");
        if (qp.get("model")) modelOverride = qp.get("model");
        applyConfigToAgent();
        const q = qp.get("q") || "compute 1+1";
        setTimeout(async () => {
          try {
            await agent!.prompt(q);
          } catch (err) {
            statusEl.textContent = "E2E:ERROR:" + (err instanceof Error ? err.message : String(err));
            return;
          }
          const msgs = agent!.state.messages as any[];
          statusEl.textContent =
            "E2E:" +
            JSON.stringify({
              n: msgs.length,
              roles: msgs.map((m) => m.role),
              assistant: msgs
                .filter((m) => m.role === "assistant")
                .map((m) => ({ stopReason: m.stopReason, contentTypes: (m.content || []).map((c: any) => c.type), errorMessage: m.errorMessage })),
              toolResults: msgs
                .filter((m) => m.role === "toolResult")
                .map((m) => ({ name: m.toolName, content: (m.content?.[0]?.text || "").slice(0, 60), isError: m.isError })),
            });
        }, 200);
      }
    })
    .catch((err) => {
      renderFooter();
      say(red(`  failed to load pyodide: ${err instanceof Error ? err.message : String(err)}`));
      prompt.setBusy(false);
      prompt.start();
    });
}

void main();
