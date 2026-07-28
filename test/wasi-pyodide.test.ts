/**
 * Integration test against REAL Pyodide (npm package, Node): the
 * EmscriptenFs bridge runs guests on the actual MEMFS that Python uses, and
 * the installed `wasi` Python module runs programs from Python itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EmscriptenFs } from "../src/wasi/emscripten-fs.ts";
import { executeWasi } from "../src/wasi/runner.ts";
import { installWasiPythonModule, type WasiRunJs } from "../src/wasi/python-module.ts";
import { fixtureBinary } from "./helpers.ts";

interface PyodideLike {
  runPython(code: string): unknown;
  runPythonAsync(code: string): Promise<unknown>;
  registerJsModule(name: string, module: Record<string, unknown>): void;
  FS: ConstructorParameters<typeof EmscriptenFs>[0] & {
    writeFile(path: string, data: string | Uint8Array): void;
    mkdirTree(path: string): void;
  };
}

async function loadRealPyodide(): Promise<PyodideLike> {
  const { loadPyodide } = await import("pyodide");
  const py = await loadPyodide();
  py.FS.mkdirTree("/home/web");
  return py as unknown as PyodideLike;
}

async function runOnPyodide(
  py: PyodideLike,
  name: string,
  args: string[],
  stdinText = "",
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  let stdinSent = stdinText.length === 0;
  const result = await executeWasi({
    binary: fixtureBinary(name),
    args,
    env: {},
    fs: new EmscriptenFs(py.FS),
    preopens: ["/home/web", "/"],
    stdin: () => {
      if (stdinSent) return null;
      stdinSent = true;
      return new TextEncoder().encode(stdinText);
    },
    stdout: (chunk) => {
      stdout += decoder.decode(chunk, { stream: true });
    },
    stderr: (chunk) => {
      stderr += decoder.decode(chunk, { stream: true });
    },
  });
  return { exitCode: result.exitCode, stdout, stderr };
}

test("pyodide: WASI guest and Python share the live MEMFS", { timeout: 120_000 }, async () => {
  const py = await loadRealPyodide();
  py.FS.writeFile("/home/web/from-python.txt", "written by python\n");

  const cat = await runOnPyodide(py, "cat.wasm", ["cat.wasm", "/home/web/from-python.txt"]);
  assert.equal(cat.exitCode, 0);
  assert.equal(cat.stdout, "written by python\n");

  // The fops fixture creates/renames/links/unlinks inside /home/web/fops.
  const fops = await runOnPyodide(py, "fops.wasm", ["fops.wasm"]);
  assert.equal(fops.exitCode, 0);
  assert.match(fops.stdout, /rmdir: ok\n/);
  // Real MEMFS has no hard links: the bridge must surface ENOTSUP (and the
  // dependent ops then fail cleanly), not corrupt anything else.
  assert.match(fops.stdout, /link: Not supported\n/);
  const failures = fops.stdout
    .split("\n")
    .filter((line) =>
      /: (No such|Bad file|Is a directory|Not a directory|File exists|Not supported|Invalid|Permission|Too many|Directory not empty|Illegal)/.test(line),
    )
    .filter(
      (line) =>
        !line.startsWith("rmdir-missing") &&
        !line.startsWith("link: ") &&
        !line.startsWith("stat-hard: ") &&
        !line.startsWith("unlink-hard: "),
    );
  assert.deepEqual(failures, [], fops.stdout);

  // Python immediately sees the guest's remaining effects (fops cleans up).
  const leftover = py.runPython("import os; os.path.exists('/home/web/fops')");
  assert.equal(leftover, false);
});

test("pyodide: `import wasi` runs programs from Python", { timeout: 120_000 }, async () => {
  const py = await loadRealPyodide();

  // Runner that maps /home/web/*.wasm paths back to the committed fixtures.
  const fixtureRun: WasiRunJs = (path, options) => {
    const name = path.replace(/^\/home\/web\//, "");
    return runOnPyodide(py, name, [path, ...(options?.args ?? [])], options?.stdin ?? "");
  };
  installWasiPythonModule(py as never, fixtureRun);

  // "Upload" the fixture into the MEMFS like a user program would be.
  py.FS.writeFile("/home/web/cat.wasm", fixtureBinary("cat.wasm"));
  py.FS.writeFile("/home/web/input.txt", "python <-> wasi bridge\n");

  const result = (await py.runPythonAsync(`
import wasi
await wasi.run_wasi("/home/web/cat.wasm", args=["/home/web/input.txt"])
`)) as { exitCode: number; stdout: string; stderr: string };

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "python <-> wasi bridge\n");
  assert.equal(result.stderr, "");
});
