/**
 * Agent tools executed inside pyodide's in-browser sandbox.
 *
 *   python  -> run Python code (stdout/stderr streamed live + returned)
 *   read    -> read a file from the MEMFS
 *   write   -> create/overwrite a file in the MEMFS
 *   edit    -> exact string replacements in a MEMFS file
 *   git     -> local Dulwich repositories + GitLab API synchronization
 *   image   -> display an image file from the MEMFS
 *   html    -> display an HTML file in a sandboxed browser popout
 *
 * `read`/`write`/`edit` deliberately use the *same* MEMFS that `python` sees,
 * so a file written by `write` is immediately importable / readable by Python.
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  type Pyodide,
  fsExists,
  fsIsDir,
  fsReadText,
  fsResolve,
  fsWriteText,
  runPythonCapture,
} from "./pyodide-host.ts";
import {
  createGitTool,
  type GitLabCredentials,
} from "./git-tool.ts";

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 50_000;
const MAX_FETCH_BYTES = 50_000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

function text(t: string) {
  return { type: "text" as const, text: t };
}

/* ------------------------------- schemas ------------------------------- */

const PythonParams = Type.Object({
  code: Type.String({
    description: "The Python code to run. Runs as a top-level script; print() to produce output.",
  }),
});

const ReadParams = Type.Object({
  path: Type.String({ description: "Absolute or relative (to /home/web) file path." }),
  offset: Type.Optional(Type.Number({ description: "1-based line number to start at." })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return." })),
});

const WriteParams = Type.Object({
  path: Type.String({ description: "Absolute or relative (to /home/web) file path." }),
  content: Type.String({ description: "The full file contents to write." }),
});

const EditParams = Type.Object({
  path: Type.String({ description: "Absolute or relative (to /home/web) file path." }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({ description: "Exact text to find (must be unique in the file)." }),
      newText: Type.String({ description: "Text to replace it with." }),
    }),
    { description: "One or more exact replacements to apply in order." },
  ),
});

const FetchParams = Type.Object({
  url: Type.String({ description: "Absolute URL to fetch (http/https)." }),
  method: Type.Optional(
    Type.Union([Type.Literal("GET"), Type.Literal("POST")], { description: "HTTP method (default GET)." }),
  ),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Request headers." })),
  body: Type.Optional(Type.String({ description: "Request body for POST." })),
  path: Type.Optional(
    Type.String({
      description:
        "Optional destination in /home/web. Binary responses are written here but not displayed.",
    }),
  ),
});

const ImageParams = Type.Object({
  path: Type.String({
    description: "PNG, JPEG, GIF, or WebP file in the in-browser filesystem.",
  }),
});

const HtmlParams = Type.Object({
  path: Type.String({
    description: "Self-contained HTML file in the in-browser filesystem.",
  }),
});

/* ------------------------------- details ------------------------------- */

export interface PythonDetails {
  ok: boolean;
  bytes: number;
}
export interface ReadDetails {
  path: string;
  lines: number;
  truncated: boolean;
}
export interface WriteDetails {
  path: string;
  bytes: number;
}
export interface EditDetails {
  path: string;
  edits: number;
}
export interface ImageDetails {
  path: string;
  bytes: number;
  mimeType: string;
}
export interface HtmlDetails {
  path: string;
  bytes: number;
}

/* ------------------------------- python -------------------------------- */

export function createPythonTool(py: Pyodide): AgentTool<typeof PythonParams, PythonDetails> {
  return {
    name: "python",
    label: "Python",
    description:
      "Execute Python 3 code in the in-browser pyodide sandbox. stdout and stderr are " +
      "captured and returned. The filesystem you see here (open/read/write files, os, " +
      "pathlib) is the SAME in-browser filesystem the read/write/edit/image tools use. " +
      "Print results; do not rely on return values. Install pure-Python packages with " +
      "`import micropip; await micropip.install('pkg')`.",
    parameters: PythonParams,
    executionMode: "sequential",
    async execute(_id, params, _signal, onUpdate) {
      const { output } = await runPythonCapture(py, params.code, (chunk) => {
        // Surface the live chunk as a partial result so the UI can stream it.
        onUpdate?.({
          content: [text(chunk)],
          details: { ok: true, bytes: chunk.length },
        });
      });
      return {
        content: [text(output.length > 0 ? output : "(no output)\n")],
        details: { ok: true, bytes: output.length },
      };
    },
  };
}

/* -------------------------------- read -------------------------------- */

