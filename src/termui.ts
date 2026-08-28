/**
 * Terminal surface (ghostty-web) + a small VT line-editor that turns the
 * terminal into an interactive prompt. Supports a hidden mode (for /login) and
 * a one-shot `ask()` for reading a single line with a custom prompt.
 */
import { FitAddon, Terminal, init, type GhosttyCell, type ITheme } from "ghostty-web";
import stringWidth from "string-width";

const FONT_FAMILY = '"IosevkaTerm Nerd Font"';
const FONT_SIZE = 16;
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const GREEN = "\x1b[32m";
const USER_PROMPT_BACKGROUND = "\x1b[48;2;36;40;59m";
const USER_PROMPT_TEXT = "\x1b[38;2;192;202;245m";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let terminalInitPromise: Promise<void> | null = null;

const THEME: ITheme = {
  background: "#0b0c10",
  foreground: "#c0caf5",
  cursor: "#7aa2f7",
  selectionBackground: "#283457",
  black: "#15161e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#414868",
  brightRed: "#ff7a93",
  brightGreen: "#b9f27c",
  brightYellow: "#ffc777",
  brightBlue: "#7da6ff",
  brightMagenta: "#c8a3ff",
  brightCyan: "#a5e6ff",
  brightWhite: "#c0caf5",
};

export interface TermWriter {
  write(data: string): void;
  writeln(data: string): void;
  ensureNewline(): void;
  replaceCurrentLine(data: string): void;
  clearPreviousLines(count: number): void;
  setCursorVisible(visible: boolean): void;
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalHandle {
  term: Terminal;
  fit: FitAddon;
  writer: TermWriter;
}

interface ViewportTerminal {
  getViewport(): GhosttyCell[];
  clearDirty(): void;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
}

interface KittyPlacement {
  viewportRow: number;
}

interface KittyCanvasRenderer {
  render(...args: unknown[]): void;
  renderKittyImages(): void;
  currentDirectPlacements: KittyPlacement[];
}

interface TerminalInternals {
  wasmTerm?: ViewportTerminal;
  renderer?: KittyCanvasRenderer;
}

/**
 * ghostty-web's Kitty branch currently rebuilds the whole WASM viewport in
 * getLine(). The canvas renderer asks for several lines per frame, so cache
 * that snapshot for the duration of a render pass instead of crossing the
 * JS/WASM boundary thousands of times for every line.
 */
function cacheViewportPerRender(term: Terminal): void {
  const wasm = (term as unknown as TerminalInternals).wasmTerm;
  if (!wasm) return;

  const getViewport = wasm.getViewport.bind(wasm);
  const clearDirty = wasm.clearDirty.bind(wasm);
  const write = wasm.write.bind(wasm);
  const resize = wasm.resize.bind(wasm);
  let viewport: GhosttyCell[] | null = null;

  wasm.getViewport = () => {
    viewport ??= getViewport();
    return viewport;
  };
  wasm.clearDirty = () => {
    clearDirty();
    viewport = null;
  };
  wasm.write = (data) => {
    viewport = null;
    write(data);
  };
  wasm.resize = (cols, rows) => {
    viewport = null;
    resize(cols, rows);
  };
}

/**
 * Direct Kitty placements are reported relative to Ghostty's active screen.
 * ghostty-web scrolls text through its own viewport offset, so apply that same
 * offset while compositing images or they remain pinned to the canvas.
 */
function makeKittyImagesFollowScrollback(term: Terminal): void {
  const renderer = (term as unknown as TerminalInternals).renderer;
  if (!renderer?.renderKittyImages) return;

  const render = renderer.render.bind(renderer);
  const renderKittyImages = renderer.renderKittyImages.bind(renderer);
  let scrollbackRows = 0;

  renderer.render = (...args) => {
    scrollbackRows = typeof args[2] === "number" ? Math.floor(args[2]) : 0;
    render(...args);
  };
  renderer.renderKittyImages = () => {
    if (scrollbackRows === 0) {
      renderKittyImages();
      return;
    }

    const placements = renderer.currentDirectPlacements;
    renderer.currentDirectPlacements = placements.map((placement) => ({
      ...placement,
      viewportRow: placement.viewportRow + scrollbackRows,
    }));
    try {
      renderKittyImages();
    } finally {
      renderer.currentDirectPlacements = placements;
    }
  };
}

/** Route the mobile keyboard's Done/Enter action through terminal input. */
function configureMobileEnter(term: Terminal): void {
  const textarea = term.textarea;
  if (!textarea) return;
  textarea.enterKeyHint = "send";
  let lastSubmit = -Infinity;

  const submit = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const now = performance.now();
    if (now - lastSubmit < 100) return;
    lastSubmit = now;
    term.input("\r", true);
  };
  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) submit(event);
  }, true);
  textarea.addEventListener("beforeinput", (event) => {
    if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
      submit(event);
    }
  }, true);
}

