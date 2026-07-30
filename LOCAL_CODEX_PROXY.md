# Local Codex subscription proxy

This opt-in local bridge lets Piodide use the Codex allowance from a ChatGPT
subscription. The browser never receives the OpenAI OAuth access or refresh
tokens: they remain in one loopback-bound Node process and disappear when it
exits. This is a personal development integration, not a hosted proxy. It uses
Codex's ChatGPT backend through `pi-ai`; it is not a documented public OpenAI
API integration and may change without notice.

## Use it

Start the Piodide development server:

```bash
npm run dev
```

Then, in another terminal, start the proxy:

```bash
npm run codex-proxy
```

On Linux, the proxy opens ChatGPT authorization in Chrome when it is installed,
so an already-running `npm run chrome:webgpu` instance keeps its GPU flags. It
falls back to the system browser when Chrome is unavailable. After login, it
opens Piodide and connects it automatically. There is no token to copy: the
proxy passes a process-local capability through a URL fragment, and Piodide
immediately removes it from the address bar and history.

In an already-open Piodide page, select `/provider codex-local` and run
`/login`. Piodide checks that the proxy is available and reconnects through
the same local handoff.

When using the local Vite link in Firefox after an older piodide build, the
page may reload once to remove its obsolete cross-origin-isolation service
worker. Vite already sends the required isolation headers; subsequent Codex
streams and Slop workers connect directly without that worker in the middle.

Use `/model` if you want a model other than the default `gpt-5.6-sol`.

The proxy binds only to `127.0.0.1:1456`, accepts only explicitly allowed
browser origins, relays only `/codex/responses`, and replaces the browser's
local capability with the in-memory OAuth credential. Stop it with Ctrl-C or
run `/logout` in piodide. You must log in again on the next start because this
bridge intentionally persists nothing.

For device-code login instead of the localhost OAuth callback:

```bash
CODEX_PROXY_DEVICE_AUTH=1 npm run codex-proxy
```

The default app URL is `http://localhost:5173/piodide/`. To open the GitHub
Pages build instead:

```bash
PIODIDE_URL=https://daugasauron.github.io/piodide/ npm run codex-proxy
```

Your browser may ask whether the Pages site can connect to services on your
local device. Allow it so the page can reach the loopback-only proxy.

To use a different Piodide deployment, set its complete URL and include its
exact origin in the allowlist:

```bash
PIODIDE_URL=https://example.test/piodide/ \
PIODIDE_ORIGINS=https://example.test \
npm run codex-proxy
```

For a terminal-only environment, disable automatic browser opening. The
command prints ordinary authorization and `/connect` links, never the
capability itself:

```bash
CODEX_PROXY_NO_OPEN=1 npm run codex-proxy
```

To choose a different browser executable:

```bash
CODEX_PROXY_BROWSER=firefox npm run codex-proxy
```

No database, credential file, service, global package, or operating-system
configuration is created by the proxy.

## Security scope

Do not bind the proxy to `0.0.0.0`. It accepts browser requests only from exact
allowed origins, relays only the fixed Codex responses endpoint, and replaces
the browser's process-local capability with the in-memory OAuth credential.
The `/connect` redirect is fixed to the configured, allowlisted Piodide URL.
