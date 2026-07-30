# Temporary local Codex proxy

This opt-in workaround lets piodide use the Codex allowance from a ChatGPT
subscription. The browser never receives the OpenAI OAuth access or refresh
tokens: they live only in one loopback-bound Node process and disappear when
it exits.

## Use it

From this checkout, run:

```bash
npm run codex-proxy
```

Complete the ChatGPT login in your browser. The command then prints two piodide
links and a temporary token. The easiest path is to open the appropriate link;
piodide removes the token from its address bar/history and selects
`codex-local` automatically.

When opening the GitHub Pages link, your browser may ask whether that site can
connect to services on your local device. Allow it so the page can reach the
loopback-only proxy.

When using the local Vite link in Firefox after an older piodide build, the
page may reload once to remove its obsolete cross-origin-isolation service
worker. Vite already sends the required isolation headers; subsequent Codex
streams and Slop workers connect directly without that worker in the middle.

Alternatively, in an already-open piodide page:

1. Run `/provider codex-local`.
2. Run `/login`.
3. Paste the temporary token printed by the proxy.

Use `/model` if you want a model other than the default `gpt-5.6-sol`.

The proxy binds only to `127.0.0.1:1456`, accepts only explicitly allowed
browser origins, relays only `/codex/responses`, and replaces the browser's
local capability with the in-memory OAuth credential. Stop it with Ctrl-C or
run `/logout` in piodide. You must log in again on the next start because this
workaround intentionally persists nothing.

For device-code login instead of the localhost OAuth callback:

```bash
CODEX_PROXY_DEVICE_AUTH=1 npm run codex-proxy
```

To use a different piodide origin, provide a comma-separated exact-origin
allowlist (origins do not contain paths):

```bash
PIODIDE_ORIGINS=https://example.test,http://localhost:5173 npm run codex-proxy
```

## Remove it

This integration is intentionally isolated and marked `TEMPORARY`. Remove:

1. `scripts/local-codex-proxy.mjs` and `scripts/local-codex-proxy.d.mts`
2. `test/local-codex-proxy.test.ts`
3. this file
4. the `codex-proxy` script from `package.json`
5. the `codex-local` provider and API-kind line from `src/providers.ts`
6. the `openai-codex-responses` dispatch in `src/stream.ts`
7. blocks marked `TEMPORARY` in `src/main.ts`

No database, credential file, service, global package, or operating-system
configuration is created by the proxy.

## Security scope

This is a personal, temporary development bridge—not a production service.
Do not bind it to `0.0.0.0`, commit a printed capability, or share a launch
URL. Although the printed capability is not an OpenAI credential, anyone who
has it while the proxy is running can spend your Codex allowance through the
single fixed relay endpoint.