/**
 * ghostty-web currently handles mouse wheels but not finger scrolling. Convert
 * a vertical drag into terminal scrollback while leaving horizontal edge
 * gestures available to the mobile command drawer.
 */
function configureTouchScroll(term: Terminal, mount: HTMLElement): void {
  let touchId: number | null = null;
  let startX = 0;
  let startY = 0;
  let lastY = 0;
  let pendingRows = 0;
  let scrollFrame = 0;
  let scrolling = false;

  const flushScroll = () => {
    scrollFrame = 0;
    if (pendingRows === 0) return;
    term.scrollLines(-pendingRows);
    pendingRows = 0;
  };

  const queueScroll = (rows: number) => {
    pendingRows += rows;
    if (!scrollFrame) scrollFrame = requestAnimationFrame(flushScroll);
  };

  const reset = () => {
    if (scrollFrame) cancelAnimationFrame(scrollFrame);
    flushScroll();
    touchId = null;
    scrolling = false;
  };

  mount.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) {
      reset();
      return;
    }
    const touch = event.touches[0];
    touchId = touch.identifier;
    startX = touch.clientX;
    startY = touch.clientY;
    lastY = touch.clientY;
    pendingRows = 0;
    scrolling = false;
  }, { passive: true, capture: true });

  mount.addEventListener("touchmove", (event) => {
    if (touchId === null) return;
    const touch = Array.from(event.touches).find(({ identifier }) => identifier === touchId);
    if (!touch) return;
    const totalX = touch.clientX - startX;
    const totalY = touch.clientY - startY;
    if (!scrolling) {
      if (Math.abs(totalY) < 8 || Math.abs(totalY) <= Math.abs(totalX)) return;
      scrolling = true;
    }

    event.preventDefault();
    event.stopPropagation();
    const rowHeight = Math.max(12, mount.clientHeight / Math.max(1, term.rows));
    // ghostty-web accepts fractional rows. Applying them once per animation
    // frame avoids redundant canvas renders and removes the old whole-row
    // stepping that made short drags feel sticky.
    queueScroll(((touch.clientY - lastY) / rowHeight) * 1.35);
    lastY = touch.clientY;
  }, { passive: false, capture: true });

  const finish = (event: TouchEvent) => {
    if (scrolling) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    reset();
  };
  mount.addEventListener("touchend", finish, { passive: false, capture: true });
  mount.addEventListener("touchcancel", finish, { passive: false, capture: true });
}

