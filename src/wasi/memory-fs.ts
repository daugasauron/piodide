/**
 * Dependency-free in-memory `WasiFs` implementation.
 *
 * Used by the Node test-suite, as the compiler sysroot overlay, and as a
 * general fallback. Supports files, directories, symlinks, and hard links.
 */
import {
  ERRNO,
  FILETYPE,
  WasiError,
  normalizePath,
  type Filetype,
  type WasiStat,
} from "./abi.ts";
import type { WasiDirEntry, WasiFs, WasiHandle, WasiOpenOptions } from "./fs.ts";

const MAX_SYMLINK_DEPTH = 16;

type Node = FileNode | DirNode | LinkNode;

interface BaseNode {
  ino: bigint;
  mode: number;
  nlink: bigint;
  atim: bigint;
  mtim: bigint;
  ctim: bigint;
}

interface FileNode extends BaseNode {
  kind: "file";
  content: Uint8Array;
}

interface DirNode extends BaseNode {
  kind: "dir";
  children: Map<string, Node>;
}

interface LinkNode extends BaseNode {
  kind: "link";
  target: string;
}

interface MemoryHandle {
  node: Node;
  read: boolean;
  write: boolean;
  append: boolean;
  /** Position used only when the host passes position=null. */
  position: number;
}

function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}

function freshNode(ino: bigint, mode: number): BaseNode {
  const now = nowNs();
  return { ino, mode, nlink: 1n, atim: now, mtim: now, ctim: now };
}

export class MemoryFs implements WasiFs {
  private root: DirNode;
  private nextIno = 2n;

  constructor() {
    this.root = {
      ...freshNode(1n, 0o755),
      kind: "dir",
      children: new Map(),
    };
  }

  /* ------------------------- convenience setup ------------------------- */

  /** Test/setup helper: write a file, creating parent directories. */
  writeFile(path: string, data: Uint8Array | string): void {
    const normalized = normalizePath(path);
    const { parent, name } = this.ensureParent(normalized);
    const existing = parent.children.get(name);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (existing && existing.kind === "dir") {
      throw new WasiError(ERRNO.ISDIR, `is a directory: ${normalized}`);
    }
    if (existing && existing.kind === "file") {
      existing.content = bytes.slice();
      existing.mtim = nowNs();
      return;
    }
    const node: FileNode = { ...freshNode(this.allocIno(), 0o644), kind: "file", content: bytes.slice() };
    parent.children.set(name, node);
  }

  /** Test/setup helper. */
  readFile(path: string): Uint8Array {
    const node = this.lookup(normalizePath(path), true);
    if (node.kind !== "file") throw new WasiError(ERRNO.ISDIR, `not a file: ${path}`);
    return node.content.slice();
  }

  /** Test/setup helper: create a directory and all parents. */
  mkdirTree(path: string): void {
    const segments = normalizePath(path).split("/").filter((s) => s.length > 0);
    let current = "";
    for (const segment of segments) {
      current += `/${segment}`;
      if (this.exists(current)) continue;
      this.mkdir(current, 0o755);
    }
  }

  /** Test/setup helper. */
  exists(path: string): boolean {
    try {
      this.lookup(normalizePath(path), true);
      return true;
    } catch {
      return false;
    }
  }

  /* ------------------------------ internals ---------------------------- */

  private allocIno(): bigint {
    return this.nextIno++;
  }

  private ensureParent(path: string): { parent: DirNode; name: string } {
    const segments = path.split("/").filter((s) => s.length > 0);
    const name = segments.pop();
    if (name === undefined) throw new WasiError(ERRNO.PERM, `cannot modify root`);
    let dir = this.root;
    for (const segment of segments) {
      let child = dir.children.get(segment);
      if (child === undefined) {
        const created: DirNode = {
          ...freshNode(this.allocIno(), 0o755),
          kind: "dir",
          children: new Map(),
        };
        dir.children.set(segment, created);
        child = created;
      }
      if (child.kind === "link") child = this.resolveLink(child, dir);
      if (child.kind !== "dir") {
        throw new WasiError(ERRNO.NOTDIR, `not a directory: ${segment}`);
      }
      dir = child;
    }
    return { parent: dir, name };
  }

