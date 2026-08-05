/** Browser-hosted commands exposed as ordinary programs inside Slop. */
import type { Pyodide } from "./pyodide-host.ts";
import { fsExists, fsIsDir } from "./pyodide-host.ts";
import type { GitHubCredentials } from "./git-remote.ts";
import { normalizePath } from "./wasi/abi.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_CURL_BODY_BYTES = 32 * 1024 * 1024;

export interface HostCommandContext {
  py: Pyodide;
  args: string[];
  cwd: string;
  stdin?: Uint8Array;
  signal?: AbortSignal;
  getGitHubCredentials?: () => GitHubCredentials | null;
}

export interface HostCommandResult {
  exitCode: number;
  stdout?: Uint8Array;
  stderr?: Uint8Array;
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? encoder.encode(value) : value;
}

function ok(stdout: string | Uint8Array = ""): HostCommandResult {
  return { exitCode: 0, stdout: bytes(stdout) };
}

function fail(command: string, message: string, exitCode = 2): HostCommandResult {
  return { exitCode, stderr: encoder.encode(`${command}: ${message}\n`) };
}

function workspacePath(cwd: string, value: string): string {
  const path = value.startsWith("/")
    ? normalizePath(value)
    : normalizePath(`${cwd}/${value}`);
  if (path !== "/home/web" && !path.startsWith("/home/web/")) {
    throw new Error(`path must stay inside /home/web: ${value}`);
  }
  return path;
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

function writeWorkspaceFile(py: Pyodide, cwd: string, path: string, data: Uint8Array): string {
  const resolved = workspacePath(cwd, path);
  const parent = parentPath(resolved);
  if (!fsExists(py, parent) || !fsIsDir(py, parent)) {
    throw new Error(`directory does not exist: ${parent}`);
  }
  py.FS.writeFile(resolved, data);
  return resolved;
}

/* -------------------------------- curl --------------------------------- */

interface CurlOptions {
  url: string;
  method?: string;
  headers: string[];
  data: Array<{ value: string; fromFile: boolean; urlEncode: boolean }>;
  get: boolean;
  head: boolean;
  include: boolean;
  output?: string;
  remoteName: boolean;
  dumpHeader?: string;
  fail: boolean;
  failWithBody: boolean;
  silent: boolean;
  showError: boolean;
  timeoutMs?: number;
  writeOut?: string;
}

const CURL_USAGE = `usage: curl [options] URL
  -X, --request METHOD       request method
  -H, --header LINE          request header (repeatable)
  -d, --data DATA            request data; @file or @- reads bytes
      --data-binary DATA     request data without text processing
      --data-urlencode DATA  URL-encode request data
      --json JSON            JSON request body
  -G, --get                  put data in the URL query
  -I, --head                 headers only
  -i, --include              include response headers
  -o, --output FILE          write response body to FILE
  -O, --remote-name          use the URL's final path component
  -f, --fail                 fail on HTTP 4xx/5xx without the body
      --fail-with-body       fail on HTTP 4xx/5xx and keep the body
  -s, --silent              suppress errors (-sS keeps errors)
  -m, --max-time SECONDS     whole-request timeout
  -w, --write-out FORMAT     print response metadata

Browser fetch follows redirects and enforces CORS. Browser-controlled TLS,
cookies, proxy settings, User-Agent, and forbidden headers cannot be changed.
`;

function optionValue(args: string[], index: number, option: string): [string, number] {
  if (index + 1 >= args.length) throw new Error(`${option} requires a value`);
  return [args[index + 1], index + 1];
}

export function parseCurlArgs(argv: string[]): CurlOptions | { help: "help" | "version" } {
  const args = argv.slice(1);
  const result: CurlOptions = {
    url: "",
    headers: [],
    data: [],
    get: false,
    head: false,
    include: false,
    remoteName: false,
    fail: false,
    failWithBody: false,
    silent: false,
    showError: false,
  };
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (!options || arg === "-" || !arg.startsWith("-")) {
      if (result.url) throw new Error("exactly one URL is supported");
      result.url = arg;
      continue;
    }
    if (arg === "-h" || arg === "--help") return { help: "help" };
    if (arg === "--version" || arg === "-V") return { help: "version" };
    if (/^-[sSfLIiGO]+$/.test(arg) && arg.length > 2) {
      for (const flag of arg.slice(1)) {
        if (flag === "s") result.silent = true;
        else if (flag === "S") result.showError = true;
        else if (flag === "f") result.fail = true;
        else if (flag === "I") result.head = true;
        else if (flag === "i") result.include = true;
        else if (flag === "G") result.get = true;
        else if (flag === "O") result.remoteName = true;
        // -L is already the browser-fetch default.
      }
      continue;
    }
    if (arg === "-L" || arg === "--location" || arg === "--compressed") continue;
    if (arg === "-G" || arg === "--get") { result.get = true; continue; }
    if (arg === "-I" || arg === "--head") { result.head = true; continue; }
    if (arg === "-i" || arg === "--include") { result.include = true; continue; }
    if (arg === "-O" || arg === "--remote-name") { result.remoteName = true; continue; }
    if (arg === "-f" || arg === "--fail") { result.fail = true; continue; }
    if (arg === "--fail-with-body") { result.failWithBody = true; continue; }
    if (arg === "-s" || arg === "--silent") { result.silent = true; continue; }
    if (arg === "-S" || arg === "--show-error") { result.showError = true; continue; }

    let value: string;
    if (arg === "--url") {
      [value, i] = optionValue(args, i, arg);
      if (result.url) throw new Error("exactly one URL is supported");
      result.url = value; continue;
    }
    if (arg === "-X" || arg === "--request") {
      [value, i] = optionValue(args, i, arg); result.method = value; continue;
    }
    if (arg.startsWith("--request=")) { result.method = arg.slice("--request=".length); continue; }
    if (arg.startsWith("-X") && arg.length > 2) { result.method = arg.slice(2); continue; }
    if (arg === "-H" || arg === "--header") {
      [value, i] = optionValue(args, i, arg); result.headers.push(value); continue;
    }
    if (arg.startsWith("--header=")) { result.headers.push(arg.slice("--header=".length)); continue; }
    if (arg.startsWith("-H") && arg.length > 2) { result.headers.push(arg.slice(2)); continue; }
    if (arg === "-d" || arg === "--data" || arg === "--data-ascii") {
      [value, i] = optionValue(args, i, arg);
      result.data.push({ value, fromFile: true, urlEncode: false }); continue;
    }
    if (arg === "--data-raw") {
      [value, i] = optionValue(args, i, arg);
      result.data.push({ value, fromFile: false, urlEncode: false }); continue;
    }
    if (arg.startsWith("-d") && arg.length > 2) {
      result.data.push({ value: arg.slice(2), fromFile: true, urlEncode: false }); continue;
    }
    if (arg === "--data-binary") {
      [value, i] = optionValue(args, i, arg);
      result.data.push({ value, fromFile: true, urlEncode: false }); continue;
    }
    if (arg === "--data-urlencode") {
      [value, i] = optionValue(args, i, arg);
      result.data.push({ value, fromFile: false, urlEncode: true }); continue;
    }
    if (arg === "--json") {
      [value, i] = optionValue(args, i, arg);
      result.data.push({ value, fromFile: true, urlEncode: false });
      result.headers.push("Content-Type: application/json");
      result.headers.push("Accept: application/json");
      continue;
    }
    if (arg === "-o" || arg === "--output") {
      [value, i] = optionValue(args, i, arg); result.output = value; continue;
    }
    if (arg.startsWith("--output=")) { result.output = arg.slice("--output=".length); continue; }
    if (arg.startsWith("-o") && arg.length > 2) { result.output = arg.slice(2); continue; }
    if (arg === "-D" || arg === "--dump-header") {
      [value, i] = optionValue(args, i, arg); result.dumpHeader = value; continue;
    }
    if (arg === "-m" || arg === "--max-time" || arg === "--connect-timeout") {
      [value, i] = optionValue(args, i, arg);
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`${arg} must be positive`);
      result.timeoutMs = Math.ceil(seconds * 1000); continue;
    }
    if (arg.startsWith("--max-time=")) {
      const seconds = Number(arg.slice("--max-time=".length));
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--max-time must be positive");
      result.timeoutMs = Math.ceil(seconds * 1000); continue;
    }
    if (arg === "-w" || arg === "--write-out") {
      [value, i] = optionValue(args, i, arg); result.writeOut = value; continue;
    }
    if (arg.startsWith("--write-out=")) { result.writeOut = arg.slice("--write-out=".length); continue; }
    throw new Error(`unsupported option: ${arg}`);
  }
  if (!result.url) throw new Error("URL is required");
  if (result.output === "" || result.dumpHeader === "") throw new Error("output path is empty");
  if (result.output && result.remoteName) throw new Error("-o and -O cannot be combined");
  return result;
}

