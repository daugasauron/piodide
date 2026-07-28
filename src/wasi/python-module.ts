/**
 * Installs the `wasi` Python module into the Pyodide runtime:
 *
 *   import wasi
 *   result = await wasi.run_wasi("/home/web/ls.wasm", args=["/home/web"])
 *   # {"exitCode": 0, "stdout": "…", "stderr": ""}
 *
 * The JS runner is injected (see browser-runner.ts `makeJsRunner`) so this
 * module stays free of browser-only imports and can be tested under Node.
 */
import type { Pyodide } from "../pyodide-host.ts";

export interface WasiRunJsOptions {
  args?: string[];
  env?: Record<string, string>;
  stdin?: string;
}

export interface WasiRunJsResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type WasiRunJs = (path: string, options?: WasiRunJsOptions) => Promise<WasiRunJsResult>;

const WASI_PY_SOURCE = `"""Run WASI programs against the shared Pyodide filesystem.

    import wasi
    result = await wasi.run_wasi("/home/web/ls.wasm", args=["/home/web"])
    print(result["exitCode"], result["stdout"])

The program reads and writes the same files Python sees (no copying).
The process cwd starts at "/", so prefer absolute /home/web paths or
chdir early in your program.
"""

from pyodide.ffi import to_js
import wasi_native as _native


async def run_wasi(path, args=None, env=None, stdin=""):
    """Run a WASI .wasm executable from the shared filesystem.

    path: absolute path to the .wasm in the Pyodide filesystem.
    args: argument list (without argv[0]).
    env:  environment variables (dict).
    stdin: text fed to standard input before EOF.

    Returns {"exitCode": int, "stdout": str, "stderr": str}.
    """
    options = to_js({
        "args": [str(a) for a in (args or [])],
        "env": {str(k): str(v) for k, v in (env or {}).items()},
        "stdin": stdin,
    })
    result = await _native.run(path, options)
    return {
        "exitCode": result.exitCode,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }
`;

export function installWasiPythonModule(py: Pyodide, run: WasiRunJs): void {
  py.registerJsModule("wasi_native", { run });
  const purelib = py.runPython("import sysconfig; sysconfig.get_paths()['purelib']") as string;
  py.FS.writeFile(`${purelib}/wasi.py`, WASI_PY_SOURCE);
}