export async function createTerminal(mount: HTMLElement): Promise<TerminalHandle> {
  await document.fonts.load(`${FONT_SIZE}px ${FONT_FAMILY}`);
  if (!terminalInitPromise) {
    terminalInitPromise = init();
    terminalInitPromise.catch(() => {
      terminalInitPromise = null;
    });
  }
  await terminalInitPromise;
  const term = new Terminal({
    fontSize: FONT_SIZE,
    fontFamily: `${FONT_FAMILY}, monospace`,
    theme: THEME,
    cursorBlink: true,
    convertEol: true, // model/tool text uses \n; translate to \r\n so lines start at column 0
  });
  term.open(mount);
  cacheViewportPerRender(term);
  makeKittyImagesFollowScrollback(term);
  configureMobileEnter(term);
  configureTouchScroll(term, mount);
  term.attachCustomKeyEventHandler((event) => {
    const terminalClipboardShortcut =
      event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
    if (!terminalClipboardShortcut) return false;

    if (event.code === "KeyC") {
      // Always consume the terminal copy chord. With no selection it is a
      // harmless no-op rather than Ctrl+C or the browser's inspector shortcut.
      term.copySelection();
      return true;
    }
    if (event.code === "KeyV") {
      // Let the browser emit its trusted paste event. Ghostty handles that
      // event as plain text and routes it through onData to the active view.
      return false;
    }
    return false;
  });

  const fit = new FitAddon();
  term.loadAddon(fit);
  fit.fit();
  fit.observeResize();

  let atLineStart = true;
  const writer: TermWriter = {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write(data: string) {
      if (data === "") return; // ghostty's WASM alloc trips on 0-length writes
      term.write(data);
      atLineStart = data.endsWith("\n");
    },
    writeln(data: string) {
      if (data !== "") term.write(data);
      term.write("\r\n");
      atLineStart = true;
    },
    ensureNewline() {
      if (!atLineStart) term.write("\r\n");
      atLineStart = true;
    },
    replaceCurrentLine(data: string) {
      term.write(`\r\x1b[2K${data}`);
      atLineStart = data.length === 0;
    },
    clearPreviousLines(count: number) {
      if (count <= 0) return;
      term.write(`\x1b[${count}A\r\x1b[J`);
      atLineStart = true;
    },
    setCursorVisible(visible: boolean) {
      term.write(visible ? "\x1b[?25h" : "\x1b[?25l");
    },
  };

  return { term, fit, writer };
}

export class Spinner {
  private frame = 0;
  private label = "";
  private startedAt = 0;
  private timer: number | null = null;
  private readonly writer: TermWriter;

  constructor(writer: TermWriter) {
    this.writer = writer;
  }

  start(label = "thinking") {
    this.label = label;
    if (this.timer !== null) return;
    this.startedAt = performance.now();
    this.writer.ensureNewline();
    this.render();
    this.timer = window.setInterval(() => {
      this.frame++;
      this.render();
    }, 80);
  }

  stop() {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
    this.startedAt = 0;
    this.writer.replaceCurrentLine("");
  }

  private render() {
    const glyph = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length];
    const elapsedSeconds = Math.max(0, (performance.now() - this.startedAt) / 1000);
    const elapsed = elapsedSeconds >= 1
      ? ` · ${elapsedSeconds < 10 ? elapsedSeconds.toFixed(1) : Math.round(elapsedSeconds)}s`
      : "";
    const labelWidth = Math.max(8, this.writer.cols - stringWidth(`⠋  ${elapsed}`) - 1);
    const label = truncateCells(this.label, labelWidth);
    this.writer.replaceCurrentLine(
      `${MAGENTA}${glyph}${RESET} ${DIM}${label}${elapsed}${RESET}`,
    );
  }
}

/* ----------------------------- line editor ----------------------------- */

export interface PromptOptions {
  writer: TermWriter;
  onSubmit: (text: string) => void;
  onAbort: () => void;
  highlightSubmitted?: (text: string) => boolean;
  onCycleThinking?: () => void;
  commands?: readonly CommandSuggestion[];
  commandMenu?: HTMLElement;
  mobilePrompt?: MobilePromptSurface;
}

export interface CommandSuggestion {
  name: string;
  description: string;
}

export interface SelectOption<T> {
  value: T;
  label: string;
  description?: string;
}

export interface SelectRequest<T> {
  title: string;
  options: readonly SelectOption<T>[];
  active?: T;
}

export interface MobilePromptSurface {
  enabled(): boolean;
  ask(question: string, hidden?: boolean): Promise<string>;
  select<T>(request: SelectRequest<T>): Promise<T | null>;
}

interface ActiveSelect {
  title: string;
  options: SelectOption<unknown>[];
  active: unknown;
  query: string;
  index: number;
  renderedRows: number;
  resolve: (value: unknown | null) => void;
}

const CHEVRON = "\x1b[35m❯\x1b[0m "; // magenta chevron + space = 2 visible cells

/** A minimal readline-style editor driven by raw terminal input bytes. */
export class PromptLine {
  private text = "";
  private pos = 0;
  private history: string[] = [];
  private histIdx = -1;
  private busy = false;
  private mobileInteraction = false;

