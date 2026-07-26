# piodide

*Entirely vibe coded POC*

The idea is simple, run pi agent in the browser and replace bash with pyodide (python in wasm).

Added some extra tools (neovim, github integration), tricky part is integrating stuff with pyodide file system.

Ghostty-web terminal (also wasm).

Surprisingly powerful.

![piodide terminal](screens/startup.png)

![Images rendered in the terminal](screens/in-terminal-pictures.png)

![Closeable HTML preview](screens/html-tool.png)

## Quickstart

```bash
npm install
npm run dev
```

Open http://localhost:5173, then use `/provider`, `/login`, and `/model`.
Typing `/` shows the available commands. Press `Ctrl+Shift+E` to toggle Neovim;
`:Ex` browses the same `/home/web` files used by the agent and Python.

## Agent tools

- `python` — runs Python in the shared Pyodide runtime with live output;
  pure-Python packages can be installed with `micropip`.
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
