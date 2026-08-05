/** Browser-hosted commands exposed as ordinary programs inside Slop. */
import type { Pyodide } from "./pyodide-host.ts";
import { fsExists, fsIsDir } from "./pyodide-host.ts";
import type { GitHubCredentials } from "./git-remote.ts";
import { normalizePath } from "./wasi/abi.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_CURL_BODY_BYTES = 32 * 1024 * 1024;
const MAX_CURL_HEADER_BYTES = 1024 * 1024;
const MAX_CURL_URL_BYTES = 1024 * 1024;
const MAX_CURL_OUTPUT_BYTES = MAX_CURL_BODY_BYTES + 2 * MAX_CURL_HEADER_BYTES;

export interface HostCommandContext {
  py: Pyodide;
  args: string[];
  cwd: string;
  stdin?: Uint8Array;
  /** Bounded exported environment supplied by the spawning shell. */
  env?: Record<string, string>;
  /** Interactive host commands can pull until this returns null (Ctrl+D). */
  readStdin?: () => Promise<Uint8Array | null> | Uint8Array | null;
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

/* -------------------------------- curl --------------------------------- */

type CurlDataKind = "data" | "binary" | "raw" | "urlencode" | "json";

interface CurlDataItem {
  kind: CurlDataKind;
  value: string;
}

interface CurlOptions {
  url: string;
  method?: string;
  headers: string[];
  data: CurlDataItem[];
  get: boolean;
  head: boolean;
  include: boolean;
  location: boolean;
  output?: string;
  remoteName: boolean;
  dumpHeader?: string;
  discardOutput: boolean;
  fail: boolean;
  failWithBody: boolean;
  silent: boolean;
  showError: boolean;
  timeoutMs?: number;
  writeOut?: string;
}

class CurlFailure extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}

const CURL_USAGE = `usage: curl [options] URL
Browser-native HTTP client backed by Fetch; this is not libcurl.

  -X, --request METHOD       request method
  -H, --header LINE          request header or @file (repeatable)
  -d, --data DATA            form data; @file strips CR/LF/NUL
      --data-binary DATA     request data without text processing
      --data-raw DATA        literal data; @ has no special meaning
      --data-urlencode DATA  URL-encode content or [name]@file
      --json JSON            JSON request body or @file
  -G, --get                  put data in the URL query
  -I, --head                 headers only
  -i, --include              include exposed response headers
  -L, --location             follow redirects
  -o, --output FILE          write response body to FILE
  -O, --remote-name          use the URL's final path component
  -D, --dump-header FILE     write exposed response headers
      --out-null             discard the response body
  -f, --fail                 fail on HTTP 4xx/5xx without the body
      --fail-with-body       fail on HTTP 4xx/5xx and keep the body
  -s, --silent               suppress errors (-sS keeps errors)
  -m, --max-time SECONDS     whole-request timeout; 0 disables
  -w, --write-out FORMAT     print selected response metadata

Write-out variables: http_code, response_code, content_type, size_download,
url_effective, time_total, exitcode, errormsg, filename_effective, method,
scheme, urlnum, and %header{name}. Unknown variables warn without changing the
transfer's exit code.

Only one HTTP(S) URL is supported. Cross-origin responses require CORS.
Redirects are followed only with -L; cross-origin redirect details are hidden
without it. TLS, cookies, proxies, HTTP versions, User-Agent, and forbidden
headers are browser-controlled. HTTP/? is a synthetic status line because
Fetch hides the HTTP version. Request and response bodies are capped at 32 MiB.
`;

function optionValue(args: string[], index: number, option: string): [string, number] {
  if (index + 1 >= args.length) throw new CurlFailure(2, `${option} requires a value`);
  return [args[index + 1], index + 1];
}

