import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync, inflateSync } from "node:zlib";
import { loadPyodide } from "pyodide";

import { runGitEngineCommand } from "../src/git-engine.ts";
import { createGitTool } from "../src/git-tool.ts";
import type { Pyodide } from "../src/pyodide-host.ts";

async function git(py: Pyodide, cwd: string, ...args: string[]): Promise<string> {
  const response = await runGitEngineCommand({ py, cwd, args: ["git-engine", ...args] });
  const output = new TextDecoder().decode(response.stdout ?? response.stderr ?? new Uint8Array());
  assert.equal(response.exitCode, 0, output);
  return output;
}

async function gitResult(py: Pyodide, cwd: string, ...args: string[]) {
  const response = await runGitEngineCommand({ py, cwd, args: ["git-engine", ...args] });
  return {
    exitCode: response.exitCode,
    output: new TextDecoder().decode(response.stdout ?? response.stderr ?? new Uint8Array()),
  };
}

function startGitHttpServer(projectRoot: string) {
  const server = createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type, git-protocol",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const target = new URL(request.url || "/", "http://localhost");
    const output = execFileSync("git", ["http-backend"], {
      input: Buffer.concat(chunks),
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: target.pathname,
        QUERY_STRING: target.search.slice(1),
        REQUEST_METHOD: request.method || "GET",
        CONTENT_TYPE: String(request.headers["content-type"] || ""),
        CONTENT_LENGTH: request.headers["content-length"] || "0",
        HTTP_GIT_PROTOCOL: String(request.headers["git-protocol"] || ""),
      },
    });
    const separator = output.indexOf("\r\n\r\n");
    const rawHeaders = output.subarray(0, separator).toString("utf8");
    const body = output.subarray(separator + 4);
    let status = 200;
    const headers: Record<string, string> = { "Access-Control-Allow-Origin": "*" };
    for (const line of rawHeaders.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const name = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.split(" ", 1)[0]);
      else headers[name] = value;
    }
    response.writeHead(status, headers);
    response.end(body);
  });
  return new Promise<{ server: typeof server; url: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function exportTree(py: Pyodide, source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const name of py.FS.readdir(source)) {
    if (name === "." || name === "..") continue;
    const from = `${source}/${name}`;
    const to = join(destination, name);
    const stat = py.FS.lstat(from);
    if (py.FS.isDir(stat.mode)) exportTree(py, from, to);
    else if (py.FS.isLink?.(stat.mode)) symlinkSync(py.FS.readlink(from), to);
    else writeFileSync(to, py.FS.readFile(from) as Uint8Array, { mode: stat.mode & 0o777 });
  }
}

function importTree(py: Pyodide, source: string, destination: string): void {
  py.FS.mkdirTree(destination);
  for (const name of readdirSync(source)) {
    const from = join(source, name);
    const to = `${destination}/${name}`;
    const stat = lstatSync(from);
    if (stat.isDirectory()) importTree(py, from, to);
    else if (stat.isSymbolicLink()) py.FS.symlink(readlinkSync(from), to);
    else {
      py.FS.writeFile(to, new Uint8Array(readFileSync(from)));
      py.FS.chmod(to, stat.mode & 0o777);
    }
  }
}