  // current prompt prefix (may contain ANSI) and its visible cell width
  private prefix = CHEVRON;
  private prefixVisible = 2;
  private hidden = false;

  private resolveRead: ((s: string) => void) | null = null;
  private selection: ActiveSelect | null = null;
  private commandIndex = 0;
  private commandDismissed = false;
  private opts: PromptOptions;

  constructor(opts: PromptOptions) {
    this.opts = opts;
  }

  setBusy(b: boolean) {
    this.busy = b;
    if (b) this.hideCommandPopup();
  }

  /** True while switching views would strand an active run or modal prompt. */
  isOccupied() {
    return (
      this.busy ||
      this.mobileInteraction ||
      this.resolveRead !== null ||
      this.selection !== null
    );
  }

  /** Submit a command from an external control while preserving terminal history. */
  submitExternal(value: string): boolean {
    if (this.isOccupied()) return false;
    this.text = value;
    this.pos = value.length;
    this.hidden = false;
    this.commandDismissed = true;
    this.redraw();
    this.submit();
    return true;
  }

  /** Show an app-generated request as a normal user turn in the transcript. */
  showSubmittedPrompt(value: string): void {
    if (!value.trim()) return;
    this.hideCommandPopup();
    this.opts.writer.ensureNewline();
    this.writeSubmittedPrompt(value);
    if (this.history[this.history.length - 1] !== value) {
      this.history.push(value);
    }
  }

  /** Draw a fresh, empty prompt at the current cursor (assumed at col 0). */
  start() {
    this.prefix = CHEVRON;
    this.prefixVisible = 2;
    this.hidden = false;
    this.text = "";
    this.pos = 0;
    this.histIdx = -1;
    this.commandDismissed = false;
    this.hideCommandPopup();
    this.opts.writer.write(this.prefix);
  }

  /**
   * Ask for a single line of input with a custom prompt. When `hidden` is set
   * (e.g. for an API key) input is masked and erased on submit. Resolves with
   * the trimmed line; an empty line is returned as "".
   */
  ask(question: string, hidden = false): Promise<string> {
    if (this.selection) throw new Error("Cannot read a line while a selection menu is open.");
    if (this.opts.mobilePrompt?.enabled()) {
      if (this.mobileInteraction || this.resolveRead) {
        throw new Error("Another interactive prompt is already open.");
      }
      this.opts.writer.ensureNewline();
      this.opts.writer.writeln(question.trimEnd());
      this.mobileInteraction = true;
      this.hideCommandPopup();
      return this.opts.mobilePrompt
        .ask(question, hidden)
        .finally(() => {
          this.mobileInteraction = false;
        });
    }
    this.opts.writer.ensureNewline();
    this.prefix = question;
    this.prefixVisible = [...question].length;
    this.hidden = hidden;
    this.text = "";
    this.pos = 0;
    this.hideCommandPopup();
    this.opts.writer.write(this.prefix);
    return new Promise<string>((resolve) => {
      this.resolveRead = resolve;
    });
  }

  /** Open a searchable, keyboard-driven selection menu. */
  select<T>(request: SelectRequest<T>): Promise<T | null> {
    if (this.resolveRead || this.selection) {
      throw new Error("Another interactive prompt is already open.");
    }
    if (request.options.length === 0) return Promise.resolve(null);
    if (this.opts.mobilePrompt?.enabled()) {
      if (this.mobileInteraction) {
        throw new Error("Another interactive prompt is already open.");
      }
      this.mobileInteraction = true;
      this.hideCommandPopup();
      return this.opts.mobilePrompt.select(request).finally(() => {
        this.mobileInteraction = false;
      });
    }

    this.opts.writer.ensureNewline();
    return new Promise<T | null>((resolve) => {
      const options = request.options.map((option) => ({ ...option })) as SelectOption<unknown>[];
      const activeIndex = options.findIndex((option) => Object.is(option.value, request.active));
      this.selection = {
        title: request.title,
        options,
        active: request.active,
        query: "",
        index: Math.max(0, activeIndex),
        renderedRows: 0,
        resolve: (value) => resolve(value as T | null),
      };
      this.opts.writer.setCursorVisible(false);
      this.renderSelection();
    });
  }

