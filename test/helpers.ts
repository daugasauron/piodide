/**
 * Shared test helpers: load committed wasm fixtures and run them against a
 * MemoryFs with captured output. Fixtures are compiled from the sibling .c
 * files with `zig cc -target wasm32-wasi -Oz -s` (see test/README.md).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MemoryFs } from "../src/wasi/memory-fs.ts";
import { executeWasi } from "../src/wasi/runner.ts";
import type { WasiHostOptions } from "../src/wasi/host.ts";

const here = dirname(fileURLToPath(import.meta.url));

export function fixtureBinary(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(here, "fixtures", name)));
}

export interface CapturedRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  fs: MemoryFs;
}

export interface RunOptions extends Partial<WasiHostOptions> {
  args?: string[];
  stdinText?: string;
}

export async function runFixture(name: string, options: RunOptions = {}): Promise<CapturedRun> {
  const fs = new MemoryFs();
  return runFixtureOn(fs, name, options);
}

export async function runFixtureOn(
  fs: MemoryFs,
  name: string,
  options: RunOptions = {},
): Promise<CapturedRun> {
  if (!fs.exists("/home/web")) fs.mkdirTree("/home/web");
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  const stdinText = options.stdinText ?? "";
  let stdinSent = stdinText.length === 0;

  const result = await executeWasi({
    binary: fixtureBinary(name),
    args: options.args ?? [name],
    env: options.env ?? {},
    fs: options.fs ?? fs,
    preopens: options.preopens ?? ["/home/web", "/"],
    stdin:
      options.stdin ??
      (() => {
        if (stdinSent) return null;
        stdinSent = true;
        return new TextEncoder().encode(stdinText);
      }),
    stdout: options.stdout ?? ((chunk) => {
      stdout += decoder.decode(chunk, { stream: true });
    }),
    stderr: options.stderr ?? ((chunk) => {
      stderr += decoder.decode(chunk, { stream: true });
    }),
    ...spreadOverrides(options),
  });
  return { exitCode: result.exitCode, stdout, stderr, fs };
}

function spreadOverrides(options: RunOptions): Partial<WasiHostOptions> {
  const overrides: Partial<WasiHostOptions> = {};
  if (options.realtimeNs) overrides.realtimeNs = options.realtimeNs;
  if (options.monotonicNs) overrides.monotonicNs = options.monotonicNs;
  if (options.random) overrides.random = options.random;
  if (options.sleepSync) overrides.sleepSync = options.sleepSync;
  return overrides;
}