test("libgit2 repositories interoperate with Git, including packed objects", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/generated";
  py.FS.mkdirTree(repository);

  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/value.txt`, "main\n");
  py.FS.symlink("value.txt", `${repository}/value-link`);
  await git(py, repository, "add", "--", ".");
  await git(py, repository, "commit", "-m", "initial");
  await git(py, repository, "switch", "-c", "feature");
  py.FS.writeFile(`${repository}/value.txt`, "feature\n");
  await git(py, repository, "add", "value.txt");
  await git(py, repository, "commit", "-m", "feature change");
  await git(py, repository, "switch", "main");
  assert.equal(py.FS.readFile(`${repository}/value.txt`, { encoding: "utf8" }), "main\n");
  py.FS.mkdirTree(`${repository}/src`);
  py.FS.writeFile(`${repository}/src/nested.txt`, "nested\n");
  await git(py, `${repository}/src`, "add", "nested.txt");
  await git(py, `${repository}/src`, "commit", "-m", "subdirectory pathspec");
  assert.equal(await git(py, `${repository}/src`, "rev-parse", "--show-toplevel"), `${repository}\n`);

  const temporary = mkdtempSync(join(tmpdir(), "piodide-git-interop-"));
  const hostRepository = join(temporary, "repo");
  try {
    exportTree(py, repository, hostRepository);
    execFileSync("git", ["-C", hostRepository, "fsck", "--full"], { stdio: "pipe" });
    assert.equal(
      execFileSync("git", ["-C", hostRepository, "show", "main:value-link"], { encoding: "utf8" }),
      "value.txt",
    );
    assert.equal(
      execFileSync("git", ["-C", hostRepository, "log", "--format=%s", "main"], { encoding: "utf8" }),
      "subdirectory pathspec\ninitial\n",
    );

    execFileSync("git", ["-C", hostRepository, "repack", "-ad"], { stdio: "pipe" });
    execFileSync("git", ["-C", hostRepository, "pack-refs", "--all"], { stdio: "pipe" });
    assert.ok(readdirSync(join(hostRepository, ".git", "objects", "pack")).some(
      (name) => name.endsWith(".pack"),
    ));

    const hostBare = join(temporary, "bare.git");
    execFileSync("git", ["clone", "--bare", hostRepository, hostBare], { stdio: "pipe" });
    importTree(py, hostBare, "/home/web/bare.git");
    await git(py, "/home/web", "clone", "bare.git", "writer");
    py.FS.writeFile("/home/web/writer/pushed.txt", "pushed\n");
    await git(py, "/home/web/writer", "add", "pushed.txt");
    await git(py, "/home/web/writer", "commit", "-m", "local push");
    assert.equal(py.FS.readlink("/home/web/writer/value-link"), "value.txt");
    await git(py, "/home/web/writer", "push", "origin", "main");
    await git(py, "/home/web", "clone", "bare.git", "reader");
    assert.equal(py.FS.readFile("/home/web/reader/pushed.txt", { encoding: "utf8" }), "pushed\n");

    const packed = "/home/web/packed";
    importTree(py, hostRepository, packed);
    assert.match(await git(py, packed, "branch"), /feature/);
    await git(py, packed, "switch", "feature");
    assert.equal(py.FS.readFile(`${packed}/value.txt`, { encoding: "utf8" }), "feature\n");
    assert.match(await git(py, packed, "log", "--oneline", "-n", "2"), /feature change/);

    const missingBranch = await gitResult(py, "/home/web", "clone", "-b", "missing-branch", "packed", "failed-clone");
    assert.notEqual(missingBranch.exitCode, 0);
    assert.equal(py.FS.analyzePath("/home/web/failed-clone").exists, false);

    const clonedOutput = await git(py, "/home/web", "clone", "-b", "main", "packed", "cloned");
    assert.doesNotMatch(clonedOutput, /\(null\)|repo 0x|\/workspace/);
    assert.equal(py.FS.readFile("/home/web/cloned/value.txt", { encoding: "utf8" }), "main\n");
    assert.match(await git(py, "/home/web/cloned", "log", "--oneline", "-n", "2"), /subdirectory pathspec/);
    await git(py, packed, "switch", "main");
    py.FS.writeFile(`${packed}/value.txt`, "upstream\n");
    await git(py, packed, "add", "value.txt");
    await git(py, packed, "commit", "-m", "upstream change");
    await git(py, "/home/web/cloned", "pull");
    assert.equal(py.FS.readFile("/home/web/cloned/value.txt", { encoding: "utf8" }), "upstream\n");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("agent Git operations stage, diff, and reject empty commits", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/agent-audit";
  py.FS.mkdirTree(repository);
  await git(py, repository, "init", "-b", "main");
  assert.match(await git(py, repository, "init"), /Reinitialized existing Git repository/);
  py.FS.writeFile(`${repository}/wanted.txt`, "wanted\n");
  py.FS.writeFile(`${repository}/other.txt`, "other\n");

  await git(py, repository, "add", "--", "wanted.txt");
  assert.match((await gitResult(py, repository, "status", "--short")).output, /^A  wanted\.txt$/m);
  const staged = await gitResult(py, repository, "diff", "--staged", "--", "wanted.txt");
  assert.equal(staged.exitCode, 0, staged.output);
  assert.match(staged.output, /wanted\.txt/);
  assert.doesNotMatch(staged.output, /other\.txt/);
  await git(py, repository, "commit", "-m", "wanted only");

  const empty = await gitResult(py, repository, "commit", "-m", "must fail");
  assert.notEqual(empty.exitCode, 0);
  assert.match(empty.output, /nothing to commit/);
  const revisions = await gitResult(py, repository, "rev-list", "--max-count", "1", "HEAD");
  assert.equal(revisions.exitCode, 0, revisions.output);
  assert.match(revisions.output, /^[0-9a-f]{40}\n$/);

  const unborn = "/home/web/unborn-status";
  py.FS.mkdirTree(unborn);
  await git(py, unborn, "init", "-b", "main");
  const response = await runGitEngineCommand({
    py,
    cwd: unborn,
    args: ["git-engine", "status"],
  });
  assert.equal(response.exitCode, 0);
  assert.doesNotMatch(new TextDecoder().decode(response.stderr ?? new Uint8Array()), /reference .* not found/);

  const tool = createGitTool(py, () => null);
  const signal = new AbortController().signal;
  await assert.rejects(
    tool.execute("add-without-paths", { operation: "add", cwd: repository }, signal),
    /add requires paths/,
  );
  await assert.rejects(
    tool.execute("oversized-arguments", {
      operation: "add", cwd: repository, paths: ["x".repeat(65_536)],
    }, signal),
    /argument list exceeds 65536 bytes/,
  );
  assert.notEqual((await gitResult(py, repository, "add")).exitCode, 0);
  assert.match((await gitResult(py, repository, "add", "missing.txt")).output, /did not match/);

  py.FS.writeFile(`${repository}/.gitignore`, "ignored.txt\n");
  py.FS.writeFile(`${repository}/ignored.txt`, "ignored\n");
  await git(py, repository, "add", ".gitignore");
  await git(py, repository, "commit", "-m", "ignore test file");
  assert.match((await gitResult(py, repository, "add", "ignored.txt")).output, /ignored/);

  py.FS.writeFile(`${repository}/-leading.txt`, "leading\n");
  await git(py, repository, "add", "--", "-leading.txt");
  assert.match((await gitResult(py, repository, "status", "--short")).output, /^A  -leading\.txt$/m);
  await git(py, repository, "commit", "-m", "leading path");

  py.FS.writeFile(`${repository}/tool-message.txt`, "message\n");
  await tool.execute("stage-message", {
    operation: "add", cwd: repository, paths: ["tool-message.txt"],
  }, signal);
  const maliciousMessage = "safe'\ntouch /home/web/agent-injected\n'";
  await tool.execute("commit-message", {
    operation: "commit", cwd: repository, message: maliciousMessage,
  }, signal);
  assert.equal(py.FS.analyzePath("/home/web/agent-injected").exists, false);

  py.FS.writeFile(`${repository}/wanted.txt`, "checkout change\n");
  await tool.execute("checkout-path", {
    operation: "checkout", cwd: repository, paths: ["wanted.txt"],
  }, signal);
  assert.equal(py.FS.readFile(`${repository}/wanted.txt`, { encoding: "utf8" }), "wanted\n");

  py.FS.writeFile(`${repository}/wanted.txt`, "keep worktree\n");
  await tool.execute("stage-restore", {
    operation: "add", cwd: repository, paths: ["wanted.txt"],
  }, signal);
  await tool.execute("unstage-only", {
    operation: "restore", cwd: repository, paths: ["wanted.txt"], staged: true,
  }, signal);
  assert.equal(py.FS.readFile(`${repository}/wanted.txt`, { encoding: "utf8" }), "keep worktree\n");
  assert.match((await gitResult(py, repository, "status", "--short")).output, /^ M wanted\.txt$/m);
  await tool.execute("restore-worktree", {
    operation: "restore", cwd: repository, paths: ["wanted.txt"],
  }, signal);

  py.FS.writeFile(`${repository}/new-unstaged.txt`, "must survive\n");
  await tool.execute("stage-new", {
    operation: "add", cwd: repository, paths: ["new-unstaged.txt"],
  }, signal);
  await tool.execute("unstage-new", {
    operation: "restore", cwd: repository, paths: ["new-unstaged.txt"], staged: true,
  }, signal);
  assert.equal(py.FS.readFile(`${repository}/new-unstaged.txt`, { encoding: "utf8" }), "must survive\n");

  await git(py, repository, "switch", "-c", "unmerged-delete");
  py.FS.writeFile(`${repository}/unmerged.txt`, "keep commit\n");
  await git(py, repository, "add", "unmerged.txt");
  await git(py, repository, "commit", "-m", "unmerged commit");
  await git(py, repository, "switch", "main");
  const safeDelete = await gitResult(py, repository, "branch", "-d", "unmerged-delete");
  assert.notEqual(safeDelete.exitCode, 0);
  assert.match(safeDelete.output, /not fully merged/);
  assert.match(await git(py, repository, "branch"), /unmerged-delete/);
  await git(py, repository, "branch", "-D", "unmerged-delete");

  const scoped = `${repository}/scoped`;
  py.FS.mkdirTree(scoped);
  py.FS.writeFile(`${repository}/outside.txt`, "base\n");
  py.FS.writeFile(`${scoped}/inside.txt`, "base\n");
  await git(py, repository, "add", ".");
  await git(py, repository, "commit", "-m", "add scoped files");
  py.FS.writeFile(`${repository}/outside.txt`, "outside change\n");
  py.FS.writeFile(`${scoped}/inside.txt`, "inside change\n");
  await git(py, repository, "add", "-A", "scoped");
  const scopedStatus = (await gitResult(py, repository, "status", "--short")).output;
  assert.match(scopedStatus, /^ M outside\.txt$/m);
  assert.match(scopedStatus, /^M  scoped\/inside\.txt$/m);

  const literalNullRepository = "/home/web/(null)";
  py.FS.mkdirTree(literalNullRepository);
  const literalNullOutput = await git(py, literalNullRepository, "init", "-b", "main");
  assert.match(literalNullOutput, /\/home\/web\/\(null\)\//);
  assert.doesNotMatch(literalNullOutput, /\/workspace/);
});

test("Git audit regressions and browser smart HTTP are compatible and script-safe", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const temporary = mkdtempSync(join(tmpdir(), "piodide-git-http-"));
  const source = join(temporary, "source");
  const bare = join(temporary, "remote.git");
  mkdirSync(source);
  execFileSync("git", ["init", "-b", "main"], { cwd: source });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: source });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: source });
  writeFileSync(join(source, "value.txt"), "base\n");
  writeFileSync(join(source, "binary.dat"), Buffer.from(Array.from({ length: 256 }, (_, index) => index)));
  symlinkSync("value.txt", join(source, "value-link"));
  execFileSync("git", ["add", "."], { cwd: source });
  execFileSync("git", ["commit", "-m", "original history"], { cwd: source });
  execFileSync("git", ["switch", "-c", "remote-feature"], { cwd: source });
  writeFileSync(join(source, "feature.txt"), "feature\n");
  execFileSync("git", ["add", "."], { cwd: source });
  execFileSync("git", ["commit", "-m", "remote branch"], { cwd: source });
  execFileSync("git", ["switch", "main"], { cwd: source });
  execFileSync("git", ["tag", "v1"], { cwd: source });
  execFileSync("git", ["clone", "--bare", source, bare]);
  execFileSync("git", ["config", "http.receivepack", "true"], { cwd: bare });
  const { server, url } = await startGitHttpServer(temporary);
  try {
    const clone = await gitResult(py, "/home/web", "clone", `${url}/remote.git`, "smart");
    assert.equal(clone.exitCode, 0, clone.output);
    assert.match((await gitResult(py, "/home/web/smart", "log", "--oneline")).output, /original history/);
    assert.match((await gitResult(py, "/home/web/smart", "branch", "-r")).output, /remote-feature/);
    assert.match((await gitResult(py, "/home/web/smart", "tag")).output, /v1/);
    assert.match((await gitResult(py, "/home/web/smart", "remote", "-v")).output, /remote\.git/);
    assert.match((await gitResult(py, "/home/web/smart", "ls-remote", "origin")).output, /refs\/heads\/main/);
    assert.deepEqual(py.FS.readFile("/home/web/smart/binary.dat"), new Uint8Array(Array.from({ length: 256 }, (_, index) => index)));
    assert.equal(py.FS.readlink("/home/web/smart/value-link"), "value.txt");

    const help = await gitResult(py, "/home/web/smart", "pull", "--help");
    assert.equal(help.exitCode, 0);
    assert.match(help.output, /^usage: git pull/);

    await git(py, "/home/web/smart", "switch", "-c", "conflict-side");
    py.FS.writeFile("/home/web/smart/value.txt", "side\n");
    await git(py, "/home/web/smart", "add", ".");
    await git(py, "/home/web/smart", "commit", "-m", "side");
    await git(py, "/home/web/smart", "switch", "main");
    py.FS.writeFile("/home/web/smart/value.txt", "main\n");
    await git(py, "/home/web/smart", "add", ".");
    await git(py, "/home/web/smart", "commit", "-m", "main");
    const conflict = await gitResult(py, "/home/web/smart", "merge", "conflict-side");
    assert.equal(conflict.exitCode, 1, conflict.output);
    assert.equal((await gitResult(py, "/home/web/smart", "status", "--porcelain=v1")).output, "UU value.txt\n");
    await git(py, "/home/web/smart", "merge", "--abort");
    assert.deepEqual(py.FS.readFile("/home/web/smart/binary.dat"), new Uint8Array(Array.from({ length: 256 }, (_, index) => index)));

    assert.match((await gitResult(py, "/home/web/smart", "ls-files", "--stage")).output, /^100644 [0-9a-f]{40} 0\tvalue\.txt$/m);
    py.FS.writeFile("/home/web/smart/value.txt", "temporary\n");
    await git(py, "/home/web/smart", "restore", "value.txt");
    assert.equal(py.FS.readFile("/home/web/smart/value.txt", { encoding: "utf8" }), "main\n");
    py.FS.writeFile("/home/web/smart/untracked.txt", "remove me\n");
    assert.match((await gitResult(py, "/home/web/smart", "clean", "-n")).output, /Would remove untracked\.txt/);
    await git(py, "/home/web/smart", "clean", "-f");
    assert.equal(py.FS.analyzePath("/home/web/smart/untracked.txt").exists, false);
    await git(py, "/home/web/smart", "config", "browser.test", "yes");
    assert.match((await gitResult(py, "/home/web/smart", "config", "--list")).output, /browser\.test=yes/);
    await git(py, "/home/web/smart", "branch", "at-main", "main");
    await git(py, "/home/web/smart", "branch", "-m", "at-main", "renamed-main");
    assert.match((await gitResult(py, "/home/web/smart", "branch")).output, /renamed-main/);
    assert.match((await gitResult(py, "/home/web/smart", "fsck")).output, /no errors/);
    assert.match((await gitResult(py, "/home/web/smart", "gc")).output, /Packed and pruned/);
    const packFiles = py.FS.readdir("/home/web/smart/.git/objects/pack");
    assert.ok(packFiles.some((name) => name.endsWith(".pack")));
    assert.ok(packFiles.some((name) => name.endsWith(".idx")));
    const looseObjects = py.FS.readdir("/home/web/smart/.git/objects").filter((name) => /^[0-9a-f]{2}$/.test(name));
    assert.equal(looseObjects.length, 0);
    assert.match((await gitResult(py, "/home/web/smart", "fsck")).output, /no errors/);
    assert.equal((await gitResult(py, "/home/web/smart", "rev-parse", "--abbrev-ref", "HEAD")).output, "main\n");

    py.FS.writeFile("/home/web/smart/reset.txt", "base\n");
    await git(py, "/home/web/smart", "add", "reset.txt");
    await git(py, "/home/web/smart", "commit", "-m", "reset base");
    py.FS.writeFile("/home/web/smart/reset.txt", "staged\n");
    await git(py, "/home/web/smart", "add", "reset.txt");
    assert.equal((await gitResult(py, "/home/web/smart", "reset")).exitCode, 0);
    assert.match((await gitResult(py, "/home/web/smart", "status", "--short")).output, /^ M reset\.txt$/m);
    assert.equal((await gitResult(py, "/home/web/smart", "reset", "--hard", "HEAD")).exitCode, 0);
    assert.equal(py.FS.readFile("/home/web/smart/reset.txt", { encoding: "utf8" }), "base\n");
    const badReset = await gitResult(py, "/home/web/smart", "reset", "missing-revision");
    assert.notEqual(badReset.exitCode, 0);
    assert.match(badReset.output, /unknown revision/);

    py.FS.writeFile("/home/web/smart/stdin-message.txt", "stdin\n");
    await git(py, "/home/web/smart", "add", "stdin-message.txt");
    await git(py, "/home/web/smart", "config", "user.name", "Configured Identity");
    await git(py, "/home/web/smart", "config", "user.email", "configured@example.com");
    const stdinCommit = await runGitEngineCommand({
      py,
      cwd: "/home/web/smart",
      args: ["git-engine", "commit", "-F", "-"],
      stdin: new TextEncoder().encode("message from stdin\n"),
      env: { GIT_AUTHOR_NAME: "Environment Author", GIT_AUTHOR_EMAIL: "env@example.com" },
    });
    assert.equal(stdinCommit.exitCode, 0, new TextDecoder().decode(stdinCommit.stderr));
    assert.match((await gitResult(py, "/home/web/smart", "log", "-n", "1")).output, /Environment Author/);

    py.FS.writeFile("/home/web/smart/scoped.txt", "scoped\n");
    await git(py, "/home/web/smart", "add", "scoped.txt");
    await git(
      py, "/home/web/smart",
      "-c", "user.name=Scoped Author", "-c", "user.email=scoped@example.com",
      "commit", "-m", "scoped identity",
    );
    assert.match((await gitResult(py, "/home/web/smart", "log", "-n", "1")).output, /Scoped Author/);

    py.FS.writeFile("/home/web/smart/pushed.txt", "from browser\n");
    await git(py, "/home/web/smart", "add", ".");
    await git(py, "/home/web/smart", "commit", "-m", "browser smart push");
    await git(py, "/home/web/smart", "push", "-u", "origin", "main");
    assert.equal(
      execFileSync("git", ["--git-dir", bare, "log", "-1", "--format=%s"], { encoding: "utf8" }),
      "browser smart push\n",
    );

    await git(py, "/home/web/smart", "switch", "-c", "corrupt-unreachable");
    py.FS.writeFile("/home/web/smart/corrupt.txt", "dangling\n");
    await git(py, "/home/web/smart", "add", "corrupt.txt");
    await git(py, "/home/web/smart", "commit", "-m", "unreachable object");
    const unreachable = (await git(py, "/home/web/smart", "rev-parse", "HEAD")).trim();
    await git(py, "/home/web/smart", "switch", "main");
    await git(py, "/home/web/smart", "branch", "-D", "corrupt-unreachable");
    const objectPath = `/home/web/smart/.git/objects/${unreachable.slice(0, 2)}/${unreachable.slice(2)}`;
    const rawObject = inflateSync(Buffer.from(py.FS.readFile(objectPath) as Uint8Array));
    rawObject[rawObject.length - 1] ^= 1;
    py.FS.writeFile(objectPath, new Uint8Array(deflateSync(rawObject)));
    const corruptFsck = await gitResult(py, "/home/web/smart", "fsck");
    assert.notEqual(corruptFsck.exitCode, 0);
    assert.match(corruptFsck.output, /object hash mismatch/);
    assert.doesNotMatch(corruptFsck.output, /isomorphic-git|report this error/);

    const packDirectory = "/home/web/smart/.git/objects/pack";
    const fakeIndex = (count: number) => {
      const bytes = new Uint8Array(8 + 256 * 4 + count * 20);
      const view = new DataView(bytes.buffer);
      view.setUint32(0, 0xff744f63);
      view.setUint32(4, 2);
      view.setUint32(8 + 255 * 4, count);
      return bytes;
    };
    py.FS.writeFile(`${packDirectory}/review-limit-a.idx`, fakeIndex(60_000));
    py.FS.writeFile(`${packDirectory}/review-limit-b.idx`, fakeIndex(60_000));
    const boundedFsck = await gitResult(py, "/home/web/smart", "fsck");
    assert.notEqual(boundedFsck.exitCode, 0);
    assert.match(boundedFsck.output, /fsck object limit exceeded \(100000\)/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(temporary, { recursive: true, force: true });
  }
});
