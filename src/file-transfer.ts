import {
  type Pyodide,
  fsExists,
  fsIsDir,
  fsResolve,
} from "./pyodide-host.ts";

const MAX_TRANSFER_FILE_BYTES = 128 * 1024 * 1024;
const MAX_UPLOAD_BATCH_BYTES = 256 * 1024 * 1024;

export interface DownloadResult {
  path: string;
  name: string;
  bytes: number;
}

export interface UploadResult {
  directory: string;
  paths: string[];
  skipped: string[];
  bytes: number;
}

let uploadInput: HTMLInputElement | null = null;

export function downloadPyodideFile(py: Pyodide, value: string): DownloadResult {
  const path = fsResolve(py, value.trim());
  if (!fsExists(py, path)) throw new Error(`File not found: ${path}`);
  if (fsIsDir(py, path)) throw new Error(`Path is a directory: ${path}`);

  const size = py.FS.stat(path).size;
  if (size > MAX_TRANSFER_FILE_BYTES) {
    throw new Error(
      `File is ${formatBytes(size)}; browser download limit is ${formatBytes(MAX_TRANSFER_FILE_BYTES)}.`,
    );
  }
  const bytes = new Uint8Array(py.FS.readFile(path) as Uint8Array);
  const rawName = path.split("/").pop() || "download";
  const name = rawName.replace(/[\u0000-\u001f\u007f]/g, "_") || "download";
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return { path, name, bytes: bytes.byteLength };
}

export function pickHostFiles(): Promise<File[]> {
  const input = getUploadInput();
  input.value = "";
  return new Promise<File[]>((resolve, reject) => {
    let settled = false;
    let focusTimer: number | null = null;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      if (focusTimer !== null) window.clearTimeout(focusTimer);
      input.removeEventListener("change", onChange);
      input.removeEventListener("cancel", onCancel);
      window.removeEventListener("focus", onFocus);
      resolve(files);
    };
    const onChange = () => finish(Array.from(input.files ?? []));
    const onCancel = () => finish([]);
    const onFocus = () => {
      focusTimer = window.setTimeout(() => finish(Array.from(input.files ?? [])), 250);
    };
    input.addEventListener("change", onChange);
    input.addEventListener("cancel", onCancel);
    window.addEventListener("focus", onFocus);
    try {
      input.click();
    } catch (error) {
      input.removeEventListener("change", onChange);
      input.removeEventListener("cancel", onCancel);
      window.removeEventListener("focus", onFocus);
      reject(error);
    }
  });
}

export function resolveUploadDirectory(py: Pyodide, value?: string): string {
  const directory = fsResolve(py, value?.trim() || "/home/web");
  if (directory !== "/home/web" && !directory.startsWith("/home/web/")) {
    throw new Error("Uploads must stay inside /home/web.");
  }
  if (fsExists(py, directory) && !fsIsDir(py, directory)) {
    throw new Error(`Upload destination is not a directory: ${directory}`);
  }
  return directory;
}

export function uploadConflicts(
  py: Pyodide,
  directory: string,
  files: readonly File[],
): string[] {
  return files
    .map((file) => `${directory}/${safeUploadName(file.name)}`)
    .filter((path) => fsExists(py, path));
}

export async function uploadHostFiles(
  py: Pyodide,
  directory: string,
  files: readonly File[],
  overwrite: boolean,
): Promise<UploadResult> {
  let total = 0;
  for (const file of files) {
    if (file.size > MAX_TRANSFER_FILE_BYTES) {
      throw new Error(
        `${file.name} is ${formatBytes(file.size)}; upload limit is ${formatBytes(MAX_TRANSFER_FILE_BYTES)} per file.`,
      );
    }
    total += file.size;
    if (total > MAX_UPLOAD_BATCH_BYTES) {
      throw new Error(`Upload batch exceeds ${formatBytes(MAX_UPLOAD_BATCH_BYTES)}.`);
    }
    safeUploadName(file.name);
  }

  py.FS.mkdirTree(directory);
  const paths: string[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const path = `${directory}/${safeUploadName(file.name)}`;
    if (fsExists(py, path) && !overwrite) {
      skipped.push(path);
      continue;
    }
    const data = new Uint8Array(await file.arrayBuffer());
    py.FS.writeFile(path, data);
    paths.push(path);
    bytes += data.byteLength;
  }
  return { directory, paths, skipped, bytes };
}

function getUploadInput(): HTMLInputElement {
  if (uploadInput) return uploadInput;
  uploadInput = document.createElement("input");
  uploadInput.type = "file";
  uploadInput.multiple = true;
  uploadInput.hidden = true;
  uploadInput.setAttribute("aria-hidden", "true");
  document.body.appendChild(uploadInput);
  return uploadInput;
}

function safeUploadName(value: string): string {
  const name = value.replaceAll("\\", "/").split("/").pop() || "";
  if (!name || name === "." || name === ".." || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new Error(`Unsafe upload filename: ${value}`);
  }
  return name;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${Math.ceil(value / 1024 / 1024)} MB`;
  if (value >= 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${value} bytes`;
}
