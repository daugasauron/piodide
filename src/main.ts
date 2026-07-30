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

/* ------------------------------------------------------------------ */
/* system prompt                                                       */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `You are pi, a coding assistant running entirely inside the user's web browser. You have no access to the host machine. Your only runtime is one long-lived Pyodide CPython instance backed by an in-memory filesystem at /home/web.

Tools:
- python: run focused Python 3 code; stdout/stderr is shown live and returned to you. Install a pure-Python package only when needed with: import micropip; await micropip.install("pkg").
- compile_c: compile one bounded C source file to a wasm32-wasi .o object. It supports C11/C17, -O0/-O1/-O2/-O3/-Os, DWARF debug info, warnings/-Werror, -D definitions, and additional /home/web include directories.
- link_wasi: link one or more .o files into a WASI .wasm executable with wasm-ld and WASI libc. It can export selected symbols and optionally strip the result. The compiler, linker, and sysroot assets are lazily downloaded.
- run_wasi: run a WASI .wasm file from /home/web with arguments, stdin, and environment variables. The program shares the live Pyodide filesystem (no copying): files it creates, edits, or deletes are immediately visible everywhere. Relative paths start at /home/web, and absolute /home/web paths also work. From Python you can also import wasi and await wasi.run_wasi(path, args=[...], stdin="...").
- slop: run one command line in the slop shell: pipes (cat f.txt | grep x), redirects (> file, >> file), &&/|| short-circuit lists, ; sequences, and $VAR/\${VAR}/$? expansion. $PATH is exactly /bin: ls, cat, grep, echo, env, fd-find. Slop also recognizes host-routed cc/ld pseudo-commands. Each call is a fresh shell — filesystem changes persist between calls, cwd does not (pass cwd; default /home/web). Use slop for small shell-style jobs instead of python for file crunching.
- read: read a text file with line numbers; offset (1-based) and limit paginate large files.
- write: create or overwrite a file; parent directories are created automatically.
- edit: apply exact, unique string replacements (each oldText must match exactly once).
- download: save one file from Pyodide to the user's browser downloads. Call it only when the user asks to download or save a file locally.
- git: use a real Dulwich Git repository in /home/web for init/status/add/commit/log/diff. GitHub clone/pull/push use its browser-compatible API; private access is registered by the user with /github and is never visible to you. The remote adapter synchronizes committed snapshots, so commit before push and push before pull.
- fetch: fetch a URL via the browser's native fetch (CORS-limited); set path to save a binary response in /home/web. Saving a file does not display it.
- image: display a PNG, JPEG, GIF, or WebP file from /home/web directly in the terminal. This is the only display path; call it exactly once.
- html: open a self-contained HTML file from /home/web in a closeable browser preview. Write one file with inline CSS and JavaScript, then call html exactly once; relative MEMFS assets are not available inside the preview.

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
- Keep sources and outputs small. There is no make, ar, package manager, native executable output, or incremental build graph; use several cc calls and one ld call. A linked executable runs only through run_wasi, ./path inside slop, Python's wasi.run_wasi, or an exact-name command installed in /bin.

Extending the shell (self-hosting):
- You can add commands: write a small C program with the write tool, compile it with cc -c file.c -o file.o, then link it with ld file.o -o /bin/name (or use compile_c + link_wasi). It runs immediately by exact name through slop. Relative paths automatically start at the cwd supplied by slop.
- The shell's own sources are in /home/web/slop/ (slop.c, ls.c, cat.c, grep.c, echo.c, env.c, fd-find.c) — small, readable starting points. You can even rebuild slop itself (careful: the user runs it interactively too).
To show an image, save it as a file and then call the image tool exactly once. A fetch,
python, or reasoning result does not display the file. Do not print binary image bytes or
base64 into the terminal, and do not call image again for the same display request.
To show an interactive page, write a self-contained .html file and call the html tool exactly
once. Keep its CSS and JavaScript inline.

Be concise and pragmatic. Prefer running code over long prose. Use python for math, data, and exploration. Use write/edit to change files, then confirm briefly.`;