  private resolveLink(link: LinkNode, _parent: DirNode): Node {
    // MemoryFs symlinks are resolved during lookup; a bare resolveLink is a
    // shallow single hop relative to root-relative targets.
    const target = link.target.startsWith("/")
      ? link.target
      : normalizePath(link.target);
    return this.lookup(target, true);
  }

  /**
   * Resolve `path` (absolute, normalized) to a node. `follow` controls the
   * final component; intermediate symlinks are always followed.
   */
  private lookup(path: string, follow: boolean, depth = 0): Node {
    if (depth > MAX_SYMLINK_DEPTH) {
      throw new WasiError(ERRNO.LOOP, `too many symlinks: ${path}`);
    }
    const segments = path.split("/").filter((s) => s.length > 0);
    let node: Node = this.root;
    let resolvedPrefix = "";
    for (let i = 0; i < segments.length; i++) {
      if (node.kind === "link") {
        // Intermediate component after a symlink parent — handled by the
        // branch below via recursion; unreachable in practice.
        throw new WasiError(ERRNO.NOTDIR, `not a directory: ${path}`);
      }
      if (node.kind !== "dir") {
        throw new WasiError(ERRNO.NOTDIR, `not a directory: ${path}`);
      }
      const child = node.children.get(segments[i]);
      if (child === undefined) {
        throw new WasiError(ERRNO.NOENT, `no such file: ${path}`);
      }
      const isFinal = i === segments.length - 1;
      if (child.kind === "link" && (follow || !isFinal)) {
        const base = resolvedPrefix === "" ? "/" : resolvedPrefix;
        const target = child.target.startsWith("/")
          ? normalizePath(child.target)
          : normalizePath(`${base}/${child.target}`);
        const rest = segments.slice(i + 1).join("/");
        const combined = rest ? `${target}/${rest}` : target;
        return this.lookup(combined, follow, depth + 1);
      }
      resolvedPrefix += `/${segments[i]}`;
      node = child;
    }
    return node;
  }

  private parentOf(path: string): { parent: DirNode; name: string } {
    const segments = path.split("/").filter((s) => s.length > 0);
    const name = segments.pop();
    if (name === undefined) throw new WasiError(ERRNO.PERM, `cannot modify root`);
    const parentPath = `/${segments.join("/")}`;
    const parent = this.lookup(parentPath, true);
    if (parent.kind !== "dir") {
      throw new WasiError(ERRNO.NOTDIR, `not a directory: ${parentPath}`);
    }
    return { parent, name };
  }

  private statNode(node: Node): WasiStat {
    const filetype: Filetype =
      node.kind === "dir"
        ? FILETYPE.DIRECTORY
        : node.kind === "file"
          ? FILETYPE.REGULAR_FILE
          : FILETYPE.SYMBOLIC_LINK;
    const size =
      node.kind === "file"
        ? BigInt(node.content.byteLength)
        : node.kind === "link"
          ? BigInt(new TextEncoder().encode(node.target).byteLength)
          : 0n;
    return {
      dev: 0n,
      ino: node.ino,
      filetype,
      nlink: node.nlink,
      size,
      atim: node.atim,
      mtim: node.mtim,
      ctim: node.ctim,
    };
  }

  /* ------------------------------- WasiFs ------------------------------ */

