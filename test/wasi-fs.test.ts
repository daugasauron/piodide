import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryFs } from "../src/wasi/memory-fs.ts";
import { RoutedFs } from "../src/wasi/fs.ts";

test("RoutedFs namespaces device and inode identities across mounts", () => {
  const root = new MemoryFs();
  const mounted = new MemoryFs();
  root.writeFile("/same.h", "root");
  mounted.writeFile("/same.h", "mounted");
  const fs = new RoutedFs(root, [{ prefix: "/sys", fs: mounted }]);

  const rootStat = fs.stat("/same.h", true);
  const mountedStat = fs.stat("/sys/same.h", true);
  assert.notEqual(rootStat.dev, mountedStat.dev);
  assert.notEqual(rootStat.ino, mountedStat.ino);
  assert.equal(fs.readdir("/").find(({ name }) => name === "same.h")?.ino, rootStat.ino);
  assert.equal(fs.readdir("/sys").find(({ name }) => name === "same.h")?.ino, mountedStat.ino);
});