const BANNER = [
  "\x1b[35m❯\x1b[0m \x1b[1mpiodide\x1b[0m — pi in the browser",
  "\x1b[2mghostty-web · pyodide · pi-agent-core\x1b[0m",
  "",
  "\x1b[2mCommands:\x1b[0m  /provider   /model   /github   /new   /tree   /thinking   /nvim   /help",
  "\x1b[2mEditor:\x1b[0m    Ctrl+Shift+E toggles agent ↔ Neovim · Ctrl+Shift+S toggles slop shell",
  "\x1b[2mStart with:\x1b[0m /provider  →  choose one  →  /login  →  then just type.",
  "",
].join("\r\n");

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
  { name: "/nvim", description: "open Neovim (Ctrl+Shift+E)" },
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
const neovimViewEl = document.getElementById("neovim-view") as HTMLElement;
const neovimEditorEl = document.getElementById("neovim-editor") as HTMLElement;
const neovimCommandlineEl = document.getElementById("neovim-commandline") as HTMLElement;
const neovimStatusEl = document.getElementById("neovim-status") as HTMLElement;
const commandMenuEl = document.getElementById("command-menu") as HTMLElement;
const htmlPreviewEl = document.getElementById("html-preview") as HTMLElement;
const htmlPreviewTitleEl = document.getElementById("html-preview-title") as HTMLElement;
const htmlPreviewFrameEl = document.getElementById("html-preview-frame") as HTMLIFrameElement;
const htmlPreviewCloseEl = document.getElementById("html-preview-close") as HTMLButtonElement;
const footerLocationEl = document.getElementById("footer-location") as HTMLElement;
const footerUsageEl = document.getElementById("footer-usage") as HTMLElement;
const footerModelEl = document.getElementById("footer-model") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;

let handle!: TerminalHandle;
let writer!: TermWriter;
let prompt!: PromptLine;
let markdown!: AssistantMarkdown;
let spinner!: Spinner;

let agent: Agent | null = null;
let py: Pyodide | null = null;
let pyReady = false;
let activeView: "agent" | "nvim" | "slop" = "agent";
let neovim: NeovimController | null = null;
let slop: SlopSession | null = null;
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
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

function say(line: string) {
  writer.ensureNewline();
  writer.writeln(line);
}

function openHtmlPreview(path: string) {
  if (!py) throw new Error("Python filesystem is not ready.");
  htmlPreviewTitleEl.textContent = path;
  htmlPreviewFrameEl.srcdoc = fsReadText(py, path);
  htmlPreviewEl.hidden = false;
  htmlPreviewCloseEl.focus();
}

function closeHtmlPreview() {
  if (htmlPreviewEl.hidden) return;
  htmlPreviewEl.hidden = true;
  htmlPreviewFrameEl.srcdoc = "";
  handle.term.focus();
}

htmlPreviewCloseEl.addEventListener("click", closeHtmlPreview);
htmlPreviewEl.addEventListener("click", (event) => {
  if (event.target === htmlPreviewEl) closeHtmlPreview();
});
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

