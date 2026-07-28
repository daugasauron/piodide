# WASI runtime tests

Node test-runner suites for `src/wasi/` (no browser required):

```bash
npm test
```

Uses `node --experimental-strip-types`, so the TypeScript sources are
imported directly.

## Layout

- `wasi-host.test.ts` — host + MemoryFs against real wasi-libc guests.
- `wasi-emscripten.test.ts` — the Emscripten-MEMFS adapter (the browser
  main-thread path) behind a mock with Emscripten-style errno semantics.
- `wasi-rpc.test.ts` — full worker-thread + SharedArrayBuffer bridge stack.
- `wasi-toolchain.test.ts` — end-to-end: the real `clang.wasm` /
  `wasm-ld.wasm` compile and link a multi-file C project, then the result
  executes on the host. Skipped unless the assets exist.
- `fixtures/*.wasm` — guests compiled from the sibling `.c` files with
  `zig cc -target wasm32-wasi -Oz -s` (committed, no toolchain needed).

## Rebuilding fixtures

Any wasi-sdk or Zig install works:

```bash
cd test/fixtures
for f in echo cat ls fops poll exitc; do
  zig cc -target wasm32-wasi -Oz -s -o $f.wasm $f.c
done
```

## Toolchain assets

`wasi-toolchain.test.ts` needs ~50 MB of binaries (skipped otherwise):

```bash
npm run test:fetch-toolchain
```
