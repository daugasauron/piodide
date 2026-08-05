import type { Pyodide } from "./pyodide-host.ts";
import { createPyodideGitFs } from "./libgit2-fs.ts";

interface Engine {
  module: Awaited<ReturnType<typeof import("wasm-git/lg2.js")["default"]>>;
  filesystem: ReturnType<typeof createPyodideGitFs>;
  stdout: string[];
  stderr: string[];
}

const engines = new WeakMap<object, Promise<Engine>>();

async function createEngine(py: Pyodide): Promise<Engine> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const { default: initGit } = await import("wasm-git/lg2.js");
  const options: Parameters<typeof initGit>[0] = {
    print: (value) => stdout.push(`${value}\n`),
    printErr: (value) => stderr.push(`${value}\n`),
  };
  if (typeof window !== "undefined") {
    const { default: wasmUrl } = await import("wasm-git/lg2.wasm?url");
    options.locateFile = (path) => path.endsWith(".wasm") ? wasmUrl : path;
  }
  const module = await initGit(options);
  module.FS.mkdirTree("/home/web_user");
  module.FS.mkdirTree("/workspace");
  const filesystem = createPyodideGitFs(module, py);
  module.FS.mount(filesystem, { root: "/home/web" }, "/workspace");
  return { module, filesystem, stdout, stderr };
}

async function engineFor(py: Pyodide): Promise<Engine> {
  let ready = engines.get(py as object);
  if (!ready) {
    ready = createEngine(py);
    engines.set(py as object, ready);
  }
  return ready;
}

export interface Libgit2Result {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runLibgit2(
  py: Pyodide,
  args: string[],
  cwd: string,
  identity = { name: "Piodide", email: "piodide@browser.local" },
): Promise<Libgit2Result> {
  const engine = await engineFor(py);
  const { module, filesystem, stdout, stderr } = engine;
  stdout.length = 0;
  stderr.length = 0;
  // Pyodide and libgit2 share file contents directly. Remounting clears
  // Emscripten's node-name cache so edits made by either runtime are visible.
  module.FS.chdir("/");
  module.FS.unmount("/workspace");
  module.FS.mount(filesystem, { root: "/home/web" }, "/workspace");
  module.FS.writeFile(
    "/home/web_user/.gitconfig",
    `[user]\n\tname = ${identity.name.replace(/[\r\n]/g, " ")}\n` +
      `\temail = ${identity.email.replace(/[\r\n]/g, " ")}\n`,
  );
  const relative = cwd === "/home/web" ? "" : cwd.slice("/home/web/".length);
  module.FS.chdir(relative ? `/workspace/${relative}` : "/workspace");
  let exitCode = 1;
  try {
    exitCode = module.callMain([...args]);
  } catch (error) {
    stderr.push(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}