export function createReadTool(py: Pyodide): AgentTool<typeof ReadParams, ReadDetails> {
  return {
    name: "read",
    label: "Read",
    description:
      "Read a text file from the in-browser filesystem. Returns the contents with line " +
      "numbers. Use offset (1-based line) and limit (line count) to page through large files. " +
      "Paths are relative to /home/web.",
    parameters: ReadParams,
    async execute(_id, params) {
      const path = fsResolve(py, params.path);
      if (!fsExists(py, path)) throw new Error(`File not found: ${path}`);
      if (fsIsDir(py, path)) throw new Error(`Path is a directory: ${path}`);

      const raw = fsReadText(py, path);
      const allLines = raw.split("\n");
      if (raw.endsWith("\n")) allLines.pop();

      const offset = Math.max(1, params.offset ?? 1);
      const limit = params.limit ?? MAX_READ_LINES;
      const start = offset - 1;
      const slice = allLines.slice(start, start + limit);

      let body = slice.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
      const truncated = body.length > MAX_READ_BYTES;
      if (truncated) body = body.slice(0, MAX_READ_BYTES) + "\n…<truncated>";

      const header = `<${path}>`;
      const footer =
        allLines.length > slice.length + start
          ? `\n(${slice.length} of ${allLines.length} lines shown; use offset to read more)`
          : "";

      return {
        content: [text(`${header}\n${body}${footer}\n`)],
        details: { path, lines: slice.length, truncated },
      };
    },
  };
}

/* ------------------------------- image -------------------------------- */

export function createImageTool(py: Pyodide): AgentTool<typeof ImageParams, ImageDetails> {
  return {
    name: "image",
    label: "Image",
    description:
      "Display a PNG, JPEG, GIF, or WebP file from the in-browser filesystem directly " +
      "in the terminal using Ghostty's Kitty graphics protocol. This is the only tool " +
      "that displays an image; call it exactly once after creating or downloading the file.",
    parameters: ImageParams,
    async execute(_id, params) {
      const path = fsResolve(py, params.path);
      if (!fsExists(py, path)) throw new Error(`File not found: ${path}`);
      if (fsIsDir(py, path)) throw new Error(`Path is a directory: ${path}`);
      const bytes = py.FS.readFile(path) as Uint8Array;
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`Image exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit.`);
      }
      const mimeType = detectImageMime(bytes, path);
      if (!mimeType) throw new Error(`Unsupported image format: ${path}`);
      return {
        content: [
          text(`Displaying ${path} (${bytes.byteLength} bytes)\n`),
          { type: "image" as const, data: bytesToBase64(bytes), mimeType },
        ],
        details: { path, bytes: bytes.byteLength, mimeType },
      };
    },
  };
}

/* -------------------------------- html --------------------------------- */

export function createHtmlTool(py: Pyodide): AgentTool<typeof HtmlParams, HtmlDetails> {
  return {
    name: "html",
    label: "HTML",
    description:
      "Open a self-contained HTML file from the in-browser filesystem in a closeable " +
      "browser preview. Write the file first, then call this tool exactly once. Put CSS " +
      "and JavaScript inline; other MEMFS files are not directly addressable by the iframe.",
    parameters: HtmlParams,
    async execute(_id, params) {
      const path = fsResolve(py, params.path);
      if (!fsExists(py, path)) throw new Error(`File not found: ${path}`);
      if (fsIsDir(py, path)) throw new Error(`Path is a directory: ${path}`);

      const html = fsReadText(py, path);
      const bytes = byteLength(html);
      if (bytes > MAX_HTML_BYTES) {
        throw new Error(`HTML exceeds the ${MAX_HTML_BYTES / 1024 / 1024} MB limit.`);
      }
      return {
        content: [text(`Opened ${path} in the browser preview (${bytes} bytes)\n`)],
        details: { path, bytes },
      };
    },
  };
}

/* ------------------------------- write -------------------------------- */

export function createWriteTool(py: Pyodide): AgentTool<typeof WriteParams, WriteDetails> {
  return {
    name: "write",
    label: "Write",
    description:
      "Create or overwrite a file in the in-browser filesystem. Parent directories are " +
      "created automatically. Use this for new files or full rewrites; prefer edit for " +
      "targeted changes.",
    parameters: WriteParams,
    async execute(_id, params) {
      const path = fsResolve(py, params.path);
      const bytes = byteLength(params.content);
      fsWriteText(py, path, params.content);
      return {
        content: [text(`Wrote ${bytes} bytes to ${path}\n`)],
        details: { path, bytes },
      };
    },
  };
}

/* -------------------------------- edit -------------------------------- */