function readCurlData(context: HostCommandContext, item: CurlOptions["data"][number]): Uint8Array {
  if (!item.fromFile || !item.value.startsWith("@")) {
    const value = item.urlEncode ? urlEncodeData(item.value) : item.value;
    return encoder.encode(value);
  }
  if (item.value === "@-") return context.stdin?.slice() ?? new Uint8Array();
  const path = workspacePath(context.cwd, item.value.slice(1));
  if (!fsExists(context.py, path) || fsIsDir(context.py, path)) {
    throw new Error(`data file not found: ${item.value.slice(1)}`);
  }
  return (context.py.FS.readFile(path) as Uint8Array).slice();
}

function urlEncodeData(value: string): string {
  const equals = value.indexOf("=");
  if (equals < 0) return encodeURIComponent(value);
  return `${value.slice(0, equals)}=${encodeURIComponent(value.slice(equals + 1))}`;
}

function joinBytes(chunks: Uint8Array[], separator?: Uint8Array): Uint8Array {
  const separators = separator ? Math.max(0, chunks.length - 1) * separator.byteLength : 0;
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, separators);
  const output = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0 && separator) { output.set(separator, offset); offset += separator.byteLength; }
    output.set(chunks[i], offset); offset += chunks[i].byteLength;
  }
  return output;
}