function parseTimeout(value: string, option: string): number | undefined {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new CurlFailure(2, `${option} must be zero or positive`);
  }
  return seconds === 0 ? undefined : Math.ceil(seconds * 1000);
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
    location: false,
    remoteName: false,
    discardOutput: false,
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
      if (result.url) throw new CurlFailure(2, "exactly one URL is supported");
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
        else if (flag === "L") result.location = true;
        else if (flag === "I") result.head = true;
        else if (flag === "i") result.include = true;
        else if (flag === "G") result.get = true;
        else if (flag === "O") result.remoteName = true;
      }
      continue;
    }
    if (arg === "-L" || arg === "--location") { result.location = true; continue; }
    if (arg === "--no-location") { result.location = false; continue; }
    if (arg === "--compressed") continue; // Fetch owns content coding.
    if (arg === "--out-null") { result.discardOutput = true; continue; }
    if (arg === "-G" || arg === "--get") { result.get = true; continue; }
    if (arg === "-I" || arg === "--head") { result.head = true; continue; }
    if (arg === "-i" || arg === "--include") { result.include = true; continue; }
    if (arg === "-O" || arg === "--remote-name") { result.remoteName = true; continue; }
    if (arg === "-f" || arg === "--fail") { result.fail = true; continue; }
    if (arg === "--fail-with-body") { result.failWithBody = true; continue; }
    if (arg === "-s" || arg === "--silent") { result.silent = true; continue; }
    if (arg === "-S" || arg === "--show-error") { result.showError = true; continue; }
    if (arg === "--connect-timeout" || arg.startsWith("--connect-timeout=")) {
      if (arg === "--connect-timeout") [, i] = optionValue(args, i, arg);
      throw new CurlFailure(
        2,
        "--connect-timeout is unavailable in browser Fetch; use --max-time",
      );
    }

    let value: string;
    if (arg === "--url") {
      [value, i] = optionValue(args, i, arg);
      if (result.url) throw new CurlFailure(2, "exactly one URL is supported");
      result.url = value; continue;
    }
    if (arg.startsWith("--url=")) {
      if (result.url) throw new CurlFailure(2, "exactly one URL is supported");
      result.url = arg.slice("--url=".length); continue;
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
      [value, i] = optionValue(args, i, arg); result.data.push({ kind: "data", value }); continue;
    }
    if (arg.startsWith("--data=")) {
      result.data.push({ kind: "data", value: arg.slice("--data=".length) }); continue;
    }
    if (arg.startsWith("-d") && arg.length > 2) {
      result.data.push({ kind: "data", value: arg.slice(2) }); continue;
    }
    if (arg === "--data-binary" || arg === "--data-raw" || arg === "--data-urlencode" || arg === "--json") {
      [value, i] = optionValue(args, i, arg);
      const kind: CurlDataKind = arg === "--data-binary" ? "binary"
        : arg === "--data-raw" ? "raw"
        : arg === "--data-urlencode" ? "urlencode"
        : "json";
      result.data.push({ kind, value }); continue;
    }
    const dataEquals = ["--data-binary=", "--data-raw=", "--data-urlencode=", "--json="]
      .find((prefix) => arg.startsWith(prefix));
    if (dataEquals) {
      const kind: CurlDataKind = dataEquals === "--data-binary=" ? "binary"
        : dataEquals === "--data-raw=" ? "raw"
        : dataEquals === "--data-urlencode=" ? "urlencode"
        : "json";
      result.data.push({ kind, value: arg.slice(dataEquals.length) }); continue;
    }
    if (arg === "-o" || arg === "--output") {
      [value, i] = optionValue(args, i, arg); result.output = value; continue;
    }
    if (arg.startsWith("--output=")) { result.output = arg.slice("--output=".length); continue; }
    if (arg.startsWith("-o") && arg.length > 2) { result.output = arg.slice(2); continue; }
    if (arg === "-D" || arg === "--dump-header") {
      [value, i] = optionValue(args, i, arg); result.dumpHeader = value; continue;
    }
    if (arg.startsWith("--dump-header=")) {
      result.dumpHeader = arg.slice("--dump-header=".length); continue;
    }
    if (arg.startsWith("-D") && arg.length > 2) { result.dumpHeader = arg.slice(2); continue; }
    if (arg === "-m" || arg === "--max-time") {
      [value, i] = optionValue(args, i, arg); result.timeoutMs = parseTimeout(value, arg); continue;
    }
    if (arg.startsWith("--max-time=")) {
      result.timeoutMs = parseTimeout(arg.slice("--max-time=".length), "--max-time"); continue;
    }
    if (arg.startsWith("-m") && arg.length > 2) {
      result.timeoutMs = parseTimeout(arg.slice(2), "-m"); continue;
    }
    if (arg === "-w" || arg === "--write-out") {
      [value, i] = optionValue(args, i, arg); result.writeOut = value; continue;
    }
    if (arg.startsWith("--write-out=")) { result.writeOut = arg.slice("--write-out=".length); continue; }
    if (arg.startsWith("-w") && arg.length > 2) { result.writeOut = arg.slice(2); continue; }
    throw new CurlFailure(2, `unsupported option: ${arg}`);
  }
  if (!result.url) throw new CurlFailure(2, "URL is required");
  if (result.output === "" || result.dumpHeader === "") {
    throw new CurlFailure(2, "output path is empty");
  }
  if (result.output && result.remoteName) throw new CurlFailure(2, "-o and -O cannot be combined");
  if (result.discardOutput && (result.output || result.remoteName)) {
    throw new CurlFailure(2, "--out-null cannot be combined with -o or -O");
  }
  return result;
}

