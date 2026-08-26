import { test } from "node:test";
import assert from "node:assert/strict";
import { runFixture, runFixtureOn } from "./helpers.ts";
import { ERRNO, LOOKUPFLAG, RIGHTS } from "../src/wasi/abi.ts";
import { MemoryFs } from "../src/wasi/memory-fs.ts";
import { WasiHost } from "../src/wasi/host.ts";

test("echo: argv and environment", async () => {
  const run = await runFixture("echo.wasm", {
    args: ["echo.wasm", "hello world", "--flag"],
    env: { TEST_VAR: "it works" },
  });
  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /argv\[0\]=echo\.wasm\n/);
  assert.match(run.stdout, /argv\[1\]=hello world\n/);
  assert.match(run.stdout, /argv\[2\]=--flag\n/);
  assert.match(run.stdout, /TEST_VAR=it works\n/);
  assert.match(run.stdout, /MISSING=\(null\)\n/);
});

test("cat: reads files through the shared filesystem", async () => {
  const fs = new (await import("../src/wasi/memory-fs.ts")).MemoryFs();
  fs.writeFile("/home/web/a.txt", "first\n");
  fs.writeFile("/b.txt", "second\n");
  // The guest libc starts with cwd "/": a relative path resolves there.
  const run = await runFixtureOn(fs, "cat.wasm", {
    args: ["cat.wasm", "/home/web/a.txt", "b.txt"],
  });
  assert.equal(run.exitCode, 0);
  assert.equal(run.stdout, "first\nsecond\n");
});

test("cat: missing file reports the errno and exits non-zero", async () => {
  const run = await runFixture("cat.wasm", { args: ["cat.wasm", "/nope.txt"] });
  assert.equal(run.exitCode, 1);
  assert.match(run.stdout, /cat: \/nope\.txt: .*\n/);
});

test("cat: streams stdin to stdout", async () => {
  const run = await runFixture("cat.wasm", { stdinText: "piped through\n" });
  assert.equal(run.exitCode, 0);
  assert.equal(run.stdout, "piped through\n");
});

test("path_open: lookup flags enforce O_NOFOLLOW on the final symlink", () => {
  const fs = new MemoryFs();
  fs.mkdirTree("/home/web");
  fs.writeFile("/home/web/target.txt", "target");
  fs.symlink("target.txt", "/home/web/link.txt");
  const host = new WasiHost({ fs, preopens: ["/home/web"] });
  const memory = new WebAssembly.Memory({ initial: 1 });
  host.bind({ exports: { memory } } as unknown as WebAssembly.Instance);
  const path = new TextEncoder().encode("link.txt");
  new Uint8Array(memory.buffer).set(path, 0);
  const pathOpen = host.getImportObject().wasi_snapshot_preview1.path_open as (
    fd: number,
    dirflags: number,
    pathPtr: number,
    pathLength: number,
    oflags: number,
    rightsBase: bigint,
    rightsInheriting: bigint,
    fdflags: number,
    resultFdPtr: number,
  ) => number;

  assert.equal(pathOpen(3, 0, 0, path.byteLength, 0, RIGHTS.FD_READ, 0n, 0, 64), ERRNO.LOOP);
  assert.equal(
    pathOpen(3, LOOKUPFLAG.SYMLINK_FOLLOW, 0, path.byteLength, 0, RIGHTS.FD_READ, 0n, 0, 64),
    ERRNO.SUCCESS,
  );
  host.close();
});

test("ls: readdir reports names and WASI filetypes", async () => {
  const fs = new (await import("../src/wasi/memory-fs.ts")).MemoryFs();
  fs.writeFile("/home/web/file.txt", "x");
  fs.mkdir("/home/web/sub", 0o755);
  // wasi-libc passes raw WASI filetypes through d_type (dir=3, reg=4).
  const run = await runFixtureOn(fs, "ls.wasm", { args: ["ls.wasm", "/home/web"] });
  assert.equal(run.exitCode, 0);
  const lines = run.stdout.trim().split("\n");
  assert.ok(lines.includes(". 3"), `expected ". 3" in ${lines}`);
  assert.ok(lines.includes(".. 3"), `expected ".. 3" in ${lines}`);
  assert.ok(lines.includes("file.txt 4"), `expected "file.txt 4" in ${lines}`);
  assert.ok(lines.includes("sub 3"), `expected "sub 3" in ${lines}`);
});

test("ls: readdir continues beyond the first WASI buffer", async () => {
  const fs = new (await import("../src/wasi/memory-fs.ts")).MemoryFs();
  for (let index = 0; index < 350; index++) {
    fs.writeFile(`/home/web/file-${String(index).padStart(3, "0")}.txt`, "x");
  }
  const run = await runFixtureOn(fs, "ls.wasm", { args: ["ls.wasm", "/home/web"] });
  assert.equal(run.exitCode, 0);
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 352);
  assert.equal(lines.filter((line) => /^file-[0-9]{3}\.txt 4$/.test(line)).length, 350);
  assert.ok(lines.includes("file-000.txt 4"));
  assert.ok(lines.includes("file-349.txt 4"));
});

test("fops: full file-operation surface", async () => {
  const run = await runFixture("fops.wasm");
  assert.equal(run.exitCode, 0, run.stdout);
  const expected = `
mkdir: ok
open-write: ok
write: ok
pwrite: ok
tell-after-writes: 10
pread: ok
pread-got: XX45
lseek-set: ok
read-at-3: ok
read-got: X4
open-append: ok
append: ok
stat: ok
size: 13
is-reg: 1
rename: ok
symlink: ok
readlink: ok
target: moved.bin
stat-via-link: ok
lstat-link: ok
lstat-is-lnk: 1
link: ok
stat-hard: ok
nlink: 2
truncate: ok
stat-trunc: ok
trunc-size: 5
unlink-hard: ok
unlink-link: ok
unlink-moved: ok
rmdir: ok
rmdir-missing: No such file or directory
`.trimStart();
  assert.equal(run.stdout, expected);
});

test("poll: stdin readiness and clock sleep", async () => {
  let slept = 0;
  const run = await runFixture("poll.wasm", {
    stdinText: "data",
    sleepSync: (ms) => {
      slept += ms;
    },
  });
  assert.equal(run.exitCode, 0);
  assert.match(run.stdout, /poll-stdin: rc=1 revents=1\n/);
  assert.match(run.stdout, /nanosleep-done \d+\n/);
  assert.ok(slept >= 39 && slept < 5000, `expected ~40ms of sleeping, got ${slept}`);
});

test("exit codes and stderr propagate", async () => {
  const run = await runFixture("exitc.wasm", { args: ["exitc.wasm", "a", "b", "c"] });
  assert.equal(run.exitCode, 4);
  assert.equal(run.stderr, "to-stderr\n");
});
