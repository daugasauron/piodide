# Development

[← README](../README.md)

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server with isolation headers |
| `npm run build` | Type-check and production build |
| `npm test` | Node test suite |
| `npm run test:fetch-toolchain` | Fetch and verify WASI test assets |
| `npm run build:slop` | Rebuild mirrored Slop sources and WASM binaries |
| `npm run check:slop` | Verify committed Slop binaries match their C sources |
| `npm run build:raylib` | Rebuild pinned raylib 6 framebuffer objects |
| `npm run check:raylib` | Verify committed raylib objects and hashes |
| `npm run chrome:webgpu` | Launch Linux Chrome with NVIDIA WebGPU flags |
| `npm run chrome:unrestricted` | Same, with CORS disabled in a dedicated profile |
| `npm run codex-proxy` | Start the optional loopback Codex bridge |
| `npm run docs:screenshots` | Capture current UI screenshots with Chrome |

## Verify

```bash
npm run test:fetch-toolchain
npm test
npm run build
```

The test suite covers local providers, proxy boundaries, the service worker,
Slop, WASI syscalls, the SAB bridge, Pyodide sharing, raylib framebuffer
rendering, and full compile-link-run cycles.

## Cross-origin isolation

`vite.config.ts` sends:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

These enable the worker/SAB execution path. GitHub Pages gets equivalent
behavior from the COI service worker.

## Screenshots

Start the current dev server, then run:

```bash
npm run docs:screenshots
```

Set `DOCS_SCREENSHOT_URL` or `CHROME_BIN` to override the defaults. The script
uses an isolated temporary Chrome profile, validates the mobile GLM login flow,
and writes to `screens/`.

Set `DOCS_GLM_API_KEY` for the optional live GLM check. Set
`DOCS_SCREENSHOT_WRITE=0` to validate without replacing screenshots, or
`DOCS_SCREENSHOT_ONLY=mobile-commands.png` to replace one image.

## GitHub Pages

`.github/workflows/pages.yml` tests and builds every push to `main`, then
deploys `dist/` to <https://daugasauron.github.io/piodide/>.