function resolveCurlUrl(value: string): URL {
  if (encoder.encode(value).byteLength > MAX_CURL_URL_BYTES) {
    throw new CurlFailure(63, "URL exceeds the 1 MiB limit");
  }
  let candidate = value;
  if (value.startsWith("//")) candidate = `http:${value}`;
  else if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) candidate = `http://${value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new CurlFailure(3, `malformed URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CurlFailure(1, `unsupported protocol: ${url.protocol.slice(0, -1)}`);
  }
  if (url.username || url.password) {
    throw new CurlFailure(2, "credentials in URLs are unavailable in browser Fetch");
  }
  return url;
}

function createStdinReader(context: HostCommandContext): () => Promise<Uint8Array> {
  let pending: Promise<Uint8Array> | null = null;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      if (context.stdin !== undefined) return context.stdin.slice();
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (context.readStdin) {
        if (context.signal?.aborted) throw new CurlFailure(130, "operation aborted");
        const chunk = await context.readStdin();
        if (chunk === null) break;
        total += chunk.byteLength;
        if (total > MAX_CURL_BODY_BYTES) {
          throw new CurlFailure(63, "stdin exceeds the 32 MiB limit");
        }
        chunks.push(chunk.slice());
      }
      return joinBytesBounded(chunks, undefined, MAX_CURL_BODY_BYTES, "stdin");
    })();
    return pending;
  };
}

function inputPath(context: HostCommandContext, value: string): string {
  try {
    return workspacePath(context.cwd, value);
  } catch (error) {
    throw new CurlFailure(26, error instanceof Error ? error.message : String(error));
  }
}

function readInputFile(context: HostCommandContext, value: string, limit: number): Uint8Array {
  const path = inputPath(context, value);
  if (!fsExists(context.py, path) || fsIsDir(context.py, path)) {
    throw new CurlFailure(26, `input file not found: ${value}`);
  }
  let size: number;
  try {
    size = context.py.FS.stat(path).size;
  } catch (error) {
    throw new CurlFailure(26, error instanceof Error ? error.message : String(error));
  }
  if (size > limit) throw new CurlFailure(63, `input file exceeds the ${limit / 1024 / 1024} MiB limit`);
  try {
    const valueRead = context.py.FS.readFile(path);
    const data = typeof valueRead === "string" ? encoder.encode(valueRead) : valueRead;
    if (data.byteLength > limit) {
      throw new CurlFailure(63, `input file exceeds the ${limit / 1024 / 1024} MiB limit`);
    }
    return data;
  } catch (error) {
    if (error instanceof CurlFailure) throw error;
    throw new CurlFailure(26, error instanceof Error ? error.message : String(error));
  }
}

