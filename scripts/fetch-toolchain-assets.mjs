/**
 * Download the runno clang/wasm-ld WASI toolchain + sysroot into
 * test/toolchain-assets/ so test/wasi-toolchain.test.ts can run offline.
 * These are the same files the app fetches at runtime from runno.dev.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "test", "toolchain-assets");
const BASE = "https://runno.dev/langs";
const FILES = ["clang.wasm", "wasm-ld.wasm", "clang-fs.tar.gz"];

mkdirSync(outDir, { recursive: true });
for (const file of FILES) {
  const url = `${BASE}/${file}`;
  console.log(`downloading ${url} …`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  writeFileSync(join(outDir, file), Buffer.from(await response.arrayBuffer()));
}
console.log("done");
