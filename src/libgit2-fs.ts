import type { Pyodide } from "./pyodide-host.ts";
import {
  forgetEmscriptenSymlinkTarget,
  preserveEmscriptenSymlinkTarget,
  preservedEmscriptenSymlinkTarget,
} from "./wasi/emscripten-fs.ts";

interface WasmGitModule {
  FS: any;
  HEAPU8: Uint8Array;
  MEMFS: any;
}

/** Mount Pyodide's live MEMFS into wasm-git's Emscripten filesystem. */
export function createPyodideGitFs(module: WasmGitModule, py: Pyodide) {
  const FS = module.FS;
  const source = py.FS as any;
  const encoder = new TextEncoder();
  let mappingId = 0;

  const translateError = (error: unknown): never => {
    if (error && typeof error === "object" && "errno" in error) {
      throw new FS.ErrnoError((error as { errno: number }).errno);
    }
    throw error;
  };
  const attempt = <T>(operation: () => T): T => {
    try {
      return operation();
    } catch (error) {
      return translateError(error);
    }
  };
  const realPath = (node: any): string => {
    const parts: string[] = [];
    while (node.parent !== node) {
      parts.push(node.name);
      node = node.parent;
    }
    parts.push(node.mount.opts.root);
    return parts.reverse().join("/").replaceAll(/\/{2,}/g, "/");
  };
  const mode = (path: string): number => attempt(() => source.lstat(path).mode);
  const toSourcePath = (path: string): string => path === "/workspace"
    ? "/home/web"
    : path.startsWith("/workspace/") ? `/home/web/${path.slice("/workspace/".length)}` : path;
  const toMountedPath = (path: string): string => path === "/home/web"
    ? "/workspace"
    : path.startsWith("/home/web/") ? `/workspace/${path.slice("/home/web/".length)}` : path;
  const createNode = (parent: any, name: string, nodeMode: number, dev = 0) => {
    if (!FS.isDir(nodeMode) && !FS.isFile(nodeMode) && !FS.isLink(nodeMode)) {
      throw new FS.ErrnoError(28);
    }
    const node = FS.createNode(parent, name, nodeMode, dev);
    node.node_ops = backend.node_ops;
    node.stream_ops = backend.stream_ops;
    return node;
  };
  const attributes = (node: any, stat: any, path: string) => ({
    dev: stat.dev ?? 1,
    ino: node.id,
    mode: stat.mode,
    nlink: stat.nlink ?? 1,
    uid: stat.uid ?? 0,
    gid: stat.gid ?? 0,
    rdev: stat.rdev ?? 0,
    size: FS.isLink(stat.mode)
      ? encoder.encode(preservedEmscriptenSymlinkTarget(source, path) ?? source.readlink(path)).byteLength
      : stat.size ?? 0,
    atime: stat.atime ?? new Date(0),
    mtime: stat.mtime ?? new Date(0),
    ctime: stat.ctime ?? stat.mtime ?? new Date(0),
    blksize: stat.blksize ?? 4096,
    blocks: stat.blocks ?? Math.ceil((stat.size ?? 0) / 4096),
  });
  const setAttributes = (path: string, node: any, attr: any) => attempt(() => {
    if (attr.mode !== undefined) {
      source.chmod(path, attr.mode);
      node.mode = attr.mode;
    }
    if (attr.atime !== undefined || attr.mtime !== undefined) {
      const current = source.lstat(path);
      const time = (value: unknown, fallback: unknown) => {
        const selected = value ?? fallback;
        return selected instanceof Date ? selected.getTime() : Number(selected);
      };
      source.utime(
        path,
        time(attr.atime, current.atime),
        time(attr.mtime, current.mtime),
      );
    }
    if (attr.size !== undefined) source.truncate(path, attr.size);
  });

  const backend = {
    mount(mount: any) {
      return createNode(null, "/", mode(mount.opts.root));
    },
    node_ops: {
      getattr(node: any) {
        return attempt(() => {
          const path = realPath(node);
          return attributes(node, source.lstat(path), path);
        });
      },
      setattr(node: any, attr: any) {
        return setAttributes(realPath(node), node, attr);
      },
      lookup(parent: any, name: string) {
        const path = `${realPath(parent)}/${name}`;
        return createNode(parent, name, mode(path));
      },
      mknod(parent: any, name: string, nodeMode: number, dev: number) {
        const node = createNode(parent, name, nodeMode, dev);
        const path = realPath(node);
        attempt(() => {
          if (FS.isDir(nodeMode)) source.mkdir(path, nodeMode & 0o777);
          else {
            source.writeFile(path, new Uint8Array());
            source.chmod(path, nodeMode & 0o777);
          }
        });
        return node;
      },
      rename(oldNode: any, newDir: any, newName: string) {
        const oldPath = realPath(oldNode);
        const newPath = `${realPath(newDir)}/${newName}`;
        attempt(() => source.rename(oldPath, newPath));
        oldNode.name = newName;
      },
      unlink(parent: any, name: string) {
        return attempt(() => {
          const path = `${realPath(parent)}/${name}`;
          forgetEmscriptenSymlinkTarget(source, path);
          source.unlink(path);
        });
      },
      rmdir(parent: any, name: string) {
        return attempt(() => source.rmdir(`${realPath(parent)}/${name}`));
      },
      readdir(node: any) {
        return attempt(() => source.readdir(realPath(node)).filter(
          (name: string) => name !== "." && name !== "..",
        ));
      },
      symlink(parent: any, newName: string, oldPath: string) {
        // Emscripten resolves link targets inside the mounted /workspace tree.
        // Translate that virtual target before creating the link in Pyodide's
        // /home/web MEMFS or the link silently points outside the workspace.
        return attempt(() => {
          const path = `${realPath(parent)}/${newName}`;
          const target = toSourcePath(oldPath);
          source.symlink(target, path);
          preserveEmscriptenSymlinkTarget(source, path, target);
        });
      },
      readlink(node: any) {
        const path = realPath(node);
        const preserved = preservedEmscriptenSymlinkTarget(source, path);
        if (preserved !== undefined) return preserved;
        // Fall back to the mounted namespace for links created before exact
        // payload tracking was installed.
        return attempt(() => toMountedPath(source.readlink(path)));
      },
      statfs() {
        return {
          bsize: 4096,
          frsize: 4096,
          blocks: 1_048_576,
          bfree: 524_288,
          bavail: 524_288,
          files: 1_000_000,
          ffree: 900_000,
          fsid: 42,
          flags: 2,
          namelen: 255,
        };
      },
    },
    stream_ops: {
      getattr(stream: any) {
        return attempt(() => {
          const path = realPath(stream.node);
          return attributes(stream.node, source.lstat(path), path);
        });
      },
      setattr(stream: any, attr: any) {
        return setAttributes(realPath(stream.node), stream.node, attr);
      },
      open(stream: any) {
        attempt(() => {
          stream.shared.proxyRefcount = 1;
          stream.shared.proxyStream = source.open(realPath(stream.node), stream.flags);
        });
      },
      close(stream: any) {
        attempt(() => {
          stream.shared.proxyRefcount--;
          if (stream.shared.proxyRefcount === 0) source.close(stream.shared.proxyStream);
        });
      },
      dup(stream: any) {
        stream.shared.proxyRefcount++;
      },
      read(stream: any, buffer: Uint8Array, offset: number, length: number, position: number) {
        return attempt(() => source.read(stream.shared.proxyStream, buffer, offset, length, position));
      },
      write(stream: any, buffer: Uint8Array, offset: number, length: number, position: number) {
        return attempt(() => source.write(stream.shared.proxyStream, buffer, offset, length, position));
      },
      llseek(stream: any, offset: number, whence: number) {
        let position = offset;
        if (whence === 1) position += stream.position;
        else if (whence === 2) position += source.lstat(realPath(stream.node)).size;
        if (position < 0) throw new FS.ErrnoError(28);
        return position;
      },
      mmap(stream: any, length: number, position: number, prot: number, flags: number) {
        if (!FS.isFile(stream.node.mode)) throw new FS.ErrnoError(43);
        // wasm-git does not export malloc.  Let its native MEMFS backend make
        // the correctly aligned mmap allocation, then discard the scratch file.
        const bytes = new Uint8Array(length);
        const read = attempt(() => source.read(
          stream.shared.proxyStream,
          bytes,
          0,
          length,
          position,
        ));
        if (read < length) bytes.fill(0, read);
        const scratchPath = `/tmp/piodide-git-mmap-${mappingId++}`;
        FS.writeFile(scratchPath, new Uint8Array());
        const scratch = FS.open(scratchPath, "r");
        try {
          scratch.node.contents = bytes;
          scratch.node.usedBytes = bytes.byteLength;
          return module.MEMFS.stream_ops.mmap(scratch, length, 0, prot, flags);
        } finally {
          FS.close(scratch);
          FS.unlink(scratchPath);
        }
      },
      msync(stream: any, buffer: Uint8Array, offset: number, length: number) {
        return attempt(() => source.write(stream.shared.proxyStream, buffer, 0, length, offset));
      },
    },
  };

  return backend;
}