async function readReference(
  context: HostCommandContext,
  reference: string,
  readStdin: () => Promise<Uint8Array>,
  limit = MAX_CURL_BODY_BYTES,
): Promise<Uint8Array> {
  if (reference === "-") {
    const input = await readStdin();
    if (input.byteLength > limit) throw new CurlFailure(63, "stdin exceeds the input limit");
    return input;
  }
  return readInputFile(context, reference, limit);
}

function stripCurlTextFile(data: Uint8Array): Uint8Array {
  let length = 0;
  for (const byte of data) if (byte !== 0 && byte !== 10 && byte !== 13) length++;
  if (length === data.byteLength) return data;
  const stripped = new Uint8Array(length);
  let offset = 0;
  for (const byte of data) if (byte !== 0 && byte !== 10 && byte !== 13) stripped[offset++] = byte;
  return stripped;
}

function isUrlUnreserved(byte: number): boolean {
  return (
    (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) ||
    (byte >= 48 && byte <= 57) || byte === 45 || byte === 46 || byte === 95 || byte === 126
  );
}

function percentEncode(data: Uint8Array): Uint8Array {
  let length = 0;
  for (const byte of data) {
    length += isUrlUnreserved(byte) ? 1 : 3;
    if (length > MAX_CURL_BODY_BYTES) {
      throw new CurlFailure(63, "URL-encoded data exceeds the 32 MiB limit");
    }
  }
  const encoded = new Uint8Array(length);
  const hex = "0123456789ABCDEF";
  let offset = 0;
  for (const byte of data) {
    if (isUrlUnreserved(byte)) {
      encoded[offset++] = byte;
    } else {
      encoded[offset++] = 37;
      encoded[offset++] = hex.charCodeAt(byte >>> 4);
      encoded[offset++] = hex.charCodeAt(byte & 15);
    }
  }
  return encoded;
}

async function readDataItem(
  context: HostCommandContext,
  item: CurlDataItem,
  readStdin: () => Promise<Uint8Array>,
): Promise<Uint8Array> {
  if (item.kind === "raw") return encoder.encode(item.value);
  if (item.kind === "urlencode") {
    const value = item.value;
    if (value.startsWith("=")) return percentEncode(encoder.encode(value.slice(1)));
    if (value.startsWith("@")) return percentEncode(await readReference(context, value.slice(1), readStdin));
    const equals = value.indexOf("=");
    if (equals >= 0) {
      const name = value.slice(0, equals);
      const content = percentEncode(encoder.encode(value.slice(equals + 1)));
      return joinBytesBounded([encoder.encode(`${name}=`), content], undefined, MAX_CURL_BODY_BYTES, "request body");
    }
    const at = value.indexOf("@");
    if (at >= 0) {
      const name = value.slice(0, at);
      const content = percentEncode(await readReference(context, value.slice(at + 1), readStdin));
      return joinBytesBounded([encoder.encode(`${name}=`), content], undefined, MAX_CURL_BODY_BYTES, "request body");
    }
    return percentEncode(encoder.encode(value));
  }
  if (!item.value.startsWith("@")) return encoder.encode(item.value);
  const data = await readReference(context, item.value.slice(1), readStdin);
  return item.kind === "data" ? stripCurlTextFile(data) : data;
}

function joinBytesBounded(
  chunks: Uint8Array[],
  separator: Uint8Array | undefined,
  limit: number,
  label: string,
): Uint8Array {
  const separators = separator ? Math.max(0, chunks.length - 1) * separator.byteLength : 0;
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, separators);
  if (total > limit) throw new CurlFailure(63, `${label} exceeds the ${limit / 1024 / 1024} MiB limit`);
  const output = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0 && separator) { output.set(separator, offset); offset += separator.byteLength; }
    output.set(chunks[i], offset); offset += chunks[i].byteLength;
  }
  return output;
}

