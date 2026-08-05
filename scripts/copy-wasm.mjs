// Copies ghostty-web's WASM into Vite's public/ so it is served at the site
// root (/ghostty-vt.wasm), which is one of ghostty-web's runtime fallback URLs.
import { cpSync, existsSync, mkdirSync } from "node:fs";

const DEST_DIR = "public";
const files = [
  ["node_modules/ghostty-web/ghostty-vt.wasm", "ghostty-vt.wasm"],
  ["node_modules/wasm-git/COPYING", "wasm-git-COPYING.txt"],
  ["node_modules/isomorphic-git/LICENSE.md", "isomorphic-git-LICENSE.txt"],
];

mkdirSync(DEST_DIR, { recursive: true });
for (const [source, name] of files) {
  if (!existsSync(source)) {
    console.warn(`[copy-wasm] source not found: ${source} — skipping`);
    continue;
  }
  const destination = `${DEST_DIR}/${name}`;
  cpSync(source, destination);
  console.log(`[copy-wasm] ${source} -> ${destination}`);
}