  open(path: string, options: WasiOpenOptions, mode: number): WasiHandle {
    let node: Node | undefined;
    try {
      node = this.lookup(path, options.followSymlinks);
    } catch (error) {
      if (
        error instanceof WasiError &&
        error.errno === ERRNO.NOENT &&
        options.create
      ) {
        node = undefined;
      } else {
        throw error;
      }
    }

    if (node === undefined) {
      if (!options.create) throw new WasiError(ERRNO.NOENT, `no such file: ${path}`);
      const { parent, name } = this.parentOf(path);
      const created: FileNode = {
        ...freshNode(this.allocIno(), mode & 0o7777 || 0o644),
        kind: "file",
        content: new Uint8Array(),
      };
      parent.children.set(name, created);
      node = created;
    } else {
      if (options.create && options.createExcl) {
        throw new WasiError(ERRNO.EXIST, `file exists: ${path}`);
      }
      if (node.kind === "link") {
        // O_NOFOLLOW on a symlink.
        throw new WasiError(ERRNO.LOOP, `symlink with O_NOFOLLOW: ${path}`);
      }
      if (options.directory && node.kind !== "dir") {
        throw new WasiError(ERRNO.NOTDIR, `not a directory: ${path}`);
      }
      if (node.kind === "dir" && options.write) {
        throw new WasiError(ERRNO.ISDIR, `is a directory: ${path}`);
      }
      if (options.truncate) {
        if (!options.write) throw new WasiError(ERRNO.ACCES, `O_TRUNC without write: ${path}`);
        if (node.kind !== "file") throw new WasiError(ERRNO.ISDIR, `not a file: ${path}`);
        node.content = new Uint8Array();
        node.mtim = nowNs();
      }
    }

    node.atim = nowNs();
    const handle: MemoryHandle = {
      node,
      read: options.read,
      write: options.write,
      append: options.append,
      position: 0,
    };
    return handle;
  }

  close(handle: WasiHandle): void {
    (handle as MemoryHandle).node.atim = nowNs();
  }

  read(handle: WasiHandle, position: bigint | null, length: number): Uint8Array {
    const h = handle as MemoryHandle;
    if (!h.read) throw new WasiError(ERRNO.BADF, `handle not open for reading`);
    if (h.node.kind !== "file") throw new WasiError(ERRNO.ISDIR, `read on non-file`);
    const start = position === null ? h.position : Number(position);
    if (start >= h.node.content.byteLength || length <= 0) return new Uint8Array();
    const end = Math.min(h.node.content.byteLength, start + length);
    const out = h.node.content.slice(start, end);
    if (position === null) h.position = end;
    h.node.atim = nowNs();
    return out;
  }

  write(handle: WasiHandle, position: bigint | null, data: Uint8Array): number {
    const h = handle as MemoryHandle;
    if (!h.write) throw new WasiError(ERRNO.BADF, `handle not open for writing`);
    if (h.node.kind !== "file") throw new WasiError(ERRNO.ISDIR, `write on non-file`);
    const start = position === null
      ? (h.append ? h.node.content.byteLength : h.position)
      : Number(position);
    const end = start + data.byteLength;
    if (end > h.node.content.byteLength) {
      const grown = new Uint8Array(end);
      grown.set(h.node.content, 0);
      h.node.content = grown;
    }
    h.node.content.set(data, start);
    if (position === null) h.position = end;
    h.node.mtim = nowNs();
    return data.byteLength;
  }

  size(handle: WasiHandle): bigint {
    const h = handle as MemoryHandle;
    if (h.node.kind === "dir") return 0n;
    if (h.node.kind === "link") return BigInt(h.node.target.length);
    return BigInt(h.node.content.byteLength);
  }

  sync(_handle: WasiHandle): void {
    // Memory-backed: nothing to flush.
  }

  stat(path: string, followSymlinks: boolean): WasiStat {
    return this.statNode(this.lookup(path, followSymlinks));
  }

  readdir(path: string): WasiDirEntry[] {
    const node = this.lookup(path, true);
    if (node.kind !== "dir") throw new WasiError(ERRNO.NOTDIR, `not a directory: ${path}`);
    node.atim = nowNs();
    return [...node.children.entries()].map(([name, child]) => ({
      name,
      filetype:
        child.kind === "dir"
          ? FILETYPE.DIRECTORY
          : child.kind === "file"
            ? FILETYPE.REGULAR_FILE
            : FILETYPE.SYMBOLIC_LINK,
      ino: child.ino,
    }));
  }

  mkdir(path: string, mode: number): void {
    const { parent, name } = this.parentOf(path);
    const existing = parent.children.get(name);
    if (existing !== undefined) {
      if (existing.kind === "dir") throw new WasiError(ERRNO.EXIST, `file exists: ${path}`);
      throw new WasiError(ERRNO.EXIST, `file exists: ${path}`);
    }
    parent.children.set(name, {
      ...freshNode(this.allocIno(), mode & 0o7777 || 0o755),
      kind: "dir",
      children: new Map(),
    });
  }