async function buildRequestBody(
  context: HostCommandContext,
  options: CurlOptions,
  readStdin: () => Promise<Uint8Array>,
): Promise<Uint8Array | undefined> {
  if (options.data.length === 0) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let index = 0; index < options.data.length; index++) {
    const chunk = await readDataItem(context, options.data[index], readStdin);
    const previous = options.data[index - 1];
    const separator = index > 0 && !(previous.kind === "json" && options.data[index].kind === "json") ? 1 : 0;
    total += separator + chunk.byteLength;
    if (total > MAX_CURL_BODY_BYTES) throw new CurlFailure(63, "request body exceeds the 32 MiB limit");
    if (separator) chunks.push(encoder.encode("&"));
    chunks.push(chunk);
  }
  return joinBytesBounded(chunks, undefined, MAX_CURL_BODY_BYTES, "request body");
}

function queryBytes(data: Uint8Array): string {
  let length = 0;
  for (const byte of data) {
    length += byte >= 0x21 && byte <= 0x7e && byte !== 0x23 ? 1 : 3;
    if (length > MAX_CURL_URL_BYTES) {
      throw new CurlFailure(63, "URL query exceeds the 1 MiB limit");
    }
  }
  const result = new Uint8Array(length);
  const hex = "0123456789ABCDEF";
  let offset = 0;
  for (const byte of data) {
    if (byte >= 0x21 && byte <= 0x7e && byte !== 0x23) {
      result[offset++] = byte;
    } else {
      result[offset++] = 37;
      result[offset++] = hex.charCodeAt(byte >>> 4);
      result[offset++] = hex.charCodeAt(byte & 15);
    }
  }
  return decoder.decode(result);
}

const FORBIDDEN_REQUEST_HEADERS = new Set([
  "accept-charset", "accept-encoding", "access-control-request-headers",
  "access-control-request-method", "connection", "content-length", "cookie", "date",
  "dnt", "expect", "host", "keep-alive", "origin", "referer", "set-cookie", "te",
  "trailer", "transfer-encoding", "upgrade", "user-agent", "via",
]);

function assertSettableHeader(name: string): void {
  const lower = name.toLowerCase();
  if (
    FORBIDDEN_REQUEST_HEADERS.has(lower) || lower.startsWith("proxy-") || lower.startsWith("sec-")
  ) {
    throw new CurlFailure(2, `browser controls request header: ${name}`);
  }
}

async function expandHeaderLines(
  context: HostCommandContext,
  entries: string[],
  readStdin: () => Promise<Uint8Array>,
): Promise<string[]> {
  const lines: string[] = [];
  let total = 0;
  for (const entry of entries) {
    const expanded = entry.startsWith("@")
      ? decoder.decode(await readReference(context, entry.slice(1), readStdin, MAX_CURL_HEADER_BYTES))
        .split(/\r?\n/).filter(Boolean)
      : [entry];
    for (const line of expanded) {
      total += encoder.encode(line).byteLength;
      if (total > MAX_CURL_HEADER_BYTES) throw new CurlFailure(63, "request headers exceed the 1 MiB limit");
      lines.push(line);
    }
  }
  return lines;
}

async function buildRequestHeaders(
  context: HostCommandContext,
  options: CurlOptions,
  body: Uint8Array | undefined,
  readStdin: () => Promise<Uint8Array>,
): Promise<Headers> {
  const headers = new Headers();
  const suppressed = new Set<string>();
  for (const line of await expandHeaderLines(context, options.headers, readStdin)) {
    let name: string;
    let value: string;
    const colon = line.indexOf(":");
    if (colon > 0) {
      name = line.slice(0, colon).trim();
      value = line.slice(colon + 1).trim();
    } else if (colon < 0 && line.endsWith(";")) {
      name = line.slice(0, -1).trim();
      value = "";
    } else {
      throw new CurlFailure(2, `invalid header: ${line}`);
    }
    assertSettableHeader(name);
    const lower = name.toLowerCase();
    if (colon > 0 && value === "") {
      headers.delete(name);
      suppressed.add(lower);
      continue;
    }
    try {
      suppressed.delete(lower);
      headers.append(name, value);
    } catch (error) {
      throw new CurlFailure(2, error instanceof Error ? error.message : String(error));
    }
  }
  const hasJson = options.data.some(({ kind }) => kind === "json");
  if (hasJson && !headers.has("Content-Type") && !suppressed.has("content-type")) {
    headers.set("Content-Type", "application/json");
  }
  if (hasJson && !headers.has("Accept") && !suppressed.has("accept")) {
    headers.set("Accept", "application/json");
  }
  if (
    body !== undefined && !options.get && !headers.has("Content-Type") &&
    !suppressed.has("content-type")
  ) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
  }
  return headers;
}