  /** Consume raw input bytes from the terminal. */
  feed(data: string) {
    if (this.selection) {
      this.feedSelection(data);
      return;
    }
    if (this.busy) {
      if (data === "\x03") this.opts.onAbort(); // Ctrl+C aborts the run
      return;
    }
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === "\r" || ch === "\n") {
        this.submit();
        i++;
        continue;
      }
      if (ch === "\x7f" || ch === "\x08") {
        this.backspace();
        i++;
        continue;
      }
      if (ch === "\x03") {
        this.cancel();
        i++;
        continue;
      }
      if (ch === "\x15") {
        this.text = "";
        this.pos = 0;
        this.commandDismissed = false;
        this.commandIndex = 0;
        this.redraw();
        i++;
        continue;
      }
      if (ch === "\x01") {
        this.pos = 0;
        this.redraw();
        i++;
        continue;
      }
      if (ch === "\x05") {
        this.pos = this.text.length;
        this.redraw();
        i++;
        continue;
      }
      if (ch === "\x0b") {
        this.text = this.text.slice(0, this.pos);
        this.commandDismissed = false;
        this.commandIndex = 0;
        this.redraw();
        i++;
        continue;
      }
      if (ch === "\t") {
        if (this.completeCommand()) this.redraw();
        i++;
        continue;
      }
      if (ch === "\x1b") {
        const seq = this.readEscape(data, i);
        this.handleEscape(seq.seq);
        i = seq.next;
        continue;
      }
      if (ch >= " ") {
        this.text = this.text.slice(0, this.pos) + ch + this.text.slice(this.pos);
        this.pos++;
        this.commandDismissed = false;
        this.commandIndex = 0;
        this.redraw();
        i++;
        continue;
      }
      i++;
    }
  }

  private submit() {
    const selectedCommand = this.currentCommand();
    const value = selectedCommand?.name ?? this.text;
    const reading = this.resolveRead;
    this.hideCommandPopup();

    if (this.hidden) {
      // Erase the masked characters, leaving just the prompt, then drop a line.
      const w = this.opts.writer;
      w.write("\r");
      if (this.prefixVisible > 0) w.write(`\x1b[${this.prefixVisible}C`);
      w.write("\x1b[K\r\n");
    } else if (
      value.trim().length > 0 &&
      !reading &&
      this.opts.highlightSubmitted?.(value)
    ) {
      this.replaceWithSubmittedPrompt(value);
      if (this.history[this.history.length - 1] !== value) {
        this.history.push(value);
      }
    } else {
      const back = this.text.length - this.pos;
      if (back > 0) this.opts.writer.write(`\x1b[${back}C`);
      this.opts.writer.writeln("");
      if (value.trim().length > 0 && this.history[this.history.length - 1] !== value) {
        this.history.push(value);
      }
    }

    // Reset to the default prompt state.
    this.text = "";
    this.pos = 0;
    this.hidden = false;
    this.histIdx = -1;
    this.commandDismissed = false;
    this.commandIndex = 0;

    if (reading) {
      this.resolveRead = null;
      reading(value);
    } else {
      this.opts.onSubmit(value);
    }
  }

  private replaceWithSubmittedPrompt(value: string) {
    const cols = Math.max(1, this.opts.writer.cols);
    const beforeCursor = this.text.slice(0, this.pos);
    const cursorCells = this.prefixVisible + stringWidth(beforeCursor);
    const cursorRow = Math.max(0, Math.ceil(cursorCells / cols) - 1);
    const clear = `${cursorRow > 0 ? `\x1b[${cursorRow}A` : ""}\r\x1b[J`;
    this.opts.writer.write(clear);
    this.writeSubmittedPrompt(value);
  }

  private writeSubmittedPrompt(value: string) {
    const cols = Math.max(1, this.opts.writer.cols);
    this.opts.writer.writeln("");
    for (const line of formatSubmittedPrompt(value, cols)) {
      this.opts.writer.writeln(line);
    }
    this.opts.writer.writeln("");
  }

  private cancel() {
    const w = this.opts.writer;
    this.hideCommandPopup();
    w.write("^C");
    w.writeln("");
    if (this.resolveRead) {
      const r = this.resolveRead;
      this.resolveRead = null;
      r("");
    }
    this.start();
  }

  private backspace() {
    if (this.pos === 0) return;
    this.text = this.text.slice(0, this.pos - 1) + this.text.slice(this.pos);
    this.pos--;
    this.commandDismissed = false;
    this.commandIndex = 0;
    this.redraw();
  }

  private readEscape(data: string, i: number): { seq: string; next: number } {
    if (data[i + 1] !== "[") return { seq: "ESC", next: i + 1 };
    let j = i + 2;
    let params = "";
    while (j < data.length) {
      const c = data[j];
      if ((c >= "0" && c <= "9") || c === ";") {
        params += c;
        j++;
        continue;
      }
      return { seq: `[${params}${c}`, next: j + 1 };
    }
    return { seq: "[", next: j };
  }

  private feedSelection(data: string) {
    let i = 0;
    while (i < data.length && this.selection) {
      const ch = data[i];
      if (ch === "\r" || ch === "\n") {
        this.finishSelection();
        return;
      }
      if (ch === "\x03") {
        this.cancelSelection();
        return;
      }
      if (ch === "\x7f" || ch === "\x08") {
        this.selection.query = this.selection.query.slice(0, -1);
        this.selection.index = 0;
        this.renderSelection();
        i++;
        continue;
      }
      if (ch === "\x15") {
        this.selection.query = "";
        this.selection.index = 0;
        this.renderSelection();
        i++;
        continue;
      }
      if (ch === "\x1b") {
        const sequence = this.readEscape(data, i);
        if (sequence.seq === "ESC") {
          this.cancelSelection();
          return;
        }
        this.handleSelectionEscape(sequence.seq);
        i = sequence.next;
        continue;
      }
      if (ch >= " ") {
        this.selection.query += ch;
        this.selection.index = 0;
        this.renderSelection();
      }
      i++;
    }
  }

  private handleSelectionEscape(sequence: string) {
    const selection = this.selection;
    if (!selection) return;
    const matches = this.selectionMatches(selection);
    switch (sequence) {
      case "[A":
        if (matches.length > 0) {
          selection.index = (selection.index - 1 + matches.length) % matches.length;
          this.renderSelection();
        }
        break;
      case "[B":
        if (matches.length > 0) {
          selection.index = (selection.index + 1) % matches.length;
          this.renderSelection();
        }
        break;
      case "[H":
      case "[1~":
        selection.index = 0;
        this.renderSelection();
        break;
      case "[F":
      case "[4~":
        selection.index = Math.max(0, matches.length - 1);
        this.renderSelection();
        break;
      default:
        break;
    }
  }

  private selectionMatches(selection: ActiveSelect): SelectOption<unknown>[] {
    const terms = selection.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return selection.options;
    return selection.options.filter((option) => {
      const searchable = `${option.label} ${option.description ?? ""} ${String(option.value)}`.toLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
  }

  private renderSelection() {
    const selection = this.selection;
    if (!selection) return;

    this.opts.writer.clearPreviousLines(selection.renderedRows);
    const matches = this.selectionMatches(selection);
    selection.index = Math.min(selection.index, Math.max(0, matches.length - 1));

    const visibleCount = Math.max(1, Math.min(10, this.opts.writer.rows - 5));
    const first = Math.min(
      Math.max(0, selection.index - Math.floor(visibleCount / 2)),
      Math.max(0, matches.length - visibleCount),
    );
    const visible = matches.slice(first, first + visibleCount);
    const count = `${matches.length}/${selection.options.length}`;

    this.opts.writer.writeln(`${BOLD}${selection.title}${RESET} ${DIM}(${count})${RESET}`);
    this.opts.writer.writeln(`${DIM}filter:${RESET} ${selection.query || `${DIM}type to search${RESET}`}`);

    if (visible.length === 0) {
      this.opts.writer.writeln(`${DIM}  No matches${RESET}`);
    } else {
      for (let offset = 0; offset < visible.length; offset++) {
        const option = visible[offset];
        const selected = first + offset === selection.index;
        const active = Object.is(option.value, selection.active);
        const lead = selected ? `${CYAN}❯${RESET}` : " ";
        const marker = active ? `${GREEN}●${RESET}` : " ";
        const description = option.description ? `  ${option.description}` : "";
        const available = Math.max(8, this.opts.writer.cols - 5);
        const plain = truncateCells(`${option.label}${description}`, available);
        this.opts.writer.writeln(`${lead} ${marker} ${selected ? BOLD : ""}${plain}${RESET}`);
      }
    }

    this.opts.writer.writeln(`${DIM}↑/↓ move  enter select  esc cancel${RESET}`);
    selection.renderedRows = 3 + Math.max(1, visible.length);
  }

  private finishSelection() {
    const selection = this.selection;
    if (!selection) return;
    const match = this.selectionMatches(selection)[selection.index];
    if (!match) return;
    this.opts.writer.clearPreviousLines(selection.renderedRows);
    this.selection = null;
    this.opts.writer.setCursorVisible(true);
    selection.resolve(match.value);
  }

  private cancelSelection() {
    const selection = this.selection;
    if (!selection) return;
    this.opts.writer.clearPreviousLines(selection.renderedRows);
    this.selection = null;
    this.opts.writer.setCursorVisible(true);
    selection.resolve(null);
  }

  private handleEscape(seq: string) {
    const commands = this.commandMatches();
    if (commands.length > 0) {
      if (seq === "[A") {
        this.commandIndex = (this.commandIndex - 1 + commands.length) % commands.length;
        this.renderCommandPopup();
        return;
      }
      if (seq === "[B") {
        this.commandIndex = (this.commandIndex + 1) % commands.length;
        this.renderCommandPopup();
        return;
      }
      if (seq === "ESC") {
        this.commandDismissed = true;
        this.hideCommandPopup();
        return;
      }
    }
    switch (seq) {
      case "[Z":
        if (!this.resolveRead) this.opts.onCycleThinking?.();
        break;
      case "[A":
        this.historyPrev();
        break;
      case "[B":
        this.historyNext();
        break;
      case "[C":
        if (this.pos < this.text.length) {
          this.pos++;
          this.redraw();
        }
        break;
      case "[D":
        if (this.pos > 0) {
          this.pos--;
          this.redraw();
        }
        break;
      case "[H":
      case "[1~":
        this.pos = 0;
        this.redraw();
        break;
      case "[F":
      case "[4~":
        this.pos = this.text.length;
        this.redraw();
        break;
      case "[3~":
        if (this.pos < this.text.length) {
          this.text = this.text.slice(0, this.pos) + this.text.slice(this.pos + 1);
          this.commandDismissed = false;
          this.commandIndex = 0;
          this.redraw();
        }
        break;
      default:
        break;
    }
  }

  private historyPrev() {
    if (this.history.length === 0 || this.resolveRead) return;
    if (this.histIdx === -1) this.histIdx = this.history.length;
    if (this.histIdx > 0) this.histIdx--;
    this.text = this.history[this.histIdx] ?? "";
    this.pos = this.text.length;
    this.redraw();
  }

  private historyNext() {
    if (this.histIdx === -1 || this.resolveRead) return;
    this.histIdx++;
    if (this.histIdx >= this.history.length) {
      this.histIdx = -1;
      this.text = "";
    } else {
      this.text = this.history[this.histIdx];
    }
    this.pos = this.text.length;
    this.redraw();
  }

  private redraw() {
    const cols = Math.max(1, this.opts.writer.cols);
    const shown = this.hidden ? "*".repeat(this.text.length) : this.text;
    const total = this.prefixVisible + shown.length;
    const rows = Math.max(1, Math.ceil(total / cols));

    let out = "";
    if (rows > 1) out += `\x1b[${rows - 1}A`;
    out += "\r";
    out += this.prefix + shown;
    out += "\x1b[J";
    const back = shown.length - this.pos;
    if (back > 0) out += `\x1b[${back}D`;
    this.opts.writer.write(out);
    this.renderCommandPopup();
  }

  private commandMatches(): readonly CommandSuggestion[] {
    if (
      this.busy ||
      this.hidden ||
      this.resolveRead ||
      this.selection ||
      this.commandDismissed ||
      !this.opts.commands ||
      !this.text.startsWith("/") ||
      /\s/.test(this.text)
    ) {
      return [];
    }
    const query = this.text.toLowerCase();
    return this.opts.commands.filter((command) => command.name.toLowerCase().startsWith(query));
  }

  private currentCommand(): CommandSuggestion | null {
    const matches = this.commandMatches();
    return matches[this.commandIndex] ?? null;
  }

  private completeCommand(): boolean {
    const command = this.currentCommand();
    if (!command) return false;
    this.text = command.name + " ";
    this.pos = this.text.length;
    this.commandDismissed = true;
    this.hideCommandPopup();
    return true;
  }

  private renderCommandPopup() {
    const menu = this.opts.commandMenu;
    if (!menu) return;
    const commands = this.commandMatches();
    if (commands.length === 0) {
      this.hideCommandPopup();
      return;
    }

    this.commandIndex = Math.min(this.commandIndex, commands.length - 1);
    const visibleCount = 8;
    const first = Math.min(
      Math.max(0, this.commandIndex - visibleCount + 1),
      Math.max(0, commands.length - visibleCount),
    );
    const matches = commands.slice(first, first + visibleCount);
    menu.replaceChildren();
    matches.forEach((command, offset) => {
      const row = document.createElement("div");
      row.className =
        `command-option${first + offset === this.commandIndex ? " selected" : ""}`;

      const name = document.createElement("span");
      name.className = "command-name";
      name.textContent = command.name;

      const description = document.createElement("span");
      description.className = "command-description";
      description.textContent = command.description;

      row.append(name, description);
      menu.append(row);
    });

    const help = document.createElement("div");
    help.className = "command-help";
    help.textContent = "↑/↓ select  enter run  tab complete  esc close";
    menu.append(help);
    menu.hidden = false;
  }

  private hideCommandPopup() {
    const menu = this.opts.commandMenu;
    if (!menu) return;
    menu.hidden = true;
    menu.replaceChildren();
  }
}

/** Render a submitted conversational prompt as a stable transcript block. */
export function formatSubmittedPrompt(value: string, columns: number): string[] {
  const cols = Math.max(1, Math.floor(columns));
  const marginWidth = cols >= 10 ? 2 : 0;
  const horizontalPadding = cols >= 10 ? 2 : 1;
  const contentWidth = Math.max(
    1,
    cols - marginWidth * 2 - horizontalPadding * 2,
  );
  const chunks = wrapCells(value, contentWidth);
  const margin = " ".repeat(marginWidth);
  const inset = " ".repeat(horizontalPadding);
  const boxWidth = Math.max(1, ...chunks.map((chunk) => stringWidth(chunk)));

  return chunks.map((chunk) => {
    const padding = " ".repeat(
      Math.max(0, boxWidth - stringWidth(chunk)),
    );
    return `${margin}${USER_PROMPT_BACKGROUND}${USER_PROMPT_TEXT}${inset}${chunk}${padding}${inset}${RESET}`;
  });
}

function wrapCells(value: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    let remaining = paragraph;
    if (!remaining) {
      lines.push("");
      continue;
    }
    while (stringWidth(remaining) > maxWidth) {
      let prefix = "";
      let prefixWidth = 0;
      let consumed = 0;
      let lastBreak = -1;
      for (const character of remaining) {
        const characterWidth = stringWidth(character);
        if (prefixWidth > 0 && prefixWidth + characterWidth > maxWidth) break;
        prefix += character;
        prefixWidth += characterWidth;
        consumed += character.length;
        if (/\s/u.test(character)) lastBreak = consumed;
      }
      const splitAt = lastBreak > 0 ? lastBreak : consumed;
      const line = remaining.slice(0, splitAt).trimEnd();
      if (!line) {
        lines.push(prefix);
        remaining = remaining.slice(consumed);
      } else {
        lines.push(line);
        remaining = remaining.slice(splitAt).trimStart();
      }
    }
    lines.push(remaining);
  }
  return lines.length > 0 ? lines : [""];
}

function truncateCells(value: string, maxWidth: number): string {
  if (stringWidth(value) <= maxWidth) return value;
  const target = Math.max(1, maxWidth - 1);
  let result = "";
  for (const character of value) {
    if (stringWidth(result + character) > target) break;
    result += character;
  }
  return result + "…";
}
