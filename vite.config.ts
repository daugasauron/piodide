import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/piodide/",
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