function consumeTemporaryCodexProxyToken(): string {
  const url = new URL(location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get("codex_proxy_token")?.trim() ?? "";
  if (!token) return "";
  fragment.delete("codex_proxy_token");
  url.hash = fragment.toString();
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return token;
}

async function verifyTemporaryCodexProxyToken(
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

function currentHeapUsage() {
  return py ? formatWasmHeapUsage(py) : "loading";
}

function currentMessages(): AgentMessage[] {
  return agent?.state.messages ?? [];
}

function renderFooter() {
  const model = currentModelId() || "no model";
  const thinking = agent?.state.thinkingLevel ?? "off";
  const usage = sessionUsage();
  const contextWindow = agent?.state.model.contextWindow || 200_000;
  const contextTokens = currentContextTokens();
  const contextPercent = Math.min(999, (contextTokens / contextWindow) * 100);
  const cacheTotal = usage.input + usage.cacheRead;
  const cacheHit = cacheTotal > 0 ? `${((usage.cacheRead / cacheTotal) * 100).toFixed(1)}%` : "—";

  footerLocationEl.textContent =
    activeView === "nvim"
      ? "/home/web (nvim)"
      : activeView === "slop"
        ? "/home/web (slop)"
        : "/home/web";
  footerUsageEl.textContent =
    `↑${formatTokenCount(usage.input)} ↓${formatTokenCount(usage.output)} ` +
    `R${formatTokenCount(usage.reasoning)} CH${cacheHit} ` +
    `${contextPercent.toFixed(1)}%/${formatTokenCount(contextWindow)}`;
  footerModelEl.textContent =
    `(${provider?.name ?? "no provider"}) ${model} • ${thinking}`;
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
    SYSTEM_PROMPT.length +
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

function applyConfigToAgent() {
  if (agent && provider) {
    const model = makeModel({
      baseUrl: provider.baseUrl,
      modelId: currentModelId(),
      api: provider.api,
      provider: provider.name,
      extraBody: provider.extraBody,
      info: getLoadedModelInfo(provider.name, currentModelId()),
    });
    agent.state.model = model;
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
  if (viewToggleRunning) return;
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
    setNeovimStatus(
      `failed: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  } finally {
    viewToggleRunning = false;
  }
}

/* ------------------------------------------------------------------ */
/* slop shell view (Ctrl+Shift+S)                                      */
/* ------------------------------------------------------------------ */

async function toggleSlop() {
  if (activeView === "slop") {
    activeView = "agent";
    inputHandler = (data) => prompt.feed(data);
    renderFooter();
    say(dim("  — agent view · Ctrl+Shift+S returns to slop —"));
    if (!prompt.isOccupied()) prompt.start();
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
    say(yellow("  slop needs cross-origin isolation (npm run dev / vite preview / coi service worker)"));
    return;
  }

  activeView = "slop";
  renderFooter();
  if (!slop || !slop.alive) {
    slop = new SlopSession({
      py,
      writeOut: writeProgramOutput,
      note: (text) => say(dim(text)),
      onExit: () => {
        if (activeView === "slop") {
          activeView = "agent";
          inputHandler = (data) => prompt.feed(data);
          renderFooter();
          if (!prompt.isOccupied()) prompt.start();
        }
      },
    });
    try {
      await slop.start();
    } catch (error) {
      activeView = "agent";
      renderFooter();
      say(red(`  slop failed to start: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
  } else {
    say(dim("  — slop shell · Ctrl+Shift+S returns to the agent —"));
  }
  inputHandler = (data) => slop!.feed(data);
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
  if (!currentApiKey()) {
    say(yellow(`  not logged in. run: /login   (to use ${provider.label})`));
    prompt.start();
    return;
  }

  prompt.setBusy(true);
  try {
    await agent.prompt(t);
  } catch (err) {
    say(red(`  agent error: ${err instanceof Error ? err.message : String(err)}`));
    prompt.setBusy(false);
    prompt.start();
  }
  // agent_end restarts the prompt in the normal case.
}

function activateProvider(next: ProviderDef) {
  provider = next;
  modelOverride = null;
  applyConfigToAgent();
  say(cyan(`  ◇ provider: ${next.label}   model: ${currentModelId()}`));
  if (next.note) say(dim(`    ${next.note}`));
  if (!currentApiKey()) say(yellow("  now run /login to set your API key"));
  void next.loadModels().then(() => {
    if (provider === next) applyConfigToAgent();
  });
}

function activateModel(modelId: string) {
  modelOverride = modelId === provider?.defaultModel ? null : modelId;
  applyConfigToAgent();
  say(cyan(`  ◇ model: ${modelId}`));
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
    `  ${provider?.temporaryLocalCodexProxy ? "proxy  " : "key    "}: ${currentApiKey() ? green("set") : dim("(none — /login)")}`,
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
      say(dim("  /github [api-url|status|logout]           session-only GitHub access"));
      say(dim("  /new  /tree  /resume  /fork  /clone     page-local sessions"));
      say(dim("  /name  /session  /copy  /export          session utilities"));
      say(dim("  /thinking [level]                         model effort (Shift+Tab cycles)"));
      say(dim("  /download <path>  /upload [directory]      host file transfer"));
      say(dim("  /run <prog.wasm> [args]                    run a WASI program (live filesystem)"));
      say(dim("  /image <path>  /html <path>                browser previews"));
      say(dim("  /nvim                                      open Neovim editor"));
      say(dim("  /status  /clear  /hotkeys                  terminal utilities"));
      break;

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
        if (name) activateProvider(PROVIDERS[name]);
      } else {
        const next = getProvider(arg);
        if (!next) {
          say(red(`  unknown provider: ${arg}`));
        } else {
          activateProvider(next);
        }
      }
      break;
    }

    case "model": {
      if (!provider) {
        say(yellow("  pick a provider first: /provider"));
      } else if (!arg) {
        const models = await provider.loadModels();
        const modelId = await prompt.select({
          title: `Select model · ${provider.label}`,
          active: currentModelId(),
          options: models.map((id) => ({
            value: id,
            label: id,
            description: id === provider!.defaultModel ? "default" : undefined,
          })),
        });
        if (modelId) activateModel(modelId);
      } else {
        activateModel(arg);
      }
      break;
    }

    case "login": {
      if (!provider) {
        say(yellow("  pick a provider first: /provider <name>"));
        break;
      }
      if (provider.temporaryLocalCodexProxy) {
        const token = (
          await prompt.ask("  temporary token printed by npm run codex-proxy (hidden): ", true)
        ).trim();
        if (!token) {
          say(yellow("  login cancelled"));
          break;
        }
        say(dim("  checking local Codex proxy…"));
        await verifyTemporaryCodexProxyToken(provider, token);
        apiKeys.set(provider.name, token);
        say(green("  ◆ connected to temporary local Codex proxy"));
        break;
      }
      const key = await prompt.ask(`  API key for ${provider.label} (hidden): `, true);
      const trimmed = key.trim();
      if (trimmed) {
        apiKeys.set(provider.name, trimmed);
        say(green(`  ◆ key set for ${provider.label}`));
      } else {
        say(yellow("  login cancelled"));
      }
      break;
    }

    case "logout":
      if (!provider) {
        say(yellow("  no provider selected"));
      } else if (provider.temporaryLocalCodexProxy) {
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
        say(green("  ◆ local Codex proxy disconnected; its temporary process was stopped"));
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
      say(dim("  Ctrl+Shift+E  toggle agent / Neovim"));
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

function printSlopCall(args: unknown) {
  const values =
    typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const command = typeof values.command === "string" ? values.command : "";
  const cwd = typeof values.cwd === "string" ? values.cwd : "/home/web";
  const valueWidth = Math.max(32, writer.cols - 15);

  writer.writeln(dim("  ⏺ slop"));
  writer.writeln(dim(`    cwd    ${exactStringPreview(cwd, valueWidth)}`));
  writer.writeln(dim(`    input  ${exactStringPreview(command, valueWidth)}`));
}

function slopOutputText(result: any, exitCode: unknown): string {
  const text = toolResultText(result);
  const marker = `[exit ${exitCode ?? "?"}]\n`;
  return text.endsWith(marker) ? text.slice(0, -marker.length) : text;
}

function printSlopOutput(result: any, exitCode: unknown) {
  const output = slopOutputText(result, exitCode);
  writer.writeln(dim("    output"));
  if (!output) {
    writer.writeln(dim("    │ (no output)"));
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
    writer.writeln(dim(`    │ ${truncateLine(safe, maxLineLength)}`));
  };

  if (lines.length <= headCount + tailCount + 1) {
    for (const line of lines) printLine(line);
    return;
  }
  for (const line of lines.slice(0, headCount)) printLine(line);
  writer.writeln(dim(`    │ … ${lines.length - headCount - tailCount} lines omitted`));
  for (const line of lines.slice(-tailCount)) printLine(line);
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
          case "html": footer = `  ↳ html · ${d.bytes ?? 0} bytes${d.path ? ` · ${d.path}` : ""}`; break;
          default: footer = `  ↳ ${event.toolName} done`;
        }
        writer.writeln(dim(footer));
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

The agent's \`git\` tool uses Dulwich for local repositories. GitHub
clone/pull/push use a browser-compatible snapshot transport; register private
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
    await navigator.serviceWorker.register(scriptUrl);
    if (
      !navigator.serviceWorker.controller &&
      !sessionStorage.getItem("coi-reloaded")
    ) {
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
  const temporaryCodexProxyToken = consumeTemporaryCodexProxyToken();
  handle = await createTerminal(mount);
  writer = handle.writer;
  markdown = new AssistantMarkdown(writer);
  spinner = new Spinner(writer);
  const term = handle.term;

  mount.addEventListener("click", () => term.focus());

  prompt = new PromptLine({
    writer,
    onSubmit,
    onAbort,
    onCycleThinking: cycleThinkingLevel,
    commands: COMMANDS,
    commandMenu: commandMenuEl,
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
          systemPrompt: SYSTEM_PROMPT,
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

      // TEMPORARY: a proxy launch URL can connect without making the user paste
      // its non-OpenAI capability. OAuth credentials never enter the browser.
      if (temporaryCodexProxyToken) {
        const localCodex = getProvider("codex-local");
        if (localCodex) {
          try {
            await verifyTemporaryCodexProxyToken(localCodex, temporaryCodexProxyToken);
            apiKeys.set(localCodex.name, temporaryCodexProxyToken);
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
          get neovim() {
            return neovim;
          },
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
        if (provider) apiKeys.set(provider.name, qp.get("key") || "test");
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