export function createEditTool(py: Pyodide): AgentTool<typeof EditParams, EditDetails> {
  return {
    name: "edit",
    label: "Edit",
    description:
      "Apply exact string replacements to a file in the in-browser filesystem. Each " +
      "edits[].oldText must match a unique region of the file (case- and " +
      "whitespace-sensitive). All edits in one call apply in order. Throws if any " +
      "oldText is missing or not unique.",
    parameters: EditParams,
    async execute(_id, params) {
      const path = fsResolve(py, params.path);
      if (!fsExists(py, path)) throw new Error(`File not found: ${path}`);
      if (fsIsDir(py, path)) throw new Error(`Path is a directory: ${path}`);

      let content = fsReadText(py, path);
      params.edits.forEach((edit, i) => {
        const count = countOccurrences(content, edit.oldText);
        if (count === 0) {
          throw new Error(
            `Edit #${i + 1} failed: oldText not found in ${path}. Make sure it matches exactly.`,
          );
        }
        if (count > 1) {
          throw new Error(
            `Edit #${i + 1} failed: oldText is not unique (${count} matches) in ${path}. ` +
              `Include more surrounding context so it matches exactly once.`,
          );
        }
        content = content.replace(edit.oldText, edit.newText);
      });

      fsWriteText(py, path, content);
      return {
        content: [text(`Edited ${path}: applied ${params.edits.length} replacement(s).\n`)],
        details: { path, edits: params.edits.length },
      };
    },
  };
}

/* -------------------------------- fetch ------------------------------- */

export interface FetchDetails {
  status: number;
  ok: boolean;
  bytes: number;
  truncated: boolean;
  path?: string;
  mimeType?: string;
}

/** A tool that uses the browser's native fetch (subject to CORS). */
export function createFetchTool(py: Pyodide): AgentTool<typeof FetchParams, FetchDetails> {
  return {
    name: "fetch",
    label: "Fetch",
    description:
      "Fetch a URL using the browser's native fetch. Subject to the browser's CORS rules, " +
      "so it works for public APIs and CORS-enabled sites (not arbitrary cross-origin pages). " +
      "Returns text responses. Set path to save a binary or image response in the shared " +
      "in-browser filesystem. Saving never displays the file; call the image tool exactly " +
      "once when the user wants to see it.",
    parameters: FetchParams,
    async execute(_id, params) {
      const resp = await fetch(params.url, {
        method: params.method ?? "GET",
        headers: params.headers as Record<string, string> | undefined,
        body: params.body,
      });

      const responseType = resp.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
      if (params.path || responseType?.startsWith("image/")) {
        const buffer = await resp.arrayBuffer();
        if (buffer.byteLength > MAX_IMAGE_BYTES) {
          throw new Error(`Response exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB binary limit.`);
        }
        const bytes = new Uint8Array(buffer);
        const path = params.path ? fsResolve(py, params.path) : undefined;
        if (path) {
          const slash = path.lastIndexOf("/");
          if (slash > 0) py.FS.mkdirTree(path.slice(0, slash));
          py.FS.writeFile(path, bytes);
        }
        const mimeType = detectImageMime(bytes, path ?? params.url);
        const summary =
          `HTTP ${resp.status} ${resp.statusText} · ${bytes.byteLength} bytes` +
          `${path ? ` · saved ${path}` : ""}\n`;
        return {
          content: [
            text(summary),
            ...(mimeType && !path
              ? [{ type: "image" as const, data: bytesToBase64(bytes), mimeType }]
              : []),
          ],
          details: {
            status: resp.status,
            ok: resp.ok,
            bytes: bytes.byteLength,
            truncated: false,
            path,
            mimeType: mimeType ?? undefined,
          },
        };
      }

      let body = await resp.text();
      const truncated = body.length > MAX_FETCH_BYTES;
      if (truncated) body = body.slice(0, MAX_FETCH_BYTES) + "\n…<truncated>";
      return {
        content: [text(`HTTP ${resp.status} ${resp.statusText}\n${body}\n`)],
        details: { status: resp.status, ok: resp.ok, bytes: body.length, truncated },
      };
    },
  };
}

/* ------------------------------ helpers ------------------------------- */

function detectImageMime(bytes: Uint8Array, path: string): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    return "image/gif";
  }
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    return "image/webp";
  }

  const extension = path.toLowerCase().split(/[?#]/, 1)[0].split(".").pop();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "webp") return "image/webp";
  return null;
}

function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(parts.join(""));
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export type AnyTool = AgentTool<any, any>;
export function createAllTools(
  py: Pyodide,
  getGitLabCredentials: () => GitLabCredentials | null,
): AnyTool[] {
  return [
    createPythonTool(py),
    createReadTool(py),
    createWriteTool(py),
    createEditTool(py),
    createGitTool(py, getGitLabCredentials),
    createFetchTool(py),
    createImageTool(py),
    createHtmlTool(py),
  ];
}
