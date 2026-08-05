# Agent tools

[← README](../README.md)

All tools operate inside the browser and share `/home/web`.

| Tool | Purpose |
| --- | --- |
| `python` | Long-lived Pyodide CPython |
| `read`, `write`, `edit` | Bounded text-file operations |
| `slop` | Shell command/pipeline with Git, curl, and separate stdout/stderr |
| `compile_c`, `link_wasi`, `run_wasi` | Build and run wasm32-wasi programs |
| `compile_raylib`, `raylib` | Build and open C games in a canvas framebuffer |
| `git` | Canonical Git repositories; smart HTTP or bounded GitHub fallback |
| `fetch` | Browser fetch, subject to CORS |
| `download` | Export a file after the user asks |
| `image` | Render PNG, JPEG, GIF, or WebP in the terminal |
| `html_debug` | Check HTML errors in a hidden sandbox |
| `html` | Open a sandboxed, full-screen HTML preview |

| Image output | HTML preview |
| --- | --- |
| ![A Matplotlib image rendered in the terminal](../screens/in-terminal-pictures.png) | ![An interactive HTML preview](../screens/html-tool.png) |

## Python packages

Pyodide has no native `pip` process. Install compatible packages with:

```python
import micropip
await micropip.install("package")
```

Use `/upload` to import host files; it must be initiated by the user.

## Boundaries

- No host shell, subprocesses, sockets, or host filesystem access.
- Browser `fetch` follows CORS.
- HTML previews have no browser storage or relative `/home/web` URLs; inline assets and state.
- The wasm32 heap has a hard ceiling near 4 GiB.
- Prefer bounded reads, output, and allocations.

See [WASI](wasi.md) for compiled programs, [raylib](raylib.md) for games, and
[Slop](slop.md) for shell syntax.
