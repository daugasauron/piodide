# piodide

*Entirely vibe coded POC*

The idea is simple, run pi agent in the browser and replace bash with pyodide (python in wasm).

Added some extra tools (neovim, github integration), tricky part is integrating stuff with pyodide file system.

Ghostty-web terminal (also wasm).

Surprisingly powerful.

![piodide terminal](screens/startup.png)

![Images rendered in the terminal](screens/in-terminal-pictures.png)

![Closeable HTML preview](screens/html-tool.png)

## WASI

A from-scratch WASI runtime (`src/wasi/`) runs wasm32-wasi programs against
the **live** Pyodide filesystem — no copying, no snapshotting. A file written
by a WASI program is immediately visible to Python, Neovim, and the agent
tools, and vice versa.

- `host.ts` implements ~45 `wasi_snapshot_preview1` syscalls (full fd I/O
  including `pread`/`pwrite`/`readdir`, the whole `path_*` family,
  `poll_oneoff`, …) plus the legacy `wasi_unstable` (snapshot0) ABI used by
  older binaries like the runno clang. Filesystem calls go through a small
  pluggable interface.
- Two execution strategies share the host: a **worker** whose syscalls are
  bridged synchronously to the main-thread MEMFS over a SharedArrayBuffer
  (`Atomics.wait`/`waitAsync`) when the page is cross-origin isolated (dev
  server, `vite preview`) — killable and with interactive stdin — and a
  **main-thread** fallback for GitHub Pages (no headers, no
  SharedArrayBuffer), where programs still share the MEMFS directly.
- The in-browser C toolchain (clang + wasm-ld, fetched lazily from
  runno.dev) runs on the same host with a `/sys` sysroot overlay, so
  `compile_c` output lands directly in `/home/web`.

Ways to run programs:

- `/run prog.wasm [args…]` in the terminal (interactive line-buffered stdin,
  Ctrl+C kills, Ctrl+D sends EOF).
- From Python: `import wasi; result = await wasi.run_wasi("/home/web/prog.wasm", args=[...])`.
- From the agent: the `run_wasi` tool.

`node --experimental-strip-types --test "test/*.test.ts"` covers the host,
the Emscripten bridge, the SAB RPC stack, and a full
clang-compile → wasm-ld-link → run cycle (see `test/README.md`).

![WASI](screens/wasi-summary.png)

## slop — the piodide shell

Press **Ctrl+Shift+S** to toggle between the agent and `slop`, a minimal
bash-ish shell written in C (`shell/src/slop.c`) running as a WASI program
on the same live filesystem. It keeps its own cwd, and `$PATH` is exactly
`/bin`:

- `/bin/ls.wasm`, `/bin/cat.wasm`, `/bin/fd-find.wasm` — tiny C utilities
  (sources in `shell/src/`, also fetched to `/home/web/slop/`).
- `cd`, `pwd`, `exit`, `help` are shell builtins (`cd` must be: a child
  can't change its parent's cwd).
- Programs spawn through a `piodide.spawn` host import: the shell asks the
  runtime to run a sibling process, the terminal foreground switches to it,
  and the exit code comes back. Children can spawn children.
- `compile hello.c` / `link hello.o -o /bin/hello.wasm` are pseudo-commands
  routed to the in-browser clang toolchain — so you can write C, build it
  into `/bin`, and immediately run it, entirely inside the sandbox.
- Ctrl+C kills the foreground program (or cancels the line), Ctrl+D sends
  EOF (or exits the shell).

Interactive mode needs cross-origin isolation. Dev/`vite preview` send the
headers; on GitHub Pages a tiny service worker (`public/coi-serviceworker.js`)
adds them so the deployed shell works too. Without isolation everything
falls back to main-thread (non-interactive) execution.

## Quickstart

```bash
npm install
npm run dev
```

Open http://localhost:5173, then use `/provider`, `/login`, and `/model`.
Typing `/` shows the available commands. Press `Ctrl+Shift+E` to toggle Neovim
(`:Ex` browses the same `/home/web` files used by the agent and Python) and
`Ctrl+Shift+S` to toggle the slop shell.

## Agent tools

- `python` — runs Python in the shared Pyodide runtime with live output;
  pure-Python packages can be installed with `micropip`.
- `compile_c` / `link_wasi` / `run_wasi` — compile C into `.o` files, link
  objects into WASI executables, and run them against the live `/home/web`
  filesystem (see the WASI section above).
- `read` — reads text files from `/home/web` with line numbers and pagination.
- `write` — creates or replaces files in the in-browser filesystem.
- `edit` — applies exact, unique text replacements to existing files.
- `download` — saves a Pyodide file through the browser; `/upload` imports host
  files into `/home/web`.
- `git` — uses Dulwich locally; GitHub clone, pull, and push use its browser API
  (`/github` registers a page-local token).
- `fetch` — uses browser `fetch` (and its CORS rules), optionally saving the
  response to `/home/web`.
- `image` — renders a saved PNG, JPEG, GIF, or WebP directly in the terminal
  through Kitty graphics.
- `html` — opens a self-contained HTML file in a sandboxed, closeable preview.

All tools share the same temporary in-memory filesystem. API keys and GitHub
tokens stay in page memory, and refreshing the page clears the runtime and files.
