/**
 * slop — the piodide shell session.
 *
 * Owns one long-running /bin/slop.wasm process plus every child it spawns,
 * and routes ghostty keystrokes to whichever is in the foreground (canonical
 * line mode with echo, like /run). Children are regular WASI programs found
 * on $PATH (/bin); the "compile"/"link" pseudo-commands are intercepted
 * here and routed to the in-browser clang toolchain, so users can build new
 * commands straight into /bin and run them.
 */
import type { Pyodide } from "./pyodide-host.ts";
import { fsExists } from "./pyodide-host.ts";
import {
  startWasiProgram,
  type WasiProgramHandle,
} from "./wasi/browser-runner.ts";
import { runToolchainInBrowser } from "./c-compiler.ts";
import { normalizePath } from "./wasi/abi.ts";

const SHELL_BINARIES = ["slop", "ls", "cat", "fd-find", "echo", "env", "grep"];
const SHELL_SOURCES = ["slop.c", "ls.c", "cat.c", "fd-find.c", "echo.c", "env.c", "grep.c"];
const SHELL_PREOPENS = ["/home/web", "/", "/bin"];
const MAX_CHILDREN = 32;

/**
 * One shared input buffer for the session, like a tty: input typed while a
 * child runs is consumed by whatever reads next (the child, or the shell
 * after the child exits). A null marker is a one-shot EOF for the next
 * reader only (unlike StdinQueue's permanent EOF state).
 */
class SharedInput {
  private queue: (Uint8Array | null)[] = [];
  private waiting: ((item: Uint8Array | null) => void)[] = [];

  push(item: Uint8Array | null): void {
    if (item !== null && item.byteLength === 0) return;
    if (this.waiting.length > 0) this.waiting.shift()!(item);
    else this.queue.push(item);
  }

