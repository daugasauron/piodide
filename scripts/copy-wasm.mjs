// Copies ghostty-web's WASM into Vite's public/ so it is served at the site
// root (/ghostty-vt.wasm), which is one of ghostty-web's runtime fallback URLs.
import { cpSync, existsSync, mkdirSync } from "node:fs";

const SRC = "node_modules/ghostty-web/ghostty-vt.wasm";
const DEST_DIR = "public";
const DEST = `${DEST_DIR}/ghostty-vt.wasm`;

if (!existsSync(SRC)) {
  console.warn(`[copy-wasm] source not found: ${SRC} — skipping`);
  process.exit(0);
}
mkdirSync(DEST_DIR, { recursive: true });
cpSync(SRC, DEST);
console.log(`[copy-wasm] ${SRC} -> ${DEST}`);
