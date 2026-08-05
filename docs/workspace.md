# Workspace

[← README](../README.md)

`/home/web` is one Pyodide MEMFS shared by every tool and view.

```mermaid
flowchart TB
  FS[("/home/web")]
  Agent["Agent file tools"] <--> FS
  Python <--> FS
  Git["Git · libgit2 Wasm"] <--> FS
  Neovim <--> FS
  Slop["Slop + WASI programs"] <--> FS
  Upload["Upload / download"] <--> FS
```

![Neovim editing the shared Piodide workspace](../screens/neovim.png)

## Neovim

- Toggle with `Ctrl+Shift+E` or `/nvim`.
- `:Ex` browses the Pyodide filesystem.
- Buffers sync when switching views.
- Set `VITE_ENABLE_NEOVIM=0` at build time to omit it.

## Host files

| Command | Direction |
| --- | --- |
| `/upload [directory]` | Host → `/home/web` |
| `/download <path>` | `/home/web` → browser download |

The agent can call `download` only after the user asks for a file.

## GitHub

The compiled `git` frontend stores standard repositories in `/home/web`.
Browser smart HTTP works with CORS-enabled servers or a user-supplied trusted
proxy. `/github` registers a page-memory token for the direct GitHub snapshot
fallback and pushes.

## Lifetime

| State | Storage |
| --- | --- |
| Workspace, sessions, API keys, GitHub token | Page memory; cleared on refresh |
| Downloaded local models | Browser cache / OPFS |
| Codex OAuth credentials | Optional loopback proxy process only |