  next(): Promise<Uint8Array | null> | Uint8Array | null {
    const queued = this.queue.shift();
    if (queued !== undefined) return queued;
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

export interface SlopSessionDeps {
  py: Pyodide;
  writeOut: (text: string) => void;
  note: (text: string) => void;
  onExit: () => void;
}

export class SlopSession {
  private deps: SlopSessionDeps;
  private slop: WasiProgramHandle | null = null;
  private foreground: WasiProgramHandle | null = null;
  private line = "";
  private installed = false;
  private activeChildren = 0;
  /** The session's shared tty-style input buffer. */
  private input = new SharedInput();

  constructor(deps: SlopSessionDeps) {
    this.deps = deps;
  }

  get alive(): boolean {
    return this.slop !== null;
  }

  async start(): Promise<void> {
    if (this.slop) return;
    if (!this.installed) await this.install();
    const handle = startWasiProgram(this.deps.py, {
      executablePath: "/bin/slop",
      env: { PATH: "/bin", PWD: "/home/web", TERM: "ghostty" },
      preopens: SHELL_PREOPENS,
      interactiveStdin: true,
      stdinProvider: () => this.input.next(),
      timeoutMs: 0,
      spawnHandler: (request) => this.onSpawn(request),
      onStdout: this.deps.writeOut,
      onStderr: this.deps.writeOut,
    });
    this.slop = handle;
    this.line = "";
    handle.result
      .catch(() => ({ exitCode: -1 }))
      .then(({ exitCode }) => {
        if (this.slop === handle) {
          this.slop = null;
          this.deps.note(`  slop exited (${exitCode}) — Ctrl+Shift+S to restart`);
          this.deps.onExit();
        }
      });
  }

  /** Stop the shell and any foreground child. */
  stop(): void {
    this.foreground?.kill();
    this.slop?.kill();
    this.slop = null;
    this.foreground = null;
  }

  /** Terminal input while the shell view is active (canonical line mode). */
  feed(data: string): void {
    const encoder = new TextEncoder();
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        this.deps.writeOut("\r\n");
        this.push(encoder.encode(`${this.line}\n`));
        this.line = "";
      } else if (ch === "\x7f" || ch === "\b") {
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.deps.writeOut("\b \b");
        }
      } else if (ch === "\x03") {
        // Ctrl+C: kill the foreground child, or cancel the line at the prompt.
        this.deps.writeOut("^C\r\n");
        if (this.foreground) this.foreground.kill();
        else {
          this.line = "";
          this.input.push(encoder.encode("\n"));
        }
        return;
      } else if (ch === "\x04") {
        // Ctrl+D: an EOF marker for whoever reads next (child, or the shell
        // at its prompt, which exits on EOF).
        if (this.line.length > 0) {
          this.input.push(encoder.encode(this.line));
          this.line = "";
        } else {
          this.input.push(null);
        }
      } else if (ch >= " ") {
        this.line += ch;
        this.deps.writeOut(ch);
      }
    }
  }

  private push(chunk: Uint8Array): void {
    this.input.push(chunk);
  }

  /* ------------------------------ spawning ------------------------------ */

  private async onSpawn(request: { path: string; args: string[]; cwd: string }): Promise<number> {
    const { path, args, cwd } = request;
    if (path === "compile") return this.toolchainCompile(args.slice(1), cwd);
    if (path === "link") return this.toolchainLink(args.slice(1), cwd);

    if (this.activeChildren >= MAX_CHILDREN) {
      this.deps.writeOut(`slop: too many nested programs\r\n`);
      return 126;
    }
    this.activeChildren++;
    const handle = startWasiProgram(this.deps.py, {
      executablePath: path,
      args: args.slice(1),
      env: { PATH: "/bin", PWD: cwd, TERM: "ghostty" },
      preopens: SHELL_PREOPENS,
      interactiveStdin: true,
      stdinProvider: () => this.input.next(),
      timeoutMs: 0,
      spawnHandler: (nested) => this.onSpawn(nested),
      onStdout: this.deps.writeOut,
      onStderr: this.deps.writeOut,
    });
    this.foreground = handle;
    try {
      const result = await handle.result;
      return result.exitCode;
    } catch {
      return 130; // SIGINT-style: killed (Ctrl+C) or crashed
    } finally {
      this.foreground = null;
      this.activeChildren--;
    }
  }

  /* ---------------------- compile / link pseudo-commands ----------------- */

  private resolveInCwd(path: string, cwd: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    return normalizePath(`${cwd}/${path}`);
  }

  private async toolchainCompile(args: string[], cwd: string): Promise<number> {
    const positional: string[] = [];
    let output: string | null = null;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-o" && i + 1 < args.length) output = args[++i];
      else positional.push(args[i]);
    }
    if (positional.length !== 1) {
      this.deps.writeOut("usage: compile <file.c> [-o out.o]\r\n");
      return 2;
    }
    const sourcePath = this.resolveInCwd(positional[0], cwd);
    const defaultOut = sourcePath.toLowerCase().endsWith(".c")
      ? `${sourcePath.slice(0, -2)}.o`
      : `${sourcePath}.o`;
    const outputPath = output ? this.resolveInCwd(output, cwd) : defaultOut;
    this.deps.note(`  compiling ${sourcePath} …`);
    try {
      const result = await runToolchainInBrowser(
        this.deps.py,
        { operation: "compile", sourcePath, outputPath },
      );
      if (result.diagnostics) this.deps.writeOut(result.diagnostics.replaceAll("\n", "\r\n"));
      return 0;
    } catch (error) {
      this.deps.writeOut(
        `compile: ${error instanceof Error ? error.message : String(error)}\r\n`.replaceAll("\n", "\r\n"),
      );
      return 1;
    }
  }

  private async toolchainLink(args: string[], cwd: string): Promise<number> {
    const objects: string[] = [];
    let output: string | null = null;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-o" && i + 1 < args.length) output = args[++i];
      else objects.push(args[i]);
    }
    if (objects.length === 0 || !output) {
      this.deps.writeOut("usage: link <a.o b.o ...> -o <out.wasm>\r\n");
      return 2;
    }
    const objectPaths = objects.map((object) => this.resolveInCwd(object, cwd));
    const outputPath = this.resolveInCwd(output, cwd);
    this.deps.note(`  linking ${outputPath} …`);
    try {
      const result = await runToolchainInBrowser(
        this.deps.py,
        { operation: "link", objectPaths, outputPath },
      );
      if (result.diagnostics) this.deps.writeOut(result.diagnostics.replaceAll("\n", "\r\n"));
      return 0;
    } catch (error) {
      this.deps.writeOut(
        `link: ${error instanceof Error ? error.message : String(error)}\r\n`.replaceAll("\n", "\r\n"),
      );
      return 1;
    }
  }

  /* ------------------------------ install ------------------------------- */

  /** Fetch the committed shell binaries + sources into the MEMFS once. */
  private async install(): Promise<void> {
    const py = this.deps.py;
    if (fsExists(py, "/bin/slop")) {
      this.installed = true;
      return;
    }
    this.deps.note("  installing slop into /bin …");
    const base = import.meta.env.BASE_URL;
    py.FS.mkdirTree("/bin");
    py.FS.mkdirTree("/home/web/slop");
    for (const name of SHELL_BINARIES) {
      const response = await fetch(`${base}slop/bin/${name}`);
      if (!response.ok) throw new Error(`could not fetch ${name} (HTTP ${response.status})`);
      py.FS.writeFile(`/bin/${name}`, new Uint8Array(await response.arrayBuffer()));
    }
    try {
      for (const name of SHELL_SOURCES) {
        const response = await fetch(`${base}slop/src/${name}`);
        if (response.ok) py.FS.writeFile(`/home/web/slop/${name}`, await response.text());
      }
    } catch {
      // Sources are a convenience, not a requirement.
    }
    this.installed = true;
  }
}
