/**
 * Download the runno clang/wasm-ld WASI toolchain + sysroot into
 * test/toolchain-assets/ so test/wasi-toolchain.test.ts can run offline.
 * These are the same files the app fetches at runtime from runno.dev.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "test", "toolchain-assets");
const BASE = "https://runno.dev/langs";
const FILES = ["clang.wasm", "wasm-ld.wasm", "clang-fs.tar.gz"];
const SHA256 = {
  "clang.wasm": "2a466f0e990329d3230b869d04fc20803eae96a7feb3a3f6c93e25a77b8aed1d",
  "wasm-ld.wasm": "36419ed202011765222098d7701218378b67f634d50f0a4625059ae2c9860f48",
  "clang-fs.tar.gz": "7ed12063619882e4dfa710ab371fc91848b256f85a4075747e8bd5c167902b50",
};

mkdirSync(outDir, { recursive: true });
for (const file of FILES) {
  const url = `${BASE}/${file}`;
  console.log(`downloading ${url} …`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== SHA256[file]) {
    throw new Error(`SHA-256 mismatch for ${file}: expected ${SHA256[file]}, received ${actual}`);
  }
  writeFileSync(join(outDir, file), bytes);
}
console.log("done");
