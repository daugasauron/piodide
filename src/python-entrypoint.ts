import {
  fsExists,
  fsIsDir,
  fsReadText,
  type Pyodide,
  runPythonWithStreams,
} from "./pyodide-host.ts";
import { normalizePath } from "./wasi/abi.ts";

const MAX_PYTHON_SOURCE_BYTES = 2 * 1024 * 1024;

export interface PythonEntrypointRequest {
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: Uint8Array;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

type PythonInvocation =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string }
  | { kind: "code"; source: string; argv: string[]; filename: string; path0: string }
  | { kind: "file"; path: string; argv: string[]; filename: string; path0: string }
  | { kind: "stdin"; argv: string[]; filename: string; path0: string }
  | { kind: "module"; module: string; argv: string[]; filename: string; path0: string };

export function parsePythonInvocation(args: string[], cwd: string): PythonInvocation {
  const rest = args.slice(1);
  let index = 0;
  while (["-B", "-E", "-I", "-u"].includes(rest[index] ?? "")) index++;
  const option = rest[index];
  if (option === "--") index++;
  const first = rest[index];
  if (first === "-h" || first === "--help") return { kind: "help" };
  if (first === "-V" || first === "--version") return { kind: "version" };
  if (first === "-c") {
    if (index + 1 >= rest.length) return { kind: "error", message: "argument expected for -c" };
    return {
      kind: "code",
      source: rest[index + 1],
      argv: ["-c", ...rest.slice(index + 2)],
      filename: "<string>",
      path0: cwd,
    };
  }
  if (first === "-m") {
    if (index + 1 >= rest.length) return { kind: "error", message: "argument expected for -m" };
    const module = rest[index + 1];
    return {
      kind: "module",
      module,
      argv: [module, ...rest.slice(index + 2)],
      filename: module,
      path0: cwd,
    };
  }
  if (first === "-") {
    return {
      kind: "stdin",
      argv: ["-", ...rest.slice(index + 1)],
      filename: "<stdin>",
      path0: cwd,
    };
  }
  if (!first) return { kind: "error", message: "interactive mode is unavailable" };
  if (first.startsWith("-")) return { kind: "error", message: "unsupported option: " + first };
  const path = normalizePath(first.startsWith("/") ? first : cwd + "/" + first);
  const slash = path.lastIndexOf("/");
  return {
    kind: "file",
    path,
    argv: [path, ...rest.slice(index + 1)],
    filename: path,
    path0: slash > 0 ? path.slice(0, slash) : "/",
  };
}

function usage(): string {
  return (
    "usage: python [-B|-E|-I|-u] (-c code | -m module | script.py | -) [args ...]\n" +
    "       interactive mode is not available inside Slop\n"
  );
}

function pythonProgram(
  invocation: Exclude<PythonInvocation, { kind: "help" | "version" | "error" | "file" }>,
  source: string,
  stdin: string,
  cwd: string,
  env: Record<string, string>,
): string {
  const isModule = invocation.kind === "module";
  return [
    "import io as _p_io, os as _p_os, runpy as _p_runpy, sys as _p_sys, traceback as _p_traceback",
    "_p_source = " + JSON.stringify(source),
    "_p_stdin_text = " + JSON.stringify(stdin),
    "_p_cwd = " + JSON.stringify(cwd),
    "_p_env = " + JSON.stringify(env),
    "_p_argv = " + JSON.stringify(invocation.argv),
    "_p_filename = " + JSON.stringify(invocation.filename),
    "_p_path0 = " + JSON.stringify(invocation.path0),
    "_p_module = " + JSON.stringify(isModule ? invocation.module : ""),
    "_p_old_argv = _p_sys.argv",
    "_p_old_stdin = _p_sys.stdin",
    "_p_old_path = list(_p_sys.path)",
    "_p_old_cwd = _p_os.getcwd()",
    "_p_old_env = dict(_p_os.environ)",
    "_p_exit_code = 0",
    "try:",
    "    _p_os.chdir(_p_cwd)",
    "    _p_os.environ.update(_p_env)",
    "    _p_sys.argv = _p_argv",
    "    _p_sys.stdin = _p_io.StringIO(_p_stdin_text)",
    "    _p_sys.path.insert(0, _p_path0)",
    "    try:",
    "        if _p_module:",
    "            _p_runpy.run_module(_p_module, run_name='__main__', alter_sys=True)",
    "        else:",
    "            _p_globals = {'__name__': '__main__', '__package__': None, '__builtins__': __builtins__}",
    "            if _p_filename not in ('<string>', '<stdin>'):",
    "                _p_globals['__file__'] = _p_filename",
    "            exec(compile(_p_source, _p_filename, 'exec'), _p_globals)",
    "    except SystemExit as _p_system_exit:",
    "        if _p_system_exit.code is None:",
    "            _p_exit_code = 0",
    "        elif isinstance(_p_system_exit.code, int):",
    "            _p_exit_code = _p_system_exit.code & 255",
    "        else:",
    "            print(_p_system_exit.code, file=_p_sys.stderr)",
    "            _p_exit_code = 1",
    "    except BaseException:",
    "        _p_traceback.print_exc()",
    "        _p_exit_code = 1",
    "finally:",
    "    _p_sys.argv = _p_old_argv",
    "    _p_sys.stdin = _p_old_stdin",
    "    _p_sys.path[:] = _p_old_path",
    "    _p_os.environ.clear()",
    "    _p_os.environ.update(_p_old_env)",
    "    _p_os.chdir(_p_old_cwd)",
    "_p_exit_code",
  ].join("\n");
}

export async function runPythonEntrypoint(
  py: Pyodide,
  request: PythonEntrypointRequest,
): Promise<number> {
  const invocation = parsePythonInvocation(request.args, request.cwd);
  if (invocation.kind === "help") {
    request.stdout(usage());
    return 0;
  }
  if (invocation.kind === "version") {
    request.stdout("Python " + py.version + "\n");
    return 0;
  }
  if (invocation.kind === "error") {
    request.stderr("python: " + invocation.message + "\n" + usage());
    return 2;
  }

  let source = "";
  let stdin = new TextDecoder().decode(request.stdin ?? new Uint8Array());
  let runnable: Exclude<PythonInvocation, { kind: "help" | "version" | "error" | "file" }>;
  if (invocation.kind === "file") {
    if (!fsExists(py, invocation.path) || fsIsDir(py, invocation.path)) {
      request.stderr("python: can't open file '" + invocation.path + "': No such file\n");
      return 2;
    }
    if (py.FS.stat(invocation.path).size > MAX_PYTHON_SOURCE_BYTES) {
      request.stderr("python: source exceeds the 2 MiB limit\n");
      return 2;
    }
    source = fsReadText(py, invocation.path);
    runnable = { ...invocation, kind: "code", source };
  } else if (invocation.kind === "stdin") {
    source = stdin;
    stdin = "";
    runnable = invocation;
  } else {
    source = invocation.kind === "code" ? invocation.source : "";
    runnable = invocation;
  }

  try {
    const result = await runPythonWithStreams(
      py,
      pythonProgram(
        runnable,
        source,
        stdin,
        request.cwd,
        { PWD: request.cwd, ...(request.env ?? {}) },
      ),
      { stdout: request.stdout, stderr: request.stderr },
    );
    return typeof result === "number" && Number.isFinite(result) ? Math.trunc(result) : 1;
  } catch (error) {
    request.stderr("python: " + (error instanceof Error ? error.message : String(error)) + "\n");
    return 1;
  }
}
