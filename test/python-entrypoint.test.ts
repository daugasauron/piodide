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
  const exitCode = await runPythonEntrypoint(py, {
    args: ["/bin/python", "run.py", "argument"],
    cwd: "/home/web/project",
    env: { SHELL_VALUE: "inherited" },
    stdin: new TextEncoder().encode("from-stdin\n"),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
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
});
