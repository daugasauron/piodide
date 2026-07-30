# Development

[← README](../README.md)

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server with isolation headers |
| `npm run build` | Type-check and production build |
| `npm test` | Node test suite |
| `npm run test:fetch-toolchain` | Fetch and verify WASI test assets |
| `npm run chrome:webgpu` | Launch Linux Chrome with NVIDIA WebGPU flags |
| `npm run codex-proxy` | Start the optional loopback Codex bridge |
| `npm run docs:screenshots` | Capture current UI screenshots with Chrome |

## Verify

```bash
npm run test:fetch-toolchain
npm test
npm run build
```

The test suite covers local providers, proxy boundaries, the service worker,
Slop, WASI syscalls, the SAB bridge, Pyodide sharing, and a full
compile-link-run cycle.

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

## GitHub Pages

`.github/workflows/pages.yml` tests and builds every push to `main`, then
deploys `dist/` to <https://daugasauron.github.io/piodide/>.