function countStdinConsumers(options: CurlOptions): number {
  let count = options.headers.filter((header) => header === "@-").length;
  for (const item of options.data) {
    if (item.kind === "raw") continue;
    if (
      item.value === "@-" ||
      (item.kind === "urlencode" && item.value.indexOf("=") < 0 && /^[^@]+@-$/.test(item.value))
    ) count++;
  }
  if (options.writeOut === "@-") count++;
  return count;
}

function responseHeaders(response: Response): Uint8Array {
  const lines = [`HTTP/? ${response.status} ${response.statusText}`.trimEnd()];
  let total = encoder.encode(lines[0]).byteLength;
  response.headers.forEach((value, name) => {
    total += encoder.encode(name).byteLength + encoder.encode(value).byteLength + 4;
    if (total <= MAX_CURL_HEADER_BYTES) lines.push(`${name}: ${value}`);
  });
  if (total > MAX_CURL_HEADER_BYTES) throw new CurlFailure(63, "response headers exceed the 1 MiB limit");
  return encoder.encode(lines.join("\r\n") + "\r\n\r\n");
}

async function consumeResponseBody(
  response: Response,
  write: (chunk: Uint8Array) => void,
): Promise<number> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CURL_BODY_BYTES) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    throw new CurlFailure(63, "response exceeds the 32 MiB limit");
  }
  if (!response.body) return 0;
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CURL_BODY_BYTES) {
        await reader.cancel();
        throw new CurlFailure(63, "response exceeds the 32 MiB limit");
      }
      write(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* best effort */ }
    if (error instanceof CurlFailure || (error instanceof DOMException && error.name === "AbortError")) throw error;
    throw new CurlFailure(18, `partial response: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    reader.releaseLock();
  }
  return total;
}

function resolveOutputPath(context: HostCommandContext, value: string): string {
  try {
    const path = workspacePath(context.cwd, value);
    const parent = parentPath(path);
    if (!fsExists(context.py, parent) || !fsIsDir(context.py, parent)) {
      throw new Error(`directory does not exist: ${parent}`);
    }
    return path;
  } catch (error) {
    throw new CurlFailure(23, error instanceof Error ? error.message : String(error));
  }
}

function writeWorkspaceFile(context: HostCommandContext, value: string, data: Uint8Array): void {
  const path = resolveOutputPath(context, value);
  try {
    context.py.FS.writeFile(path, data);
  } catch (error) {
    throw new CurlFailure(23, error instanceof Error ? error.message : String(error));
  }
}

interface OutputSink {
  write(data: Uint8Array): void;
  close(): void;
}

function openOutputSink(context: HostCommandContext, value: string): OutputSink {
  const path = resolveOutputPath(context, value);
  let stream: unknown;
  try {
    stream = context.py.FS.open(path, "w");
  } catch (error) {
    throw new CurlFailure(23, error instanceof Error ? error.message : String(error));
  }
  let closed = false;
  return {
    write(data) {
      if (data.byteLength === 0) return;
      try {
        const written = context.py.FS.write(stream, data, 0, data.byteLength);
        if (written !== data.byteLength) throw new Error("short write");
      } catch (error) {
        throw new CurlFailure(23, error instanceof Error ? error.message : String(error));
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        context.py.FS.close(stream);
      } catch (error) {
        throw new CurlFailure(23, error instanceof Error ? error.message : String(error));
      }
    },
  };
}

interface WriteOutMetadata {
  response: Response;
  urlEffective: string;
  size: number;
  elapsedMs: number;
  exitCode: number;
  method: string;
  outputName: string;
}

function formatWriteOut(format: string, metadata: WriteOutMetadata): { text: string; warnings: string[] } {
  const { response, urlEffective, size, elapsedMs, exitCode, method, outputName } = metadata;
  const values: Record<string, string> = {
    http_code: String(response.status).padStart(3, "0"),
    response_code: String(response.status).padStart(3, "0"),
    content_type: response.headers.get("content-type") ?? "",
    size_download: String(size),
    url_effective: urlEffective,
    time_total: (elapsedMs / 1000).toFixed(6),
    exitcode: String(exitCode),
    errormsg: exitCode === 0 ? "" : `HTTP ${response.status} ${response.statusText}`.trimEnd(),
    filename_effective: outputName,
    method,
    scheme: new URL(urlEffective).protocol.slice(0, -1),
    urlnum: "0",
  };
  const warnings: string[] = [];
  const text = format
    .replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
    .replace(/%%/g, "\0")
    .replace(/%header\{([^}]+)\}/gi, (_match, name: string) => response.headers.get(name) ?? "")
    .replace(/%\{([a-z0-9_]+)\}/gi, (_match, name: string) => {
      if (!(name in values)) warnings.push(name);
      return values[name] ?? "";
    })
    .replace(/\0/g, "%");
  return { text, warnings: [...new Set(warnings)] };
}

async function resolveWriteOut(
  context: HostCommandContext,
  value: string | undefined,
  readStdin: () => Promise<Uint8Array>,
): Promise<string | undefined> {
  if (!value?.startsWith("@")) return value;
  return decoder.decode(await readReference(context, value.slice(1), readStdin, MAX_CURL_HEADER_BYTES));
}

function curlError(options: CurlOptions | null, message: string, exitCode: number): HostCommandResult {
  if (options?.silent && !options.showError) return { exitCode };
  return fail("curl", `(${exitCode}) ${message}`, exitCode);
}

function appendStderr(result: HostCommandResult, lines: string[], options: CurlOptions): HostCommandResult {
  if (lines.length === 0 || (options.silent && !options.showError)) return result;
  const extra = encoder.encode(lines.map((line) => `curl: ${line}\n`).join(""));
  const current = result.stderr ?? new Uint8Array();
  return { ...result, stderr: joinBytesBounded([current, extra], undefined, MAX_CURL_HEADER_BYTES, "stderr") };
}

export async function runCurlCommand(context: HostCommandContext): Promise<HostCommandResult> {
  let options: CurlOptions | null = null;
  try {
    const parsed = parseCurlArgs(context.args);
    if ("help" in parsed) {
      return ok(parsed.help === "version"
        ? "curl 0.2.0-piodide (browser Fetch; not libcurl)\n"
        : CURL_USAGE);
    }
    options = parsed;
    if (countStdinConsumers(options) > 1) {
      throw new CurlFailure(2, "stdin can only be consumed once per invocation");
    }
    const url = resolveCurlUrl(options.url);
    const readStdin = createStdinReader(context);
    const writeOut = await resolveWriteOut(context, options.writeOut, readStdin);
    let body = await buildRequestBody(context, options, readStdin);
    if (options.get && body !== undefined) {
      const query = queryBytes(body);
      url.search += `${url.search ? "&" : ""}${query}`;
      body = undefined;
    }
    const headers = await buildRequestHeaders(context, options, body, readStdin);
    const method = (options.method || (options.head ? "HEAD" : body !== undefined ? "POST" : "GET")).toUpperCase();
    if (body !== undefined && (method === "GET" || method === "HEAD")) {
      throw new CurlFailure(2, `browser Fetch cannot send a request body with ${method}; use -G`);
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
    let sink: OutputSink | null = null;
    try {
      const requestBody = body === undefined ? undefined : body as Uint8Array<ArrayBuffer>;
      try {
        response = await fetch(url, {
          method,
          headers,
          body: requestBody,
          redirect: options.location ? "follow" : "manual",
          credentials: "omit",
          signal: controller.signal,
        });
      } catch (error) {
        if (timedOut) throw new CurlFailure(28, "operation timed out");
        if (context.signal?.aborted) throw new CurlFailure(130, "operation aborted");
        const detail = error instanceof Error ? error.message : String(error);
        if (detail.toLowerCase().includes("redirect")) throw new CurlFailure(47, detail);
        throw new CurlFailure(7, `Fetch failed (network, TLS, mixed-content, private-network, or CORS error): ${detail}`);
      }
      if (response.type === "opaqueredirect" || response.status === 0) {
        throw new CurlFailure(47, "cross-origin redirect details are hidden by the browser; rerun with -L");
      }

      const headerBytes = responseHeaders(response);
      if (options.dumpHeader && options.dumpHeader !== "-" && options.dumpHeader !== "/dev/null") {
        writeWorkspaceFile(context, options.dumpHeader, headerBytes);
      }
      const httpFailure = response.status >= 400 && (options.fail || options.failWithBody);
      const keepBody = !httpFailure || options.failWithBody;
      const outputName = options.output || (options.remoteName ? safeRemoteName(url) : "");
      const discard = options.discardOutput || outputName === "/dev/null";
      const directOutput = outputName && outputName !== "-" && !discard;
      if (directOutput) sink = openOutputSink(context, outputName);

      const stdoutChunks: Uint8Array[] = [];
      if (options.dumpHeader === "-") stdoutChunks.push(headerBytes);
      const payloadPrefix = options.head || options.include ? headerBytes : new Uint8Array();
      if (sink) sink.write(payloadPrefix);
      else if (!discard && payloadPrefix.byteLength) stdoutChunks.push(payloadPrefix);

      let size = 0;
      if (!options.head) {
        size = await consumeResponseBody(response, (chunk) => {
          if (!keepBody || discard) return;
          if (sink) sink.write(chunk);
          else stdoutChunks.push(chunk.slice());
        });
      }
      sink?.close();
      sink = null;

      const exitCode = httpFailure ? 22 : 0;
      const warnings: string[] = [];
      if (writeOut) {
        const formatted = formatWriteOut(writeOut, {
          response,
          urlEffective: response.url || url.toString(),
          size,
          elapsedMs: performance.now() - started,
          exitCode,
          method,
          outputName: discard ? "/dev/null" : outputName,
        });
        stdoutChunks.push(encoder.encode(formatted.text));
        warnings.push(...formatted.warnings.map((name) => `unknown --write-out variable: '${name}'`));
      }
      const stdout = joinBytesBounded(
        stdoutChunks,
        undefined,
        MAX_CURL_OUTPUT_BYTES,
        "output",
      );
      const result = httpFailure
        ? { ...curlError(options, `HTTP ${response.status} ${response.statusText}`.trimEnd(), 22), stdout }
        : { exitCode: 0, stdout };
      return appendStderr(result, warnings, options);
    } catch (error) {
      try { sink?.close(); } catch (closeError) { error = closeError; }
      if (timedOut) return curlError(options, "operation timed out", 28);
      if (context.signal?.aborted) return curlError(options, "operation aborted", 130);
      if (error instanceof CurlFailure) return curlError(options, error.message, error.exitCode);
      return curlError(options, error instanceof Error ? error.message : String(error), 2);
    } finally {
      if (timer) globalThis.clearTimeout(timer);
      context.signal?.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    if (error instanceof CurlFailure) return curlError(options, error.message, error.exitCode);
    return curlError(options, error instanceof Error ? error.message : String(error), 2);
  }
}

function safeRemoteName(url: URL): string {
  const parts = url.pathname.split("/").filter(Boolean);
  const name = parts.pop() || "curl_response";
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new CurlFailure(23, "URL does not have a safe remote filename");
  }
  return name;
}
