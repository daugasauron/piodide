import assert from "node:assert/strict";
import test from "node:test";
import { loadPyodide } from "pyodide";
import {
  attachPythonStreamCapture,
  type Pyodide,
} from "../src/pyodide-host.ts";
import {
  parsePythonInvocation,
  runPythonEntrypoint,
} from "../src/python-entrypoint.ts";

test("python entrypoint parses command, module, file, and stdin modes", () => {
  assert.equal(parsePythonInvocation(["python", "-c", "print(1)"], "/home/web").kind, "code");
  assert.equal(parsePythonInvocation(["/bin/python", "-m", "json.tool"], "/home/web").kind, "module");
  assert.equal(parsePythonInvocation(["python", "script.py"], "/home/web/sub").kind, "file");
  assert.equal(parsePythonInvocation(["python", "-"], "/home/web").kind, "stdin");
});

test("python entrypoint runs in shared Pyodide with argv, env, cwd, and stdin", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  attachPythonStreamCapture(py);
  py.FS.mkdirTree("/home/web/project");
  py.FS.writeFile(
    "/home/web/project/run.py",
    [
      "import os, sys",
      "print(sys.argv[1])",
      "print(os.environ['SHELL_VALUE'])",
      "print(os.getcwd())",
      "print(input())",
      "open('made.txt', 'w').write('shared')",
    ].join("\n"),
  );
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  const exitCode = await runPythonEntrypoint(py, {
    args: ["/bin/python", "run.py", "argument"],
    cwd: "/home/web/project",
    env: { SHELL_VALUE: "inherited" },
    stdin: new TextEncoder().encode("from-stdin\n"),
    stdout: (chunk) => {
      stdout += decoder.decode(chunk, { stream: true });
    },
    stderr: (chunk) => {
      stderr += decoder.decode(chunk, { stream: true });
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(stderr, "");
  assert.match(stdout, /argument\ninherited\n\/home\/web\/project\nfrom-stdin\n/);
  assert.equal(py.FS.readFile("/home/web/project/made.txt", { encoding: "utf8" }), "shared");

  const systemExit = await runPythonEntrypoint(py, {
    args: ["python", "-c", "raise SystemExit(7)"],
    cwd: "/home/web",
    stdout: () => {},
    stderr: () => {},
  });
  assert.equal(systemExit, 7);

  stdout = "";
  const versionExit = await runPythonEntrypoint(py, {
    args: ["python", "--version"],
    cwd: "/home/web",
    stdout: (chunk) => { stdout += decoder.decode(chunk, { stream: true }); },
    stderr: () => {},
  });
  assert.equal(versionExit, 0);
  assert.match(stdout, /^Python 3\.\d+\.\d+\n$/);
  assert.doesNotMatch(stdout, /0\.27\.7/);
});

test("Python entrypoint preserves NUL-delimited stdout bytes for shell sinks", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  attachPythonStreamCapture(py);
  py.FS.mkdirTree("/home/web");
  const stream = py.FS.open("/home/web/got.bin", "w");
  let stderr = "";
  const response = await runPythonEntrypoint(py, {
    args: ["python", "-c", "import sys; sys.stdout.write('a b\\0line\\nname\\0-lead\\0')"],
    cwd: "/home/web",
    stdout: (chunk) => {
      py.FS.write(stream, chunk, 0, chunk.byteLength);
    },
    stderr: (chunk) => { stderr += new TextDecoder().decode(chunk); },
  });
  py.FS.close(stream);
  assert.equal(response, 0, stderr);
  assert.deepEqual(
    py.FS.readFile("/home/web/got.bin") as Uint8Array,
    new TextEncoder().encode("a b\0line\nname\0-lead\0"),
  );
});

test("Python entrypoint flushes byte streams within one invocation", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  attachPythonStreamCapture(py);
  py.FS.mkdirTree("/home/web");
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const join = (chunks: Uint8Array[]) => {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  };
  let response = await runPythonEntrypoint(py, {
    args: [
      "python",
      "-c",
      "import sys; sys.stdout.buffer.write(bytes([65,0,255])); sys.stderr.buffer.write(bytes([69,0,254]))",
    ],
    cwd: "/home/web",
    stdout: (chunk) => stdout.push(chunk.slice()),
    stderr: (chunk) => stderr.push(chunk.slice()),
  });
  assert.equal(response, 0);
  assert.deepEqual(join(stdout), new Uint8Array([65, 0, 255]));
  assert.deepEqual(join(stderr), new Uint8Array([69, 0, 254]));

  stdout.length = 0;
  stderr.length = 0;
  response = await runPythonEntrypoint(py, {
    args: ["python", "-c", "import sys; sys.stdout.buffer.write(b'NEXT')"],
    cwd: "/home/web",
    stdout: (chunk) => stdout.push(chunk.slice()),
    stderr: (chunk) => stderr.push(chunk.slice()),
  });
  assert.equal(response, 0);
  assert.deepEqual(join(stdout), new TextEncoder().encode("NEXT"));
  assert.deepEqual(join(stderr), new Uint8Array());
});
