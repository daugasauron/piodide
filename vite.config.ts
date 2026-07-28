import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Cross-origin isolation headers. These are a hard requirement for the
// Rust-in-WASM toolchain (rustc_opt.wasm), which needs SharedArrayBuffer /
// crossOriginIsolated to allocate shared memory. Without them the browser
// refuses to create a shared WebAssembly.Memory and compilation aborts.
//
// We use `credentialless` rather than `require-corp`: the app boots Pyodide
// from the jsDelivr CDN via a plain cross-origin <script>, which `require-corp`
// would block (jsDelivr sends CORS but not Cross-Origin-Resource-Policy).
// `credentialless` grants the same crossOriginIsolated=true without breaking
// that public-CDN load. See downloads/RUST_IN_BROWSER.md.
const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  base: "/piodide/",
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
  },
  optimizeDeps: {
    exclude: [
      "@monaco-neovim-wasm/lib",
      "@monaco-neovim-wasm/wasm-async",
    ],
  },
  resolve: {
    alias: {
      // markdansi's detector publishes this browser entry through the legacy
      // `browser` field, which Rolldown does not select from its exports map.
      "supports-hyperlinks": fileURLToPath(
        new URL("./node_modules/supports-hyperlinks/browser.js", import.meta.url),
      ),
    },
  },
});