  rmdir(path: string): void {
    const { parent, name } = this.parentOf(path);
    const node = parent.children.get(name);
    if (node === undefined) throw new WasiError(ERRNO.NOENT, `no such file: ${path}`);
    if (node.kind === "link") {
      // POSIX: rmdir on a symlink fails ENOTDIR.
      throw new WasiError(ERRNO.NOTDIR, `not a directory: ${path}`);
    }
    if (node.kind !== "dir") throw new WasiError(ERRNO.NOTDIR, `not a directory: ${path}`);
    if (node.children.size > 0) throw new WasiError(ERRNO.NOTEMPTY, `directory not empty: ${path}`);
    parent.children.delete(name);
  }

  unlink(path: string): void {
    const { parent, name } = this.parentOf(path);
    const node = parent.children.get(name);
    if (node === undefined) throw new WasiError(ERRNO.NOENT, `no such file: ${path}`);
    if (node.kind === "dir") throw new WasiError(ERRNO.ISDIR, `is a directory: ${path}`);
    node.nlink -= 1n;
    parent.children.delete(name);
  }

  rename(from: string, to: string): void {
    if (from === to) return;
    if (to.startsWith(`${from}/`)) {
      throw new WasiError(ERRNO.INVAL, `cannot rename into own subdirectory`);
    }
    const source = this.parentOf(from);
    const node = source.parent.children.get(source.name);
    if (node === undefined) throw new WasiError(ERRNO.NOENT, `no such file: ${from}`);
    const target = this.parentOf(to);
    const existing = target.parent.children.get(target.name);
    if (existing !== undefined) {
      if (node.kind === "dir") {
        if (existing.kind !== "dir") throw new WasiError(ERRNO.NOTDIR, `not a directory: ${to}`);
        if (existing.children.size > 0) {
          throw new WasiError(ERRNO.NOTEMPTY, `directory not empty: ${to}`);
        }
      } else if (existing.kind === "dir") {
        throw new WasiError(ERRNO.ISDIR, `is a directory: ${to}`);
      }
      target.parent.children.delete(target.name);
    }
    source.parent.children.delete(source.name);
    target.parent.children.set(target.name, node);
    node.ctim = nowNs();
  }

  link(existing: string, path: string): void {
    const node = this.lookup(existing, true);
    if (node.kind === "dir") throw new WasiError(ERRNO.PERM, `hard link on directory: ${existing}`);
    const { parent, name } = this.parentOf(path);
    if (parent.children.has(name)) throw new WasiError(ERRNO.EXIST, `file exists: ${path}`);
    parent.children.set(name, node);
    node.nlink += 1n;
    node.ctim = nowNs();
  }

  symlink(target: string, path: string): void {
    const { parent, name } = this.parentOf(path);
    if (parent.children.has(name)) throw new WasiError(ERRNO.EXIST, `file exists: ${path}`);
    parent.children.set(name, {
      ...freshNode(this.allocIno(), 0o777),
      kind: "link",
      target,
    });
  }

  readlink(path: string): string {
    const node = this.lookup(path, false);
    if (node.kind !== "link") throw new WasiError(ERRNO.INVAL, `not a symlink: ${path}`);
    return node.target;
  }

  truncate(path: string, size: bigint): void {
    const node = this.lookup(path, true);
    if (node.kind !== "file") throw new WasiError(ERRNO.ISDIR, `not a file: ${path}`);
    const length = Number(size);
    if (length < node.content.byteLength) {
      node.content = node.content.slice(0, length);
    } else if (length > node.content.byteLength) {
      const grown = new Uint8Array(length);
      grown.set(node.content, 0);
      node.content = grown;
    }
    node.mtim = nowNs();
  }

  utimes(path: string, atim: bigint | null, mtim: bigint | null): void {
    const node = this.lookup(path, true);
    if (atim !== null) node.atim = atim;
    if (mtim !== null) node.mtim = mtim;
    node.ctim = nowNs();
  }
}