function responseHeaders(response: Response): Uint8Array {
  const lines = [`HTTP/1.1 ${response.status} ${response.statusText}`.trimEnd()];
  response.headers.forEach((value, name) => lines.push(`${name}: ${value}`));
  return encoder.encode(lines.join("\r\n") + "\r\n\r\n");
}

async function boundedResponseBody(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CURL_BODY_BYTES) {
    throw new Error(`response exceeds the ${MAX_CURL_BODY_BYTES / 1024 / 1024} MiB limit`);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CURL_BODY_BYTES) {
        await reader.cancel();
        throw new Error(`response exceeds the ${MAX_CURL_BODY_BYTES / 1024 / 1024} MiB limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return joinBytes(chunks);
}

function formatWriteOut(format: string, response: Response, size: number, elapsedMs: number): string {
  const values: Record<string, string> = {
    http_code: String(response.status).padStart(3, "0"),
    response_code: String(response.status).padStart(3, "0"),
    content_type: response.headers.get("content-type") ?? "",
    size_download: String(size),
    url_effective: response.url,
    time_total: (elapsedMs / 1000).toFixed(6),
  };
  return format
    .replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
    .replace(/%%/g, "\0")
    .replace(/%\{([a-z_]+)\}/g, (_match, name: string) => values[name] ?? "")
    .replace(/\0/g, "%");
}

function curlError(options: CurlOptions | null, message: string, exitCode: number): HostCommandResult {
  if (options?.silent && !options.showError) return { exitCode };
  return fail("curl", `(${exitCode}) ${message}`, exitCode);
}

export async function runCurlCommand(context: HostCommandContext): Promise<HostCommandResult> {
  let options: CurlOptions | null = null;
  try {
    const parsed = parseCurlArgs(context.args);
    if ("help" in parsed) {
      return ok(parsed.help === "version" ? "curl 8.0.0-piodide (browser fetch)\n" : CURL_USAGE);
    }
    options = parsed;
    const url = new URL(options.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return curlError(options, "only http:// and https:// URLs are supported", 3);
    }

    const headers = new Headers();
    for (const line of options.headers) {
      const colon = line.indexOf(":");
      if (colon <= 0) throw new Error(`invalid header: ${line}`);
      headers.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    const dataChunks = options.data.map((item) => readCurlData(context, item));
    let body = dataChunks.length ? joinBytes(dataChunks, encoder.encode("&")) : undefined;
    if (body && body.byteLength > MAX_CURL_BODY_BYTES) {
      throw new Error(`request body exceeds the ${MAX_CURL_BODY_BYTES / 1024 / 1024} MiB limit`);
    }
    if (options.get && body) {
      const query = decoder.decode(body);
      url.search += `${url.search ? "&" : ""}${query}`;
      body = undefined;
    }
    const method = (options.method || (options.head ? "HEAD" : body ? "POST" : "GET")).toUpperCase();
    if (body && (method === "GET" || method === "HEAD")) {
      throw new Error(`browser fetch cannot send a request body with ${method}; use -G`);
    }

    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(context.signal?.reason);
    context.signal?.addEventListener("abort", onAbort, { once: true });
    if (context.signal?.aborted) controller.abort(context.signal.reason);
    const timer = options.timeoutMs
      ? globalThis.setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs)
      : 0;
    const started = performance.now();
    let response: Response;
    let headerBytes: Uint8Array;
    let responseBody: Uint8Array;
    try {
      const requestBody = body ? body.slice().buffer as ArrayBuffer : undefined;
      response = await fetch(url, {
        method,
        headers,
        body: requestBody,
        redirect: "follow",
        credentials: "omit",
        signal: controller.signal,
      });
      headerBytes = responseHeaders(response);
      responseBody = options.head ? new Uint8Array() : await boundedResponseBody(response);
    } catch (error) {
      if (timedOut) return curlError(options, "operation timed out", 28);
      if (context.signal?.aborted) return curlError(options, "operation aborted", 130);
      const detail = error instanceof Error ? error.message : String(error);
      if (detail.startsWith("response exceeds")) return curlError(options, detail, 63);
      return curlError(options, `fetch failed (network error or CORS): ${detail}`, 7);
    } finally {
      if (timer) globalThis.clearTimeout(timer);
      context.signal?.removeEventListener("abort", onAbort);
    }

    if (options.dumpHeader && options.dumpHeader !== "-") {
      writeWorkspaceFile(context.py, context.cwd, options.dumpHeader, headerBytes);
    }
    const httpFailure = response.status >= 400 && (options.fail || options.failWithBody);
    const keepBody = !httpFailure || options.failWithBody;
    const payload = options.head
      ? headerBytes
      : options.include
        ? joinBytes([headerBytes, keepBody ? responseBody : new Uint8Array()])
        : keepBody ? responseBody : new Uint8Array();

    let stdout = options.dumpHeader === "-" ? joinBytes([headerBytes, payload]) : payload;
    const output = options.output || (options.remoteName
      ? safeRemoteName(url)
      : undefined);
    if (output && output !== "-") {
      writeWorkspaceFile(context.py, context.cwd, output, payload);
      stdout = new Uint8Array();
    }
    if (options.writeOut) {
      stdout = joinBytes([
        stdout,
        encoder.encode(formatWriteOut(options.writeOut, response, responseBody.byteLength, performance.now() - started)),
      ]);
    }
    if (httpFailure) {
      const error = curlError(options, `HTTP ${response.status} ${response.statusText}`.trimEnd(), 22);
      return { ...error, stdout };
    }
    return { exitCode: 0, stdout };
  } catch (error) {
    return curlError(options, error instanceof Error ? error.message : String(error), 2);
  }
}

function safeRemoteName(url: URL): string {
  const encoded = url.pathname.split("/").filter(Boolean).pop() || "index.html";
  const name = decodeURIComponent(encoded);
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error("URL does not have a safe remote filename");
  }
  return name;
}
