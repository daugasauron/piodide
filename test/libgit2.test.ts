import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { gitIndexIntentToAddPaths } from "../src/git-index-compat.ts";
import { createIsomorphicGitFs, isomorphicGit } from "../src/git-smart-http.ts";
import { createGitTool } from "../src/git-tool.ts";
import type { Pyodide } from "../src/pyodide-host.ts";
import { preserveEmscriptenSymlinkTarget } from "../src/wasi/emscripten-fs.ts";

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
  // Model Pyodide 0.27 MEMFS: it stores an absolute target internally while
  // readlink/Git must continue to observe the original relative payload.
  py.FS.unlink(`${repository}/value-link`);
  py.FS.symlink(`${repository}/value.txt`, `${repository}/value-link`);
  preserveEmscriptenSymlinkTarget(py.FS, `${repository}/value-link`, "value.txt");
  assert.doesNotMatch((await gitResult(py, repository, "status", "--short")).output, /value-link/);
  py.FS.unlink(`${repository}/value-link`);
  await git(py, repository, "checkout", "HEAD", "--", "value-link");
  assert.equal(py.FS.readlink(`${repository}/value-link`), "value.txt");
  assert.doesNotMatch((await gitResult(py, repository, "status", "--short")).output, /value-link/);
  py.FS.unlink(`${repository}/value-link`);
  await git(py, repository, "restore", "value-link");
  assert.equal(py.FS.readlink(`${repository}/value-link`), "value.txt");
  assert.doesNotMatch((await gitResult(py, repository, "status", "--short")).output, /value-link/);
  await git(py, repository, "switch", "-c", "feature");
  py.FS.writeFile(`${repository}/value.txt`, "feature\n");
  await git(py, repository, "add", "value.txt");
  await git(py, repository, "commit", "-m", "feature change");
  await git(py, repository, "switch", "main");
  assert.equal(py.FS.readFile(`${repository}/value.txt`, { encoding: "utf8" }), "main\n");
  py.FS.writeFile(`${repository}/keep.txt`, "committed\n");
  await git(py, repository, "add", "keep.txt");
  await git(py, repository, "commit", "-m", "tracked merge guard fixture");
  const headBeforeRejectedMerge = await git(py, repository, "rev-parse", "HEAD");
  py.FS.writeFile(`${repository}/keep.txt`, "local bytes must survive\n");
  const rejectedMerge = await gitResult(py, repository, "merge", "feature");
  assert.equal(rejectedMerge.exitCode, 1);
  assert.match(rejectedMerge.output, /cannot merge with tracked or staged changes/);
  assert.equal(py.FS.readFile(`${repository}/keep.txt`, { encoding: "utf8" }), "local bytes must survive\n");
  assert.equal(await git(py, repository, "rev-parse", "HEAD"), headBeforeRejectedMerge);
  assert.equal(py.FS.analyzePath(`${repository}/.git/MERGE_HEAD`).exists, false);
  await git(py, repository, "restore", "keep.txt");
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
      "subdirectory pathspec\ntracked merge guard fixture\ninitial\n",
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

  const amendRepository = "/home/web/amend-audit";
  py.FS.mkdirTree(amendRepository);
  await git(py, amendRepository, "init", "-b", "main");
  py.FS.writeFile(`${amendRepository}/value.txt`, "one\n");
  await git(py, amendRepository, "add", "value.txt");
  await git(py, amendRepository, "commit", "-m", "original subject");
  const originalOid = (await git(py, amendRepository, "rev-parse", "HEAD")).trim();
  const originalAuthor = (await git(py, amendRepository, "show", "--no-patch", "HEAD"))
    .match(/^Author:.*$/m)?.[0];
  assert.ok(originalAuthor);
  const amended = await git(py, amendRepository, "commit", "--amend", "-m", "corrected subject");
  assert.match(amended, /^[0-9a-f]{7} corrected subject\n$/);
  const messageOnlyOid = (await git(py, amendRepository, "rev-parse", "HEAD")).trim();
  assert.notEqual(messageOnlyOid, originalOid);
  assert.equal(await git(py, amendRepository, "log", "--format=%s", "-n", "1"), "corrected subject\n");
  assert.equal(
    (await git(py, amendRepository, "show", "--no-patch", "HEAD")).match(/^Author:.*$/m)?.[0],
    originalAuthor,
  );
  assert.equal((await git(py, amendRepository, "rev-list", "--max-count", "2", "HEAD")).trim().split("\n").length, 1);
  py.FS.writeFile(`${amendRepository}/value.txt`, "two\n");
  await git(py, amendRepository, "add", "value.txt");
  await git(py, amendRepository, "commit", "--amend", "--no-edit");
  assert.equal(await git(py, amendRepository, "show", "--format=%s", "--no-patch"), "corrected subject\n");
  assert.match((await git(py, amendRepository, "show", "HEAD")).toString(), /\+two/);
  const stdinAmend = await runGitEngineCommand({
    py,
    cwd: amendRepository,
    args: ["git-engine", "commit", "--amend", "-F", "-"],
    stdin: new TextEncoder().encode("stdin subject\n"),
  });
  assert.equal(stdinAmend.exitCode, 0, new TextDecoder().decode(stdinAmend.stderr));
  assert.equal(await git(py, amendRepository, "log", "--format=%s", "-n", "1"), "stdin subject\n");
  assert.equal((await gitResult(py, amendRepository, "commit", "--amend")).exitCode, 2);
  assert.equal((await gitResult(py, amendRepository, "commit", "--no-edit")).exitCode, 2);
  assert.equal(
    (await gitResult(py, amendRepository, "commit", "--amend", "--no-edit", "-m", "bad")).exitCode,
    2,
  );
  const unsupportedAmend = await gitResult(
    py, amendRepository, "commit", "--amend", "--reset-author", "-m", "bad",
  );
  assert.equal(unsupportedAmend.exitCode, 2);
  assert.match(unsupportedAmend.output, /unsupported commit option/);

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

  const protocolRepository = "/home/web/agent-protocol";
  py.FS.mkdirTree(protocolRepository);
  await git(py, protocolRepository, "init", "-b", "main");
  py.FS.writeFile(`${protocolRepository}/tracked.txt`, "clean\n");
  await git(py, protocolRepository, "add", "tracked.txt");
  await git(py, protocolRepository, "commit", "-m", "protocol base");
  const cleanQuiet = await gitResult(py, protocolRepository, "diff", "--quiet", "--", "tracked.txt");
  assert.equal(cleanQuiet.exitCode, 0, cleanQuiet.output);
  assert.equal(cleanQuiet.output, "");
  const cachedNul = await runGitEngineCommand({
    py,
    cwd: protocolRepository,
    args: ["git-engine", "ls-files", "--cached", "-z"],
  });
  assert.equal(cachedNul.exitCode, 0);
  assert.deepEqual(cachedNul.stdout, new TextEncoder().encode("tracked.txt\0"));
  py.FS.writeFile(`${protocolRepository}/line\nbreak.txt`, "untracked\n");
  const nulStatus = await runGitEngineCommand({
    py,
    cwd: protocolRepository,
    args: ["git-engine", "status", "--porcelain=v1", "-z"],
  });
  assert.equal(nulStatus.exitCode, 0);
  assert.deepEqual(
    nulStatus.stdout,
    new TextEncoder().encode("?? line\nbreak.txt\0"),
  );
  const othersNul = await runGitEngineCommand({
    py,
    cwd: protocolRepository,
    args: ["git-engine", "ls-files", "--others", "--exclude-standard", "-z"],
  });
  assert.equal(othersNul.exitCode, 0);
  assert.deepEqual(othersNul.stdout, new TextEncoder().encode("line\nbreak.txt\0"));

  py.FS.writeFile(`${protocolRepository}/tracked.txt`, "trailing  \n");
  const dirtyQuiet = await gitResult(py, protocolRepository, "diff", "--quiet", "--", "tracked.txt");
  assert.equal(dirtyQuiet.exitCode, 1);
  assert.equal(dirtyQuiet.output, "");
  const dirtyExitCode = await gitResult(py, protocolRepository, "diff", "--exit-code", "--", "tracked.txt");
  assert.equal(dirtyExitCode.exitCode, 1);
  assert.match(dirtyExitCode.output, /tracked\.txt/);
  const whitespace = await gitResult(py, protocolRepository, "diff", "--check");
  assert.equal(whitespace.exitCode, 1);
  assert.match(whitespace.output, /tracked\.txt:1: trailing whitespace/);
  py.FS.writeFile(`${protocolRepository}/tracked.txt`, "clean again\n");
  assert.equal((await gitResult(py, protocolRepository, "diff", "--check")).exitCode, 0);
  py.FS.writeFile(`${protocolRepository}/tracked.txt`, "staged trailing \n");
  await git(py, protocolRepository, "add", "tracked.txt");
  const stagedWhitespace = await gitResult(py, protocolRepository, "diff", "--cached", "--check");
  assert.equal(stagedWhitespace.exitCode, 1);
  assert.match(stagedWhitespace.output, /tracked\.txt:1: trailing whitespace/);

  const projectionRepository = "/home/web/diff-projections";
  py.FS.mkdirTree(`${projectionRepository}/docs`);
  py.FS.mkdirTree(`${projectionRepository}/src`);
  await git(py, projectionRepository, "init", "-b", "main");
  py.FS.writeFile(`${projectionRepository}/docs/readme.md`, "docs one\n");
  py.FS.writeFile(`${projectionRepository}/src/a.txt`, "source one\n");
  py.FS.writeFile(`${projectionRepository}/src/line\nbreak.txt`, "newline one\n");
  await git(py, projectionRepository, "add", "-A");
  await git(py, projectionRepository, "commit", "-m", "projection base");
  py.FS.writeFile(`${projectionRepository}/docs/readme.md`, "docs two\n");
  py.FS.writeFile(`${projectionRepository}/src/a.txt`, "source two\n");
  py.FS.writeFile(`${projectionRepository}/src/line\nbreak.txt`, "newline two\n");
  await git(py, projectionRepository, "add", "-A");
  await git(py, projectionRepository, "commit", "-m", "projection update");
  assert.equal(
    (await gitResult(py, projectionRepository, "diff", "--name-only", "HEAD~1", "HEAD", "--", "docs")).output,
    "docs/readme.md\n",
  );
  const projectedNames = await runGitEngineCommand({
    py,
    cwd: projectionRepository,
    args: ["git-engine", "diff", "--name-only", "-z", "HEAD~1", "HEAD", "--", "src"],
  });
  assert.equal(projectedNames.exitCode, 0);
  assert.deepEqual(
    projectedNames.stdout,
    new TextEncoder().encode("src/a.txt\0src/line\nbreak.txt\0"),
  );
  const projectedStatus = await runGitEngineCommand({
    py,
    cwd: projectionRepository,
    args: ["git-engine", "diff", "--name-status", "-z", "HEAD~1", "HEAD", "--", "docs"],
  });
  assert.equal(projectedStatus.exitCode, 0);
  assert.deepEqual(projectedStatus.stdout, new TextEncoder().encode("M\0docs/readme.md\0"));
  const projectedPatch = await gitResult(
    py, projectionRepository, "diff", "HEAD~1", "HEAD", "--", "docs",
  );
  assert.equal(projectedPatch.exitCode, 0, projectedPatch.output);
  assert.match(projectedPatch.output, /docs\/readme\.md/);
  assert.doesNotMatch(projectedPatch.output, /src\/a\.txt|line\\nbreak/);
  const projectedStat = await gitResult(
    py, projectionRepository, "diff", "--stat", "HEAD~1", "HEAD", "--", "docs",
  );
  assert.equal(projectedStat.exitCode, 0, projectedStat.output);
  assert.match(projectedStat.output, /docs\/readme\.md \| 2 \+-/);
  assert.match(projectedStat.output, /1 file changed, 1 insertion\(\+\), 1 deletion\(-\)/);
  assert.doesNotMatch(projectedStat.output, /src\//);
  const invalidDiffNul = await gitResult(py, projectionRepository, "diff", "-z", "HEAD~1", "HEAD");
  assert.equal(invalidDiffNul.exitCode, 2);
  assert.match(invalidDiffNul.output, /requires --name-only, --name-status, or --numstat/);
  const unknownHelp = await gitResult(py, projectionRepository, "definitely-not-a-command", "--help");
  assert.equal(unknownHelp.exitCode, 1);
  assert.match(unknownHelp.output, /not an available browser Git command/);
  const showHelp = await gitResult(py, projectionRepository, "show", "--help");
  assert.equal(showHelp.exitCode, 0);
  assert.match(showHelp.output, /one commit, first parent/);
  const grepHelp = await gitResult(py, projectionRepository, "help", "grep");
  assert.equal(grepHelp.exitCode, 0);
  assert.match(grepHelp.output, /tracked worktree bytes or one historical tree/);
  assert.match((await gitResult(py, projectionRepository, "diff", "--help")).output, /-z/);
  const shownPatch = await gitResult(py, projectionRepository, "show", "HEAD", "--", "docs");
  assert.equal(shownPatch.exitCode, 0, shownPatch.output);
  assert.match(shownPatch.output, /projection update/);
  assert.match(shownPatch.output, /docs\/readme\.md/);
  assert.doesNotMatch(shownPatch.output, /src\/a\.txt|line\\nbreak/);
  const shownStat = await gitResult(
    py, projectionRepository, "show", "--oneline", "--stat", "HEAD", "--", "docs",
  );
  assert.equal(shownStat.exitCode, 0, shownStat.output);
  assert.match(shownStat.output, /^[0-9a-f]{7} projection update$/m);
  assert.match(shownStat.output, /docs\/readme\.md \| 2 \+-/);
  assert.doesNotMatch(shownStat.output, /src\//);
  const shownNewlinePath = await gitResult(
    py, projectionRepository, "show", "--stat", "HEAD", "--", "src/line\nbreak.txt",
  );
  assert.equal(shownNewlinePath.exitCode, 0, shownNewlinePath.output);
  assert.match(shownNewlinePath.output, /line\\012break\.txt/);
  assert.doesNotMatch(shownNewlinePath.output, /src\/a\.txt|docs\/readme\.md/);
  assert.equal(
    (await gitResult(py, projectionRepository, "show", "--format=%s", "--no-patch", "HEAD")).output,
    "projection update\n",
  );
  assert.equal(
    (await gitResult(py, projectionRepository, "show", "HEAD", "--", "not-changed.txt")).output,
    "",
  );
  const rootShow = await gitResult(py, projectionRepository, "show", "--stat", "HEAD~1");
  assert.equal(rootShow.exitCode, 0, rootShow.output);
  assert.match(rootShow.output, /projection base/);
  assert.match(rootShow.output, /3 files changed/);
  const badShowFormat = await gitResult(py, projectionRepository, "show", "--format=%an", "HEAD");
  assert.equal(badShowFormat.exitCode, 2);
  assert.match(badShowFormat.output, /unsupported git show format atom/);
  const conflictingShow = await gitResult(py, projectionRepository, "show", "--stat", "--no-patch");
  assert.equal(conflictingShow.exitCode, 2);
  assert.match(conflictingShow.output, /--no-patch cannot be combined with an output projection/);
  assert.equal((await gitResult(py, projectionRepository, "show", "missing-revision")).exitCode, 1);

  const updateRepository = "/home/web/add-update";
  py.FS.mkdirTree(updateRepository);
  await git(py, updateRepository, "init", "-b", "main");
  py.FS.writeFile(`${updateRepository}/tracked.txt`, "base\n");
  py.FS.writeFile(`${updateRepository}/deleted.txt`, "delete me\n");
  py.FS.writeFile(`${updateRepository}/rename-old.txt`, "same payload\n");
  py.FS.writeFile(`${updateRepository}/.gitignore`, "ignored.txt\n");
  await git(py, updateRepository, "add", "-A");
  await git(py, updateRepository, "commit", "-m", "base subject");
  py.FS.writeFile(`${updateRepository}/tracked.txt`, "updated\n");
  py.FS.unlink(`${updateRepository}/deleted.txt`);
  py.FS.rename(`${updateRepository}/rename-old.txt`, `${updateRepository}/rename-new.txt`);
  py.FS.writeFile(`${updateRepository}/untracked.txt`, "leave untracked\n");
  py.FS.writeFile(`${updateRepository}/ignored.txt`, "leave ignored\n");
  assert.equal(
    (await gitResult(py, updateRepository, "ls-files", "--deleted")).output,
    "deleted.txt\nrename-old.txt\n",
  );
  assert.equal(
    (await gitResult(py, updateRepository, "ls-files", "--modified")).output,
    "deleted.txt\nrename-old.txt\ntracked.txt\n",
  );
  assert.equal(
    (await gitResult(py, updateRepository, "ls-files", "--others", "--exclude-standard")).output,
    "rename-new.txt\nuntracked.txt\n",
  );
  await git(py, updateRepository, "add", "--", "rename-old.txt", "rename-new.txt");
  assert.equal(
    (await gitResult(py, updateRepository, "diff", "--cached", "--name-status")).output,
    "R100\trename-old.txt\trename-new.txt\n",
  );
  const renameNul = await runGitEngineCommand({
    py,
    cwd: updateRepository,
    args: ["git-engine", "diff", "--cached", "--name-status", "-z"],
  });
  assert.equal(renameNul.exitCode, 0);
  assert.deepEqual(
    renameNul.stdout,
    new TextEncoder().encode("R100\0rename-old.txt\0rename-new.txt\0"),
  );
  const conflictingAddModes = await gitResult(py, updateRepository, "add", "-A", "-u");
  assert.equal(conflictingAddModes.exitCode, 2);
  assert.match(conflictingAddModes.output, /mutually exclusive/);
  await git(py, updateRepository, "add", "--update");
  const updateStatus = (await gitResult(py, updateRepository, "status", "--short")).output;
  assert.match(updateStatus, /^D  deleted\.txt$/m);
  assert.match(updateStatus, /^M  tracked\.txt$/m);
  assert.match(updateStatus, /^\?\? untracked\.txt$/m);
  const updateDiff = (await gitResult(py, updateRepository, "diff", "--cached")).output;
  assert.match(updateDiff, /deleted\.txt/);
  assert.match(updateDiff, /tracked\.txt/);
  assert.doesNotMatch(updateDiff, /untracked\.txt/);
  await git(py, updateRepository, "commit", "-m", "update subject");

  py.FS.writeFile(`${updateRepository}/tracked.txt`, "updated again\n");
  py.FS.writeFile(`${updateRepository}/second-untracked.txt`, "still untracked\n");
  await git(py, updateRepository, "add", "-u");
  const shortUpdateStatus = (await gitResult(py, updateRepository, "status", "--short")).output;
  assert.match(shortUpdateStatus, /^M  tracked\.txt$/m);
  assert.match(shortUpdateStatus, /^\?\? second-untracked\.txt$/m);
  await git(py, updateRepository, "commit", "-m", "short update subject");
  assert.equal(
    await git(py, updateRepository, "log", "--format=%s", "-n", "2"),
    "short update subject\nupdate subject\n",
  );
  assert.equal(
    await git(py, updateRepository, "log", "--format", "%s", "-1", "HEAD"),
    "short update subject\n",
  );
  const unsupportedLogFormat = await gitResult(py, updateRepository, "log", "--format=%an");
  assert.equal(unsupportedLogFormat.exitCode, 2);
  assert.match(unsupportedLogFormat.output, /unsupported git log format atom/);

  const statusRepository = "/home/web/status-protocol";
  py.FS.mkdirTree(`${statusRepository}/dir space`);
  await git(py, statusRepository, "init", "-b", "main");
  py.FS.writeFile(`${statusRepository}/dir space/a file.txt`, "rename payload\n");
  py.FS.writeFile(`${statusRepository}/line\nbreak.txt`, "base\n");
  await git(py, statusRepository, "add", "-A");
  await git(py, statusRepository, "commit", "-m", "status base");
  py.FS.rename(
    `${statusRepository}/dir space/a file.txt`,
    `${statusRepository}/dir space/renamed file.txt`,
  );
  await git(py, statusRepository, "add", "-A");
  py.FS.writeFile(`${statusRepository}/line\nbreak.txt`, "changed\n");
  assert.equal(
    (await gitResult(py, statusRepository, "status", "--short")).output,
    "R  \"dir space/a file.txt\" -> \"dir space/renamed file.txt\"\n M \"line\\nbreak.txt\"\n",
  );
  const statusNul = await runGitEngineCommand({
    py,
    cwd: statusRepository,
    args: ["git-engine", "status", "--porcelain=v1", "-z"],
  });
  assert.equal(statusNul.exitCode, 0);
  assert.deepEqual(
    statusNul.stdout,
    new TextEncoder().encode(
      "R  dir space/renamed file.txt\0dir space/a file.txt\0 M line\nbreak.txt\0",
    ),
  );

  const graphRepository = "/home/web/graph-protocol";
  py.FS.mkdirTree(graphRepository);
  await git(py, graphRepository, "init", "-b", "main");
  py.FS.writeFile(`${graphRepository}/shared.txt`, "base\n");
  py.FS.writeFile(`${graphRepository}/alpha.txt`, "alpha base\n");
  py.FS.writeFile(`${graphRepository}/beta.txt`, "beta base\n");
  await git(py, graphRepository, "add", "-A");
  await git(py, graphRepository, "commit", "-m", "graph base");
  const graphBase = (await git(py, graphRepository, "rev-parse", "HEAD")).trim();
  await git(py, graphRepository, "switch", "-c", "feature");
  py.FS.writeFile(`${graphRepository}/feature.txt`, "feature\n");
  py.FS.writeFile(`${graphRepository}/alpha.txt`, "alpha feature\n");
  await git(py, graphRepository, "add", "-A");
  await git(py, graphRepository, "commit", "-m", "feature change");
  await git(py, graphRepository, "switch", "main");
  py.FS.writeFile(`${graphRepository}/main-only.txt`, "main\n");
  await git(py, graphRepository, "add", "-A");
  await git(py, graphRepository, "commit", "-m", "main advance");
  assert.equal(await git(py, graphRepository, "merge-base", "main", "feature"), `${graphBase}\n`);
  assert.equal(
    await git(py, graphRepository, "diff", "--name-only", "main...feature"),
    "alpha.txt\nfeature.txt\n",
  );
  py.FS.writeFile(`${graphRepository}/beta.txt`, "beta main\n");
  await git(py, graphRepository, "add", "beta.txt");
  await git(py, graphRepository, "commit", "-m", "beta change");
  py.FS.writeFile(`${graphRepository}/alpha.txt`, "alpha main\n");
  await git(py, graphRepository, "add", "alpha.txt");
  await git(py, graphRepository, "commit", "-m", "alpha change");
  assert.equal(
    await git(py, graphRepository, "log", "--format=%s", "--", "alpha.txt"),
    "alpha change\ngraph base\n",
  );
  assert.equal(
    await git(py, graphRepository, "log", "--oneline", "-n", "1", "--", "beta.txt"),
    `${(await git(py, graphRepository, "rev-parse", "HEAD~1")).slice(0, 7)} beta change\n`,
  );

  const applyRepository = "/home/web/apply-protocol";
  py.FS.mkdirTree(`${applyRepository}/dir space`);
  await git(py, applyRepository, "init", "-b", "main");
  py.FS.writeFile(`${applyRepository}/keep.txt`, "keep base\n");
  py.FS.writeFile(`${applyRepository}/delete.txt`, "delete base\n");
  await git(py, applyRepository, "add", "-A");
  await git(py, applyRepository, "commit", "-m", "apply base");
  const applyHelp = await git(py, applyRepository, "help", "apply");
  assert.match(applyHelp, /git apply \[--cached\] \[-R\|--reverse\] \[--check\]/);
  assert.match(applyHelp, /16 MiB\/file, 64 MiB staged bytes/);
  py.FS.writeFile(`${applyRepository}/keep.txt`, "keep changed\n");
  py.FS.unlink(`${applyRepository}/delete.txt`);
  py.FS.writeFile(`${applyRepository}/dir space/new file.txt`, "new payload\n");
  await git(py, applyRepository, "add", "-A");
  const validPatch = await git(py, applyRepository, "diff", "--cached");
  py.FS.writeFile("/home/web/apply-valid.patch", validPatch);
  await git(py, applyRepository, "reset", "--hard", "HEAD");
  assert.equal((await gitResult(py, applyRepository, "status", "--short")).output, "");
  assert.equal((await gitResult(py, applyRepository, "apply", "--check", "../apply-valid.patch")).exitCode, 0);
  assert.equal(py.FS.readFile(`${applyRepository}/keep.txt`, { encoding: "utf8" }), "keep base\n");
  assert.equal(py.FS.analyzePath(`${applyRepository}/delete.txt`).exists, true);
  assert.equal(py.FS.analyzePath(`${applyRepository}/dir space/new file.txt`).exists, false);
  await git(py, applyRepository, "apply", "../apply-valid.patch");
  assert.equal(py.FS.readFile(`${applyRepository}/keep.txt`, { encoding: "utf8" }), "keep changed\n");
  assert.equal(py.FS.analyzePath(`${applyRepository}/delete.txt`).exists, false);
  assert.equal(
    py.FS.readFile(`${applyRepository}/dir space/new file.txt`, { encoding: "utf8" }),
    "new payload\n",
  );

  // Reverse check and apply use the patch's new-side positions, exchange
  // additions/deletions, and preserve unrelated bytes after the selected hunk.
  py.FS.writeFile(`${applyRepository}/keep.txt`, "keep changed\nlocal-only\n");
  const reverseCheck = await gitResult(
    py, applyRepository, "apply", "-R", "--check", "../apply-valid.patch",
  );
  assert.equal(reverseCheck.exitCode, 0, reverseCheck.output);
  assert.equal(py.FS.readFile(`${applyRepository}/keep.txt`, { encoding: "utf8" }),
    "keep changed\nlocal-only\n");
  assert.equal(py.FS.analyzePath(`${applyRepository}/delete.txt`).exists, false);
  assert.equal(py.FS.analyzePath(`${applyRepository}/dir space/new file.txt`).exists, true);
  await git(py, applyRepository, "apply", "--reverse", "../apply-valid.patch");
  assert.equal(py.FS.readFile(`${applyRepository}/keep.txt`, { encoding: "utf8" }),
    "keep base\nlocal-only\n");
  assert.equal(py.FS.readFile(`${applyRepository}/delete.txt`, { encoding: "utf8" }), "delete base\n");
  assert.equal(py.FS.analyzePath(`${applyRepository}/dir space/new file.txt`).exists, false);

  const renamePatch = [
    "diff --git a/rename-old.txt b/rename-new.txt",
    "similarity index 100%",
    "rename from rename-old.txt",
    "rename to rename-new.txt",
    "",
  ].join("\n");
  py.FS.writeFile("/home/web/apply-rename.patch", renamePatch);
  py.FS.writeFile(`${applyRepository}/rename-old.txt`, "rename payload\n");
  await git(py, applyRepository, "apply", "../apply-rename.patch");
  assert.equal(py.FS.analyzePath(`${applyRepository}/rename-old.txt`).exists, false);
  assert.equal(py.FS.readFile(`${applyRepository}/rename-new.txt`, { encoding: "utf8" }), "rename payload\n");
  assert.equal((await gitResult(
    py, applyRepository, "apply", "--reverse", "--check", "../apply-rename.patch",
  )).exitCode, 0);
  await git(py, applyRepository, "apply", "-R", "../apply-rename.patch");
  assert.equal(py.FS.readFile(`${applyRepository}/rename-old.txt`, { encoding: "utf8" }), "rename payload\n");
  assert.equal(py.FS.analyzePath(`${applyRepository}/rename-new.txt`).exists, false);

  const noNewlinePatch = [
    "diff --git a/no-newline.txt b/no-newline.txt",
    "--- a/no-newline.txt",
    "+++ b/no-newline.txt",
    "@@ -1 +1 @@",
    "-old",
    "\\ No newline at end of file",
    "+new",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  py.FS.writeFile("/home/web/apply-no-newline.patch", noNewlinePatch);
  py.FS.writeFile(`${applyRepository}/no-newline.txt`, "old");
  await git(py, applyRepository, "apply", "../apply-no-newline.patch");
  assert.equal(py.FS.readFile(`${applyRepository}/no-newline.txt`, { encoding: "utf8" }), "new");
  await git(py, applyRepository, "apply", "--reverse", "../apply-no-newline.patch");
  assert.equal(py.FS.readFile(`${applyRepository}/no-newline.txt`, { encoding: "utf8" }), "old");

  await git(py, applyRepository, "reset", "--hard", "HEAD");
  await git(py, applyRepository, "clean", "-f", "-d");
  const badPatch = validPatch.replace("-keep base", "-wrong context");
  py.FS.writeFile("/home/web/apply-invalid.patch", badPatch);
  const rejectedCheck = await gitResult(
    py, applyRepository, "apply", "--check", "../apply-invalid.patch",
  );
  assert.equal(rejectedCheck.exitCode, 1);
  assert.match(rejectedCheck.output, /patch failed: keep\.txt:1/);
  const rejectedApply = await gitResult(py, applyRepository, "apply", "../apply-invalid.patch");
  assert.equal(rejectedApply.exitCode, 1);
  assert.equal(py.FS.readFile(`${applyRepository}/keep.txt`, { encoding: "utf8" }), "keep base\n");
  assert.equal(py.FS.analyzePath(`${applyRepository}/delete.txt`).exists, true);
  assert.equal(py.FS.analyzePath(`${applyRepository}/dir space/new file.txt`).exists, false);

  const stdinApply = await runGitEngineCommand({
    py,
    cwd: applyRepository,
    args: ["git-engine", "apply", "--check", "-"],
    stdin: new TextEncoder().encode(validPatch),
  });
  assert.equal(stdinApply.exitCode, 0);
  assert.equal((await gitResult(py, applyRepository, "status", "--short")).output, "");

  await git(py, applyRepository, "apply", "../apply-valid.patch");
  const stdinReverseCheck = await runGitEngineCommand({
    py,
    cwd: applyRepository,
    args: ["git-engine", "apply", "--reverse", "--check"],
    stdin: new TextEncoder().encode(validPatch),
  });
  assert.equal(stdinReverseCheck.exitCode, 0);
  assert.equal(py.FS.readFile(`${applyRepository}/keep.txt`, { encoding: "utf8" }), "keep changed\n");
  const stdinReverse = await runGitEngineCommand({
    py,
    cwd: applyRepository,
    args: ["git-engine", "apply", "-R", "-"],
    stdin: new TextEncoder().encode(validPatch),
  });
  assert.equal(stdinReverse.exitCode, 0);
  assert.equal((await gitResult(py, applyRepository, "status", "--short")).output, "");

  for (const args of [
    ["-R", "--reverse", "../apply-valid.patch"],
    ["--reverse", "--reverse", "../apply-valid.patch"],
    ["-RR", "../apply-valid.patch"],
  ]) {
    const invalid = await gitResult(py, applyRepository, "apply", ...args);
    assert.equal(invalid.exitCode, 2, args.join(" "));
  }
  assert.equal((await gitResult(py, applyRepository, "status", "--short")).output, "");

  const modifyPatch = (path: string, newStart = "1") => [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1 +${newStart} @@`,
    "-old",
    "+new",
    "",
  ].join("\n");
  const exactPatchPath = "p".repeat(4_096);
  const overPatchPath = `${exactPatchPath}p`;
  py.FS.writeFile("/home/web/apply-path-exact.patch", modifyPatch(exactPatchPath));
  py.FS.writeFile("/home/web/apply-path-over.patch", modifyPatch(overPatchPath));
  const exactPathResult = await gitResult(
    py, applyRepository, "apply", "-R", "--check", "../apply-path-exact.patch",
  );
  assert.equal(exactPathResult.exitCode, 1);
  assert.match(exactPathResult.output, /patch source does not exist/);
  const overPathResult = await gitResult(
    py, applyRepository, "apply", "--reverse", "--check", "../apply-path-over.patch",
  );
  assert.equal(overPathResult.exitCode, 2);
  assert.match(overPathResult.output, /patch path exceeds 4096 bytes/);

  py.FS.writeFile(
    "/home/web/apply-new-start-over.patch",
    modifyPatch("new-start.txt", "9007199254740992"),
  );
  const invalidNewStart = await gitResult(
    py, applyRepository, "apply", "-R", "--check", "../apply-new-start-over.patch",
  );
  assert.equal(invalidNewStart.exitCode, 2);
  assert.match(invalidNewStart.output, /invalid hunk start/);

  const renameOnlyPatch = (source: string, destination: string) => [
    `diff --git a/${source} b/${destination}`,
    "similarity index 100%",
    `rename from ${source}`,
    `rename to ${destination}`,
    "",
  ].join("\n");
  const exactLarge = new Uint8Array(16 * 1024 * 1024).fill(0x78);
  py.FS.writeFile(`${applyRepository}/large-new.bin`, exactLarge);
  py.FS.writeFile(
    "/home/web/apply-large-exact.patch",
    renameOnlyPatch("large-old.bin", "large-new.bin"),
  );
  const exactLargeResult = await gitResult(
    py, applyRepository, "apply", "-R", "--check", "../apply-large-exact.patch",
  );
  assert.equal(exactLargeResult.exitCode, 0, exactLargeResult.output);
  const overLarge = new Uint8Array(exactLarge.byteLength + 1).fill(0x79);
  py.FS.writeFile(`${applyRepository}/large-over-new.bin`, overLarge);
  py.FS.writeFile(
    "/home/web/apply-large-over.patch",
    renameOnlyPatch("large-over-old.bin", "large-over-new.bin"),
  );
  const overLargeResult = await gitResult(
    py, applyRepository, "apply", "--reverse", "--check", "../apply-large-over.patch",
  );
  assert.equal(overLargeResult.exitCode, 2);
  assert.match(overLargeResult.output, /patch source exceeds 16777216 bytes/);
  assert.equal(py.FS.analyzePath(`${applyRepository}/large-old.bin`).exists, false);
  assert.equal(py.FS.analyzePath(`${applyRepository}/large-over-old.bin`).exists, false);
});

test("bounded Git add -N records real intent entries atomically across existing commands", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/add-intent-protocol";
  const indexPath = `${repository}/.git/index`;
  py.FS.mkdirTree(`${repository}/raw`);
  py.FS.mkdirTree(`${repository}/dir`);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/.gitignore`, "*.ignored\n");
  py.FS.writeFile(`${repository}/tracked.txt`, "tracked base\n");
  py.FS.writeFile(`${repository}/commit-me.txt`, "commit base\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "intent base");
  const head = (await git(py, repository, "rev-parse", "HEAD")).trim();
  py.FS.writeFile(`${repository}/tracked.txt`, "tracked work\n");
  py.FS.writeFile(`${repository}/new.txt`, "new contents\n");
  py.FS.writeFile(`${repository}/ignored.ignored`, "ignored\n");

  const trackedOnlyIndex = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  assert.deepEqual(await gitResult(py, repository, "add", "-N", "--", "tracked.txt"), {
    exitCode: 0,
    output: "",
  });
  assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, trackedOnlyIndex);

  const worktreeBefore = new Uint8Array(py.FS.readFile(`${repository}/new.txt`) as Uint8Array);
  assert.deepEqual(await gitResult(py, repository, "add", "-N", "--", "new.txt"), {
    exitCode: 0,
    output: "",
  });
  const intentIndex = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  assert.equal(new DataView(intentIndex.buffer, intentIndex.byteOffset).getUint32(4), 3);
  assert.deepEqual(gitIndexIntentToAddPaths(intentIndex), new Set(["new.txt"]));
  assert.equal((await gitResult(py, repository, "status", "--short", "--", "new.txt")).output, " A new.txt\n");
  assert.match((await gitResult(py, repository, "diff", "--", "new.txt")).output, /\+new contents/);
  assert.equal((await gitResult(py, repository, "diff", "--cached", "--", "new.txt")).output, "");
  for (const projection of ["--name-only", "--stat", "--numstat"] as const) {
    assert.deepEqual(await gitResult(
      py, repository, "diff", "--cached", projection, "--", "new.txt",
    ), { exitCode: 0, output: "" });
  }
  assert.equal((await gitResult(
    py, repository, "diff", "--cached", "--name-status", "-z", "--", "new.txt",
  )).output, "");
  assert.deepEqual(await gitResult(
    py, repository, "diff", "--cached", "--check", "--", "new.txt",
  ), { exitCode: 0, output: "" });
  assert.deepEqual(await gitResult(
    py, repository, "diff", "--cached", "--quiet", "--", "new.txt",
  ), { exitCode: 0, output: "" });
  assert.deepEqual(await gitResult(
    py, repository, "diff", "--cached", "--exit-code", "--", "new.txt",
  ), { exitCode: 0, output: "" });
  assert.equal(
    (await gitResult(py, repository, "ls-files", "--stage", "--", "new.txt")).output,
    `100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0\tnew.txt\n`,
  );
  assert.deepEqual(py.FS.readFile(`${repository}/new.txt`) as Uint8Array, worktreeBefore);
  assert.equal((await git(py, repository, "rev-parse", "HEAD")).trim(), head);
  const intentOnlyCommit = await gitResult(py, repository, "commit", "-m", "must not commit intent");
  assert.equal(intentOnlyCommit.exitCode, 1);
  assert.match(intentOnlyCommit.output, /nothing to commit/);
  assert.equal((await git(py, repository, "rev-parse", "HEAD")).trim(), head);
  assert.deepEqual(
    gitIndexIntentToAddPaths(new Uint8Array(py.FS.readFile(indexPath) as Uint8Array)),
    new Set(["new.txt"]),
  );

  py.FS.writeFile(`${repository}/commit-me.txt`, "commit staged\n");
  await git(py, repository, "add", "commit-me.txt");
  assert.deepEqual(
    gitIndexIntentToAddPaths(new Uint8Array(py.FS.readFile(indexPath) as Uint8Array)),
    new Set(["new.txt"]),
  );
  assert.match((await gitResult(py, repository, "diff", "--cached", "--name-status")).output, /M\s+commit-me\.txt/);
  assert.doesNotMatch((await gitResult(py, repository, "diff", "--cached", "--name-status")).output, /new\.txt/);
  await git(py, repository, "commit", "-m", "commit beside intent");
  assert.doesNotMatch(
    (await gitResult(py, repository, "ls-tree", "-r", "--name-only", "HEAD")).output,
    /(?:^|\n)new\.txt(?:\n|$)/,
  );
  assert.equal((await gitResult(py, repository, "status", "--short", "--", "new.txt")).output, " A new.txt\n");
  assert.deepEqual(
    gitIndexIntentToAddPaths(new Uint8Array(py.FS.readFile(indexPath) as Uint8Array)),
    new Set(["new.txt"]),
  );

  await git(py, repository, "add", "new.txt");
  assert.deepEqual(
    gitIndexIntentToAddPaths(new Uint8Array(py.FS.readFile(indexPath) as Uint8Array)),
    new Set(),
  );
  assert.match((await gitResult(py, repository, "diff", "--cached", "--", "new.txt")).output, /\+new contents/);
  await git(py, repository, "reset", "HEAD", "--", "new.txt");
  assert.equal((await gitResult(py, repository, "status", "--short", "--", "new.txt")).output, "?? new.txt\n");

  py.FS.writeFile(`${repository}/raw/-dash`, "dash\n");
  py.FS.writeFile(`${repository}/raw/tab\tname`, "tab\n");
  py.FS.writeFile(`${repository}/raw/line\nname`, "line\n");
  py.FS.writeFile(`${repository}/dir/nested`, "nested\n");
  py.FS.symlink("new.txt", `${repository}/new-link`);
  await git(
    py,
    repository,
    "add",
    "--intent-to-add",
    "--",
    "raw/-dash",
    "raw/tab\tname",
    "raw/line\nname",
    "dir",
    "new-link",
  );
  const rawIntentPaths = new Set([
    "dir/nested", "new-link", "raw/-dash", "raw/line\nname", "raw/tab\tname",
  ]);
  assert.deepEqual(
    gitIndexIntentToAddPaths(new Uint8Array(py.FS.readFile(indexPath) as Uint8Array)),
    rawIntentPaths,
  );
  const rawStatus = (await gitResult(
    py, repository, "status", "--short", "-z", "--",
    "dir", "new-link", "raw",
  )).output;
  assert.equal(
    rawStatus,
    " A dir/nested\0 A new-link\0 A raw/-dash\0 A raw/line\nname\0 A raw/tab\tname\0",
  );
  assert.equal(py.FS.readlink(`${repository}/new-link`), "new.txt");

  await git(py, repository, "mv", "--", "raw/-dash", "raw/renamed");
  rawIntentPaths.delete("raw/-dash");
  rawIntentPaths.add("raw/renamed");
  assert.deepEqual(
    gitIndexIntentToAddPaths(new Uint8Array(py.FS.readFile(indexPath) as Uint8Array)),
    rawIntentPaths,
  );
  assert.match((await gitResult(py, repository, "diff", "--", "raw/renamed")).output, /\+dash/);
  assert.equal((await gitResult(py, repository, "diff", "--cached", "--", "raw/renamed")).output, "");
  await git(py, repository, "rm", "--cached", "--", "new-link");
  rawIntentPaths.delete("new-link");
  assert.deepEqual(
    gitIndexIntentToAddPaths(new Uint8Array(py.FS.readFile(indexPath) as Uint8Array)),
    rawIntentPaths,
  );
  assert.equal(py.FS.readlink(`${repository}/new-link`), "new.txt");

  py.FS.writeFile(`${repository}/gone.txt`, "gone\n");
  await git(py, repository, "add", "-N", "--", "gone.txt");
  py.FS.unlink(`${repository}/gone.txt`);
  assert.equal((await gitResult(py, repository, "status", "--short", "--", "gone.txt")).output, " D gone.txt\n");
  await git(py, repository, "rm", "--cached", "--", "gone.txt");

  const assertRejectedUnchanged = async (expectedStatus: number, pattern: RegExp, ...args: string[]) => {
    const before = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
    const worktree = new Uint8Array(py.FS.readFile(`${repository}/raw/tab\tname`) as Uint8Array);
    const rejected = await gitResult(py, repository, "add", ...args);
    assert.equal(rejected.exitCode, expectedStatus, rejected.output);
    assert.match(rejected.output, pattern);
    assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, before);
    assert.deepEqual(py.FS.readFile(`${repository}/raw/tab\tname`) as Uint8Array, worktree);
  };
  await assertRejectedUnchanged(1, /did not match any files/, "-N", "--", "raw/tab\tname", "missing");
  await assertRejectedUnchanged(1, /path is ignored/, "-N", "--", "raw/tab\tname", "ignored.ignored");
  await assertRejectedUnchanged(2, /incompatible/, "-N", "-A", "--", "raw/tab\tname");
  await assertRejectedUnchanged(2, /incompatible/, "--intent-to-add", "-u", "--", "raw/tab\tname");
  await assertRejectedUnchanged(2, /requires at least one path/, "-N");
  await assertRejectedUnchanged(2, /unsupported add option/, "-N", "--dry-run", "--", "raw/tab\tname");
  await assertRejectedUnchanged(2, /at most 100 paths/, "-N", "--", ...Array(101).fill("raw/tab\tname"));
  assert.equal((await gitResult(
    py, repository, "add", "-N", "--", ...Array(100).fill("raw/tab\tname"),
  )).exitCode, 0);
  await assertRejectedUnchanged(1, /did not match any files/, "-N", "--", "p".repeat(4_096));
  await assertRejectedUnchanged(2, /path exceeds 4096 bytes/, "-N", "--", "p".repeat(4_097));
  await assertRejectedUnchanged(
    2, /exceed 65536 aggregate bytes/, "-N", "--", ...Array(17).fill("q".repeat(4_096)),
  );
  await assertRejectedUnchanged(
    2, /more than 128 components/, "-N", "--",
    Array.from({ length: 129 }, (_, index) => `d${index}`).join("/"),
  );

  py.FS.writeFile(`${repository}/publication.txt`, "publication\n");
  const publicationIndex = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  const originalWriteFile = py.FS.writeFile;
  let publicationInjected = false;
  (py.FS as any).writeFile = (path: string, ...args: unknown[]) => {
    if (path === indexPath && !publicationInjected) {
      publicationInjected = true;
      throw new Error("injected add intent publication failure");
    }
    return Reflect.apply(originalWriteFile, py.FS, [path, ...args]);
  };
  try {
    const failed = await gitResult(py, repository, "add", "-N", "--", "publication.txt");
    assert.equal(failed.exitCode, 1);
    assert.match(failed.output, /injected add intent publication failure/);
  } finally {
    (py.FS as any).writeFile = originalWriteFile;
  }
  assert.equal(publicationInjected, true);
  assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, publicationIndex);
  assert.equal(py.FS.readFile(`${repository}/publication.txt`, { encoding: "utf8" }), "publication\n");
  assert.equal(
    py.FS.readdir(`${repository}/.git`).some((name: string) => name.startsWith("piodide-add-intent-index-")),
    false,
  );

  py.FS.writeFile(`${repository}/race.txt`, "original\n");
  const raceIndex = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  const originalReadFile = py.FS.readFile;
  let raceInjected = false;
  (py.FS as any).readFile = (path: string, ...args: unknown[]) => {
    const value = Reflect.apply(originalReadFile, py.FS, [path, ...args]);
    if (path.includes("/.git/piodide-add-intent-index-") && path.endsWith("/index") && !raceInjected) {
      raceInjected = true;
      py.FS.unlink(`${repository}/race.txt`);
      originalWriteFile.call(py.FS, `${repository}/race.txt`, "replacement\n");
    }
    return value;
  };
  try {
    const failed = await gitResult(py, repository, "add", "-N", "--", "race.txt");
    assert.equal(failed.exitCode, 1);
    assert.match(failed.output, /worktree changed during the operation/);
  } finally {
    (py.FS as any).readFile = originalReadFile;
  }
  assert.equal(raceInjected, true);
  assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, raceIndex);
  assert.equal(py.FS.readFile(`${repository}/race.txt`, { encoding: "utf8" }), "replacement\n");

  const help = await git(py, repository, "help", "add");
  assert.match(help, /-N\|--intent-to-add/);
  assert.match(help, /canonical empty-blob stage-0 entries.*real Git intent flag/s);
  assert.match(help, /100 paths.*4096 bytes\/path.*65536 path bytes.*100000 candidates.*16 MiB index/s);
  assert.match(help, /force.*dry-run.*patch\/interactive.*pathspec magic.*submodules.*conflicts.*special files/s);
});

test("bounded Git cached apply patches only the index and is atomic across raw paths", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/apply-cached";
  py.FS.mkdirTree(repository);
  await git(py, repository, "init", "-b", "main");

  const paths = [
    "workflow.txt",
    "delete.txt",
    "--dash.txt",
    "tab\tname.txt",
    "line\nbreak.txt",
    "exec.sh",
  ];
  py.FS.writeFile(
    `${repository}/workflow.txt`,
    "title: base\nseparator one\nseparator two\ntarget: old\n",
  );
  py.FS.writeFile(`${repository}/delete.txt`, "delete base\n");
  for (const path of paths.slice(2)) py.FS.writeFile(`${repository}/${path}`, `old ${path.length}\n`);
  py.FS.chmod(`${repository}/exec.sh`, 0o755);
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "cached apply base");
  const head = await git(py, repository, "rev-parse", "HEAD");

  py.FS.writeFile(
    `${repository}/workflow.txt`,
    "title: base\nseparator one\nseparator two\ntarget: reviewed\n",
  );
  py.FS.unlink(`${repository}/delete.txt`);
  for (const path of paths.slice(2)) py.FS.writeFile(`${repository}/${path}`, `reviewed ${path.length}\n`);
  py.FS.writeFile(`${repository}/added.txt`, "reviewed addition\n");
  await git(py, repository, "add", "-A");
  const patch = await git(py, repository, "diff", "--cached");
  py.FS.writeFile("/home/web/apply-cached.patch", patch);
  await git(py, repository, "reset", "--hard", "HEAD");

  py.FS.writeFile(
    `${repository}/workflow.txt`,
    "title: unrelated local\nseparator one\nseparator two\ntarget: old\n",
  );
  py.FS.writeFile(`${repository}/delete.txt`, "unrelated local delete edit\n");
  for (const path of paths.slice(2)) py.FS.writeFile(`${repository}/${path}`, `unrelated ${path.length}\n`);
  py.FS.writeFile(`${repository}/added.txt`, "unrelated untracked collision\n");
  const worktree = new Map(
    [...paths, "added.txt"].map((path) => [
      path,
      new Uint8Array(py.FS.readFile(`${repository}/${path}`) as Uint8Array),
    ]),
  );
  const assertWorktreeUnchanged = () => {
    for (const [path, bytes] of worktree) {
      assert.deepEqual(py.FS.readFile(`${repository}/${path}`), bytes, path);
    }
  };

  const help = await git(py, repository, "help", "apply");
  assert.match(help, /git apply \[--cached\]/);
  const checkIndex = new Uint8Array(py.FS.readFile(`${repository}/.git/index`) as Uint8Array);
  const check = await gitResult(py, repository, "apply", "--cached", "--check", "../apply-cached.patch");
  assert.equal(check.exitCode, 0, check.output);
  assert.equal(await git(py, repository, "diff", "--cached"), "");
  assert.deepEqual(py.FS.readFile(`${repository}/.git/index`), checkIndex);
  assert.equal(await git(py, repository, "rev-parse", "HEAD"), head);
  assertWorktreeUnchanged();

  const applied = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "apply", "--cached"],
    stdin: new TextEncoder().encode(patch),
  });
  assert.equal(applied.exitCode, 0, new TextDecoder().decode(applied.stderr));
  assert.equal(await git(py, repository, "diff", "--cached"), patch);
  assert.match(await git(py, repository, "ls-files", "--stage", "--", "exec.sh"), /^100755 /);
  assert.equal(await git(py, repository, "rev-parse", "HEAD"), head);
  assertWorktreeUnchanged();

  assert.equal((await gitResult(
    py, repository, "apply", "--cached", "-R", "--check", "../apply-cached.patch",
  )).exitCode, 0);
  assert.equal((await gitResult(
    py, repository, "apply", "--reverse", "--cached", "../apply-cached.patch",
  )).exitCode, 0);
  assert.equal(await git(py, repository, "diff", "--cached"), "");
  assert.equal(await git(py, repository, "rev-parse", "HEAD"), head);
  assertWorktreeUnchanged();

  const rejectedIndex = new Uint8Array(py.FS.readFile(`${repository}/.git/index`) as Uint8Array);
  const badPatch = patch.replace("-target: old", "-target: wrong");
  assert.notEqual(badPatch, patch);
  py.FS.writeFile("/home/web/apply-cached-bad.patch", badPatch);
  const rejected = await gitResult(
    py, repository, "apply", "--cached", "../apply-cached-bad.patch",
  );
  assert.equal(rejected.exitCode, 1);
  assert.match(rejected.output, /patch failed: workflow\.txt/);
  assert.equal(await git(py, repository, "diff", "--cached"), "");
  assert.deepEqual(py.FS.readFile(`${repository}/.git/index`), rejectedIndex);
  assert.equal(await git(py, repository, "rev-parse", "HEAD"), head);
  assertWorktreeUnchanged();

  for (const args of [
    ["--cached", "--cached", "../apply-cached.patch"],
    ["--cached", "../apply-cached.patch", "extra.patch"],
  ]) {
    const invalid = await gitResult(py, repository, "apply", ...args);
    assert.equal(invalid.exitCode, 2, args.join(" "));
    assert.equal(await git(py, repository, "diff", "--cached"), "");
    assert.deepEqual(py.FS.readFile(`${repository}/.git/index`), rejectedIndex);
    assert.equal(await git(py, repository, "rev-parse", "HEAD"), head);
    assertWorktreeUnchanged();
  }
});

test("bounded Git rm --cached removes only safe index entries atomically", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/rm-cached-protocol";
  const indexPath = `${repository}/.git/index`;
  py.FS.mkdirTree(`${repository}/dir/sub`);
  await git(py, repository, "init", "-b", "main");
  const fixtures = new Map([
    ["clean.txt", "clean base\n"],
    ["modified.txt", "modified base\n"],
    ["staged.txt", "staged base\n"],
    ["unique.txt", "unique base\n"],
    ["keep.txt", "keep base\n"],
    ["dir/a.txt", "directory a\n"],
    ["dir/sub/b.txt", "directory b\n"],
    ["-dash.txt", "dash base\n"],
    ["tab\tname.txt", "tab base\n"],
    ["line\nname.txt", "line base\n"],
  ]);
  for (const [path, contents] of fixtures) py.FS.writeFile(`${repository}/${path}`, contents);
  py.FS.symlink("keep.txt", `${repository}/keep-link`);
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "rm cached base");
  const head = await git(py, repository, "rev-parse", "HEAD");

  const help = await git(py, repository, "help", "rm");
  assert.match(help, /git rm --cached \[-r\]/);
  assert.match(help, /HEAD and worktree are unchanged/);

  py.FS.writeFile(`${repository}/modified.txt`, "modified worktree survives\n");
  const modifiedBytes = new Uint8Array(py.FS.readFile(`${repository}/modified.txt`) as Uint8Array);
  const removed = await gitResult(
    py, repository, "rm", "--cached", "--", "clean.txt", "modified.txt",
  );
  assert.deepEqual(removed, { exitCode: 0, output: "" });
  assert.equal(await git(py, repository, "ls-files", "--", "clean.txt", "modified.txt"), "");
  assert.equal(await git(py, repository, "rev-parse", "HEAD"), head);
  assert.equal(py.FS.readFile(`${repository}/clean.txt`, { encoding: "utf8" }), "clean base\n");
  assert.deepEqual(py.FS.readFile(`${repository}/modified.txt`) as Uint8Array, modifiedBytes);
  await git(py, repository, "reset", "HEAD", "--", "clean.txt", "modified.txt");

  py.FS.writeFile(`${repository}/new.txt`, "new staged bytes\n");
  await git(py, repository, "add", "new.txt");
  assert.deepEqual(await gitResult(py, repository, "rm", "--cached", "new.txt"), {
    exitCode: 0,
    output: "",
  });
  assert.equal(await git(py, repository, "ls-files", "--", "new.txt"), "");
  assert.equal(py.FS.readFile(`${repository}/new.txt`, { encoding: "utf8" }), "new staged bytes\n");
  py.FS.unlink(`${repository}/new.txt`);

  py.FS.writeFile(`${repository}/staged.txt`, "staged copy retained\n");
  await git(py, repository, "add", "staged.txt");
  assert.equal((await gitResult(py, repository, "rm", "--cached", "staged.txt")).exitCode, 0);
  assert.equal(py.FS.readFile(`${repository}/staged.txt`, { encoding: "utf8" }), "staged copy retained\n");
  await git(py, repository, "reset", "HEAD", "--", "staged.txt");

  py.FS.writeFile(`${repository}/unique.txt`, "unique staged copy\n");
  await git(py, repository, "add", "unique.txt");
  py.FS.writeFile(`${repository}/unique.txt`, "different worktree copy\n");
  const uniqueIndex = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  const uniqueRejected = await gitResult(py, repository, "rm", "--cached", "unique.txt");
  assert.equal(uniqueRejected.exitCode, 1);
  assert.match(uniqueRejected.output, /unique staged content.*unique\.txt/);
  assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, uniqueIndex);
  assert.equal(
    py.FS.readFile(`${repository}/unique.txt`, { encoding: "utf8" }),
    "different worktree copy\n",
  );
  await git(py, repository, "reset", "--hard", "HEAD");

  const directoryIndex = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  const nonRecursive = await gitResult(py, repository, "rm", "--cached", "--", "dir");
  assert.equal(nonRecursive.exitCode, 2);
  assert.match(nonRecursive.output, /requires -r/);
  assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, directoryIndex);
  assert.deepEqual(
    await gitResult(py, repository, "rm", "-r", "--cached", "--", "dir", "dir/a.txt"),
    { exitCode: 0, output: "" },
  );
  assert.equal(await git(py, repository, "ls-files", "--", "dir"), "");
  assert.equal(py.FS.readFile(`${repository}/dir/a.txt`, { encoding: "utf8" }), "directory a\n");
  assert.equal(py.FS.readFile(`${repository}/dir/sub/b.txt`, { encoding: "utf8" }), "directory b\n");
  await git(py, repository, "reset", "HEAD", "--", "dir");
  assert.equal((await gitResult(
    py, `${repository}/dir`, "rm", "--cached", "--", "a.txt",
  )).exitCode, 0);
  assert.equal(await git(py, repository, "ls-files", "--", "dir/a.txt"), "");
  assert.equal(py.FS.readFile(`${repository}/dir/a.txt`, { encoding: "utf8" }), "directory a\n");
  await git(py, repository, "reset", "HEAD", "--", "dir/a.txt");

  const rawPaths = ["-dash.txt", "tab\tname.txt", "line\nname.txt", "keep-link"];
  assert.equal((await gitResult(
    py, repository, "rm", "--cached", "--", ...rawPaths,
  )).exitCode, 0);
  assert.equal(await git(py, repository, "ls-files", "--", ...rawPaths), "");
  for (const path of rawPaths.slice(0, -1)) {
    assert.equal(py.FS.readFile(`${repository}/${path}`, { encoding: "utf8" }), fixtures.get(path));
  }
  assert.equal(py.FS.readlink(`${repository}/keep-link`), "keep.txt");
  await git(py, repository, "reset", "HEAD", "--", ...rawPaths);

  const assertAtomicFailure = async (exitCode: number, pattern: RegExp, ...args: string[]) => {
    const before = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
    const response = await gitResult(py, repository, "rm", ...args);
    assert.equal(response.exitCode, exitCode, `${args.join(" ")}: ${response.output}`);
    assert.match(response.output, pattern);
    assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, before);
  };
  await assertAtomicFailure(2, /did not match/, "--cached", "--", "keep.txt", "missing.txt");
  await assertAtomicFailure(2, /escapes the worktree/, "--cached", "--", "../outside.txt");
  await assertAtomicFailure(
    2, /relative to the worktree/, "--cached", "--", `${repository}/keep.txt`,
  );
  await assertAtomicFailure(2, /at most 100 paths/, "--cached", "--", ...Array(101).fill("keep.txt"));
  await assertAtomicFailure(2, /exceeds 4096 bytes/, "--cached", "--", "p".repeat(4_097));
  await assertAtomicFailure(
    2,
    /exceed 65536 aggregate bytes/,
    "--cached", "--", ...Array(16).fill("q".repeat(4_096)), "x",
  );
  await assertAtomicFailure(2, /did not match/, "--cached", "--", ...Array(16).fill("q".repeat(4_096)));
  await assertAtomicFailure(2, /only once/, "--cached", "--cached", "keep.txt");
  await assertAtomicFailure(2, /only once/, "--cached", "-r", "-r", "keep.txt");
  await assertAtomicFailure(2, /unsupported rm option: -f/, "--cached", "-f", "keep.txt");
  await assertAtomicFailure(2, /requires at least one path/, "--cached");

  assert.equal((await gitResult(
    py, repository, "rm", "--cached", "--", ...Array(100).fill("keep.txt"),
  )).exitCode, 0);
  assert.equal(py.FS.readFile(`${repository}/keep.txt`, { encoding: "utf8" }), "keep base\n");
  await git(py, repository, "reset", "HEAD", "--", "keep.txt");

  const lockedIndex = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  py.FS.writeFile(`${indexPath}.lock`, "busy\n");
  const locked = await gitResult(py, repository, "rm", "--cached", "keep.txt");
  assert.equal(locked.exitCode, 1);
  assert.match(locked.output, /index lock/);
  assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, lockedIndex);
  py.FS.unlink(`${indexPath}.lock`);

  const originalWriteFile = py.FS.writeFile;
  let rejectedIndexWrite = false;
  (py.FS as any).writeFile = (path: string, ...args: unknown[]) => {
    if (path === indexPath && !rejectedIndexWrite) {
      rejectedIndexWrite = true;
      throw new Error("injected rm index write failure");
    }
    return Reflect.apply(originalWriteFile, py.FS, [path, ...args]);
  };
  const writeFailureIndex = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  try {
    const writeFailure = await gitResult(py, repository, "rm", "--cached", "keep.txt");
    assert.equal(writeFailure.exitCode, 1);
    assert.match(writeFailure.output, /injected rm index write failure/);
  } finally {
    (py.FS as any).writeFile = originalWriteFile;
  }
  assert.equal(rejectedIndexWrite, true);
  assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, writeFailureIndex);
  assert.equal(
    py.FS.readdir(`${repository}/.git`).some((name: string) => name.startsWith("piodide-rm-index-")),
    false,
  );

  const exactLarge = new Uint8Array(16 * 1024 * 1024).fill(0x65);
  py.FS.writeFile(`${repository}/large-exact.bin`, exactLarge);
  await git(py, repository, "add", "large-exact.bin");
  assert.equal((await gitResult(
    py, repository, "rm", "--cached", "large-exact.bin",
  )).exitCode, 0);
  assert.deepEqual(py.FS.readFile(`${repository}/large-exact.bin`) as Uint8Array, exactLarge);
  py.FS.unlink(`${repository}/large-exact.bin`);

  const overLarge = new Uint8Array(exactLarge.byteLength + 1).fill(0x6f);
  py.FS.writeFile(`${repository}/large-over.bin`, overLarge);
  await git(py, repository, "add", "large-over.bin");
  const overLargeIndex = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  const overLargeRejected = await gitResult(
    py, repository, "rm", "--cached", "large-over.bin",
  );
  assert.equal(overLargeRejected.exitCode, 2);
  assert.match(overLargeRejected.output, /worktree file exceeds 16777216 bytes/);
  assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, overLargeIndex);
  assert.deepEqual(py.FS.readFile(`${repository}/large-over.bin`) as Uint8Array, overLarge);
  await git(py, repository, "reset", "HEAD", "--", "large-over.bin");
  py.FS.unlink(`${repository}/large-over.bin`);

  const aggregatePaths = Array.from({ length: 4 }, (_, index) => `aggregate-${index}.bin`);
  for (const path of aggregatePaths) {
    py.FS.writeFile(`${repository}/${path}`, exactLarge);
    await git(py, repository, "add", path);
  }
  assert.equal((await gitResult(
    py, repository, "rm", "--cached", "--", ...aggregatePaths,
  )).exitCode, 0);
  for (const path of aggregatePaths) {
    assert.equal((py.FS.stat(`${repository}/${path}`) as { size: number }).size, exactLarge.byteLength);
    await git(py, repository, "add", path);
  }
  py.FS.writeFile(`${repository}/aggregate-over.bin`, new Uint8Array([0x78]));
  await git(py, repository, "add", "aggregate-over.bin");
  const aggregateIndex = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  const aggregateRejected = await gitResult(
    py,
    repository,
    "rm",
    "--cached",
    "--",
    ...aggregatePaths,
    "aggregate-over.bin",
  );
  assert.equal(aggregateRejected.exitCode, 2);
  assert.match(aggregateRejected.output, /compared worktree bytes exceed 67108864/);
  assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, aggregateIndex);
  await git(py, repository, "reset", "HEAD", "--", ...aggregatePaths, "aggregate-over.bin");
  for (const path of [...aggregatePaths, "aggregate-over.bin"]) py.FS.unlink(`${repository}/${path}`);
  assert.equal(await git(py, repository, "rev-parse", "HEAD"), head);

  const conflictRepository = "/home/web/rm-cached-conflict";
  py.FS.mkdirTree(conflictRepository);
  await git(py, conflictRepository, "init", "-b", "main");
  py.FS.writeFile(`${conflictRepository}/conflict.txt`, "base\n");
  await git(py, conflictRepository, "add", "conflict.txt");
  await git(py, conflictRepository, "commit", "-m", "conflict base");
  await git(py, conflictRepository, "switch", "-c", "side");
  py.FS.writeFile(`${conflictRepository}/conflict.txt`, "side\n");
  await git(py, conflictRepository, "add", "conflict.txt");
  await git(py, conflictRepository, "commit", "-m", "conflict side");
  await git(py, conflictRepository, "switch", "main");
  py.FS.writeFile(`${conflictRepository}/conflict.txt`, "main\n");
  await git(py, conflictRepository, "add", "conflict.txt");
  await git(py, conflictRepository, "commit", "-m", "conflict main");
  const conflictHead = await git(py, conflictRepository, "rev-parse", "HEAD");
  const conflicted = await gitResult(py, conflictRepository, "merge", "side");
  assert.equal(conflicted.exitCode, 1, conflicted.output);
  const conflictIndex = new Uint8Array(
    py.FS.readFile(`${conflictRepository}/.git/index`) as Uint8Array,
  );
  const conflictWorktree = new Uint8Array(
    py.FS.readFile(`${conflictRepository}/conflict.txt`) as Uint8Array,
  );
  const unmergedRejected = await gitResult(
    py, conflictRepository, "rm", "--cached", "conflict.txt",
  );
  assert.equal(unmergedRejected.exitCode, 1);
  assert.match(unmergedRejected.output, /unmerged index/);
  assert.deepEqual(
    py.FS.readFile(`${conflictRepository}/.git/index`) as Uint8Array,
    conflictIndex,
  );
  assert.deepEqual(
    py.FS.readFile(`${conflictRepository}/conflict.txt`) as Uint8Array,
    conflictWorktree,
  );
  const unmergedWorktreeRejected = await gitResult(
    py, conflictRepository, "rm", "conflict.txt",
  );
  assert.equal(unmergedWorktreeRejected.exitCode, 1);
  assert.match(unmergedWorktreeRejected.output, /rm refuses an unmerged index/);
  assert.deepEqual(
    py.FS.readFile(`${conflictRepository}/.git/index`) as Uint8Array,
    conflictIndex,
  );
  assert.deepEqual(
    py.FS.readFile(`${conflictRepository}/conflict.txt`) as Uint8Array,
    conflictWorktree,
  );
  assert.equal(await git(py, conflictRepository, "rev-parse", "HEAD"), conflictHead);
  await git(py, conflictRepository, "merge", "--abort");
});

test("bounded Git rm coordinates safe worktree and index deletion with rollback", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/rm-worktree-protocol";
  const indexPath = `${repository}/.git/index`;
  py.FS.mkdirTree(`${repository}/clean-dir/sub`);
  py.FS.mkdirTree(`${repository}/mixed-dir/sub`);
  py.FS.mkdirTree(`${repository}/raw`);
  py.FS.mkdirTree(`${repository}/ancestry`);
  await git(py, repository, "init", "-b", "main");
  const fixtures = new Map([
    ["clean.txt", "clean base\n"],
    ["second.txt", "second base\n"],
    ["modified.txt", "modified base\n"],
    ["staged.txt", "staged base\n"],
    ["clean-dir/a.txt", "directory a\n"],
    ["clean-dir/sub/b.txt", "directory b\n"],
    ["mixed-dir/sub/tracked.txt", "tracked in mixed tree\n"],
    ["raw/-dash.txt", "dash base\n"],
    ["raw/tab\tname.txt", "tab base\n"],
    ["raw/line\nname.txt", "line base\n"],
    ["raw/quote'name.txt", "quote base\n"],
    ["exec.sh", "#!/bin/sh\nexit 0\n"],
    ["link-target.txt", "link target\n"],
    ["ancestry/file.txt", "ancestry base\n"],
  ]);
  for (const [path, contents] of fixtures) py.FS.writeFile(`${repository}/${path}`, contents);
  py.FS.chmod(`${repository}/exec.sh`, 0o755);
  py.FS.symlink("link-target.txt", `${repository}/tracked-link`);
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "rm worktree base");
  const head = await git(py, repository, "rev-parse", "HEAD");

  const help = await git(py, repository, "help", "rm");
  assert.match(help, /git rm \[-r\].*git rm --cached \[-r\]/s);
  assert.match(help, /index=HEAD and worktree=index/);
  assert.match(help, /8 MiB output/);

  const removed = await gitResult(
    py, repository, "rm", "--", "second.txt", "clean.txt", "clean.txt",
  );
  assert.deepEqual(removed, {
    exitCode: 0,
    output: "rm 'clean.txt'\nrm 'second.txt'\n",
  });
  assert.equal(py.FS.analyzePath(`${repository}/clean.txt`).exists, false);
  assert.equal(py.FS.analyzePath(`${repository}/second.txt`).exists, false);
  assert.equal(await git(py, repository, "ls-files", "--", "clean.txt", "second.txt"), "");
  assert.equal(await git(py, repository, "rev-parse", "HEAD"), head);
  await git(py, repository, "checkout", "HEAD", "--", "clean.txt", "second.txt");

  const assertRejectedUnchanged = async (
    exitCode: number,
    pattern: RegExp,
    paths: string[],
    ...args: string[]
  ) => {
    const index = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
    const snapshots = new Map(paths.map((path) => [
      path,
      py.FS.analyzePath(`${repository}/${path}`).exists
        ? new Uint8Array(py.FS.readFile(`${repository}/${path}`) as Uint8Array)
        : null,
    ]));
    const response = await gitResult(py, repository, "rm", ...args);
    assert.equal(response.exitCode, exitCode, `${args.join(" ")}: ${response.output}`);
    assert.match(response.output, pattern);
    assert.doesNotMatch(response.output, /^rm '/m);
    assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, index);
    for (const [path, bytes] of snapshots) {
      assert.equal(py.FS.analyzePath(`${repository}/${path}`).exists, bytes !== null, path);
      if (bytes) assert.deepEqual(py.FS.readFile(`${repository}/${path}`) as Uint8Array, bytes, path);
    }
  };

  await assertRejectedUnchanged(
    2, /did not match/, ["clean.txt"], "--", "clean.txt", "missing.txt",
  );
  py.FS.writeFile(`${repository}/modified.txt`, "modified worktree\n");
  await assertRejectedUnchanged(
    1, /worktree differs from the index/, ["clean.txt", "modified.txt"],
    "--", "clean.txt", "modified.txt",
  );
  await git(py, repository, "checkout", "HEAD", "--", "modified.txt");

  py.FS.writeFile(`${repository}/staged.txt`, "staged bytes\n");
  await git(py, repository, "add", "staged.txt");
  await assertRejectedUnchanged(
    1, /index differs from HEAD/, ["clean.txt", "staged.txt"],
    "--", "clean.txt", "staged.txt",
  );
  await git(py, repository, "checkout", "HEAD", "--", "staged.txt");
  py.FS.writeFile(`${repository}/new-staged.txt`, "new staged\n");
  await git(py, repository, "add", "new-staged.txt");
  await assertRejectedUnchanged(
    1, /index differs from HEAD/, ["new-staged.txt"], "--", "new-staged.txt",
  );
  await git(py, repository, "reset", "HEAD", "--", "new-staged.txt");
  py.FS.unlink(`${repository}/new-staged.txt`);

  await assertRejectedUnchanged(
    2, /requires -r/, ["clean-dir/a.txt", "clean-dir/sub/b.txt"], "--", "clean-dir",
  );
  const directoryRemoved = await gitResult(py, repository, "rm", "-r", "--", "clean-dir");
  assert.equal(directoryRemoved.exitCode, 0, directoryRemoved.output);
  assert.match(directoryRemoved.output, /rm 'clean-dir\/a\.txt'/);
  assert.match(directoryRemoved.output, /rm 'clean-dir\/sub\/b\.txt'/);
  assert.equal(py.FS.analyzePath(`${repository}/clean-dir`).exists, false);
  await git(py, repository, "checkout", "HEAD", "--", "clean-dir");

  py.FS.writeFile(`${repository}/mixed-dir/untracked.txt`, "untracked survives\n");
  const mixedRemoved = await gitResult(py, repository, "rm", "-r", "--", "mixed-dir");
  assert.equal(mixedRemoved.exitCode, 0, mixedRemoved.output);
  assert.equal(py.FS.analyzePath(`${repository}/mixed-dir/sub/tracked.txt`).exists, false);
  assert.equal(
    py.FS.readFile(`${repository}/mixed-dir/untracked.txt`, { encoding: "utf8" }),
    "untracked survives\n",
  );
  assert.equal(await git(py, repository, "ls-files", "--", "mixed-dir"), "");
  await git(py, repository, "checkout", "HEAD", "--", "mixed-dir/sub/tracked.txt");

  const rawRemoved = await gitResult(
    py, `${repository}/raw`, "rm", "--",
    "-dash.txt", "tab\tname.txt", "line\nname.txt", "quote'name.txt",
  );
  assert.equal(rawRemoved.exitCode, 0, rawRemoved.output);
  assert.match(rawRemoved.output, /rm '-dash\.txt'/);
  assert.match(rawRemoved.output, /\\011/);
  assert.match(rawRemoved.output, /\\012/);
  assert.match(rawRemoved.output, /rm "quote'name\.txt"/);
  for (const path of [
    "raw/-dash.txt", "raw/tab\tname.txt", "raw/line\nname.txt", "raw/quote'name.txt",
  ])
    assert.equal(py.FS.analyzePath(`${repository}/${path}`).exists, false, path);
  await git(py, repository, "checkout", "HEAD", "--", "raw");

  const outsideCwd = await gitResult(py, `${repository}/raw`, "rm", "--", "../clean.txt");
  assert.deepEqual(outsideCwd, { exitCode: 0, output: "rm '../clean.txt'\n" });
  await git(py, repository, "checkout", "HEAD", "--", "clean.txt");

  const modesRemoved = await gitResult(py, repository, "rm", "--", "exec.sh", "tracked-link");
  assert.equal(modesRemoved.exitCode, 0, modesRemoved.output);
  assert.equal(py.FS.analyzePath(`${repository}/exec.sh`).exists, false);
  assert.equal(py.FS.analyzePath(`${repository}/tracked-link`).exists, false);
  await git(py, repository, "checkout", "HEAD", "--", "exec.sh", "tracked-link");
  assert.notEqual(py.FS.stat(`${repository}/exec.sh`).mode & 0o111, 0);
  assert.equal(py.FS.readlink(`${repository}/tracked-link`), "link-target.txt");

  py.FS.mkdirTree(`${repository}/ancestry-target`);
  py.FS.writeFile(`${repository}/ancestry-target/file.txt`, "ancestry base\n");
  py.FS.unlink(`${repository}/ancestry/file.txt`);
  py.FS.rmdir(`${repository}/ancestry`);
  py.FS.symlink("ancestry-target", `${repository}/ancestry`);
  const ancestryIndex = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  const ancestryRejected = await gitResult(py, repository, "rm", "-r", "--", "ancestry");
  assert.equal(ancestryRejected.exitCode, 1);
  assert.match(ancestryRejected.output, /refuses symlink ancestry/);
  assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, ancestryIndex);
  assert.equal(py.FS.readFile(`${repository}/ancestry-target/file.txt`, { encoding: "utf8" }), "ancestry base\n");
  py.FS.unlink(`${repository}/ancestry`);
  py.FS.mkdirTree(`${repository}/ancestry`);
  py.FS.writeFile(`${repository}/ancestry/file.txt`, "ancestry base\n");

  await assertRejectedUnchanged(
    2, /at most 100 paths/, ["clean.txt"], "--", ...Array(101).fill("clean.txt"),
  );
  assert.equal((await gitResult(
    py, repository, "rm", "--", ...Array(100).fill("clean.txt"),
  )).exitCode, 0);
  await git(py, repository, "checkout", "HEAD", "--", "clean.txt");
  await assertRejectedUnchanged(
    2, /exceeds 4096 bytes/, ["clean.txt"], "--", "clean.txt", "p".repeat(4_097),
  );
  await assertRejectedUnchanged(
    2, /exceed 65536 aggregate bytes/, ["clean.txt"],
    "--", "clean.txt", ...Array(16).fill("q".repeat(4_096)),
  );
  const components129 = Array.from({ length: 129 }, (_, index) => `c${index}`).join("/");
  await assertRejectedUnchanged(
    2, /more than 128 components/, ["clean.txt"], "--", "clean.txt", components129,
  );
  await assertRejectedUnchanged(
    2, /unsupported rm option: -f/, ["clean.txt"], "-f", "clean.txt",
  );
  await assertRejectedUnchanged(
    2, /unsupported rm option: --bad/, ["clean.txt"], "clean.txt", "--bad",
  );

  const originalUnlink = py.FS.unlink;
  let unlinkInjected = false;
  const unlinkIndex = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  (py.FS as any).unlink = (path: string) => {
    if (path === `${repository}/second.txt` && !unlinkInjected) {
      unlinkInjected = true;
      throw new Error("injected rm worktree unlink failure");
    }
    return Reflect.apply(originalUnlink, py.FS, [path]);
  };
  try {
    const failure = await gitResult(py, repository, "rm", "--", "clean.txt", "second.txt");
    assert.equal(failure.exitCode, 1);
    assert.match(failure.output, /injected rm worktree unlink failure/);
    assert.doesNotMatch(failure.output, /^rm '/m);
  } finally {
    (py.FS as any).unlink = originalUnlink;
  }
  assert.equal(unlinkInjected, true);
  assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, unlinkIndex);
  assert.equal(py.FS.readFile(`${repository}/clean.txt`, { encoding: "utf8" }), "clean base\n");
  assert.equal(py.FS.readFile(`${repository}/second.txt`, { encoding: "utf8" }), "second base\n");

  const originalWriteFile = py.FS.writeFile;
  let writeInjected = false;
  const writeIndex = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  (py.FS as any).writeFile = (path: string, ...args: unknown[]) => {
    if (path === indexPath && !writeInjected) {
      writeInjected = true;
      throw new Error("injected coordinated rm index failure");
    }
    return Reflect.apply(originalWriteFile, py.FS, [path, ...args]);
  };
  try {
    const failure = await gitResult(py, repository, "rm", "--", "clean.txt", "exec.sh", "tracked-link");
    assert.equal(failure.exitCode, 1);
    assert.match(failure.output, /injected coordinated rm index failure/);
    assert.doesNotMatch(failure.output, /^rm '/m);
  } finally {
    (py.FS as any).writeFile = originalWriteFile;
  }
  assert.equal(writeInjected, true);
  assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, writeIndex);
  assert.equal(py.FS.readFile(`${repository}/clean.txt`, { encoding: "utf8" }), "clean base\n");
  assert.notEqual(py.FS.stat(`${repository}/exec.sh`).mode & 0o111, 0);
  assert.equal(py.FS.readlink(`${repository}/tracked-link`), "link-target.txt");

  let directoryWriteInjected = false;
  const directoryWriteIndex = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  (py.FS as any).writeFile = (path: string, ...args: unknown[]) => {
    if (path === indexPath && !directoryWriteInjected) {
      directoryWriteInjected = true;
      throw new Error("injected coordinated directory rm index failure");
    }
    return Reflect.apply(originalWriteFile, py.FS, [path, ...args]);
  };
  try {
    const failure = await gitResult(py, repository, "rm", "-r", "--", "clean-dir");
    assert.equal(failure.exitCode, 1);
    assert.match(failure.output, /injected coordinated directory rm index failure/);
    assert.doesNotMatch(failure.output, /^rm '/m);
  } finally {
    (py.FS as any).writeFile = originalWriteFile;
  }
  assert.equal(directoryWriteInjected, true);
  assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, directoryWriteIndex);
  assert.equal(
    py.FS.readFile(`${repository}/clean-dir/a.txt`, { encoding: "utf8" }),
    "directory a\n",
  );
  assert.equal(
    py.FS.readFile(`${repository}/clean-dir/sub/b.txt`, { encoding: "utf8" }),
    "directory b\n",
  );
  assert.equal(
    py.FS.readdir(`${repository}/.git`).some((name: string) => name.startsWith("piodide-rm-index-")),
    false,
  );
  assert.equal(await git(py, repository, "rev-parse", "HEAD"), head);
});

test("bounded Git mv preserves distinct index and worktree layers transactionally", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/mv-protocol";
  const indexPath = `${repository}/.git/index`;
  py.FS.mkdirTree(`${repository}/dir/sub`);
  py.FS.mkdirTree(`${repository}/raw`);
  await git(py, repository, "init", "-b", "main");
  const fixtures = new Map([
    ["clean.txt", "clean base\n"],
    ["modified.txt", "modified base\n"],
    ["staged.txt", "staged base\n"],
    ["collision-source.txt", "collision source\n"],
    ["tracked-destination.txt", "tracked destination\n"],
    ["dir/a.txt", "directory a\n"],
    ["dir/sub/b.txt", "directory b\n"],
    ["raw/-dash", "dash\n"],
    ["raw/tab\tname", "tab\n"],
    ["raw/line\nname", "newline\n"],
    ["exec.sh", "#!/bin/sh\nexit 0\n"],
    ["target.txt", "target\n"],
  ]);
  for (const [path, contents] of fixtures) py.FS.writeFile(`${repository}/${path}`, contents);
  py.FS.chmod(`${repository}/exec.sh`, 0o755);
  py.FS.symlink("target.txt", `${repository}/tracked-link`);
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "mv base");
  const head = await git(py, repository, "rev-parse", "HEAD");

  const help = await git(py, repository, "help", "mv");
  assert.match(help, /git mv \[--\] <source> <destination>/);
  assert.match(help, /preserves existing index OIDs\/modes/);
  assert.match(help, /destination must not exist/);
  assert.match(help, /unmerged indexes.*submodules.*pathspec magic/);
  assert.match(help, /100000 scanned\/index entries.*16 MiB index/);

  const stageEntry = async (path: string): Promise<{ mode: string; oid: string }> => {
    const output = await git(py, repository, "ls-files", "--stage", "--", path);
    const match = /^(\d+) ([0-9a-f]{40}) 0\t/.exec(output);
    assert.ok(match, `${path}: ${output}`);
    return { mode: match[1]!, oid: match[2]! };
  };
  const cleanStage = await stageEntry("clean.txt");
  assert.deepEqual(await gitResult(py, repository, "mv", "--", "clean.txt", "renamed.txt"), {
    exitCode: 0,
    output: "",
  });
  assert.equal(py.FS.analyzePath(`${repository}/clean.txt`).exists, false);
  assert.equal(py.FS.readFile(`${repository}/renamed.txt`, { encoding: "utf8" }), "clean base\n");
  assert.deepEqual(await stageEntry("renamed.txt"), cleanStage);
  assert.equal(await git(py, repository, "ls-files", "--", "clean.txt"), "");
  assert.equal(await git(py, repository, "rev-parse", "HEAD"), head);
  await git(py, repository, "reset", "--hard", "HEAD");

  const modifiedStage = await stageEntry("modified.txt");
  py.FS.writeFile(`${repository}/modified.txt`, "modified worktree survives\n");
  assert.equal((await gitResult(
    py, repository, "mv", "modified.txt", "modified-new.txt",
  )).exitCode, 0);
  assert.deepEqual(await stageEntry("modified-new.txt"), modifiedStage);
  assert.equal(
    py.FS.readFile(`${repository}/modified-new.txt`, { encoding: "utf8" }),
    "modified worktree survives\n",
  );
  assert.match(await git(py, repository, "diff", "--", "modified-new.txt"), /modified worktree survives/);
  await git(py, repository, "reset", "--hard", "HEAD");

  py.FS.writeFile(`${repository}/staged.txt`, "staged index bytes\n");
  await git(py, repository, "add", "staged.txt");
  const stagedEntry = await stageEntry("staged.txt");
  py.FS.writeFile(`${repository}/staged.txt`, "distinct worktree bytes\n");
  assert.equal((await gitResult(py, repository, "mv", "staged.txt", "staged-new.txt")).exitCode, 0);
  assert.deepEqual(await stageEntry("staged-new.txt"), stagedEntry);
  assert.equal(
    py.FS.readFile(`${repository}/staged-new.txt`, { encoding: "utf8" }),
    "distinct worktree bytes\n",
  );
  assert.match(await git(py, repository, "diff", "--", "staged-new.txt"), /distinct worktree bytes/);
  await git(py, repository, "reset", "--hard", "HEAD");

  const directoryA = await stageEntry("dir/a.txt");
  const directoryB = await stageEntry("dir/sub/b.txt");
  py.FS.writeFile(`${repository}/dir/untracked.txt`, "untracked stays untracked\n");
  assert.equal((await gitResult(py, repository, "mv", "dir", "new-dir")).exitCode, 0);
  assert.equal(py.FS.analyzePath(`${repository}/dir`).exists, false);
  assert.deepEqual(await stageEntry("new-dir/a.txt"), directoryA);
  assert.deepEqual(await stageEntry("new-dir/sub/b.txt"), directoryB);
  assert.equal(
    py.FS.readFile(`${repository}/new-dir/untracked.txt`, { encoding: "utf8" }),
    "untracked stays untracked\n",
  );
  assert.equal(await git(py, repository, "ls-files", "--", "new-dir/untracked.txt"), "");
  await git(py, repository, "reset", "--hard", "HEAD");
  await git(py, repository, "clean", "-f", "-d", "--", "new-dir");

  const executableStage = await stageEntry("exec.sh");
  assert.equal((await gitResult(py, repository, "mv", "exec.sh", "exec-new.sh")).exitCode, 0);
  assert.deepEqual(await stageEntry("exec-new.sh"), executableStage);
  assert.equal(executableStage.mode, "100755");
  assert.notEqual(py.FS.stat(`${repository}/exec-new.sh`).mode & 0o111, 0);
  await git(py, repository, "reset", "--hard", "HEAD");

  const linkStage = await stageEntry("tracked-link");
  const linkTarget = py.FS.readlink(`${repository}/tracked-link`);
  assert.equal((await gitResult(py, repository, "mv", "tracked-link", "renamed-link")).exitCode, 0);
  assert.deepEqual(await stageEntry("renamed-link"), linkStage);
  assert.equal(linkStage.mode, "120000");
  assert.equal(py.FS.isLink?.(py.FS.lstat(`${repository}/renamed-link`).mode), true);
  assert.equal(py.FS.readlink(`${repository}/renamed-link`), linkTarget);
  await git(py, repository, "reset", "--hard", "HEAD");

  assert.equal((await gitResult(
    py, `${repository}/raw`, "mv", "--", "-dash", "dash-new",
  )).exitCode, 0);
  assert.equal((await gitResult(
    py, `${repository}/raw`, "mv", "tab\tname", "tab\tnew",
  )).exitCode, 0);
  assert.equal((await gitResult(
    py, `${repository}/raw`, "mv", "line\nname", "line\nnew",
  )).exitCode, 0);
  assert.equal(py.FS.readFile(`${repository}/raw/dash-new`, { encoding: "utf8" }), "dash\n");
  assert.equal(py.FS.readFile(`${repository}/raw/tab\tnew`, { encoding: "utf8" }), "tab\n");
  assert.equal(py.FS.readFile(`${repository}/raw/line\nnew`, { encoding: "utf8" }), "newline\n");
  await git(py, repository, "reset", "--hard", "HEAD");
  assert.equal((await gitResult(py, `${repository}/dir`, "mv", "a.txt", "from-subdir.txt")).exitCode, 0);
  assert.equal(
    py.FS.readFile(`${repository}/dir/from-subdir.txt`, { encoding: "utf8" }),
    "directory a\n",
  );
  await git(py, repository, "reset", "--hard", "HEAD");

  const assertAtomicFailure = async (
    exitCode: number,
    pattern: RegExp,
    args: string[],
    paths: string[],
  ): Promise<void> => {
    const index = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
    const snapshots = paths.map((path) => {
      const absolute = `${repository}/${path}`;
      const stat = py.FS.analyzePath(absolute);
      if (!stat.exists) return { path, kind: "missing" as const };
      const mode = py.FS.lstat(absolute).mode;
      if (py.FS.isDir(mode)) {
        return { path, kind: "directory" as const, names: py.FS.readdir(absolute) };
      }
      if (py.FS.isLink?.(mode)) {
        return { path, kind: "link" as const, target: py.FS.readlink(absolute) };
      }
      return {
        path, kind: "file" as const,
        bytes: new Uint8Array(py.FS.readFile(absolute) as Uint8Array),
      };
    });
    const response = await gitResult(py, repository, "mv", ...args);
    assert.equal(response.exitCode, exitCode, `${args.join(" ")}: ${response.output}`);
    assert.match(response.output, pattern);
    assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, index);
    for (const snapshot of snapshots) {
      const absolute = `${repository}/${snapshot.path}`;
      assert.equal(py.FS.analyzePath(absolute).exists, snapshot.kind !== "missing", snapshot.path);
      if (snapshot.kind === "directory") assert.deepEqual(py.FS.readdir(absolute), snapshot.names);
      else if (snapshot.kind === "link") assert.equal(py.FS.readlink(absolute), snapshot.target);
      else if (snapshot.kind === "file") {
        assert.deepEqual(py.FS.readFile(absolute) as Uint8Array, snapshot.bytes);
      }
    }
  };

  py.FS.writeFile(`${repository}/untracked-destination.txt`, "untracked destination\n");
  await assertAtomicFailure(
    1, /destination already exists/, ["collision-source.txt", "untracked-destination.txt"],
    ["collision-source.txt", "untracked-destination.txt"],
  );
  await assertAtomicFailure(
    1, /destination already exists/, ["collision-source.txt", "tracked-destination.txt"],
    ["collision-source.txt", "tracked-destination.txt"],
  );
  py.FS.mkdir(`${repository}/empty-destination`);
  await assertAtomicFailure(
    1, /destination already exists/, ["collision-source.txt", "empty-destination"],
    ["collision-source.txt", "empty-destination"],
  );
  await assertAtomicFailure(
    1, /destination is inside the source/, ["dir", "dir/inside"],
    ["dir", "dir/a.txt"],
  );
  py.FS.writeFile(`${repository}/untracked-source.txt`, "untracked source\n");
  await assertAtomicFailure(
    1, /source is not tracked/, ["untracked-source.txt", "unused-destination"],
    ["untracked-source.txt"],
  );
  await assertAtomicFailure(
    1, /source does not exist/, ["missing-source", "unused-destination"],
    ["collision-source.txt"],
  );

  py.FS.unlink(`${repository}/tracked-destination.txt`);
  await assertAtomicFailure(
    1, /destination collides with the index/,
    ["collision-source.txt", "tracked-destination.txt"], ["collision-source.txt"],
  );
  await git(py, repository, "checkout", "HEAD", "--", "tracked-destination.txt");

  py.FS.mkdir(`${repository}/real-parent`);
  py.FS.symlink("real-parent", `${repository}/linked-parent`);
  await assertAtomicFailure(
    1, /refuses symlink ancestry/,
    ["collision-source.txt", "linked-parent/new.txt"], ["collision-source.txt", "linked-parent"],
  );
  assert.deepEqual(py.FS.readdir(`${repository}/real-parent`).sort(), [".", ".."]);

  const objectFs = createIsomorphicGitFs(py);
  py.FS.mkdir(`${repository}/submodule-entry`);
  await isomorphicGit.updateIndex({
    fs: objectFs,
    dir: repository,
    filepath: "submodule-entry",
    oid: head.trim(),
    mode: 0o160000,
    add: true,
  });
  await assertAtomicFailure(
    1, /does not support submodules/,
    ["submodule-entry", "submodule-moved"], ["submodule-entry"],
  );
  await isomorphicGit.updateIndex({
    fs: objectFs,
    dir: repository,
    filepath: "submodule-entry",
    remove: true,
    force: true,
  });
  py.FS.rmdir(`${repository}/submodule-entry`);

  for (const [args, pattern] of [
    [["-f", "collision-source.txt", "unused-destination"], /unsupported mv option: -f/],
    [["collision-source.txt"], /requires exactly one source and one destination/],
    [["collision-source.txt", "unused-destination", "extra"], /requires exactly one source and one destination/],
    [["collision-source.txt", "--bad"], /unsupported mv option: --bad/],
    [[`${repository}/collision-source.txt`, "unused-destination"], /relative to the worktree/],
    [["../outside", "unused-destination"], /escapes the worktree/],
    [[".git/index", "unused-destination"], /repository metadata/],
  ] as const) {
    await assertAtomicFailure(2, pattern, [...args], ["collision-source.txt"]);
  }
  await assertAtomicFailure(
    1, /same path/, ["collision-source.txt", "collision-source.txt"], ["collision-source.txt"],
  );
  await assertAtomicFailure(
    1, /source does not exist/, ["p".repeat(4_096), "unused-destination"],
    ["collision-source.txt"],
  );
  await assertAtomicFailure(
    2, /exceeds 4096 bytes/, ["p".repeat(4_097), "unused-destination"],
    ["collision-source.txt"],
  );
  const depth128 = Array(128).fill("p").join("/");
  const depth129 = `${depth128}/p`;
  await assertAtomicFailure(
    1, /parent does not exist/, [depth128, "unused-destination"], ["collision-source.txt"],
  );
  await assertAtomicFailure(
    2, /more than 128 components/, [depth129, "unused-destination"],
    ["collision-source.txt"],
  );

  const validIndex = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  const excessiveEntries = validIndex.slice();
  new DataView(
    excessiveEntries.buffer, excessiveEntries.byteOffset, excessiveEntries.byteLength,
  ).setUint32(8, 100_001);
  py.FS.writeFile(indexPath, excessiveEntries);
  const entryLimit = await gitResult(
    py, repository, "mv", "collision-source.txt", "unused-destination",
  );
  assert.equal(entryLimit.exitCode, 2);
  assert.match(entryLimit.output, /index entry limit exceeded \(100000\)/);
  assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, excessiveEntries);
  py.FS.writeFile(indexPath, validIndex);

  const oversizedIndex = new Uint8Array(16 * 1024 * 1024 + 1);
  oversizedIndex.set(validIndex.subarray(0, Math.min(validIndex.byteLength, oversizedIndex.byteLength)));
  py.FS.writeFile(indexPath, oversizedIndex);
  const byteLimit = await gitResult(
    py, repository, "mv", "collision-source.txt", "unused-destination",
  );
  assert.equal(byteLimit.exitCode, 2);
  assert.match(byteLimit.output, /index exceeds 16777216 bytes/);
  assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, oversizedIndex);
  py.FS.writeFile(indexPath, validIndex);

  const originalRename = py.FS.rename;
  let renameInjected = false;
  (py.FS as any).rename = (source: string, destination: string) => {
    if (source === `${repository}/collision-source.txt` && !renameInjected) {
      renameInjected = true;
      throw new Error("injected mv worktree failure");
    }
    return Reflect.apply(originalRename, py.FS, [source, destination]);
  };
  try {
    await assertAtomicFailure(
      1, /injected mv worktree failure/,
      ["collision-source.txt", "rename-failure.txt"], ["collision-source.txt"],
    );
  } finally {
    (py.FS as any).rename = originalRename;
  }
  assert.equal(renameInjected, true);

  const originalWriteFile = py.FS.writeFile;
  let indexWriteInjected = false;
  (py.FS as any).writeFile = (path: string, ...args: unknown[]) => {
    if (path === indexPath && !indexWriteInjected) {
      indexWriteInjected = true;
      throw new Error("injected mv index write failure");
    }
    return Reflect.apply(originalWriteFile, py.FS, [path, ...args]);
  };
  try {
    await assertAtomicFailure(
      1, /injected mv index write failure/,
      ["collision-source.txt", "index-failure.txt"], ["collision-source.txt"],
    );
  } finally {
    (py.FS as any).writeFile = originalWriteFile;
  }
  assert.equal(indexWriteInjected, true);

  let rollbackWriteInjected = false;
  let rollbackRenameInjected = false;
  (py.FS as any).writeFile = (path: string, ...args: unknown[]) => {
    if (path === indexPath && !rollbackWriteInjected) {
      rollbackWriteInjected = true;
      throw new Error("injected mv rollback index failure");
    }
    return Reflect.apply(originalWriteFile, py.FS, [path, ...args]);
  };
  (py.FS as any).rename = (source: string, destination: string) => {
    if (
      source === `${repository}/rollback-destination.txt` &&
      destination === `${repository}/collision-source.txt` &&
      !rollbackRenameInjected
    ) {
      rollbackRenameInjected = true;
      throw new Error("injected mv rollback rename failure");
    }
    return Reflect.apply(originalRename, py.FS, [source, destination]);
  };
  const rollbackIndex = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  let rollbackFailure;
  try {
    rollbackFailure = await gitResult(
      py, repository, "mv", "collision-source.txt", "rollback-destination.txt",
    );
  } finally {
    (py.FS as any).writeFile = originalWriteFile;
    (py.FS as any).rename = originalRename;
  }
  assert.equal(rollbackFailure.exitCode, 1);
  assert.match(rollbackFailure.output, /mv rollback failed.*injected mv rollback rename failure/);
  assert.equal(rollbackWriteInjected, true);
  assert.equal(rollbackRenameInjected, true);
  assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, rollbackIndex);
  assert.equal(py.FS.analyzePath(`${repository}/collision-source.txt`).exists, false);
  assert.equal(py.FS.readFile(`${repository}/rollback-destination.txt`, { encoding: "utf8" }), "collision source\n");
  Reflect.apply(originalRename, py.FS, [
    `${repository}/rollback-destination.txt`, `${repository}/collision-source.txt`,
  ]);
  assert.equal(
    py.FS.readdir(`${repository}/.git`).some((name: string) => name.startsWith("piodide-mv-index-")),
    false,
  );
  assert.equal(await git(py, repository, "rev-parse", "HEAD"), head);

  const conflictRepository = "/home/web/mv-conflict";
  py.FS.mkdirTree(conflictRepository);
  await git(py, conflictRepository, "init", "-b", "main");
  py.FS.writeFile(`${conflictRepository}/conflict.txt`, "base\n");
  await git(py, conflictRepository, "add", "conflict.txt");
  await git(py, conflictRepository, "commit", "-m", "conflict base");
  await git(py, conflictRepository, "switch", "-c", "side");
  py.FS.writeFile(`${conflictRepository}/conflict.txt`, "side\n");
  await git(py, conflictRepository, "add", "conflict.txt");
  await git(py, conflictRepository, "commit", "-m", "side");
  await git(py, conflictRepository, "switch", "main");
  py.FS.writeFile(`${conflictRepository}/conflict.txt`, "main\n");
  await git(py, conflictRepository, "add", "conflict.txt");
  await git(py, conflictRepository, "commit", "-m", "main");
  assert.equal((await gitResult(py, conflictRepository, "merge", "side")).exitCode, 1);
  const conflictIndex = new Uint8Array(
    py.FS.readFile(`${conflictRepository}/.git/index`) as Uint8Array,
  );
  const conflictBytes = new Uint8Array(
    py.FS.readFile(`${conflictRepository}/conflict.txt`) as Uint8Array,
  );
  const conflictMove = await gitResult(
    py, conflictRepository, "mv", "conflict.txt", "renamed-conflict.txt",
  );
  assert.equal(conflictMove.exitCode, 1);
  assert.match(conflictMove.output, /mv refuses an unmerged index/);
  assert.deepEqual(
    py.FS.readFile(`${conflictRepository}/.git/index`) as Uint8Array,
    conflictIndex,
  );
  assert.deepEqual(
    py.FS.readFile(`${conflictRepository}/conflict.txt`) as Uint8Array,
    conflictBytes,
  );
  assert.equal(py.FS.analyzePath(`${conflictRepository}/renamed-conflict.txt`).exists, false);
});

test("bounded Git reverse apply honors count and aggregate byte limits", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/apply-reverse-limits";
  py.FS.mkdirTree(repository);
  await git(py, repository, "init", "-b", "main");
  const missingInput = await gitResult(
    py, repository, "apply", "-R", "--check", "../missing-reverse.patch",
  );
  assert.equal(missingInput.exitCode, 2);
  assert.match(missingInput.output, /patch source does not exist/);
  py.FS.mkdirTree("/home/web/apply-patch-directory");
  const directoryInput = await gitResult(
    py, repository, "apply", "--reverse", "--check", "../apply-patch-directory",
  );
  assert.equal(directoryInput.exitCode, 2);
  assert.match(directoryInput.output, /patch source is not a regular file/);

  const hunkPatch = (count: number): string => {
    const lines = [
      "diff --git a/hunks.txt b/hunks.txt",
      "--- a/hunks.txt",
      "+++ b/hunks.txt",
    ];
    for (let line = 1; line <= count; line++) {
      lines.push(`@@ -${line} +${line} @@`, `-old-${line}`, `+new-${line}`);
    }
    return `${lines.join("\n")}\n`;
  };
  py.FS.writeFile(
    `${repository}/hunks.txt`,
    `${Array.from({ length: 10_000 }, (_, index) => `new-${index + 1}`).join("\n")}\n`,
  );
  py.FS.writeFile("/home/web/apply-hunks-exact.patch", hunkPatch(10_000));
  py.FS.writeFile("/home/web/apply-hunks-over.patch", hunkPatch(10_001));
  assert.equal((await gitResult(
    py, repository, "apply", "-R", "--check", "../apply-hunks-exact.patch",
  )).exitCode, 0);
  const hunksOver = await gitResult(
    py, repository, "apply", "-R", "--check", "../apply-hunks-over.patch",
  );
  assert.equal(hunksOver.exitCode, 2);
  assert.match(hunksOver.output, /patch hunk limit exceeded \(10000\)/);

  const linePatch = (count: number): string => {
    const fixed = [
      "diff --git a/lines.txt b/lines.txt",
      "--- a/lines.txt",
      "+++ b/lines.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ];
    return `${[fixed[0], ...Array(count - fixed.length).fill("metadata"), ...fixed.slice(1)].join("\n")}\n`;
  };
  py.FS.writeFile(`${repository}/lines.txt`, "new\n");
  py.FS.writeFile("/home/web/apply-lines-exact.patch", linePatch(100_000));
  py.FS.writeFile("/home/web/apply-lines-over.patch", linePatch(100_001));
  assert.equal((await gitResult(
    py, repository, "apply", "--reverse", "--check", "../apply-lines-exact.patch",
  )).exitCode, 0);
  const linesOver = await gitResult(
    py, repository, "apply", "--reverse", "--check", "../apply-lines-over.patch",
  );
  assert.equal(linesOver.exitCode, 2);
  assert.match(linesOver.output, /patch line limit exceeded \(100000\)/);
  py.FS.mkdirTree("/home/web/apply-no-repository");
  const outsideRepository = await gitResult(
    py, "/home/web/apply-no-repository", "apply", "-R", "--check", "../apply-lines-exact.patch",
  );
  assert.equal(outsideRepository.exitCode, 2);
  assert.match(outsideRepository.output, /not a Git repository/);

  const renameSection = (source: string, destination: string): string => [
    `diff --git a/${source} b/${destination}`,
    "similarity index 100%",
    `rename from ${source}`,
    `rename to ${destination}`,
  ].join("\n");
  const sourceSections: string[] = [];
  for (let index = 0; index < 4; index++) {
    py.FS.writeFile(`${repository}/source-new-${index}.bin`, new Uint8Array(16 * 1024 * 1024).fill(0x73));
    sourceSections.push(renameSection(`source-old-${index}.bin`, `source-new-${index}.bin`));
  }
  py.FS.writeFile("/home/web/apply-source-total-exact.patch", `${sourceSections.join("\n")}\n`);
  assert.equal((await gitResult(
    py, repository, "apply", "-R", "--check", "../apply-source-total-exact.patch",
  )).exitCode, 0);
  py.FS.writeFile(`${repository}/source-new-extra.bin`, "x");
  py.FS.writeFile(
    "/home/web/apply-source-total-over.patch",
    `${[...sourceSections, renameSection("source-old-extra.bin", "source-new-extra.bin")].join("\n")}\n`,
  );
  const sourceTotalOver = await gitResult(
    py, repository, "apply", "-R", "--check", "../apply-source-total-over.patch",
  );
  assert.equal(sourceTotalOver.exitCode, 2);
  assert.match(sourceTotalOver.output, /patch source bytes exceed 67108864/);
  for (let index = 0; index < 4; index++) py.FS.unlink(`${repository}/source-new-${index}.bin`);
  py.FS.unlink(`${repository}/source-new-extra.bin`);

  const insertionSection = (path: string): string => [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +0,0 @@",
    "-y",
    "\\ No newline at end of file",
  ].join("\n");
  const resultSections: string[] = [];
  for (let index = 0; index < 5; index++) {
    const size = index < 4 ? 12 * 1024 * 1024 : 16 * 1024 * 1024 - 5;
    py.FS.writeFile(`${repository}/result-${index}.bin`, new Uint8Array(size).fill(0x72));
    resultSections.push(insertionSection(`result-${index}.bin`));
  }
  py.FS.writeFile("/home/web/apply-result-total.patch", `${resultSections.join("\n")}\n`);
  assert.equal((await gitResult(
    py, repository, "apply", "--reverse", "--check", "../apply-result-total.patch",
  )).exitCode, 0);
  py.FS.writeFile(
    `${repository}/result-4.bin`,
    new Uint8Array(16 * 1024 * 1024 - 4).fill(0x72),
  );
  const resultTotalOver = await gitResult(
    py, repository, "apply", "--reverse", "--check", "../apply-result-total.patch",
  );
  assert.equal(resultTotalOver.exitCode, 2);
  assert.match(resultTotalOver.output, /patched bytes exceed 67108864/);

  assert.equal(py.FS.readFile(`${repository}/lines.txt`, { encoding: "utf8" }), "new\n");
  assert.match(
    py.FS.readFile(`${repository}/hunks.txt`, { encoding: "utf8" }) as string,
    /^new-1\n/,
  );
});

test("bounded Git ls-files filters literal paths atomically", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/ls-files-paths";
  const outside = "/home/web/ls-files-outside";
  py.FS.mkdirTree(`${repository}/dir/nested`);
  py.FS.mkdirTree(`${repository}/dir-two`);
  py.FS.mkdirTree(outside);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/alpha.txt`, "alpha\n");
  py.FS.writeFile(`${repository}/space name.txt`, "space\n");
  py.FS.writeFile(`${repository}/[literal]*.txt`, "literal\n");
  py.FS.writeFile(`${repository}/-dash`, "dash\n");
  py.FS.writeFile(`${repository}/--modified`, "option-looking\n");
  py.FS.writeFile(`${repository}/line\nbreak.txt`, "newline\n");
  py.FS.writeFile(`${repository}/binary.bin`, new Uint8Array([0, 1, 2, 255]));
  py.FS.writeFile(`${repository}/dir/a.txt`, "deleted later\n");
  py.FS.writeFile(`${repository}/dir/nested/b.txt`, "nested\n");
  py.FS.writeFile(`${repository}/dir-two/c.txt`, "prefix collision\n");
  py.FS.symlink("alpha.txt", `${repository}/alpha-link`);
  py.FS.writeFile(`${repository}/.gitignore`, "ignored-*\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "ls-files path fixture");

  py.FS.writeFile(`${repository}/alpha.txt`, "modified\n");
  py.FS.unlink(`${repository}/dir/a.txt`);
  py.FS.writeFile(`${repository}/dir/new.txt`, "untracked dir\n");
  py.FS.writeFile(`${repository}/other-new.txt`, "untracked root\n");
  py.FS.writeFile(`${repository}/ignored-root.txt`, "ignored\n");

  const beforeIndex = new Uint8Array(py.FS.readFile(`${repository}/.git/index`) as Uint8Array);
  const beforeHead = py.FS.readFile(`${repository}/.git/HEAD`, { encoding: "utf8" });
  const beforeStatus = (await gitResult(py, repository, "status", "--short")).output;

  const invoke = (cwd: string, ...args: string[]) => runGitEngineCommand({
    py,
    cwd,
    args: ["git-engine", "ls-files", ...args],
  });
  const output = async (cwd: string, ...args: string[]) => {
    const response = await invoke(cwd, ...args);
    assert.equal(
      response.exitCode,
      0,
      new TextDecoder().decode(response.stderr ?? response.stdout ?? new Uint8Array()),
    );
    return new TextDecoder().decode(response.stdout ?? new Uint8Array());
  };
  const assertRejected = async (cwd: string, ...args: string[]) => {
    const response = await invoke(cwd, ...args);
    assert.equal(response.exitCode, 2, `${cwd}: ${args.join(" ")}`);
    assert.equal(response.stdout?.byteLength ?? 0, 0);
    assert.ok((response.stderr?.byteLength ?? 0) > 0);
  };

  const all = await output(repository);
  assert.equal(await output(repository, "--"), all);
  assert.equal(await output(repository, "--", "."), all);
  assert.equal(await output(repository, "--", "alpha.txt"), "alpha.txt\n");
  assert.equal(await output(repository, "--", "dir/../alpha.txt"), "alpha.txt\n");
  assert.equal(await output(repository, "--", `${repository}/alpha.txt`), "alpha.txt\n");
  assert.equal(await output(repository, "--", "absent.txt"), "");
  assert.equal(
    await output(repository, "--", "dir"),
    "dir/a.txt\ndir/nested/b.txt\n",
  );
  assert.doesNotMatch(await output(repository, "--", "dir"), /dir-two/);
  assert.equal(await output(repository, "--", "[literal]*.txt"), "[literal]*.txt\n");
  assert.equal(await output(repository, "--", "-dash"), "-dash\n");
  assert.equal(await output(repository, "--", "--modified"), "--modified\n");
  assert.equal(await output(repository, "--", "binary.bin"), "binary.bin\n");
  assert.equal(await output(repository, "--", "alpha-link"), "alpha-link\n");
  assert.equal(
    await output(repository, "--", "alpha.txt", "dir", "alpha.txt"),
    "alpha.txt\ndir/a.txt\ndir/nested/b.txt\n",
  );

  assert.equal(await output(repository, "--modified", "--", "alpha.txt"), "alpha.txt\n");
  assert.equal(await output(repository, "--deleted", "--", "dir"), "dir/a.txt\n");
  assert.equal(
    await output(repository, "--others", "--exclude-standard", "--", "dir"),
    "dir/new.txt\n",
  );
  assert.equal(
    await output(repository, "--others", "--", "ignored-root.txt"),
    "ignored-root.txt\n",
  );
  assert.equal(
    await output(repository, "--others", "--exclude-standard", "--", "ignored-root.txt"),
    "",
  );

  assert.equal(
    await output(`${repository}/dir/nested`, "--", "."),
    "dir/nested/b.txt\n",
  );
  assert.equal(
    await output(`${repository}/dir/nested`, "--", "../../alpha.txt"),
    "alpha.txt\n",
  );
  assert.equal(
    await output(`${repository}/dir/nested`, "--others", "--", "../new.txt"),
    "dir/new.txt\n",
  );

  const staged = await invoke(repository, "--stage", "-z", "--", "alpha-link", "line\nbreak.txt");
  assert.equal(staged.exitCode, 0);
  const stagedRecords = new TextDecoder().decode(staged.stdout).split("\0").filter(Boolean);
  assert.equal(stagedRecords.length, 2);
  assert.match(stagedRecords[0], /^120000 [0-9a-f]{40} 0\talpha-link$/);
  assert.match(stagedRecords[1], /^100644 [0-9a-f]{40} 0\tline\nbreak\.txt$/);

  const repeated100 = Array.from({ length: 100 }, () => "alpha.txt");
  assert.equal(await output(repository, "--", ...repeated100), "alpha.txt\n");
  await assertRejected(repository, "--", ...repeated100, "alpha.txt");
  const exactPath = "p".repeat(4_096);
  assert.equal(await output(repository, "--", exactPath), "");
  await assertRejected(repository, "--", `${exactPath}p`);
  await assertRejected(repository, "--", "");
  await assertRejected(repository, "--", "\ud800");
  await assertRejected(repository, "--", "../ls-files-outside");
  await assertRejected(repository, "alpha.txt");
  await assertRejected(repository, "--stage", "--modified", "--", "alpha.txt");
  await assertRejected(repository, "--exclude-standard", "--", "alpha.txt");
  await assertRejected(outside, "--", "anything");
  await assertRejected(outside, "--definitely-unknown");

  assert.match(await git(py, repository, "help", "ls-files"), /literal cwd-relative exact\/directory-prefix selectors/);
  assert.deepEqual(py.FS.readFile(`${repository}/.git/index`) as Uint8Array, beforeIndex);
  assert.equal(py.FS.readFile(`${repository}/.git/HEAD`, { encoding: "utf8" }), beforeHead);
  assert.equal((await gitResult(py, repository, "status", "--short")).output, beforeStatus);

  const writeSyntheticIndex = (paths: string[]): void => {
    const encodedPaths = paths.map((path) => new TextEncoder().encode(path));
    const entrySizes = encodedPaths.map((path) => (62 + path.byteLength + 1 + 7) & ~7);
    const entriesLength = entrySizes.reduce((total, length) => total + length, 0);
    const bytes = new Uint8Array(12 + entriesLength + 20);
    bytes.set(new TextEncoder().encode("DIRC"), 0);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, 2);
    view.setUint32(8, paths.length);
    let offset = 12;
    for (let index = 0; index < encodedPaths.length; index++) {
      const path = encodedPaths[index];
      view.setUint32(offset + 24, 0o100644);
      view.setUint16(offset + 60, Math.min(path.byteLength, 0x0fff));
      bytes.set(path, offset + 62);
      offset += entrySizes[index];
    }
    bytes.set(createHash("sha1").update(bytes.subarray(0, offset)).digest(), offset);
    py.FS.writeFile(`${repository}/.git/index`, bytes);
  };
  try {
    writeSyntheticIndex(Array.from(
      { length: 100_000 },
      (_, index) => `p${String(index).padStart(6, "0")}`,
    ));
    const exactCandidates = await invoke(repository, "--stage");
    assert.equal(exactCandidates.exitCode, 0);
    assert.equal(
      new TextDecoder().decode(exactCandidates.stdout).split("\n").filter(Boolean).length,
      100_000,
    );

    writeSyntheticIndex(Array.from(
      { length: 100_001 },
      (_, index) => `p${String(index).padStart(6, "0")}`,
    ));
    await assertRejected(repository, "--stage");

    writeSyntheticIndex(["x".repeat(16 * 1024 * 1024 - 51)]);
    const exactOutput = await invoke(repository, "--stage");
    assert.equal(exactOutput.exitCode, 0);
    assert.equal(exactOutput.stdout?.byteLength, 16 * 1024 * 1024);

    writeSyntheticIndex(["x".repeat(16 * 1024 * 1024 - 50)]);
    await assertRejected(repository, "--stage");
  } finally {
    py.FS.writeFile(`${repository}/.git/index`, beforeIndex);
  }
  assert.deepEqual(py.FS.readFile(`${repository}/.git/index`) as Uint8Array, beforeIndex);
  try {
    py.FS.writeFile(`${repository}/.git/index`, "not an index");
    await assertRejected(repository, "--cached", "--", "alpha.txt");
  } finally {
    py.FS.writeFile(`${repository}/.git/index`, beforeIndex);
  }
  assert.deepEqual(py.FS.readFile(`${repository}/.git/index`) as Uint8Array, beforeIndex);
});

test("bounded Git config unset is scoped, atomic, and rejects false success", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/config-unset";
  const outside = "/home/web/config-outside";
  const localPath = `${repository}/.git/config`;
  const globalPath = "/home/web/.gitconfig";
  py.FS.mkdirTree(repository);
  py.FS.mkdirTree(outside);
  await git(py, repository, "init", "-b", "main");

  await git(py, repository, "config", "audit.key", "value");
  assert.equal((await gitResult(py, repository, "config", "--get", "audit.key")).output, "value\n");
  const beforeFirstUnset = py.FS.readFile(localPath, { encoding: "utf8" });
  const firstUnset = await gitResult(py, repository, "config", "--unset", "audit.key");
  assert.equal(firstUnset.exitCode, 0, firstUnset.output);
  assert.equal(firstUnset.output, "");
  assert.notEqual(py.FS.readFile(localPath, { encoding: "utf8" }), beforeFirstUnset);
  assert.equal((await gitResult(py, repository, "config", "--get", "audit.key")).exitCode, 1);
  const afterFirstUnset = py.FS.readFile(localPath, { encoding: "utf8" });
  const missingUnset = await gitResult(py, repository, "config", "--unset", "audit.key");
  assert.equal(missingUnset.exitCode, 5);
  assert.equal(missingUnset.output, "");
  assert.equal(py.FS.readFile(localPath, { encoding: "utf8" }), afterFirstUnset);

  py.FS.writeFile(globalPath, "[scope]\n\tkey = global\n\tglobal-only = yes\n");
  await git(py, repository, "config", "scope.key", "local");
  await git(py, repository, "config", "scope.local-only", "yes");
  assert.equal((await gitResult(py, repository, "config", "--get", "scope.key")).output, "local\n");
  assert.equal((await gitResult(py, repository, "config", "--global", "--get", "scope.key")).output, "global\n");
  assert.equal((await gitResult(py, repository, "config", "--get", "--local", "scope.key")).output, "local\n");
  const localListing = await gitResult(py, repository, "config", "--local", "--list");
  assert.match(localListing.output, /scope\.local-only=yes/);
  assert.doesNotMatch(localListing.output, /global-only/);
  await git(py, repository, "config", "--unset", "scope.key");
  assert.equal((await gitResult(py, repository, "config", "--local", "--get", "scope.key")).exitCode, 1);
  assert.equal((await gitResult(py, repository, "config", "--get", "scope.key")).output, "global\n");
  assert.equal((await gitResult(py, repository, "config", "--unset", "scope.key")).exitCode, 5);
  assert.equal((await gitResult(py, repository, "config", "--global", "--get", "scope.key")).output, "global\n");
  await git(py, outside, "config", "--global", "--unset", "scope.key");
  assert.equal((await gitResult(py, repository, "config", "--get", "scope.key")).exitCode, 1);
  assert.equal((await gitResult(py, outside, "config", "--local", "--list")).exitCode, 1);

  const isolatedHome = "/home/web/config-home";
  const isolatedGlobalPath = `${isolatedHome}/.gitconfig`;
  py.FS.mkdirTree(isolatedHome);
  const gitWithHome = async (cwd: string, home: string, ...args: string[]) => {
    const response = await runGitEngineCommand({
      py,
      cwd,
      args: ["git-engine", ...args],
      env: { HOME: home },
    });
    return {
      exitCode: response.exitCode,
      output: new TextDecoder().decode(response.stdout ?? response.stderr ?? new Uint8Array()),
    };
  };
  const defaultGlobalBeforeIsolated = py.FS.readFile(globalPath, { encoding: "utf8" });
  assert.equal(
    (await gitWithHome(outside, isolatedHome, "config", "--global", "home.key", "isolated")).exitCode,
    0,
  );
  assert.match(py.FS.readFile(isolatedGlobalPath, { encoding: "utf8" }) as string, /key = isolated/);
  assert.equal(py.FS.readFile(globalPath, { encoding: "utf8" }), defaultGlobalBeforeIsolated);
  assert.deepEqual(
    await gitWithHome(outside, isolatedHome, "config", "--global", "--get", "home.key"),
    { exitCode: 0, output: "isolated\n" },
  );
  assert.deepEqual(
    await gitWithHome(outside, isolatedHome, "config", "--global", "--unset", "home.key"),
    { exitCode: 0, output: "" },
  );
  assert.equal(
    (await gitWithHome(outside, isolatedHome, "config", "--global", "--get", "home.key")).exitCode,
    1,
  );
  assert.equal(py.FS.readFile(globalPath, { encoding: "utf8" }), defaultGlobalBeforeIsolated);

  const invalidHomeLocal = await gitWithHome(repository, "relative-home", "config", "--local", "stable.home", "local");
  assert.equal(invalidHomeLocal.exitCode, 0, invalidHomeLocal.output);
  const relativeHome = await gitWithHome(outside, "relative-home", "config", "--global", "--get", "stable.key");
  assert.equal(relativeHome.exitCode, 1);
  assert.match(relativeHome.output, /HOME must be an absolute workspace path/);
  const escapedHome = await gitWithHome(outside, "/tmp/config-home", "config", "--global", "--get", "stable.key");
  assert.equal(escapedHome.exitCode, 1);
  assert.match(escapedHome.output, /path must stay inside \/home\/web/);
  assert.equal(py.FS.readFile(globalPath, { encoding: "utf8" }), defaultGlobalBeforeIsolated);

  await git(py, repository, "config", "--", "dash.key", "--local");
  assert.equal((await gitResult(py, repository, "config", "--local", "--get", "dash.key")).output, "--local\n");
  await git(py, repository, "config", "--unset", "--", "dash.key");

  const preserved = `${(py.FS.readFile(localPath, { encoding: "utf8" }) as string).trimEnd()}\n` +
    "# preserve this comment\r\n[Audit]\r\n\tKeep = stay\r\n\tRemove = gone\r\n" +
    "[tail]\n\tvalue = exact\n";
  py.FS.writeFile(localPath, preserved);
  await git(py, repository, "config", "--unset", "AUDIT.REMOVE");
  assert.equal(
    py.FS.readFile(localPath, { encoding: "utf8" }),
    preserved.replace("\tRemove = gone\r\n", ""),
  );
  assert.equal((await gitResult(py, repository, "config", "--get", "audit.keep")).output, "stay\n");

  const continued = `${py.FS.readFile(localPath, { encoding: "utf8" })}` +
    "[continued]\n\tremove = first \\\n\t  second \\\n\t  third\n\tkeep = exact\n";
  py.FS.writeFile(localPath, continued);
  await git(py, repository, "config", "--unset", "continued.remove");
  assert.equal(
    py.FS.readFile(localPath, { encoding: "utf8" }),
    continued.replace("\tremove = first \\\n\t  second \\\n\t  third\n", ""),
  );
  assert.equal((await gitResult(py, repository, "config", "--get", "continued.keep")).output, "exact\n");

  const duplicated = `${py.FS.readFile(localPath, { encoding: "utf8" })}` +
    "[duplicate]\n\tvalue = one\n\tvalue = two\n";
  py.FS.writeFile(localPath, duplicated);
  const duplicateUnset = await gitResult(py, repository, "config", "--unset", "duplicate.value");
  assert.equal(duplicateUnset.exitCode, 5);
  assert.equal(duplicateUnset.output, "warning: duplicate.value has multiple values\n");
  assert.equal(py.FS.readFile(localPath, { encoding: "utf8" }), duplicated);

  const simpleLocal = "[core]\n\tbare = false\n[stable]\n\tkey = local\n";
  const simpleGlobal = "[stable]\n\tkey = global\n";
  py.FS.writeFile(localPath, simpleLocal);
  py.FS.writeFile(globalPath, simpleGlobal);
  const oversizedKey = `${"s".repeat(4095)}.n`;
  for (const malformed of [
    ["--unset"],
    ["--unset", "stable.key", "extra"],
    ["--get", "--unset", "stable.key"],
    ["--global", "--local", "--unset", "stable.key"],
    ["--global", "--global", "--unset", "stable.key"],
    ["--list", "extra"],
    ["--bogus", "stable.key"],
    ["invalid", "value"],
    [oversizedKey, "value"],
  ]) {
    const rejected = await gitResult(py, repository, "config", ...malformed);
    assert.equal(rejected.exitCode, 2, `${malformed.join(" ")}: ${rejected.output}`);
    assert.equal(py.FS.readFile(localPath, { encoding: "utf8" }), simpleLocal);
    assert.equal(py.FS.readFile(globalPath, { encoding: "utf8" }), simpleGlobal);
  }
  const outsideUnsupported = await gitResult(py, outside, "config", "--bogus", "stable.key");
  assert.equal(outsideUnsupported.exitCode, 2);
  assert.match(outsideUnsupported.output, /unsupported config option: --bogus/);

  const exactKey = `${"s".repeat(4094)}.n`;
  await git(py, outside, "config", "--global", exactKey, "boundary");
  assert.equal((await gitResult(py, outside, "config", "--global", "--unset", exactKey)).exitCode, 0);
  const keyTooLong = await gitResult(py, outside, "config", "--global", "--unset", oversizedKey);
  assert.equal(keyTooLong.exitCode, 2);
  assert.match(keyTooLong.output, /config key exceeds 4096 bytes/);

  const fileLimit = 1024 * 1024;
  const exactFilePrefix = "[limit]\n\ttarget = yes\n";
  const exactFile = exactFilePrefix + `#${"f".repeat(fileLimit - exactFilePrefix.length - 1)}`;
  assert.equal(new TextEncoder().encode(exactFile).byteLength, fileLimit);
  py.FS.writeFile(localPath, exactFile);
  assert.equal((await gitResult(py, repository, "config", "--unset", "limit.target")).exitCode, 0);
  const oversizedFile = `${exactFile}x`;
  py.FS.writeFile(localPath, oversizedFile);
  const rejectedFile = await gitResult(py, repository, "config", "--unset", "limit.target");
  assert.equal(rejectedFile.exitCode, 2);
  assert.match(rejectedFile.output, /selected config file exceeds 1048576 bytes/);
  assert.equal(py.FS.readFile(localPath, { encoding: "utf8" }), oversizedFile);

  const exactEntries = `[bulk]\n${"other = 1\n".repeat(99_999)}target = yes\n`;
  py.FS.writeFile(localPath, exactEntries);
  assert.equal((await gitResult(py, repository, "config", "--unset", "bulk.target")).exitCode, 0);
  const excessiveEntries = `[bulk]\n${"other = 1\n".repeat(100_000)}target = yes\n`;
  assert.ok(new TextEncoder().encode(excessiveEntries).byteLength < fileLimit);
  py.FS.writeFile(localPath, excessiveEntries);
  const rejectedEntries = await gitResult(py, repository, "config", "--unset", "bulk.target");
  assert.equal(rejectedEntries.exitCode, 2);
  assert.match(rejectedEntries.output, /selected config has more than 100000 entries/);
  assert.equal(py.FS.readFile(localPath, { encoding: "utf8" }), excessiveEntries);

  const help = await gitResult(py, repository, "config", "--help");
  assert.equal(help.exitCode, 0);
  assert.match(help.output, /--unset <name>/);
  assert.match(help.output, /status: 0 one value removed, 5 no value or multiple values/);
  assert.match(help.output, /4096-byte key, 1 MiB selected config file, 100000 parsed entries/);
});

test("bounded Git commit validates complete requests and common automation forms", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/commit-protocol";
  py.FS.mkdirTree(repository);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/tracked.txt`, "tracked base\n");
  py.FS.writeFile(`${repository}/deleted.txt`, "delete base\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "commit base");

  py.FS.writeFile(`${repository}/tracked.txt`, "tracked auto\n");
  py.FS.unlink(`${repository}/deleted.txt`);
  py.FS.writeFile(`${repository}/loose.txt`, "untracked survives\n");
  const automatic = await gitResult(
    py, repository, "commit", "--no-verify", "--no-gpg-sign", "-am", "automatic tracked",
  );
  assert.equal(automatic.exitCode, 0, automatic.output);
  assert.match(automatic.output, /^[0-9a-f]{7} automatic tracked\n$/);
  assert.equal((await gitResult(py, repository, "status", "--short")).output, "?? loose.txt\n");
  assert.equal(await git(py, repository, "show", "--format=%s", "--no-patch"), "automatic tracked\n");
  assert.match(await git(py, repository, "show", "--format=", "--name-status"), /^D\tdeleted\.txt$/m);

  py.FS.writeFile(`${repository}/tracked.txt`, "long alias\n");
  await git(py, repository, "add", "tracked.txt");
  assert.deepEqual(await gitResult(
    py, repository, "commit", "--quiet", "--message=long alias",
  ), { exitCode: 0, output: "" });
  assert.equal(await git(py, repository, "log", "--format=%s", "-n", "1"), "long alias\n");

  py.FS.writeFile(`${repository}/tracked.txt`, "compact alias\n");
  await git(py, repository, "add", "tracked.txt");
  await git(py, repository, "commit", "-mcompact alias");
  assert.equal(await git(py, repository, "log", "--format=%s", "-n", "1"), "compact alias\n");

  py.FS.writeFile(`${repository}/tracked.txt`, "paragraphs\n");
  await git(py, repository, "add", "tracked.txt");
  await git(py, repository, "commit", "--message", "first", "-msecond");
  const paragraphCommit = await git(py, repository, "cat-file", "-p", "HEAD");
  assert.match(paragraphCommit, /\n\nfirst\n\nsecond\n+$/);

  py.FS.writeFile(`${repository}/tracked.txt`, "stdin message\n");
  await git(py, repository, "add", "tracked.txt");
  const stdinCommit = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "commit", "-F-"],
    stdin: new TextEncoder().encode("stdin subject\n\nstdin body\n"),
  });
  assert.equal(stdinCommit.exitCode, 0, new TextDecoder().decode(stdinCommit.stderr));
  assert.match(await git(py, repository, "cat-file", "-p", "HEAD"), /\n\nstdin subject\n\nstdin body\n+$/);

  const emptyParent = (await git(py, repository, "rev-parse", "HEAD")).trim();
  const emptyTree = (await git(py, repository, "cat-file", "-p", "HEAD")).match(/^tree ([0-9a-f]{40})$/m)?.[1];
  assert.ok(emptyTree);
  assert.deepEqual(await gitResult(
    py, repository, "commit", "--allow-empty", "-q", "-m", "empty checkpoint",
  ), { exitCode: 0, output: "" });
  const emptyObject = await git(py, repository, "cat-file", "-p", "HEAD");
  assert.match(emptyObject, new RegExp(`^tree ${emptyTree}$`, "m"));
  assert.match(emptyObject, new RegExp(`^parent ${emptyParent}$`, "m"));
  assert.match(emptyObject, /\n\nempty checkpoint\n+$/);

  py.FS.writeFile(`${repository}/tracked.txt`, "dated\n");
  await git(py, repository, "add", "tracked.txt");
  const authorTimestamp = Math.floor(Date.parse("2001-02-03T04:05:06Z") / 1000);
  const committerTimestamp = Math.floor(Date.parse("2002-03-04T05:06:07+09:00") / 1000);
  const dated = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "commit", "-m", "dated identity"],
    env: {
      GIT_AUTHOR_NAME: "Agent Author",
      GIT_AUTHOR_EMAIL: "author@example.test",
      GIT_AUTHOR_DATE: "2001-02-03T04:05:06Z",
      GIT_COMMITTER_NAME: "Agent Committer",
      GIT_COMMITTER_EMAIL: "committer@example.test",
      GIT_COMMITTER_DATE: "2002-03-04T05:06:07+09:00",
    },
  });
  assert.equal(dated.exitCode, 0, new TextDecoder().decode(dated.stderr));
  const datedObject = await git(py, repository, "cat-file", "-p", "HEAD");
  assert.match(
    datedObject,
    new RegExp(`^author Agent Author <author@example\\.test> ${authorTimestamp} \\+0000$`, "m"),
  );
  assert.match(
    datedObject,
    new RegExp(`^committer Agent Committer <committer@example\\.test> ${committerTimestamp} \\+0900$`, "m"),
  );

  py.FS.writeFile(`${repository}/tracked.txt`, "staged guard\n");
  py.FS.writeFile(`${repository}/other.txt`, "other staged\n");
  await git(py, repository, "add", "tracked.txt", "other.txt");
  const headBeforeRejected = (await git(py, repository, "rev-parse", "HEAD")).trim();
  const statusBeforeRejected = (await gitResult(py, repository, "status", "--short")).output;
  const indexBeforeRejected = new Uint8Array(py.FS.readFile(`${repository}/.git/index`) as Uint8Array);
  for (const args of [
    ["commit", "-m", "path tail", "tracked.txt"],
    ["commit", "-m", "separator tail", "--", "tracked.txt"],
    ["commit", "-m", "unknown tail", "--bogus"],
    ["commit", "--bogus", "-m", "unknown head"],
    ["commit", "--message"],
    ["commit", "-F", "message.txt"],
    ["commit", "--no-edit"],
    ["commit", "-m", ""],
    ["commit", "-a", "--bogus", "-m", "must not stage"],
  ]) {
    const rejected = await gitResult(py, repository, ...args);
    assert.equal(rejected.exitCode, 2, `${args.join(" ")}: ${rejected.output}`);
    assert.doesNotMatch(rejected.output, /\.git\/shallow|Bad news/);
    assert.equal((await git(py, repository, "rev-parse", "HEAD")).trim(), headBeforeRejected);
    assert.equal((await gitResult(py, repository, "status", "--short")).output, statusBeforeRejected);
    assert.deepEqual(
      new Uint8Array(py.FS.readFile(`${repository}/.git/index`) as Uint8Array),
      indexBeforeRejected,
    );
  }
  const contradictory = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "commit", "-m", "chosen", "-F", "-"],
    stdin: new TextEncoder().encode("ignored\n"),
  });
  assert.equal(contradictory.exitCode, 2);
  assert.match(new TextDecoder().decode(contradictory.stderr), /mutually exclusive/);
  assert.equal((await git(py, repository, "rev-parse", "HEAD")).trim(), headBeforeRejected);
  assert.deepEqual(
    new Uint8Array(py.FS.readFile(`${repository}/.git/index`) as Uint8Array),
    indexBeforeRejected,
  );
  await git(py, repository, "commit", "-m", "finish guards");
  const noTracked = await gitResult(py, repository, "commit", "-a", "-m", "only loose remains");
  assert.deepEqual(noTracked, { exitCode: 1, output: "nothing to commit\n" });

  const mergeRepository = "/home/web/commit-merge-protocol";
  py.FS.mkdirTree(mergeRepository);
  await git(py, mergeRepository, "init", "-b", "main");
  py.FS.writeFile(`${mergeRepository}/base.txt`, "base\n");
  await git(py, mergeRepository, "add", "base.txt");
  await git(py, mergeRepository, "commit", "-m", "merge base");
  await git(py, mergeRepository, "switch", "-c", "side");
  py.FS.writeFile(`${mergeRepository}/side.txt`, "side\n");
  await git(py, mergeRepository, "add", "side.txt");
  await git(py, mergeRepository, "commit", "-m", "side commit");
  await git(py, mergeRepository, "switch", "main");
  py.FS.writeFile(`${mergeRepository}/main.txt`, "main\n");
  await git(py, mergeRepository, "add", "main.txt");
  await git(py, mergeRepository, "commit", "-m", "main commit");
  assert.deepEqual(await gitResult(py, mergeRepository, "merge", "--no-commit", "side"), {
    exitCode: 0,
    output: "Merge prepared; run git commit to complete it.\n",
  });
  assert.match((await gitResult(py, mergeRepository, "status", "--short")).output, /^A  side\.txt$/m);
  assert.deepEqual(await gitResult(
    py, mergeRepository, "commit", "--quiet", "--no-verify", "-m", "merge complete",
  ), { exitCode: 0, output: "" });
  const mergeObject = await git(py, mergeRepository, "cat-file", "-p", "HEAD");
  assert.equal((mergeObject.match(/^parent [0-9a-f]{40}$/gm) ?? []).length, 2);
  assert.equal((await gitResult(py, mergeRepository, "rev-parse", "--verify", "MERGE_HEAD")).exitCode, 1);
  assert.equal((await gitResult(py, mergeRepository, "status", "--short")).output, "");

  const help = await git(py, repository, "help", "commit");
  assert.match(help, /-a\|--all.*--allow-empty.*--no-verify.*--no-gpg-sign/);
  assert.match(help, /-mTEXT.*--message.*compact -am.*multiple -m/s);
  assert.match(help, /paths.*hooks.*signing are unavailable/s);
  assert.match(await git(py, mergeRepository, "help", "merge"), /--no-commit/);
});

test("bounded Git merge preserves unrelated untracked data and rejects path collisions", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const initialize = async (name: string) => {
    const repository = `/home/web/${name}`;
    py.FS.mkdirTree(repository);
    await git(py, repository, "init", "-b", "main");
    py.FS.writeFile(`${repository}/base.txt`, "base\n");
    await git(py, repository, "add", "base.txt");
    await git(py, repository, "commit", "-m", "base");
    return repository;
  };

  const fastForward = await initialize("merge-untracked-ff");
  await git(py, fastForward, "switch", "-c", "side");
  py.FS.writeFile(`${fastForward}/incoming.txt`, "incoming\n");
  await git(py, fastForward, "add", "incoming.txt");
  await git(py, fastForward, "commit", "-m", "incoming");
  const sideHead = (await git(py, fastForward, "rev-parse", "HEAD")).trim();
  await git(py, fastForward, "switch", "main");
  py.FS.writeFile(`${fastForward}/loose.txt`, "preserve loose\n");
  const ff = await gitResult(py, fastForward, "merge", "side");
  assert.equal(ff.exitCode, 0, ff.output);
  assert.equal((await git(py, fastForward, "rev-parse", "HEAD")).trim(), sideHead);
  assert.equal(py.FS.readFile(`${fastForward}/loose.txt`, { encoding: "utf8" }), "preserve loose\n");
  assert.match((await gitResult(py, fastForward, "status", "--short")).output, /\?\? loose\.txt/);
  assert.deepEqual(await gitResult(py, fastForward, "merge", "side"), {
    exitCode: 0,
    output: "Already up to date.\n",
  });

  const ignoredExact = await initialize("merge-ignored-exact");
  await git(py, ignoredExact, "switch", "-c", "side");
  py.FS.writeFile(`${ignoredExact}/collide.txt`, "incoming\n");
  await git(py, ignoredExact, "add", "collide.txt");
  await git(py, ignoredExact, "commit", "-m", "incoming collision");
  await git(py, ignoredExact, "switch", "main");
  py.FS.writeFile(`${ignoredExact}/.gitignore`, "collide.txt\n");
  await git(py, ignoredExact, "add", ".gitignore");
  await git(py, ignoredExact, "commit", "-m", "ignore local collision");
  py.FS.writeFile(`${ignoredExact}/collide.txt`, "local ignored bytes\n");
  const exactHead = (await git(py, ignoredExact, "rev-parse", "HEAD")).trim();
  const exactIndex = new Uint8Array(py.FS.readFile(`${ignoredExact}/.git/index`) as Uint8Array);
  const exact = await gitResult(py, ignoredExact, "merge", "--no-commit", "side");
  assert.equal(exact.exitCode, 1, exact.output);
  assert.match(exact.output, /untracked path collision: collide\.txt equals merge output collide\.txt \[ignored\]/);
  assert.match(exact.output, /no repository state was changed/);
  assert.equal((await git(py, ignoredExact, "rev-parse", "HEAD")).trim(), exactHead);
  assert.deepEqual(new Uint8Array(py.FS.readFile(`${ignoredExact}/.git/index`) as Uint8Array), exactIndex);
  assert.equal(py.FS.readFile(`${ignoredExact}/collide.txt`, { encoding: "utf8" }), "local ignored bytes\n");
  assert.equal(py.FS.analyzePath(`${ignoredExact}/.git/MERGE_HEAD`).exists, false);
  py.FS.writeFile(`${ignoredExact}/collide.txt`, "incoming\n");
  const identical = await gitResult(py, ignoredExact, "merge", "side");
  assert.equal(identical.exitCode, 1, identical.output);
  assert.match(identical.output, /untracked path collision/);
  assert.equal(py.FS.readFile(`${ignoredExact}/collide.txt`, { encoding: "utf8" }), "incoming\n");

  const ancestor = await initialize("merge-ignored-ancestor");
  await git(py, ancestor, "switch", "-c", "side");
  py.FS.mkdirTree(`${ancestor}/tree`);
  py.FS.writeFile(`${ancestor}/tree/new.txt`, "incoming child\n");
  await git(py, ancestor, "add", "tree/new.txt");
  await git(py, ancestor, "commit", "-m", "incoming child");
  await git(py, ancestor, "switch", "main");
  if (py.FS.analyzePath(`${ancestor}/tree`).exists) py.FS.rmdir(`${ancestor}/tree`);
  py.FS.writeFile(`${ancestor}/.gitignore`, "tree\n");
  await git(py, ancestor, "add", ".gitignore");
  await git(py, ancestor, "commit", "-m", "ignore ancestor");
  py.FS.writeFile(`${ancestor}/tree`, "local ancestor\n");
  const ancestorResult = await gitResult(py, ancestor, "merge", "side");
  assert.equal(ancestorResult.exitCode, 1, ancestorResult.output);
  assert.match(ancestorResult.output, /tree is ancestor of merge output tree\/new\.txt \[ignored\]/);
  assert.equal(py.FS.readFile(`${ancestor}/tree`, { encoding: "utf8" }), "local ancestor\n");
  py.FS.unlink(`${ancestor}/tree`);
  py.FS.symlink("somewhere-local", `${ancestor}/tree`);
  const symlinkAncestor = await gitResult(py, ancestor, "merge", "side");
  assert.equal(symlinkAncestor.exitCode, 1, symlinkAncestor.output);
  assert.match(symlinkAncestor.output, /tree is ancestor of merge output tree\/new\.txt/);
  assert.equal(py.FS.readlink(`${ancestor}/tree`), "somewhere-local");

  const descendant = await initialize("merge-ignored-descendant");
  await git(py, descendant, "switch", "-c", "side");
  py.FS.writeFile(`${descendant}/node`, "incoming file\n");
  await git(py, descendant, "add", "node");
  await git(py, descendant, "commit", "-m", "incoming file");
  await git(py, descendant, "switch", "main");
  py.FS.writeFile(`${descendant}/.gitignore`, "node/\n");
  await git(py, descendant, "add", ".gitignore");
  await git(py, descendant, "commit", "-m", "ignore descendant");
  py.FS.mkdirTree(`${descendant}/node`);
  py.FS.writeFile(`${descendant}/node/child.txt`, "local descendant\n");
  const descendantResult = await gitResult(py, descendant, "merge", "side");
  assert.equal(descendantResult.exitCode, 1, descendantResult.output);
  assert.match(descendantResult.output, /node\/child\.txt is descendant of merge output node \[ignored\]/);
  assert.equal(
    py.FS.readFile(`${descendant}/node/child.txt`, { encoding: "utf8" }),
    "local descendant\n",
  );

  const sibling = await initialize("merge-untracked-sibling");
  await git(py, sibling, "switch", "-c", "side");
  py.FS.mkdirTree(`${sibling}/dir`);
  py.FS.writeFile(`${sibling}/dir/new.txt`, "incoming sibling\n");
  await git(py, sibling, "add", "dir/new.txt");
  await git(py, sibling, "commit", "-m", "incoming sibling");
  await git(py, sibling, "switch", "main");
  py.FS.writeFile(`${sibling}/main.txt`, "main\n");
  await git(py, sibling, "add", "main.txt");
  await git(py, sibling, "commit", "-m", "diverge main");
  py.FS.mkdirTree(`${sibling}/dir`);
  py.FS.writeFile(`${sibling}/dir/keep.txt`, "local sibling\n");
  assert.deepEqual(await gitResult(py, sibling, "merge", "--no-commit", "side"), {
    exitCode: 0,
    output: "Merge prepared; run git commit to complete it.\n",
  });
  assert.equal(py.FS.readFile(`${sibling}/dir/keep.txt`, { encoding: "utf8" }), "local sibling\n");
  assert.equal(py.FS.readFile(`${sibling}/dir/new.txt`, { encoding: "utf8" }), "incoming sibling\n");
  await git(py, sibling, "merge", "--abort");
  assert.equal(py.FS.readFile(`${sibling}/dir/keep.txt`, { encoding: "utf8" }), "local sibling\n");

  const conflict = await initialize("merge-untracked-conflict");
  py.FS.writeFile(`${conflict}/conflict.txt`, "base conflict\n");
  await git(py, conflict, "add", "conflict.txt");
  await git(py, conflict, "commit", "-m", "conflict base");
  await git(py, conflict, "switch", "-c", "side");
  py.FS.writeFile(`${conflict}/conflict.txt`, "side conflict\n");
  await git(py, conflict, "add", "conflict.txt");
  await git(py, conflict, "commit", "-m", "side conflict");
  await git(py, conflict, "switch", "main");
  py.FS.writeFile(`${conflict}/conflict.txt`, "main conflict\n");
  await git(py, conflict, "add", "conflict.txt");
  await git(py, conflict, "commit", "-m", "main conflict");
  py.FS.writeFile(`${conflict}/loose.txt`, "unrelated conflict data\n");
  const conflicted = await gitResult(py, conflict, "merge", "side");
  assert.equal(conflicted.exitCode, 1, conflicted.output);
  assert.match((await gitResult(py, conflict, "status", "--short")).output, /UU conflict\.txt/);
  assert.equal(py.FS.readFile(`${conflict}/loose.txt`, { encoding: "utf8" }), "unrelated conflict data\n");
  await git(py, conflict, "merge", "--abort");
  assert.equal(py.FS.readFile(`${conflict}/loose.txt`, { encoding: "utf8" }), "unrelated conflict data\n");

  py.FS.writeFile(`${fastForward}/base.txt`, "tracked dirty\n");
  const dirty = await gitResult(py, fastForward, "merge", "side");
  assert.equal(dirty.exitCode, 1);
  assert.match(dirty.output, /cannot merge with tracked or staged changes/);
  assert.match(await git(py, fastForward, "help", "merge"), /unrelated untracked\/ignored.*collisions reject/s);
});

test("bounded Git cherry-pick preflights tracked state and untracked write collisions", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const initialize = async (name: string) => {
    const repository = `/home/web/${name}`;
    py.FS.mkdirTree(repository);
    await git(py, repository, "init", "-b", "main");
    py.FS.writeFile(`${repository}/base.txt`, "base\n");
    await git(py, repository, "add", "base.txt");
    await git(py, repository, "commit", "-m", "base");
    return repository;
  };
  const repositoryState = async (repository: string) => ({
    head: (await git(py, repository, "rev-parse", "HEAD")).trim(),
    index: new Uint8Array(py.FS.readFile(`${repository}/.git/index`) as Uint8Array),
  });
  const assertRepositoryState = async (
    repository: string,
    before: { head: string; index: Uint8Array },
  ) => {
    assert.equal((await git(py, repository, "rev-parse", "HEAD")).trim(), before.head);
    assert.deepEqual(new Uint8Array(py.FS.readFile(`${repository}/.git/index`) as Uint8Array), before.index);
  };

  const repository = "/home/web/cherry-pick-dirty-conflict";
  py.FS.mkdirTree(`${repository}/nested`);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/conflict.txt`, "base conflict\n");
  py.FS.writeFile(`${repository}/keep.txt`, "base keep\n");
  py.FS.writeFile(`${repository}/nested/tracked.txt`, "nested\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "base");
  await git(py, repository, "switch", "-c", "side");
  py.FS.writeFile(`${repository}/conflict.txt`, "side conflict\n");
  await git(py, repository, "add", "conflict.txt");
  await git(py, repository, "commit", "-m", "side conflict");
  const picked = (await git(py, repository, "rev-parse", "HEAD")).trim();
  await git(py, repository, "switch", "main");
  py.FS.writeFile(`${repository}/conflict.txt`, "main conflict\n");
  await git(py, repository, "add", "conflict.txt");
  await git(py, repository, "commit", "-m", "main conflict");
  py.FS.writeFile(`${repository}/keep.txt`, "unrelated local bytes\n");

  const dirtyBefore = await repositoryState(repository);
  const rejected = await gitResult(py, `${repository}/nested`, "cherry-pick", picked);
  assert.equal(rejected.exitCode, 1, rejected.output);
  assert.match(rejected.output, /local changes would be overwritten by cherry-pick/);
  await assertRepositoryState(repository, dirtyBefore);
  assert.equal(py.FS.readFile(`${repository}/conflict.txt`, { encoding: "utf8" }), "main conflict\n");
  assert.equal(py.FS.readFile(`${repository}/keep.txt`, { encoding: "utf8" }), "unrelated local bytes\n");

  await git(py, repository, "restore", "keep.txt");
  py.FS.writeFile(`${repository}/keep.txt`, "staged local bytes\n");
  await git(py, repository, "add", "keep.txt");
  const stagedBefore = await repositoryState(repository);
  const staged = await gitResult(py, repository, "cherry-pick", picked);
  assert.equal(staged.exitCode, 1, staged.output);
  assert.match(staged.output, /local changes would be overwritten by cherry-pick/);
  await assertRepositoryState(repository, stagedBefore);
  assert.equal(py.FS.readFile(`${repository}/keep.txt`, { encoding: "utf8" }), "staged local bytes\n");

  py.FS.writeFile(`${repository}/keep.txt`, "mixed worktree bytes\n");
  const mixedBefore = await repositoryState(repository);
  const mixed = await gitResult(py, repository, "cherry-pick", picked);
  assert.equal(mixed.exitCode, 1, mixed.output);
  await assertRepositoryState(repository, mixedBefore);
  assert.equal(py.FS.readFile(`${repository}/keep.txt`, { encoding: "utf8" }), "mixed worktree bytes\n");
  await git(py, repository, "restore", "--staged", "--worktree", "keep.txt");

  py.FS.unlink(`${repository}/keep.txt`);
  const deletedBefore = await repositoryState(repository);
  const deleted = await gitResult(py, repository, "cherry-pick", picked);
  assert.equal(deleted.exitCode, 1, deleted.output);
  await assertRepositoryState(repository, deletedBefore);
  assert.equal(py.FS.analyzePath(`${repository}/keep.txt`).exists, false);
  await git(py, repository, "restore", "keep.txt");

  py.FS.writeFile(`${repository}/kind`, "tracked kind\n");
  py.FS.symlink("keep.txt", `${repository}/tracked-link`);
  await git(py, repository, "add", "kind", "tracked-link");
  await git(py, repository, "commit", "-m", "tracked path types");
  py.FS.unlink(`${repository}/tracked-link`);
  py.FS.symlink("conflict.txt", `${repository}/tracked-link`);
  const symlinkBefore = await repositoryState(repository);
  const symlink = await gitResult(py, repository, "cherry-pick", picked);
  assert.equal(symlink.exitCode, 1, symlink.output);
  await assertRepositoryState(repository, symlinkBefore);
  assert.equal(py.FS.readlink(`${repository}/tracked-link`), "conflict.txt");
  await git(py, repository, "restore", "tracked-link");
  py.FS.unlink(`${repository}/kind`);
  py.FS.mkdirTree(`${repository}/kind`);
  py.FS.writeFile(`${repository}/kind/child.txt`, "replacement child\n");
  const typeBefore = await repositoryState(repository);
  const typeReplacement = await gitResult(py, repository, "cherry-pick", picked);
  assert.equal(typeReplacement.exitCode, 1, typeReplacement.output);
  await assertRepositoryState(repository, typeBefore);
  assert.equal(py.FS.readFile(`${repository}/kind/child.txt`, { encoding: "utf8" }), "replacement child\n");

  const invalid = await gitResult(py, repository, "cherry-pick", "not-a-commit");
  assert.equal(invalid.exitCode, 1, invalid.output);
  await assertRepositoryState(repository, typeBefore);
  assert.equal(py.FS.readFile(`${repository}/kind/child.txt`, { encoding: "utf8" }), "replacement child\n");

  const unrelated = await initialize("cherry-pick-unrelated-untracked");
  await git(py, unrelated, "switch", "-c", "side");
  py.FS.writeFile(`${unrelated}/incoming.txt`, "incoming\n");
  await git(py, unrelated, "add", "incoming.txt");
  await git(py, unrelated, "commit", "-m", "incoming");
  const unrelatedPick = (await git(py, unrelated, "rev-parse", "HEAD")).trim();
  await git(py, unrelated, "switch", "main");
  py.FS.writeFile(`${unrelated}/current.txt`, "current\n");
  py.FS.writeFile(`${unrelated}/.gitignore`, "*.tmp\n");
  await git(py, unrelated, "add", "current.txt", ".gitignore");
  await git(py, unrelated, "commit", "-m", "current");
  py.FS.writeFile(`${unrelated}/loose.txt`, "ordinary local\n");
  py.FS.writeFile(`${unrelated}/ignored.tmp`, "ignored local\n");
  const successful = await gitResult(py, unrelated, "cherry-pick", unrelatedPick);
  assert.equal(successful.exitCode, 0, successful.output);
  assert.match(successful.output, /cherry-pick/);
  assert.equal(py.FS.readFile(`${unrelated}/incoming.txt`, { encoding: "utf8" }), "incoming\n");
  assert.equal(py.FS.readFile(`${unrelated}/loose.txt`, { encoding: "utf8" }), "ordinary local\n");
  assert.equal(py.FS.readFile(`${unrelated}/ignored.tmp`, { encoding: "utf8" }), "ignored local\n");

  const exact = await initialize("cherry-pick-untracked-exact");
  await git(py, exact, "switch", "-c", "side");
  py.FS.writeFile(`${exact}/collision.txt`, "incoming collision\n");
  await git(py, exact, "add", "collision.txt");
  await git(py, exact, "commit", "-m", "incoming collision");
  const exactPick = (await git(py, exact, "rev-parse", "HEAD")).trim();
  await git(py, exact, "switch", "main");
  py.FS.writeFile(`${exact}/current.txt`, "current\n");
  await git(py, exact, "add", "current.txt");
  await git(py, exact, "commit", "-m", "current");
  py.FS.writeFile(`${exact}/collision.txt`, "local collision\n");
  const exactBefore = await repositoryState(exact);
  const exactRejected = await gitResult(py, exact, "cherry-pick", exactPick);
  assert.equal(exactRejected.exitCode, 1, exactRejected.output);
  assert.match(exactRejected.output, /collision\.txt equals cherry-pick output collision\.txt/);
  assert.doesNotMatch(exactRejected.output, /\[ignored\]/);
  assert.match(exactRejected.output, /no repository state was changed/);
  await assertRepositoryState(exact, exactBefore);
  assert.equal(py.FS.readFile(`${exact}/collision.txt`, { encoding: "utf8" }), "local collision\n");
  py.FS.writeFile(`${exact}/.gitignore`, "collision.txt\n");
  await git(py, exact, "add", ".gitignore");
  await git(py, exact, "commit", "-m", "ignore collision");
  py.FS.writeFile(`${exact}/collision.txt`, "incoming collision\n");
  const ignoredBefore = await repositoryState(exact);
  const ignoredRejected = await gitResult(py, exact, "cherry-pick", exactPick);
  assert.equal(ignoredRejected.exitCode, 1, ignoredRejected.output);
  assert.match(ignoredRejected.output, /equals cherry-pick output collision\.txt \[ignored\]/);
  await assertRepositoryState(exact, ignoredBefore);
  assert.equal(py.FS.readFile(`${exact}/collision.txt`, { encoding: "utf8" }), "incoming collision\n");

  const ancestor = await initialize("cherry-pick-untracked-ancestor");
  await git(py, ancestor, "switch", "-c", "side");
  py.FS.mkdirTree(`${ancestor}/tree`);
  py.FS.writeFile(`${ancestor}/tree/new.txt`, "incoming child\n");
  await git(py, ancestor, "add", "tree/new.txt");
  await git(py, ancestor, "commit", "-m", "incoming child");
  const ancestorPick = (await git(py, ancestor, "rev-parse", "HEAD")).trim();
  await git(py, ancestor, "switch", "main");
  py.FS.writeFile(`${ancestor}/current.txt`, "current\n");
  await git(py, ancestor, "add", "current.txt");
  await git(py, ancestor, "commit", "-m", "current");
  if (py.FS.analyzePath(`${ancestor}/tree`).exists) py.FS.rmdir(`${ancestor}/tree`);
  py.FS.symlink("local-target", `${ancestor}/tree`);
  const ancestorBefore = await repositoryState(ancestor);
  const ancestorRejected = await gitResult(py, ancestor, "cherry-pick", ancestorPick);
  assert.equal(ancestorRejected.exitCode, 1, ancestorRejected.output);
  assert.match(ancestorRejected.output, /tree is ancestor of cherry-pick output tree\/new\.txt/);
  await assertRepositoryState(ancestor, ancestorBefore);
  assert.equal(py.FS.readlink(`${ancestor}/tree`), "local-target");

  const descendant = await initialize("cherry-pick-untracked-descendant");
  await git(py, descendant, "switch", "-c", "side");
  py.FS.writeFile(`${descendant}/node`, "incoming file\n");
  await git(py, descendant, "add", "node");
  await git(py, descendant, "commit", "-m", "incoming file");
  const descendantPick = (await git(py, descendant, "rev-parse", "HEAD")).trim();
  await git(py, descendant, "switch", "main");
  py.FS.writeFile(`${descendant}/.gitignore`, "node/\n");
  await git(py, descendant, "add", ".gitignore");
  await git(py, descendant, "commit", "-m", "ignore descendant");
  py.FS.mkdirTree(`${descendant}/node`);
  py.FS.writeFile(`${descendant}/node/child.txt`, "local child\n");
  const descendantBefore = await repositoryState(descendant);
  const descendantRejected = await gitResult(py, descendant, "cherry-pick", descendantPick);
  assert.equal(descendantRejected.exitCode, 1, descendantRejected.output);
  assert.match(descendantRejected.output, /node\/child\.txt is descendant of cherry-pick output node \[ignored\]/);
  await assertRepositoryState(descendant, descendantBefore);
  assert.equal(py.FS.readFile(`${descendant}/node/child.txt`, { encoding: "utf8" }), "local child\n");

  const cleanConflict = "/home/web/cherry-pick-clean-conflict";
  py.FS.mkdirTree(cleanConflict);
  await git(py, cleanConflict, "init", "-b", "main");
  py.FS.writeFile(`${cleanConflict}/conflict.txt`, "base\n");
  await git(py, cleanConflict, "add", "conflict.txt");
  await git(py, cleanConflict, "commit", "-m", "base");
  await git(py, cleanConflict, "switch", "-c", "side");
  py.FS.writeFile(`${cleanConflict}/conflict.txt`, "side\n");
  await git(py, cleanConflict, "add", "conflict.txt");
  await git(py, cleanConflict, "commit", "-m", "side");
  const conflictPick = (await git(py, cleanConflict, "rev-parse", "HEAD")).trim();
  await git(py, cleanConflict, "switch", "main");
  py.FS.writeFile(`${cleanConflict}/conflict.txt`, "main\n");
  await git(py, cleanConflict, "add", "conflict.txt");
  await git(py, cleanConflict, "commit", "-m", "main");
  const conflictHead = (await git(py, cleanConflict, "rev-parse", "HEAD")).trim();
  py.FS.writeFile(`${cleanConflict}/loose.txt`, "preserve through conflict\n");
  const conflictResult = await gitResult(py, cleanConflict, "cherry-pick", conflictPick);
  assert.equal(conflictResult.exitCode, 1, conflictResult.output);
  assert.match(conflictResult.output, /merge conflicts/);
  assert.equal(py.FS.readFile(`${cleanConflict}/loose.txt`, { encoding: "utf8" }), "preserve through conflict\n");
  await git(py, cleanConflict, "reset", "--hard", "HEAD");
  assert.equal((await git(py, cleanConflict, "rev-parse", "HEAD")).trim(), conflictHead);
  assert.equal(py.FS.readFile(`${cleanConflict}/conflict.txt`, { encoding: "utf8" }), "main\n");
  assert.equal(py.FS.readFile(`${cleanConflict}/loose.txt`, { encoding: "utf8" }), "preserve through conflict\n");

  assert.match(await git(py, exact, "help", "cherry-pick"), /tracked changes are rejected/);
  assert.match(await git(py, exact, "help", "cherry-pick"), /untracked\/ignored.*collisions reject/s);
});

test("bounded Git verbose branch listing reports subjects and upstream divergence", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/branch-verbose";
  py.FS.mkdirTree(repository);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/base.txt`, "base\n");
  await git(py, repository, "add", "base.txt");
  await git(py, repository, "commit", "-m", "base subject");
  await git(py, repository, "switch", "-c", "feature");
  py.FS.writeFile(`${repository}/feature.txt`, "feature\n");
  await git(py, repository, "add", "feature.txt");
  await git(py, repository, "commit", "-m", "feature work");
  const featureOid = (await git(py, repository, "rev-parse", "HEAD")).trim();
  await git(py, repository, "switch", "main");
  py.FS.writeFile(`${repository}/main.txt`, "main\n");
  await git(py, repository, "add", "main.txt");
  await git(py, repository, "commit", "-m", "main work");
  const mainOid = (await git(py, repository, "rev-parse", "HEAD")).trim();
  await git(py, repository, "branch", "topic");
  await git(py, repository, "switch", "-c", "unicode");
  py.FS.writeFile(`${repository}/unicode.txt`, "unicode\n");
  await git(py, repository, "add", "unicode.txt");
  await git(py, repository, "commit", "-m", "mañana ☃");
  const unicodeOid = (await git(py, repository, "rev-parse", "HEAD")).trim();
  await git(py, repository, "switch", "main");

  await git(py, repository, "config", "branch.feature.remote", ".");
  await git(py, repository, "config", "branch.feature.merge", "refs/heads/main");
  await git(py, repository, "config", "branch.topic.remote", ".");
  await git(py, repository, "config", "branch.topic.merge", "refs/heads/missing");
  await git(py, repository, "remote", "add", "origin", "https://example.invalid/repository.git");
  py.FS.mkdirTree(`${repository}/.git/refs/remotes/origin`);
  py.FS.writeFile(`${repository}/.git/refs/remotes/origin/remote-topic`, `${featureOid}\n`);
  await git(py, repository, "config", "branch.main.remote", "origin");
  await git(py, repository, "config", "branch.main.merge", "refs/heads/remote-topic");

  assert.equal(
    (await gitResult(py, repository, "branch")).output,
    "  feature\n* main\n  topic\n  unicode\n",
  );
  const verbose = (await gitResult(py, repository, "branch", "-v")).output;
  assert.match(verbose, new RegExp(`^  feature\\s+${featureOid.slice(0, 7)} feature work$`, "m"));
  assert.match(verbose, new RegExp(`^\\* main\\s+${mainOid.slice(0, 7)} main work$`, "m"));
  assert.match(verbose, new RegExp(`^  unicode\\s+${unicodeOid.slice(0, 7)} mañana ☃$`, "m"));
  assert.equal((await gitResult(py, repository, "branch", "--verbose")).output, verbose);

  const veryVerbose = (await gitResult(py, repository, "branch", "-vv")).output;
  assert.match(
    veryVerbose,
    new RegExp(`^  feature\\s+${featureOid.slice(0, 7)} \\[main: ahead 1, behind 1\\] feature work$`, "m"),
  );
  assert.match(
    veryVerbose,
    new RegExp(`^\\* main\\s+${mainOid.slice(0, 7)} \\[origin/remote-topic: ahead 1, behind 1\\] main work$`, "m"),
  );
  assert.match(veryVerbose, new RegExp(`^  topic\\s+${mainOid.slice(0, 7)} \\[missing: gone\\] main work$`, "m"));
  assert.match(veryVerbose, new RegExp(`^  unicode\\s+${unicodeOid.slice(0, 7)} mañana ☃$`, "m"));
  assert.equal(
    (await gitResult(py, repository, "branch", "--verbose", "--verbose")).output,
    veryVerbose,
  );

  const allVerbose = (await gitResult(py, repository, "branch", "-avv")).output;
  assert.equal((await gitResult(py, repository, "branch", "-a", "-vv")).output, allVerbose);
  assert.equal((await gitResult(py, repository, "branch", "-vva")).output, allVerbose);
  assert.match(
    allVerbose,
    new RegExp(`^  remotes/origin/remote-topic\\s+${featureOid.slice(0, 7)} feature work$`, "m"),
  );
  assert.equal(
    (await gitResult(py, repository, "branch", "-av")).output,
    (await gitResult(py, repository, "branch", "-a", "-v")).output,
  );
  assert.equal(
    (await gitResult(py, repository, "branch", "-rv")).output,
    (await gitResult(py, repository, "branch", "-r", "-v")).output,
  );
  assert.equal(
    (await gitResult(py, repository, "branch", "-ar")).output,
    (await gitResult(py, repository, "branch", "-a")).output,
  );

  for (const args of [
    ["-vvv"],
    ["-avvv"],
    ["--verbose", "--verbose", "-v"],
  ]) {
    const rejected = await gitResult(py, repository, "branch", ...args);
    assert.equal(rejected.exitCode, 2, `${args.join(" ")}: ${rejected.output}`);
    assert.equal(rejected.output, "git: branch verbosity may be specified at most twice\n");
  }
  for (const args of [["-xv"], ["-mfeature"], ["--sort=-committerdate"], ["--list", "feature"]]) {
    const rejected = await gitResult(py, repository, "branch", ...args);
    assert.equal(rejected.exitCode, 2, `${args.join(" ")}: ${rejected.output}`);
  }

  await git(py, repository, "switch", "--detach", "main");
  assert.equal((await gitResult(py, repository, "branch", "--show-current")).output, "");
  assert.doesNotMatch((await gitResult(py, repository, "branch", "-v")).output, /^\*/m);
  await git(py, repository, "switch", "main");
  const unborn = "/home/web/branch-verbose-unborn";
  py.FS.mkdirTree(unborn);
  await git(py, unborn, "init", "-b", "main");
  assert.deepEqual(await gitResult(py, unborn, "branch", "-vv"), { exitCode: 0, output: "" });

  const limited = "/home/web/branch-verbose-limit";
  py.FS.mkdirTree(limited);
  await git(py, limited, "init", "-b", "main");
  py.FS.writeFile(`${limited}/base.txt`, "base\n");
  await git(py, limited, "add", "base.txt");
  await git(py, limited, "commit", "-m", "limit base");
  const limitOid = (await git(py, limited, "rev-parse", "HEAD")).trim();
  let limitConfig = py.FS.readFile(`${limited}/.git/config`, { encoding: "utf8" });
  for (let index = 0; index <= 1_000; index++) {
    const name = `row-${index.toString().padStart(4, "0")}`;
    py.FS.writeFile(`${limited}/.git/refs/heads/${name}`, `${limitOid}\n`);
    limitConfig += `[branch "${name}"]\n\tremote = .\n\tmerge = refs/heads/main\n`;
  }
  py.FS.writeFile(`${limited}/.git/config`, limitConfig);
  assert.deepEqual(await gitResult(py, limited, "branch", "-vv"), {
    exitCode: 2,
    output: "git branch: refusing to inspect more than 1000 upstreams\n",
  });

  const help = await git(py, repository, "help", "branch");
  assert.match(help, /compact -av\/-rv\/-avv/);
  assert.match(help, /-v adds subjects.*-vv adds configured upstream divergence/s);
  assert.match(help, /100000 commits.*1000 upstream-bearing rows/s);
});

test("bounded Git tag deletion is multi-name atomic across loose and packed refs", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/tag-delete-protocol";
  py.FS.mkdirTree(repository);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/tracked.txt`, "tracked\n");
  await git(py, repository, "add", "tracked.txt");
  await git(py, repository, "commit", "-m", "tag base");
  const head = (await git(py, repository, "rev-parse", "HEAD")).trim();
  const fs = createIsomorphicGitFs(py);
  const indexPath = `${repository}/.git/index`;
  const indexBefore = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array).slice();

  const writeLightweight = async (name: string, oid = head): Promise<void> => {
    await isomorphicGit.writeRef({
      fs, dir: repository, ref: `refs/tags/${name}`, value: oid, force: true,
    });
  };
  const run = (args: string[]) => runGitEngineCommand({
    py, cwd: repository, args: ["git-engine", "tag", ...args],
  });
  const text = (bytes?: Uint8Array) => new TextDecoder().decode(bytes ?? new Uint8Array());
  const assertResponse = async (
    args: string[],
    exitCode: number,
    stdout = "",
    stderr = "",
  ) => {
    const response = await run(args);
    assert.equal(response.exitCode, exitCode, `${args.join(" ")}: ${text(response.stderr)}`);
    assert.equal(text(response.stdout), stdout);
    assert.equal(text(response.stderr), stderr);
    return response;
  };
  const refExists = async (ref: string): Promise<boolean> =>
    (await runGitEngineCommand({
      py, cwd: repository,
      args: ["git-engine", "show-ref", "--verify", "--quiet", ref],
    })).exitCode === 0;
  const refs = async (): Promise<string> => {
    const response = await runGitEngineCommand({
      py, cwd: repository, args: ["git-engine", "show-ref"],
    });
    return `${response.exitCode}\0${text(response.stdout)}\0${text(response.stderr)}`;
  };
  const assertLayersUnchanged = async (): Promise<void> => {
    assert.equal((await git(py, repository, "rev-parse", "HEAD")).trim(), head);
    assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, indexBefore);
    assert.equal(py.FS.readFile(`${repository}/tracked.txt`, { encoding: "utf8" }), "tracked\n");
  };

  await writeLightweight("light");
  await git(py, repository, "tag", "-a", "annotated", "-m", "annotated tag", "HEAD");
  const annotatedOid = (await git(py, repository, "rev-parse", "annotated")).trim();
  assert.equal(await git(py, repository, "cat-file", "-t", annotatedOid), "tag\n");
  await assertResponse(
    ["-d", "light", "annotated"],
    0,
    `Deleted tag 'light' (was ${head.slice(0, 7)})\n` +
      `Deleted tag 'annotated' (was ${annotatedOid.slice(0, 7)})\n`,
  );
  assert.equal(await refExists("refs/tags/light"), false);
  assert.equal(await refExists("refs/tags/annotated"), false);
  assert.equal(await git(py, repository, "cat-file", "-t", annotatedOid), "tag\n");
  await assertLayersUnchanged();

  await git(py, repository, "branch", "collision");
  await writeLightweight("collision");
  await assertResponse(
    ["--delete", "collision"], 0,
    `Deleted tag 'collision' (was ${head.slice(0, 7)})\n`,
  );
  assert.equal(await refExists("refs/tags/collision"), false);
  assert.equal(await refExists("refs/heads/collision"), true);

  await writeLightweight("-leading");
  await writeLightweight("quote'tag");
  await assertResponse(
    ["-d", "--", "-leading"], 0,
    `Deleted tag '-leading' (was ${head.slice(0, 7)})\n`,
  );
  await assertResponse(
    ["--delete", "quote'tag"], 0,
    `Deleted tag "quote'tag" (was ${head.slice(0, 7)})\n`,
  );

  await writeLightweight("keep-one");
  await writeLightweight("keep-two");
  let before = await refs();
  let rejected = await run(["-d", "keep-one", "missing-late"]);
  assert.equal(rejected.exitCode, 1);
  assert.equal(text(rejected.stdout), "");
  assert.equal(text(rejected.stderr), "git tag: tag not found: 'missing-late'\n");
  assert.equal(await refs(), before);
  rejected = await run(["--delete", "keep-one", "bad..name"]);
  assert.equal(rejected.exitCode, 2);
  assert.equal(text(rejected.stdout), "");
  assert.match(text(rejected.stderr), /invalid tag name/);
  assert.equal(await refs(), before);
  for (const args of [
    ["-d", "keep-one", "keep-one"],
    ["-d", "keep-one", "-x"],
    ["-d"],
    ["--delete"],
    ["-d", "refs/tags/keep-one"],
    ["-d", "@"],
  ]) {
    rejected = await run(args);
    assert.equal(rejected.exitCode, 2, `${args.join(" ")}: ${text(rejected.stderr)}`);
    assert.equal(text(rejected.stdout), "");
    assert.equal(await refs(), before);
  }

  const acceptedName = "n".repeat(4_096);
  rejected = await run(["-d", acceptedName]);
  assert.equal(rejected.exitCode, 1);
  assert.match(text(rejected.stderr), /tag not found/);
  rejected = await run(["-d", `${acceptedName}n`]);
  assert.equal(rejected.exitCode, 2);
  assert.match(text(rejected.stderr), /4096 UTF-8 bytes/);
  const acceptedDepth = Array(128).fill("n").join("/");
  rejected = await run(["-d", acceptedDepth]);
  assert.equal(rejected.exitCode, 1);
  rejected = await run(["-d", `${acceptedDepth}/n`]);
  assert.equal(rejected.exitCode, 2);
  assert.match(text(rejected.stderr), /more than 128 components/);
  const aggregateNames = Array.from(
    { length: 16 }, (_, index) => `${String.fromCharCode(97 + index)}${"q".repeat(4_095)}`,
  );
  rejected = await run(["-d", ...aggregateNames]);
  assert.equal(rejected.exitCode, 1);
  rejected = await run(["-d", ...aggregateNames, "x"]);
  assert.equal(rejected.exitCode, 2);
  assert.match(text(rejected.stderr), /65536 aggregate UTF-8 bytes/);
  rejected = await run(["-d", ...Array(101).fill("keep-one")]);
  assert.equal(rejected.exitCode, 2);
  assert.match(text(rejected.stderr), /at most 100 names/);
  assert.equal(await refs(), before);

  const keepOnePath = `${repository}/.git/refs/tags/keep-one`;
  const keepOneBeforeLock = new Uint8Array(py.FS.readFile(keepOnePath) as Uint8Array).slice();
  py.FS.writeFile(`${keepOnePath}.lock`, "busy\n");
  rejected = await run(["-d", "keep-one"]);
  assert.equal(rejected.exitCode, 1);
  assert.equal(text(rejected.stdout), "");
  assert.match(text(rejected.stderr), /cannot acquire tag lock/);
  assert.deepEqual(py.FS.readFile(keepOnePath) as Uint8Array, keepOneBeforeLock);
  py.FS.unlink(`${keepOnePath}.lock`);
  assert.equal(await refs(), before);

  const packedLight = "packed-light";
  const packedAnnotated = "packed-annotated";
  await git(py, repository, "tag", "-a", packedAnnotated, "-m", "packed annotated", "HEAD");
  const packedAnnotatedOid = (await git(py, repository, "rev-parse", packedAnnotated)).trim();
  const packedPath = `${repository}/.git/packed-refs`;
  py.FS.writeFile(
    packedPath,
    "# pack-refs with: peeled fully-peeled sorted \n" +
      `${head} refs/heads/packed-branch\n` +
      `${packedAnnotatedOid} refs/tags/${packedAnnotated}\n` +
      `^${head}\n` +
      `${head} refs/tags/${packedLight}\n`,
  );
  py.FS.unlink(`${repository}/.git/refs/tags/${packedAnnotated}`);
  assert.equal(await refExists(`refs/tags/${packedLight}`), true);
  assert.equal(await refExists(`refs/tags/${packedAnnotated}`), true);
  await assertResponse(
    ["-d", packedLight, packedAnnotated],
    0,
    `Deleted tag '${packedLight}' (was ${head.slice(0, 7)})\n` +
      `Deleted tag '${packedAnnotated}' (was ${packedAnnotatedOid.slice(0, 7)})\n`,
  );
  assert.equal(await refExists(`refs/tags/${packedLight}`), false);
  assert.equal(await refExists(`refs/tags/${packedAnnotated}`), false);
  assert.equal(await refExists("refs/heads/packed-branch"), true);
  assert.doesNotMatch(
    String(py.FS.readFile(packedPath, { encoding: "utf8" })),
    /refs\/tags\/packed-/,
  );

  await writeLightweight("rollback-one");
  await writeLightweight("rollback-two");
  before = await refs();
  const originalUnlink = py.FS.unlink;
  let unlinkInjected = false;
  (py.FS as any).unlink = (path: string) => {
    if (path === `${repository}/.git/refs/tags/rollback-two` && !unlinkInjected) {
      unlinkInjected = true;
      throw new Error("injected tag unlink failure");
    }
    return Reflect.apply(originalUnlink, py.FS, [path]);
  };
  try {
    rejected = await run(["-d", "rollback-one", "rollback-two"]);
  } finally {
    (py.FS as any).unlink = originalUnlink;
  }
  assert.equal(unlinkInjected, true);
  assert.equal(rejected.exitCode, 1);
  assert.equal(text(rejected.stdout), "");
  assert.match(text(rejected.stderr), /injected tag unlink failure/);
  assert.equal(await refs(), before);

  const originalWriteFile = py.FS.writeFile;
  unlinkInjected = false;
  let rollbackInjected = false;
  (py.FS as any).unlink = (path: string) => {
    if (path === `${repository}/.git/refs/tags/rollback-two` && !unlinkInjected) {
      unlinkInjected = true;
      throw new Error("injected tag action failure");
    }
    return Reflect.apply(originalUnlink, py.FS, [path]);
  };
  (py.FS as any).writeFile = (path: string, ...args: unknown[]) => {
    if (
      path === `${repository}/.git/refs/tags/rollback-one` &&
      unlinkInjected && !rollbackInjected
    ) {
      rollbackInjected = true;
      throw new Error("injected tag rollback failure");
    }
    return Reflect.apply(originalWriteFile, py.FS, [path, ...args]);
  };
  try {
    rejected = await run(["-d", "rollback-one", "rollback-two"]);
  } finally {
    (py.FS as any).unlink = originalUnlink;
    (py.FS as any).writeFile = originalWriteFile;
  }
  assert.equal(rejected.exitCode, 1);
  assert.match(text(rejected.stderr), /tag rollback failed.*injected tag rollback failure/);
  await writeLightweight("rollback-one");
  assert.equal(await refExists("refs/tags/rollback-two"), true);

  const packedFailureName = "packed-write-failure";
  const packedBeforeFailure = String(py.FS.readFile(packedPath, { encoding: "utf8" }));
  py.FS.writeFile(packedPath, `${packedBeforeFailure}${head} refs/tags/${packedFailureName}\n`);
  before = await refs();
  const originalRename = py.FS.rename;
  let renameInjected = false;
  (py.FS as any).rename = (oldPath: string, newPath: string) => {
    if (oldPath === `${packedPath}.lock` && newPath === packedPath && !renameInjected) {
      renameInjected = true;
      throw new Error("injected packed tag commit failure");
    }
    return Reflect.apply(originalRename, py.FS, [oldPath, newPath]);
  };
  try {
    rejected = await run(["-d", packedFailureName]);
  } finally {
    (py.FS as any).rename = originalRename;
  }
  assert.equal(renameInjected, true);
  assert.equal(rejected.exitCode, 1);
  assert.match(text(rejected.stderr), /injected packed tag commit failure/);
  assert.equal(await refs(), before);
  assert.equal(py.FS.analyzePath(`${packedPath}.lock`).exists, false);
  py.FS.writeFile(`${packedPath}.lock`, "busy\n");
  rejected = await run(["-d", packedFailureName]);
  assert.equal(rejected.exitCode, 1);
  assert.equal(text(rejected.stdout), "");
  assert.match(text(rejected.stderr), /cannot acquire packed-refs lock/);
  assert.equal(await refs(), before);
  py.FS.unlink(`${packedPath}.lock`);

  const limitNames = Array.from({ length: 100 }, (_, index) =>
    `limit-${index.toString().padStart(3, "0")}`
  );
  for (const name of limitNames) await writeLightweight(name);
  const limitResponse = await run(["--delete", ...limitNames]);
  assert.equal(limitResponse.exitCode, 0, text(limitResponse.stderr));
  assert.equal(text(limitResponse.stdout).split("\n").filter(Boolean).length, 100);
  for (const name of limitNames) assert.equal(await refExists(`refs/tags/${name}`), false);

  py.FS.writeFile(`${repository}/.git/refs/tags/symbolic`, "ref: refs/heads/main\n");
  rejected = await run(["-d", "symbolic"]);
  assert.equal(rejected.exitCode, 1);
  assert.match(text(rejected.stderr), /not a direct ref/);
  assert.equal(py.FS.readFile(`${repository}/.git/refs/tags/symbolic`, { encoding: "utf8" }),
    "ref: refs/heads/main\n");

  const help = await git(py, repository, "help", "tag");
  assert.match(help, /tag \(-d\|--delete\) \[--\] NAME/);
  assert.match(help, /literal local tag names.*complete validated request with rollback/s);
  assert.match(help, /status: 0 deleted, 1 repository\/ref\/runtime failure, 2 invocation\/name\/bounds/);
  assert.match(help, /100 names.*4096 bytes\/name.*65536 name bytes.*100000 ref entries/s);
  assert.match(help, /remote deletion, patterns, reflog policy, force.*unavailable/);
  await assertLayersUnchanged();
});

test("bounded Git inspection supports path filters, untracked suppression, and machine projections", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/inspection-api";
  py.FS.mkdirTree(`${repository}/alpha`);
  py.FS.mkdirTree(`${repository}/beta`);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/alpha/tracked.txt`, "alpha one\n");
  py.FS.writeFile(`${repository}/beta/tracked.txt`, "beta one\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "first subject");
  py.FS.writeFile(`${repository}/alpha/tracked.txt`, "alpha two\n");
  py.FS.writeFile(`${repository}/beta/added.txt`, "added two\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "second subject");
  const head = (await git(py, repository, "rev-parse", "HEAD")).trim();

  py.FS.writeFile(`${repository}/alpha/tracked.txt`, "alpha working\n");
  py.FS.writeFile(`${repository}/beta/tracked.txt`, "beta staged\n");
  await git(py, repository, "add", "beta/tracked.txt");
  py.FS.writeFile(`${repository}/alpha/untracked.txt`, "alpha untracked\n");
  py.FS.writeFile(`${repository}/beta/untracked.txt`, "beta untracked\n");
  py.FS.writeFile(`${repository}/root-untracked.txt`, "root untracked\n");

  assert.equal(
    (await gitResult(py, repository, "status", "--short", "--", "alpha")).output,
    " M alpha/tracked.txt\n?? alpha/untracked.txt\n",
  );
  assert.equal(
    (await gitResult(py, repository, "status", "--short", "alpha")).output,
    " M alpha/tracked.txt\n?? alpha/untracked.txt\n",
  );
  assert.equal(
    (await gitResult(py, repository, "status", "--short", "-uno")).output,
    " M alpha/tracked.txt\nM  beta/tracked.txt\n",
  );
  const boundedStatus = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "status", "-sbz", "--untracked-files=no", "--", "alpha"],
  });
  assert.equal(boundedStatus.exitCode, 0);
  assert.deepEqual(
    boundedStatus.stdout,
    new TextEncoder().encode("## main\0 M alpha/tracked.txt\0"),
  );
  const untrackedStatus =
    " M alpha/tracked.txt\n" +
    "?? alpha/untracked.txt\n" +
    "M  beta/tracked.txt\n" +
    "?? beta/untracked.txt\n" +
    "?? root-untracked.txt\n";
  for (const untrackedOption of [
    "--untracked-files=all",
    "--untracked-files=normal",
    "-uall",
    "-unormal",
  ]) {
    assert.equal(
      (await gitResult(py, repository, "status", "--short", untrackedOption)).output,
      untrackedStatus,
      untrackedOption,
    );
  }

  const changed = await gitResult(py, repository, "diff", "--exit-code", "--color=never", "--", "alpha");
  assert.equal(changed.exitCode, 1);
  assert.match(changed.output, /alpha\/tracked\.txt/);
  const quietChanged = await gitResult(py, repository, "diff", "--quiet", "--no-color");
  assert.deepEqual(quietChanged, { exitCode: 1, output: "" });
  for (const invalid of [
    ["--exit-code", "--bogus"],
    ["--quiet", "--color=always"],
    ["--check", "--stat"],
    ["HEAD", "HEAD", "HEAD"],
  ]) {
    const rejected = await gitResult(py, repository, "diff", ...invalid);
    assert.equal(rejected.exitCode, 2, `${invalid.join(" ")}: ${rejected.output}`);
  }

  assert.equal(
    await git(py, repository, "log", "--format=%H%x09%h%x09%s", "-n1"),
    `${head}\t${head.slice(0, 7)}\tsecond subject\n`,
  );
  assert.equal(
    await git(py, repository, "log", "--pretty=oneline", "--color=never", "-1"),
    `${head} second subject\n`,
  );
  const nulLog = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "log", "--pretty=format:%h%x00%s", "-1"],
  });
  assert.equal(nulLog.exitCode, 0);
  assert.deepEqual(nulLog.stdout, new TextEncoder().encode(`${head.slice(0, 7)}\0second subject\n`));
  const invalidLogFormat = await gitResult(py, repository, "log", "--format=%an");
  assert.equal(invalidLogFormat.exitCode, 2);
  assert.match(invalidLogFormat.output, /unsupported git log format atom/);

  assert.equal(
    await git(py, repository, "show", "--format=", "--name-only", "HEAD"),
    "alpha/tracked.txt\nbeta/added.txt\n",
  );
  assert.equal(
    await git(py, repository, "show", "--format=%H%x09%s", "--no-patch", "--no-color", "HEAD"),
    `${head}\tsecond subject\n`,
  );
  const nulShow = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "show", "--format=", "--name-status", "-z", "HEAD"],
  });
  assert.equal(nulShow.exitCode, 0);
  assert.deepEqual(
    nulShow.stdout,
    new TextEncoder().encode("M\0alpha/tracked.txt\0A\0beta/added.txt\0"),
  );
  const invalidShowFormat = await gitResult(py, repository, "show", "--format=%x80", "HEAD");
  assert.equal(invalidShowFormat.exitCode, 2);
  assert.match(invalidShowFormat.output, /ASCII %xNN escapes/);

  assert.match(await git(py, repository, "help", "status"), /--untracked-files=no\|normal\|all.*paths/);
  assert.match(await git(py, repository, "help", "log"), /FMT atoms: %H %h %s %n %% and ASCII %xNN/);
  assert.match(await git(py, repository, "help", "show"), /--name-only\|--name-status/);
});

test("bounded Git status rejects unsupported options before repository inspection", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/status-option-validation";
  const outside = "/home/web/status-option-validation-outside";
  py.FS.mkdirTree(repository);
  py.FS.mkdirTree(outside);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/tracked.txt`, "base\n");
  await git(py, repository, "add", "tracked.txt");
  await git(py, repository, "commit", "-m", "status validation base");
  for (const path of ["--porcelain=v2", "--short", "-z"]) {
    py.FS.writeFile(`${repository}/${path}`, `${path}\n`);
  }

  const snapshotTree = (path: string): string => {
    const rows: Array<[string, string]> = [];
    const visit = (current: string, relative: string): void => {
      for (const name of py.FS.readdir(current).filter((value) => value !== "." && value !== "..").sort()) {
        const child = `${current}/${name}`;
        const childRelative = relative ? `${relative}/${name}` : name;
        const stat = py.FS.lstat(child);
        if (py.FS.isDir(stat.mode)) visit(child, childRelative);
        else rows.push([childRelative, Buffer.from(py.FS.readFile(child) as Uint8Array).toString("hex")]);
      }
    };
    visit(path, "");
    return JSON.stringify(rows);
  };
  const invokeStatus = (cwd: string, ...args: string[]) => runGitEngineCommand({
    py,
    cwd,
    args: ["git-engine", "status", ...args],
  });
  const assertRejected = async (cwd: string, token: string, ...prefix: string[]): Promise<void> => {
    const response = await invokeStatus(cwd, ...prefix, token);
    assert.equal(response.exitCode, 2, [cwd, ...prefix, token].join(" "));
    assert.equal(response.stdout?.byteLength ?? 0, 0);
    assert.deepEqual(
      response.stderr,
      new TextEncoder().encode(`git: unsupported status option: ${token}\n`),
    );
  };
  const invalidOptions = [
    "--porcelain=v2",
    "--porcelain=v3",
    "--porcelain=",
    "--unknown",
    "--untracked-files",
    "--untracked-files=bogus",
    "-u",
    "-ubogus",
  ];

  for (const state of ["ordinary", "shallow", "grafts"] as const) {
    if (state === "shallow") py.FS.writeFile(`${repository}/.git/shallow`, "");
    if (state === "grafts") {
      py.FS.mkdirTree(`${repository}/.git/info`);
      py.FS.writeFile(`${repository}/.git/info/grafts`, "");
    }
    const before = snapshotTree(repository);
    for (const option of invalidOptions) await assertRejected(repository, option);
    assert.equal(snapshotTree(repository), before, state);
  }

  for (const option of invalidOptions) await assertRejected(outside, option);
  await assertRejected(repository, "--unknown", "tracked.txt");
  await assertRejected(repository, "--unknown", ...Array.from({ length: 100 }, (_, index) => `path-${index}`));
  const firstRejected = await invokeStatus(repository, "--unknown", "--porcelain=v2");
  assert.deepEqual(firstRejected.stderr, new TextEncoder().encode("git: unsupported status option: --unknown\n"));

  const porcelainPath = await invokeStatus(repository, "--porcelain=v1", "--", "--porcelain=v2");
  assert.equal(porcelainPath.exitCode, 0);
  assert.deepEqual(porcelainPath.stdout, new TextEncoder().encode("?? --porcelain=v2\n"));
  const nulPath = await invokeStatus(repository, "--porcelain=v1", "-z", "--", "-z");
  assert.equal(nulPath.exitCode, 0);
  assert.deepEqual(nulPath.stdout, new TextEncoder().encode("?? -z\0"));
  const ordinaryPath = await invokeStatus(repository, "--", "--short");
  assert.equal(
    ordinaryPath.exitCode,
    0,
    new TextDecoder().decode(ordinaryPath.stderr ?? ordinaryPath.stdout),
  );
  assert.match(new TextDecoder().decode(ordinaryPath.stdout), /--short/);

  const untracked = await invokeStatus(repository, "--short", "-uno", "-uall");
  assert.equal(untracked.exitCode, 0);
  assert.match(new TextDecoder().decode(untracked.stdout), /^\?\? --porcelain=v2$/m);
  const suppressed = await invokeStatus(repository, "--short", "-uall", "--untracked-files=no");
  assert.deepEqual(suppressed, { exitCode: 0, stdout: new Uint8Array() });

  const validOutside = await invokeStatus(outside, "--short");
  assert.equal(validOutside.exitCode, 1);
  assert.notEqual(validOutside.stderr?.byteLength ?? 0, 0);

  for (const [command, options] of [
    ["add", ["--bogus"]],
    ["diff", ["--bogus"]],
    ["rev-parse", ["--symbolic-full-name", "HEAD"]],
  ] as const) {
    const response = await runGitEngineCommand({
      py,
      cwd: repository,
      args: ["git-engine", command, ...options],
    });
    assert.equal(response.exitCode, 2, `${command} ${options.join(" ")}`);
  }
});

test("bounded Git diff predicates reserve status one for computed differences", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/diff-predicate-status";
  const outside = "/home/web/diff-predicate-outside";
  py.FS.mkdirTree(repository);
  py.FS.mkdirTree(outside);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/tracked.txt`, "base\n");
  py.FS.writeFile(`${repository}/side.txt`, "side\n");
  py.FS.writeFile(`${repository}/--quiet`, "dash base\n");
  py.FS.writeFile(`${repository}/-`, "hyphen base\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "predicate base");
  const parent = (await git(py, repository, "rev-parse", "HEAD")).trim();
  py.FS.writeFile(`${repository}/history.txt`, "history\n");
  await git(py, repository, "add", "history.txt");
  await git(py, repository, "commit", "-m", "predicate child");
  const head = (await git(py, repository, "rev-parse", "HEAD")).trim();

  const run = (...args: string[]) => runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", ...args],
  });
  const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes ?? new Uint8Array());

  let response = await run("diff", "--quiet");
  assert.equal(response.exitCode, 0);
  assert.equal(text(response.stdout), "");
  assert.equal(text(response.stderr), "");
  response = await run("diff", "--exit-code");
  assert.equal(response.exitCode, 0);
  assert.equal(text(response.stdout), "");
  response = await run("diff", "--quiet", head, head);
  assert.equal(response.exitCode, 0);
  response = await run("diff", "--quiet", parent, head);
  assert.equal(response.exitCode, 1);
  assert.equal(text(response.stdout), "");
  assert.equal(text(response.stderr), "");

  py.FS.writeFile(`${repository}/tracked.txt`, "working\n");
  py.FS.writeFile(`${repository}/--quiet`, "dash working\n");
  response = await run("diff", "--quiet");
  assert.equal(response.exitCode, 1);
  assert.equal(text(response.stdout), "");
  response = await run("diff", "--quiet", "--", "tracked.txt");
  assert.equal(response.exitCode, 1);
  response = await run("diff", "--quiet", "--", "side.txt");
  assert.equal(response.exitCode, 0);
  response = await run("diff", "--quiet", "--", "missing-path.txt");
  assert.equal(response.exitCode, 0);
  response = await run("diff", "--", "--quiet");
  assert.equal(response.exitCode, 0);
  assert.match(text(response.stdout), /diff --git a\/--quiet b\/--quiet/);
  response = await run("diff", "--quiet", "--", "--quiet");
  assert.equal(response.exitCode, 1);
  py.FS.writeFile(`${repository}/untracked.txt`, "untracked\n");
  response = await run("diff", "--quiet", "--", "untracked.txt");
  assert.equal(response.exitCode, 0);

  response = await run("diff", "--exit-code", "--name-only", "--", "tracked.txt");
  assert.equal(response.exitCode, 1);
  assert.equal(text(response.stdout), "tracked.txt\n");
  response = await run("diff", "--exit-code", "--name-only", "-z", "--", "tracked.txt");
  assert.equal(response.exitCode, 1);
  assert.deepEqual(response.stdout, new TextEncoder().encode("tracked.txt\0"));
  await git(py, repository, "add", "--", "tracked.txt", "--quiet");
  response = await run("diff", "--quiet");
  assert.equal(response.exitCode, 0);
  response = await run("diff", "--cached", "--quiet");
  assert.equal(response.exitCode, 1);
  response = await run("diff", "--staged", "--quiet");
  assert.equal(response.exitCode, 1);

  const indexBefore = py.FS.readFile(`${repository}/.git/index`) as Uint8Array;
  const headBefore = py.FS.readFile(`${repository}/.git/HEAD`) as Uint8Array;
  const trackedBefore = py.FS.readFile(`${repository}/tracked.txt`) as Uint8Array;
  const failures: Array<{ args: string[]; diagnostic: RegExp }> = [
    { args: ["diff", "--quiet", "HEAD", "missing-revision"], diagnostic: /revspec 'missing-revision' not found/ },
    { args: ["diff", "--exit-code", "missing-revision", "HEAD"], diagnostic: /revspec 'missing-revision' not found/ },
    { args: ["diff", "--quiet", "--unified=1001"], diagnostic: /context must be a decimal integer/ },
    { args: ["diff", "--exit-code", "--unified=nope"], diagnostic: /context must be a decimal integer/ },
    { args: ["diff", "--quiet", "-U"], diagnostic: /context must be a decimal integer/ },
    { args: ["diff", "--quiet", "--unsupported"], diagnostic: /unsupported diff option/ },
    { args: ["diff", "--quiet", "--exit-code"], diagnostic: /accepts only one of --quiet or --exit-code/ },
  ];
  for (const failure of failures) {
    response = await run(...failure.args);
    assert.equal(response.exitCode, 2, failure.args.join(" "));
    assert.equal(text(response.stdout), "", failure.args.join(" "));
    assert.match(text(response.stderr), failure.diagnostic, failure.args.join(" "));
  }
  const ordinaryRevisionFailure = await run("diff", "HEAD", "missing-revision");
  assert.equal(ordinaryRevisionFailure.exitCode, 2);
  assert.match(text(ordinaryRevisionFailure.stderr), /revspec 'missing-revision' not found/);
  const outsideFailure = await runGitEngineCommand({
    py,
    cwd: outside,
    args: ["git-engine", "diff", "--quiet"],
  });
  assert.equal(outsideFailure.exitCode, 2);
  assert.equal(text(outsideFailure.stdout), "");
  assert.match(text(outsideFailure.stderr), /not a Git repository/);
  const outsideOrdinary = await runGitEngineCommand({
    py,
    cwd: outside,
    args: ["git-engine", "diff"],
  });
  assert.equal(outsideOrdinary.exitCode, 2);
  assert.match(text(outsideOrdinary.stderr), /not a Git repository/);

  assert.deepEqual(py.FS.readFile(`${repository}/.git/index`) as Uint8Array, indexBefore);
  assert.deepEqual(py.FS.readFile(`${repository}/.git/HEAD`) as Uint8Array, headBefore);
  assert.deepEqual(py.FS.readFile(`${repository}/tracked.txt`) as Uint8Array, trackedBefore);
  assert.match(await git(py, repository, "help", "diff"), /--quiet\|--exit-code/);
  assert.equal((await git(py, repository, "rev-parse", "HEAD")).trim(), head);
});

test("bounded Git numstat is exact across layers, revisions, show, and raw paths", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/numstat-protocol";
  py.FS.mkdirTree(repository);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/binary.bin`, new Uint8Array([1, 0, 2]));
  py.FS.writeFile(`${repository}/café.txt`, "accent old\n");
  py.FS.writeFile(`${repository}/delete.txt`, "gone one\ngone two");
  py.FS.writeFile(`${repository}/modify.txt`, "old");
  py.FS.writeFile(`${repository}/old-name.txt`, "same one\nsame two");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "numstat base");
  const base = (await git(py, repository, "rev-parse", "HEAD")).trim();

  py.FS.writeFile(`${repository}/added.txt`, "added one\nadded two\n");
  py.FS.writeFile(`${repository}/binary.bin`, new Uint8Array([3, 0, 4]));
  py.FS.writeFile(`${repository}/café.txt`, "accent new\n");
  py.FS.unlink(`${repository}/delete.txt`);
  py.FS.writeFile(`${repository}/modify.txt`, "new one\nnew two\n");
  py.FS.rename(`${repository}/old-name.txt`, `${repository}/renamed exact.txt`);
  py.FS.writeFile(`${repository}/space path.txt`, "spaced\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "numstat second");
  const second = (await git(py, repository, "rev-parse", "HEAD")).trim();

  const expected =
    "2\t0\tadded.txt\n" +
    "-\t-\tbinary.bin\n" +
    "1\t1\t\"caf\\303\\251.txt\"\n" +
    "0\t2\tdelete.txt\n" +
    "2\t1\tmodify.txt\n" +
    "0\t2\told-name.txt\n" +
    "2\t0\trenamed exact.txt\n" +
    "1\t0\tspace path.txt\n";
  assert.equal(await git(py, repository, "diff", "--numstat", base, second), expected);
  assert.equal(await git(py, repository, "diff", "--numstat", `${base}...${second}`), expected);
  assert.equal(
    await git(py, repository, "diff", "--numstat", base, second, "--", "modify.txt"),
    "2\t1\tmodify.txt\n",
  );
  const raw = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "diff", "--numstat", "-z", base, second],
  });
  assert.equal(raw.exitCode, 0);
  assert.deepEqual(
    raw.stdout,
    new TextEncoder().encode(
      "2\t0\tadded.txt\0" +
      "-\t-\tbinary.bin\0" +
      "1\t1\tcafé.txt\0" +
      "0\t2\tdelete.txt\0" +
      "2\t1\tmodify.txt\0" +
      "0\t2\told-name.txt\0" +
      "2\t0\trenamed exact.txt\0" +
      "1\t0\tspace path.txt\0",
    ),
  );

  assert.equal(await git(py, repository, "show", "--format=", "--numstat", second), expected);
  assert.match(await git(py, repository, "show", "--numstat", second), /numstat second[\s\S]*2\t0\tadded\.txt/);
  assert.match(await git(py, repository, "show", "--format=%s", "--numstat", second), /^numstat second\n2\t0\tadded\.txt/m);
  const rawShow = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "show", "--format=", "--numstat", "-z", second],
  });
  assert.deepEqual(rawShow.stdout, raw.stdout);
  assert.equal(
    await git(py, repository, "show", "--format=", "--numstat", base),
    "-\t-\tbinary.bin\n" +
    "1\t0\t\"caf\\303\\251.txt\"\n" +
    "2\t0\tdelete.txt\n" +
    "1\t0\tmodify.txt\n" +
    "2\t0\told-name.txt\n",
  );

  py.FS.writeFile(`${repository}/modify.txt`, "new one\nnew two\nwork\n");
  py.FS.writeFile(`${repository}/untracked.txt`, "not reported\n");
  assert.equal(await git(py, repository, "diff", "--numstat"), "1\t0\tmodify.txt\n");
  await git(py, repository, "add", "modify.txt");
  py.FS.writeFile(`${repository}/modify.txt`, "new one\nnew two\nwork\nunstaged\n");
  assert.equal(await git(py, repository, "diff", "--cached", "--numstat"), "1\t0\tmodify.txt\n");
  assert.equal(await git(py, repository, "diff", "--numstat"), "1\t0\tmodify.txt\n");
  assert.equal(await git(py, repository, "diff", "--numstat", second), "2\t0\tmodify.txt\n");
  await git(py, repository, "reset", "--hard", second);

  py.FS.rename(`${repository}/renamed exact.txt`, `${repository}/moved again.txt`);
  await git(py, repository, "add", "--", "renamed exact.txt", "moved again.txt");
  assert.equal(
    await git(py, repository, "diff", "--cached", "--name-status"),
    "R100\trenamed exact.txt\tmoved again.txt\n",
  );
  const stagedRename = await git(py, repository, "diff", "--cached", "--numstat");
  assert.match(stagedRename, /^2\t0\tmoved again\.txt$/m);
  assert.match(stagedRename, /^0\t2\trenamed exact\.txt$/m);
  await git(py, repository, "reset", "--hard", second);

  await git(py, repository, "switch", "-c", "feature");
  py.FS.writeFile(`${repository}/added.txt`, "added one\nadded two\nfeature\n");
  await git(py, repository, "add", "added.txt");
  await git(py, repository, "commit", "-m", "feature line");
  await git(py, repository, "switch", "main");
  py.FS.writeFile(`${repository}/space path.txt`, "main spaced\n");
  await git(py, repository, "add", "space path.txt");
  await git(py, repository, "commit", "-m", "main line");
  assert.equal(await git(py, repository, "diff", "--numstat", "main...feature"), "1\t0\tadded.txt\n");

  const quiet = await gitResult(py, repository, "diff", "--quiet", "--numstat", base, second);
  assert.deepEqual(quiet, { exitCode: 1, output: "" });
  const exitCode = await gitResult(py, repository, "diff", "--exit-code", "--numstat", base, second);
  assert.equal(exitCode.exitCode, 1);
  assert.equal(exitCode.output, expected);
  assert.deepEqual(await gitResult(py, repository, "diff", "--numstat", second, second), {
    exitCode: 0,
    output: "",
  });
  for (const args of [
    ["diff", "--numstat", "--stat"],
    ["diff", "--numstat", "--name-only"],
    ["diff", "--numstat", "--check"],
    ["show", "--numstat", "--name-status"],
    ["show", "--numstat", "--no-patch"],
  ]) {
    const rejected = await gitResult(py, repository, ...args);
    assert.equal(rejected.exitCode, 2, `${args.join(" ")}: ${rejected.output}`);
  }
  assert.match(await git(py, repository, "help", "diff"), /--numstat emits added<TAB>deleted<TAB>path/);
  assert.match(await git(py, repository, "help", "show"), /numstat reports exact moves/);
});

test("bounded Git diff projections detect racy same-size worktree rewrites", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/diff-racy-projections";
  py.FS.mkdirTree(repository);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/binary.bin`, new Uint8Array([1, 0, 2]));
  py.FS.writeFile(`${repository}/same.txt`, "lower\n");
  py.FS.writeFile(`${repository}/tab\tname.txt`, "one\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "racy projection base");

  // MEMFS can preserve every stat field consulted by the index across an
  // immediate equal-length rewrite. Full diff/status already verify content;
  // machine projections must not silently trust the resulting racy-clean OID.
  py.FS.writeFile(`${repository}/binary.bin`, new Uint8Array([3, 0, 4]));
  py.FS.writeFile(`${repository}/same.txt`, "UPPER\n");
  py.FS.writeFile(`${repository}/tab\tname.txt`, "TWO\n");

  assert.match(await git(py, repository, "status", "--short"), /^ M same\.txt$/m);
  assert.match(await git(py, repository, "diff"), /-lower[\s\S]*\+UPPER/);
  assert.deepEqual(
    await gitResult(py, repository, "diff", "--quiet"),
    { exitCode: 1, output: "" },
  );
  assert.equal(
    await git(py, repository, "diff", "--name-only"),
    "binary.bin\nsame.txt\n\"tab\\011name.txt\"\n",
  );
  assert.equal(
    await git(py, repository, "diff", "--name-status"),
    "M\tbinary.bin\nM\tsame.txt\nM\t\"tab\\011name.txt\"\n",
  );
  assert.equal(
    await git(py, repository, "diff", "--numstat"),
    "-\t-\tbinary.bin\n1\t1\tsame.txt\n1\t1\t\"tab\\011name.txt\"\n",
  );
  for (const projection of ["--name-only", "--name-status", "--numstat"]) {
    const raw = await runGitEngineCommand({
      py,
      cwd: repository,
      args: ["git-engine", "diff", projection, "-z"],
    });
    assert.equal(raw.exitCode, 0);
    const expected = projection === "--name-only"
      ? "binary.bin\x00same.txt\x00tab\tname.txt\x00"
      : projection === "--name-status"
        ? "M\x00binary.bin\x00M\x00same.txt\x00M\x00tab\tname.txt\x00"
        : "-\t-\tbinary.bin\x001\t1\tsame.txt\x001\t1\ttab\tname.txt\x00";
    assert.deepEqual(raw.stdout, new TextEncoder().encode(expected));
  }
  assert.equal(
    await git(py, repository, "diff", "--name-only", "--", "same.txt"),
    "same.txt\n",
  );
  assert.equal(
    await git(py, repository, "diff", "--name-only", "HEAD"),
    "binary.bin\nsame.txt\n\"tab\\011name.txt\"\n",
  );
  assert.equal(await git(py, repository, "diff", "--cached", "--name-only"), "");

  await git(py, repository, "add", "same.txt");
  py.FS.writeFile(`${repository}/same.txt`, "MIXED\n");
  assert.equal(await git(py, repository, "diff", "--name-only", "--", "same.txt"), "same.txt\n");
  assert.equal(
    await git(py, repository, "diff", "--cached", "--name-only", "--", "same.txt"),
    "same.txt\n",
  );
  assert.equal(await git(py, repository, "diff", "--numstat", "--", "same.txt"), "1\t1\tsame.txt\n");

  const invalidRevision = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "diff", "--name-only", "-z", "NO_SUCH_REV"],
  });
  assert.equal(invalidRevision.exitCode, 2);
  assert.equal(invalidRevision.stdout, undefined);
  assert.match(new TextDecoder().decode(invalidRevision.stderr), /NO_SUCH_REV/);
  const outside = "/home/web/diff-racy-projections-outside";
  py.FS.mkdirTree(outside);
  const invalidRepository = await runGitEngineCommand({
    py,
    cwd: outside,
    args: ["git-engine", "diff", "--name-only", "-z"],
  });
  assert.equal(invalidRepository.exitCode, 2);
  assert.equal(invalidRepository.stdout, undefined);
  assert.match(new TextDecoder().decode(invalidRepository.stderr), /not a Git repository/);
  // wasm-git's Node wrapper mirrors its most recent native status onto
  // process.exitCode; finish with a successful native command so the passing
  // test does not leak the deliberately exercised failure to node:test.
  await git(py, repository, "rev-parse", "HEAD");
});

test("bounded Git diff name projections enforce exact pathname limits", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/diff-name-projection-limits";
  const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  py.FS.mkdirTree(repository);
  await git(py, repository, "init", "-b", "main");
  const fs = createIsomorphicGitFs(py);
  const blob = await isomorphicGit.writeBlob({
    fs,
    dir: repository,
    blob: new TextEncoder().encode("bounded\n"),
  });
  const nestedTree = async (pathBytes: number): Promise<{ path: string; oid: string }> => {
    const directories = Array.from({ length: 16 }, () => "d".repeat(250));
    const prefix = `${directories.join("/")}/`;
    const path = `${prefix}${"f".repeat(pathBytes - prefix.length)}`;
    let oid = await isomorphicGit.writeTree({
      fs,
      dir: repository,
      tree: [{ mode: "100644", path: path.slice(prefix.length), oid: blob, type: "blob" }],
    });
    for (const directory of directories.reverse()) {
      oid = await isomorphicGit.writeTree({
        fs,
        dir: repository,
        tree: [{ mode: "040000", path: directory, oid, type: "tree" }],
      });
    }
    return { path, oid };
  };

  const exact = await nestedTree(4_096);
  assert.equal(
    await git(py, repository, "diff", "--name-only", emptyTree, exact.oid),
    `${exact.path}\n`,
  );
  const over = await nestedTree(4_097);
  const rejected = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "diff", "--name-status", "-z", emptyTree, over.oid],
  });
  assert.equal(rejected.exitCode, 2);
  assert.equal(rejected.stdout, undefined);
  assert.match(new TextDecoder().decode(rejected.stderr), /pathname limit exceeded \(4096 bytes\)/);

  const emptyBlob = await isomorphicGit.writeBlob({
    fs,
    dir: repository,
    blob: new Uint8Array(),
  });
  const outputEntry = (index: number) => ({
    mode: "100644",
    path: `${index.toString(36).padStart(6, "0")}-${"x".repeat(248)}`,
    oid: emptyBlob,
    type: "blob" as const,
  });
  const exactEntries = Array.from({ length: 32_768 }, (_, index) => outputEntry(index));
  const exactOutputTree = await isomorphicGit.writeTree({
    fs,
    dir: repository,
    tree: exactEntries,
  });
  const exactOutput = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "diff", "--name-only", "-z", emptyTree, exactOutputTree],
  });
  assert.equal(exactOutput.exitCode, 0);
  assert.equal(exactOutput.stdout?.byteLength, 8 * 1024 * 1024);
  assert.equal(exactOutput.stdout?.at(-1), 0);

  const excessiveOutputTree = await isomorphicGit.writeTree({
    fs,
    dir: repository,
    tree: [...exactEntries, outputEntry(exactEntries.length)],
  });
  const excessiveOutput = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "diff", "--name-only", "-z", emptyTree, excessiveOutputTree],
  });
  assert.equal(excessiveOutput.exitCode, 2);
  assert.equal(excessiveOutput.stdout, undefined);
  assert.match(
    new TextDecoder().decode(excessiveOutput.stderr),
    /output limit exceeded \(8388608 bytes\)/,
  );

  const recordEntry = (index: number) => ({
    mode: "100644",
    path: `r${index.toString(36).padStart(6, "0")}`,
    oid: emptyBlob,
    type: "blob" as const,
  });
  const exactRecordEntries = Array.from({ length: 100_000 }, (_, index) => recordEntry(index));
  const exactRecordTree = await isomorphicGit.writeTree({
    fs,
    dir: repository,
    tree: exactRecordEntries,
  });
  const exactRecords = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "diff", "--name-only", "-z", emptyTree, exactRecordTree],
  });
  assert.equal(exactRecords.exitCode, 0);
  assert.equal(exactRecords.stdout?.byteLength, 800_000);

  const excessiveRecordTree = await isomorphicGit.writeTree({
    fs,
    dir: repository,
    tree: [...exactRecordEntries, recordEntry(exactRecordEntries.length)],
  });
  const excessiveRecords = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "diff", "--name-status", "-z", emptyTree, excessiveRecordTree],
  });
  assert.equal(excessiveRecords.exitCode, 2);
  assert.equal(excessiveRecords.stdout, undefined);
  assert.match(
    new TextDecoder().decode(excessiveRecords.stderr),
    /record limit exceeded \(100000\)/,
  );
});

test("bounded Git diff context is native across revisions, layers, show, and projections", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/diff-context-protocol";
  const original = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
  const changed = "one\nTWO\nthree\nfour\nfive\nsix\nseven\nEIGHT\nnine\nten\n";
  py.FS.mkdirTree(repository);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/context.txt`, original);
  py.FS.writeFile(`${repository}/binary.bin`, new Uint8Array([1, 0, 2]));
  py.FS.writeFile(`${repository}/no-final-newline.txt`, "old");
  py.FS.writeFile(`${repository}/line\nbreak.txt`, "old\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "context base");
  const base = (await git(py, repository, "rev-parse", "HEAD")).trim();

  py.FS.writeFile(`${repository}/context.txt`, changed);
  py.FS.writeFile(`${repository}/binary.bin`, new Uint8Array([3, 0, 4]));
  py.FS.writeFile(`${repository}/no-final-newline.txt`, "new");
  py.FS.writeFile(`${repository}/line\nbreak.txt`, "new\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "context tip");
  const tip = (await git(py, repository, "rev-parse", "HEAD")).trim();

  const zero = await git(py, repository, "diff", "-U0", base, tip, "--", "context.txt");
  assert.equal(
    zero,
    "diff --git a/context.txt b/context.txt\n" +
    "index c9e9e05..c7c4051 100644\n" +
    "--- a/context.txt\n" +
    "+++ b/context.txt\n" +
    "@@ -2 +2 @@ one\n" +
    "-two\n" +
    "+TWO\n" +
    "@@ -8 +8 @@ seven\n" +
    "-eight\n" +
    "+EIGHT\n",
  );
  for (const spelling of [
    ["-U", "0"],
    ["--unified=0"],
    ["--unified", "0"],
  ]) {
    assert.equal(
      await git(py, repository, "diff", ...spelling, base, tip, "--", "context.txt"),
      zero,
    );
  }

  const one = await git(py, repository, "diff", "-U1", base, tip, "--", "context.txt");
  assert.equal(
    one,
    "diff --git a/context.txt b/context.txt\n" +
    "index c9e9e05..c7c4051 100644\n" +
    "--- a/context.txt\n" +
    "+++ b/context.txt\n" +
    "@@ -1,3 +1,3 @@\n" +
    " one\n" +
    "-two\n" +
    "+TWO\n" +
    " three\n" +
    "@@ -7,3 +7,3 @@ six\n" +
    " seven\n" +
    "-eight\n" +
    "+EIGHT\n" +
    " nine\n",
  );
  assert.equal(
    await git(py, repository, "diff", "-U0", "--unified", "1", base, tip, "--", "context.txt"),
    one,
  );
  assert.equal(
    await git(py, repository, "diff", "-U1", "--unified=0", base, tip, "--", "context.txt"),
    zero,
  );
  assert.equal(
    await git(py, repository, "diff", base, tip, "--", "context.txt"),
    await git(py, repository, "diff", "-U3", base, tip, "--", "context.txt"),
  );
  assert.equal(
    await git(py, repository, "diff", "-U1000", base, tip, "--", "context.txt"),
    await git(py, repository, "diff", base, tip, "--", "context.txt"),
  );
  assert.equal(
    await git(py, repository, "diff", "--unified=0", `${base}...${tip}`, "--", "context.txt"),
    zero,
  );

  assert.equal(
    await git(py, repository, "show", "--format=", "-U0", tip, "--", "context.txt"),
    zero,
  );
  const rootShow = await git(py, repository, "show", "--format=", "-U0", base, "--", "context.txt");
  assert.match(rootShow, /@@ -0,0 \+1,10 @@/);
  assert.equal((rootShow.match(/^\+/gm) ?? []).length, 11);
  assert.equal(
    await git(py, repository, "show", "--format=%s", "--no-patch", "--unified", "0", tip),
    "context tip\n",
  );

  const binary = await git(py, repository, "diff", "-U0", base, tip, "--", "binary.bin");
  assert.match(binary, /Binary files a\/binary\.bin and b\/binary\.bin differ/);
  const noFinalNewline = await git(
    py, repository, "diff", "-U0", base, tip, "--", "no-final-newline.txt",
  );
  assert.equal((noFinalNewline.match(/\\ No newline at end of file/g) ?? []).length, 2);
  const unusualPath = await git(py, repository, "diff", "-U0", base, tip, "--", "line\nbreak.txt");
  assert.match(unusualPath, /"a\/line\\nbreak\.txt"/);
  assert.doesNotMatch(unusualPath, /context\.txt/);

  for (const projection of [["--name-only"], ["--name-status"], ["--stat"], ["--numstat"]]) {
    assert.equal(
      await git(py, repository, "diff", ...projection, "-U0", base, tip, "--", "context.txt"),
      await git(py, repository, "diff", ...projection, base, tip, "--", "context.txt"),
    );
  }
  assert.equal(
    await git(py, repository, "show", "--format=", "--numstat", "-U0", tip, "--", "context.txt"),
    "2\t2\tcontext.txt\n",
  );

  py.FS.writeFile(`${repository}/context.txt`, changed.replace("five\n", "FIVE  \n"));
  assert.equal(
    await git(py, repository, "diff", "-U0", tip, "--", "context.txt"),
    await git(py, repository, "diff", "-U0", "--", "context.txt"),
  );
  const whitespace = await gitResult(py, repository, "diff", "--check", "-U0", "--", "context.txt");
  assert.equal(whitespace.exitCode, 1);
  assert.match(whitespace.output, /context\.txt:5: trailing whitespace/);
  assert.deepEqual(
    await gitResult(py, repository, "diff", "--quiet", "-U0", "--", "context.txt"),
    { exitCode: 1, output: "" },
  );
  const exited = await gitResult(py, repository, "diff", "--exit-code", "-U0", "--", "context.txt");
  assert.equal(exited.exitCode, 1);
  assert.match(exited.output, /@@ -5 \+5 @@ four/);
  await git(py, repository, "add", "context.txt");
  assert.match(await git(py, repository, "diff", "--cached", "-U0", "--", "context.txt"), /@@ -5 \+5 @@ four/);
  await git(py, repository, "reset", "--hard", tip);

  for (const args of [
    ["diff", "-U"],
    ["diff", "-U-1", base, tip],
    ["diff", "-U+1", base, tip],
    ["diff", "-U1.5", base, tip],
    ["diff", "-U1001", base, tip],
    ["diff", "--unified"],
    ["diff", "--unified="],
    ["diff", "--unified=lots", base, tip],
    ["show", "-U1001", tip],
    ["show", "--unified=-1", tip],
  ]) {
    const rejected = await runGitEngineCommand({
      py,
      cwd: repository,
      args: ["git-engine", ...args],
    });
    assert.equal(rejected.exitCode, 2, args.join(" "));
    assert.equal(rejected.stdout?.byteLength ?? 0, 0, args.join(" "));
    assert.match(new TextDecoder().decode(rejected.stderr), /context must be a decimal integer from 0 through 1000/);
  }
  assert.match(await git(py, repository, "help", "diff"), /-U N\|-UN\|--unified=N/);
  assert.match(await git(py, repository, "help", "show"), /decimal integer from 0 through 1000/);
});

test("bounded Git rev-list counts unique reachable commits without mutating the repository", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/rev-list-count";
  py.FS.mkdirTree(repository);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/root.txt`, "root\n");
  await git(py, repository, "add", "root.txt");
  await git(py, repository, "commit", "-m", "root");
  const root = (await git(py, repository, "rev-parse", "HEAD")).trim();

  await git(py, repository, "switch", "-c", "side");
  py.FS.writeFile(`${repository}/side.txt`, "side\n");
  await git(py, repository, "add", "side.txt");
  await git(py, repository, "commit", "-m", "side");
  await git(py, repository, "switch", "main");
  py.FS.writeFile(`${repository}/main.txt`, "main\n");
  await git(py, repository, "add", "main.txt");
  await git(py, repository, "commit", "-m", "main");
  await git(py, repository, "merge", "side");

  const head = (await git(py, repository, "rev-parse", "HEAD")).trim();
  const listed = (await git(py, repository, "rev-list", "HEAD")).trim().split("\n");
  assert.ok(listed.length >= 4);
  assert.equal(new Set(listed).size, listed.length);
  const reachable = `${listed.length}\n`;
  assert.equal(await git(py, repository, "rev-list", "--count", "HEAD"), reachable);
  assert.equal(await git(py, repository, "rev-list", "HEAD", "--count"), reachable);
  assert.equal(await git(py, repository, "rev-list", "--count", root), "1\n");
  assert.equal(await git(py, repository, "rev-list", "--count", "--max-count", "3", "HEAD"), "3\n");
  assert.equal(await git(py, repository, "rev-list", "HEAD", "--max-count=2", "--count"), "2\n");
  assert.equal(
    await git(py, repository, "rev-list", "--max-count=1", "--max-count", "3", "--count", "HEAD"),
    "3\n",
  );
  assert.equal(await git(py, repository, "rev-list", "--max-count=100000", "--count", "HEAD"), reachable);
  assert.equal((await git(py, repository, "rev-list", "--max-count", "3", "HEAD")).trim().split("\n").length, 3);

  await git(py, repository, "tag", "light-count", "HEAD");
  await git(py, repository, "tag", "-a", "annotated-count", "-m", "count tag", "HEAD");
  assert.equal(await git(py, repository, "rev-list", "--count", "light-count"), reachable);
  assert.equal(await git(py, repository, "rev-list", "--count", "annotated-count"), reachable);
  await git(py, repository, "switch", "--detach", head);
  assert.equal(await git(py, repository, "rev-list", "--count", "HEAD"), reachable);

  const statusBefore = await git(py, repository, "status", "--porcelain=v1", "-z");
  const configBefore = py.FS.readFile(`${repository}/.git/config`, { encoding: "utf8" });
  const objectsBefore = JSON.stringify(py.FS.readdir(`${repository}/.git/objects`));
  const tree = (await git(py, repository, "rev-parse", "HEAD^{tree}")).trim();
  for (const args of [
    ["--count", "--count", "HEAD"],
    ["--count=1", "HEAD"],
    ["-n", "1", "HEAD"],
    ["--all", "HEAD"],
    ["--count"],
    ["--count", "HEAD", root],
    ["--count", `${root}..HEAD`],
    ["--count", "HEAD", "--", "root.txt"],
    ["--count", "--max-count", "0", "HEAD"],
    ["--count", "--max-count=-1", "HEAD"],
    ["--count", "--max-count=lots", "HEAD"],
    ["--count", "--max-count=100001", "HEAD"],
    ["--count", "missing"],
    ["--count", tree],
  ]) {
    const rejected = await runGitEngineCommand({
      py,
      cwd: repository,
      args: ["git-engine", "rev-list", ...args],
    });
    assert.equal(rejected.exitCode, 1, args.join(" "));
    assert.equal(rejected.stdout?.byteLength ?? 0, 0, args.join(" "));
    assert.ok((rejected.stderr?.byteLength ?? 0) > 0, args.join(" "));
  }
  assert.equal(await git(py, repository, "rev-parse", "HEAD"), `${head}\n`);
  assert.equal(await git(py, repository, "status", "--porcelain=v1", "-z"), statusBefore);
  assert.equal(py.FS.readFile(`${repository}/.git/config`, { encoding: "utf8" }), configBefore);
  assert.equal(JSON.stringify(py.FS.readdir(`${repository}/.git/objects`)), objectsBefore);

  const unborn = "/home/web/rev-list-count-unborn";
  py.FS.mkdirTree(unborn);
  await git(py, unborn, "init", "-b", "main");
  const rejectedUnborn = await runGitEngineCommand({
    py,
    cwd: unborn,
    args: ["git-engine", "rev-list", "--count", "HEAD"],
  });
  assert.equal(rejectedUnborn.exitCode, 1);
  assert.equal(rejectedUnborn.stdout?.byteLength ?? 0, 0);
  assert.ok((rejectedUnborn.stderr?.byteLength ?? 0) > 0);
  assert.match(await git(py, repository, "help", "rev-list"), /--count.*100000/s);
});

test("bounded Git merge-base ancestry is a strict silent predicate", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/merge-base-ancestor";
  py.FS.mkdirTree(repository);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/root.txt`, "root\n");
  await git(py, repository, "add", "root.txt");
  await git(py, repository, "commit", "-m", "root");
  const root = (await git(py, repository, "rev-parse", "HEAD")).trim();
  await git(py, repository, "tag", "root-light", root);
  await git(py, repository, "tag", "-a", "root-annotated", "-m", "root tag", root);

  await git(py, repository, "switch", "-c", "feature");
  py.FS.writeFile(`${repository}/feature-one.txt`, "feature one\n");
  await git(py, repository, "add", "feature-one.txt");
  await git(py, repository, "commit", "-m", "feature one");
  const featureOne = (await git(py, repository, "rev-parse", "HEAD")).trim();
  py.FS.writeFile(`${repository}/feature-two.txt`, "feature two\n");
  await git(py, repository, "add", "feature-two.txt");
  await git(py, repository, "commit", "-m", "feature two");
  const featureTwo = (await git(py, repository, "rev-parse", "HEAD")).trim();

  await git(py, repository, "switch", "main");
  py.FS.writeFile(`${repository}/main.txt`, "main\n");
  await git(py, repository, "add", "main.txt");
  await git(py, repository, "commit", "-m", "main");
  const mainParent = (await git(py, repository, "rev-parse", "HEAD")).trim();
  await git(py, repository, "merge", "feature");
  const merge = (await git(py, repository, "rev-parse", "HEAD")).trim();

  const disconnectedRepository = "/home/web/merge-base-disconnected";
  py.FS.mkdirTree(disconnectedRepository);
  await git(py, disconnectedRepository, "init", "-b", "main");
  py.FS.writeFile(`${disconnectedRepository}/other.txt`, "other root\n");
  await git(py, disconnectedRepository, "add", "other.txt");
  await git(py, disconnectedRepository, "commit", "-m", "other root");
  const disconnected = (await git(py, disconnectedRepository, "rev-parse", "HEAD")).trim();
  const objectDirectory = `${repository}/.git/objects/${disconnected.slice(0, 2)}`;
  py.FS.mkdirTree(objectDirectory);
  py.FS.writeFile(
    `${objectDirectory}/${disconnected.slice(2)}`,
    py.FS.readFile(
      `${disconnectedRepository}/.git/objects/${disconnected.slice(0, 2)}/${disconnected.slice(2)}`,
    ) as Uint8Array,
  );

  const fs = createIsomorphicGitFs(py);
  const featureCommit = await isomorphicGit.readCommit({ fs, dir: repository, oid: featureTwo });
  const broken = await isomorphicGit.writeCommit({
    fs,
    dir: repository,
    commit: {
      ...featureCommit.commit,
      message: "missing parent\n",
      parent: ["f".repeat(40)],
    },
  });

  py.FS.writeFile(`${repository}/root.txt`, "dirty but irrelevant\n");
  py.FS.writeFile(`${repository}/loose.txt`, "untracked and irrelevant\n");
  const snapshotTree = (path: string): string => {
    const rows: Array<[string, string]> = [];
    const visit = (current: string, relative: string): void => {
      for (const name of py.FS.readdir(current).filter((value) => value !== "." && value !== "..").sort()) {
        const child = `${current}/${name}`;
        const childRelative = relative ? `${relative}/${name}` : name;
        const stat = py.FS.lstat(child);
        if (py.FS.isDir(stat.mode)) visit(child, childRelative);
        else rows.push([childRelative, Buffer.from(py.FS.readFile(child) as Uint8Array).toString("hex")]);
      }
    };
    visit(path, "");
    return JSON.stringify(rows);
  };
  const repositoryBefore = snapshotTree(repository);

  const predicate = (...args: string[]) => runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "merge-base", "--is-ancestor", ...args],
  });
  const assertPredicate = async (expected: 0 | 1, ...args: string[]): Promise<void> => {
    const response = await predicate(...args);
    assert.equal(response.exitCode, expected, args.join(" "));
    assert.equal(response.stdout?.byteLength ?? 0, 0, args.join(" "));
    assert.equal(response.stderr?.byteLength ?? 0, 0, args.join(" "));
  };

  await assertPredicate(0, root, root);
  await assertPredicate(0, root, featureOne);
  await assertPredicate(0, root, featureTwo);
  await assertPredicate(0, "root-light", merge);
  await assertPredicate(0, "root-annotated", merge);
  await assertPredicate(0, featureOne, merge);
  await assertPredicate(0, featureTwo, merge);
  await assertPredicate(0, mainParent, merge);
  await assertPredicate(1, featureTwo, mainParent);
  await assertPredicate(1, mainParent, featureTwo);
  await assertPredicate(1, merge, root);
  await assertPredicate(1, root, disconnected);
  await assertPredicate(1, disconnected, merge);

  const fromGlobalC = await runGitEngineCommand({
    py,
    cwd: "/home/web",
    args: ["git-engine", "-C", "merge-base-ancestor", "merge-base", "--is-ancestor", root, merge],
  });
  assert.equal(fromGlobalC.exitCode, 0);
  assert.equal(fromGlobalC.stdout?.byteLength ?? 0, 0);
  assert.equal(fromGlobalC.stderr?.byteLength ?? 0, 0);

  const ordinary = await runGitEngineCommand({
    py, cwd: repository, args: ["git-engine", "merge-base", "main", "feature"],
  });
  assert.equal(ordinary.exitCode, 0);
  assert.deepEqual(ordinary.stdout, new TextEncoder().encode(`${featureTwo}\n`));

  const unknownOrdinary = await runGitEngineCommand({
    py, cwd: repository, args: ["git-engine", "merge-base", "missing-revision", "main"],
  });
  const unknownPredicate = await predicate("missing-revision", "main");
  assert.equal(unknownOrdinary.exitCode, 1);
  assert.equal(unknownPredicate.exitCode, 2);
  assert.equal(unknownPredicate.stdout?.byteLength ?? 0, 0);
  assert.deepEqual(unknownPredicate.stderr, unknownOrdinary.stderr);

  const tree = (await git(py, repository, "rev-parse", "HEAD^{tree}")).trim();
  const treeOrdinary = await runGitEngineCommand({
    py, cwd: repository, args: ["git-engine", "merge-base", tree, "main"],
  });
  const treePredicate = await predicate(tree, "main");
  assert.equal(treeOrdinary.exitCode, 1);
  assert.equal(treePredicate.exitCode, 2);
  assert.equal(treePredicate.stdout?.byteLength ?? 0, 0);
  assert.match(new TextDecoder().decode(treePredicate.stderr), /anticipated to be a commit/);

  const brokenPredicate = await predicate(root, broken);
  assert.equal(brokenPredicate.exitCode, 2);
  assert.equal(brokenPredicate.stdout?.byteLength ?? 0, 0);
  assert.ok((brokenPredicate.stderr?.byteLength ?? 0) > 0);

  const outside = "/home/web/merge-base-outside";
  py.FS.mkdirTree(outside);
  const outsideOrdinary = await runGitEngineCommand({
    py, cwd: outside, args: ["git-engine", "merge-base", root, merge],
  });
  const outsidePredicate = await runGitEngineCommand({
    py, cwd: outside, args: ["git-engine", "merge-base", "--is-ancestor", root, merge],
  });
  assert.equal(outsideOrdinary.exitCode, 1);
  assert.equal(outsidePredicate.exitCode, 2);
  assert.equal(outsidePredicate.stdout?.byteLength ?? 0, 0);
  assert.deepEqual(outsidePredicate.stderr, outsideOrdinary.stderr);

  const unborn = "/home/web/merge-base-unborn";
  py.FS.mkdirTree(unborn);
  await git(py, unborn, "init", "-b", "main");
  const unbornPredicate = await runGitEngineCommand({
    py, cwd: unborn, args: ["git-engine", "merge-base", "--is-ancestor", "HEAD", "HEAD"],
  });
  assert.equal(unbornPredicate.exitCode, 2);
  assert.equal(unbornPredicate.stdout?.byteLength ?? 0, 0);
  assert.ok((unbornPredicate.stderr?.byteLength ?? 0) > 0);

  const usage = "usage: git merge-base [--is-ancestor] <revision> <revision>\n";
  for (const args of [
    ["--is-ancestor"],
    ["--is-ancestor", root],
    ["--is-ancestor", root, merge, "extra"],
    ["--is-ancestor", "", merge],
    ["--is-ancestor", "x".repeat(4_097), merge],
    ["--is-anc", root, merge],
    [root, "--is-ancestor", merge],
    ["--", root, merge],
  ]) {
    const rejected = await runGitEngineCommand({
      py, cwd: repository, args: ["git-engine", "merge-base", ...args],
    });
    assert.equal(rejected.exitCode, 2, args.join(" "));
    assert.equal(rejected.stdout?.byteLength ?? 0, 0, args.join(" "));
    assert.deepEqual(rejected.stderr, new TextEncoder().encode(usage), args.join(" "));
  }

  const dash = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "merge-base", "--is-ancestor", "-", merge],
    stdin: new TextEncoder().encode("sentinel stdin\n"),
  });
  const dashWithoutStdin = await predicate("-", merge);
  assert.equal(dash.exitCode, 2);
  assert.equal(dash.stdout?.byteLength ?? 0, 0);
  assert.deepEqual(dash.stderr, dashWithoutStdin.stderr);

  const help = await git(py, repository, "help", "merge-base");
  assert.match(help, /usage: git merge-base \[--is-ancestor\] <revision> <revision>/);
  assert.match(help, /status: 0 ancestor, 1 not ancestor, 2 .*error/);
  assert.match(help, /100000 unique commits and 1000000 parent edges/);
  assert.equal(snapshotTree(repository), repositoryBefore);

  // wasm-git's native calls set Node's process.exitCode; finish on a successful
  // native invocation so filtered test runs report the assertion result.
  assert.equal(await git(py, repository, "rev-parse", "HEAD"), `${merge}\n`);
});

test("bounded Git cat-file existence is a strict silent predicate", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/cat-file-exists";
  py.FS.mkdirTree(repository);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/tracked.txt`, "root\n");
  await git(py, repository, "add", "tracked.txt");
  await git(py, repository, "commit", "-m", "root");
  const parent = (await git(py, repository, "rev-parse", "HEAD")).trim();
  py.FS.writeFile(`${repository}/tracked.txt`, "tip\n");
  await git(py, repository, "add", "tracked.txt");
  await git(py, repository, "commit", "-m", "tip");
  const head = (await git(py, repository, "rev-parse", "HEAD")).trim();
  const tree = (await git(py, repository, "rev-parse", "HEAD^{tree}")).trim();
  const blob = (await git(py, repository, "rev-parse", "HEAD:tracked.txt")).trim();
  await git(py, repository, "tag", "light-exists", "HEAD");
  await git(py, repository, "tag", "-a", "annotated-exists", "-m", "exists tag", "HEAD");
  const tag = (await git(py, repository, "rev-parse", "annotated-exists")).trim();
  py.FS.mkdirTree(`${repository}/.git/refs/tags`);
  py.FS.writeFile(`${repository}/.git/refs/tags/dangling-exists`, `${"0".repeat(40)}\n`);

  // Ordinary inspection modes keep their established payload behavior.
  assert.equal(await git(py, repository, "cat-file", "-t", head), "commit\n");
  assert.equal(await git(py, repository, "cat-file", "-s", blob), "4\n");
  assert.equal(await git(py, repository, "cat-file", "-p", "HEAD:tracked.txt"), "tip\n");

  py.FS.writeFile(`${repository}/tracked.txt`, "dirty but irrelevant\n");
  py.FS.writeFile(`${repository}/untracked.txt`, "untracked but irrelevant\n");
  const snapshotTree = (path: string): string => {
    const rows: Array<[string, string]> = [];
    const visit = (current: string, relative: string): void => {
      for (const name of py.FS.readdir(current).filter((value) => value !== "." && value !== "..").sort()) {
        const child = `${current}/${name}`;
        const childRelative = relative ? `${relative}/${name}` : name;
        const stat = py.FS.lstat(child);
        if (py.FS.isDir(stat.mode)) visit(child, childRelative);
        else rows.push([childRelative, Buffer.from(py.FS.readFile(child) as Uint8Array).toString("hex")]);
      }
    };
    visit(path, "");
    return JSON.stringify(rows);
  };
  const repositoryBefore = snapshotTree(repository);

  const predicate = (object: string, stdin?: Uint8Array) => runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "cat-file", "-e", object],
    ...(stdin ? { stdin } : {}),
  });
  const assertPredicate = async (expected: 0 | 1, object: string): Promise<void> => {
    const response = await predicate(object);
    assert.equal(response.exitCode, expected, object);
    assert.equal(response.stdout?.byteLength ?? 0, 0, object);
    assert.equal(response.stderr?.byteLength ?? 0, 0, object);
  };

  for (const object of [
    "HEAD",
    "HEAD^",
    "HEAD~1",
    "refs/heads/main",
    "light-exists",
    "annotated-exists",
    "annotated-exists^{}",
    "annotated-exists^{commit}",
    "HEAD^{tree}",
    "HEAD:tracked.txt",
    head,
    parent,
    tree,
    blob,
    tag,
    head.slice(0, 12),
  ]) await assertPredicate(0, object);

  for (const object of [
    "",
    "missing-exists",
    "0".repeat(40),
    "dangling-exists",
    "HEAD:missing.txt",
    "HEAD^{nonsense}",
  ]) await assertPredicate(1, object);

  const withStdin = await predicate("HEAD", new TextEncoder().encode("missing-exists\n"));
  assert.equal(withStdin.exitCode, 0);
  assert.equal(withStdin.stdout?.byteLength ?? 0, 0);
  assert.equal(withStdin.stderr?.byteLength ?? 0, 0);

  const fromGlobalC = await runGitEngineCommand({
    py,
    cwd: "/home/web",
    args: ["git-engine", "-C", "cat-file-exists", "cat-file", "-e", "HEAD^"],
  });
  assert.equal(fromGlobalC.exitCode, 0);
  assert.equal(fromGlobalC.stdout?.byteLength ?? 0, 0);
  assert.equal(fromGlobalC.stderr?.byteLength ?? 0, 0);

  for (const args of [
    ["-e"],
    ["-e", "HEAD", "extra"],
    ["-e", "-"],
    ["-e", "-e"],
    ["-e", "--help"],
    ["-ee", "HEAD"],
    ["-eHEAD"],
    ["-et", "HEAD"],
    ["-te", "HEAD"],
    ["-e", "-t", "HEAD"],
    ["-t", "-e", "HEAD"],
    ["-e", "-v", "HEAD"],
    ["-v", "-e", "HEAD"],
    ["--", "-e", "HEAD"],
    ["-e", "x".repeat(4_097)],
  ]) {
    const rejected = await runGitEngineCommand({
      py,
      cwd: repository,
      args: ["git-engine", "cat-file", ...args],
    });
    assert.equal(rejected.exitCode, 2, args.join(" "));
    assert.equal(rejected.stdout?.byteLength ?? 0, 0, args.join(" "));
    assert.equal(rejected.stderr?.byteLength ?? 0, 0, args.join(" "));
  }

  const outside = "/home/web/cat-file-outside";
  py.FS.mkdirTree(outside);
  const outsidePredicate = await runGitEngineCommand({
    py,
    cwd: outside,
    args: ["git-engine", "cat-file", "-e", head],
  });
  assert.equal(outsidePredicate.exitCode, 2);
  assert.equal(outsidePredicate.stdout?.byteLength ?? 0, 0);
  assert.equal(outsidePredicate.stderr?.byteLength ?? 0, 0);

  const unborn = "/home/web/cat-file-unborn";
  py.FS.mkdirTree(unborn);
  await git(py, unborn, "init", "-b", "main");
  const unbornPredicate = await runGitEngineCommand({
    py,
    cwd: unborn,
    args: ["git-engine", "cat-file", "-e", "HEAD"],
  });
  assert.equal(unbornPredicate.exitCode, 1);
  assert.equal(unbornPredicate.stdout?.byteLength ?? 0, 0);
  assert.equal(unbornPredicate.stderr?.byteLength ?? 0, 0);

  const corrupt = "/home/web/cat-file-corrupt";
  py.FS.mkdirTree(corrupt);
  await git(py, corrupt, "init", "-b", "main");
  py.FS.writeFile(`${corrupt}/broken.txt`, "object bytes\n");
  await git(py, corrupt, "add", "broken.txt");
  await git(py, corrupt, "commit", "-m", "corrupt fixture");
  const corruptBlob = (await git(py, corrupt, "rev-parse", "HEAD:broken.txt")).trim();
  py.FS.writeFile(
    `${corrupt}/.git/objects/${corruptBlob.slice(0, 2)}/${corruptBlob.slice(2)}`,
    new TextEncoder().encode("not a zlib object"),
  );
  const corruptPredicate = await runGitEngineCommand({
    py,
    cwd: corrupt,
    args: ["git-engine", "cat-file", "-e", corruptBlob],
  });
  assert.equal(corruptPredicate.exitCode, 2);
  assert.equal(corruptPredicate.stdout?.byteLength ?? 0, 0);
  assert.equal(corruptPredicate.stderr?.byteLength ?? 0, 0);

  const help = await git(py, repository, "help", "cat-file");
  assert.equal(await git(py, repository, "cat-file", "--help"), help);
  assert.match(help, /-t\|-s\|-e\|-p/);
  assert.match(help, /0 object exists, 1 expression does not resolve, 2 .*error; predicate is silent/);
  assert.equal(snapshotTree(repository), repositoryBefore);

  // wasm-git's native calls set Node's process.exitCode; finish on a successful
  // native invocation so filtered test runs report the assertion result.
  assert.equal(await git(py, repository, "rev-parse", "HEAD"), `${head}\n`);
});

test("bounded Git check-ignore classifies prospective paths atomically", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/check-ignore-protocol";
  py.FS.mkdirTree(`${repository}/nested`);
  py.FS.mkdirTree(`${repository}/build`);
  py.FS.mkdirTree(`${repository}/logs`);
  py.FS.mkdirTree(`${repository}/mask-scope`);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/plain.txt`, "tracked plain\n");
  py.FS.writeFile(`${repository}/forced.o`, "tracked despite ignore\n");
  py.FS.writeFile(`${repository}/tracked\nignored.o`, "tracked newline ignore-looking\n");
  await git(py, repository, "add", "plain.txt", "forced.o", "tracked\nignored.o");
  py.FS.writeFile(
    `${repository}/.gitignore`,
    "*.o\nbuild/\n!build/keep.txt\nlogs/*.log\n*.ignored-link\n",
  );
  py.FS.writeFile(`${repository}/nested/.gitignore`, "*.tmp\n!keep.tmp\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "ignore fixtures");
  py.FS.writeFile(`${repository}/.git/info/exclude`, "*.secret\n");
  py.FS.writeFile(`${repository}/future.o`, "ignored existing\n");
  py.FS.writeFile(`${repository}/line\nbreak.o`, "ignored newline path\n");
  py.FS.writeFile(`${repository}/build/out.js`, "ignored directory\n");
  py.FS.writeFile(`${repository}/build/keep.txt`, "blocked reinclude\n");
  py.FS.writeFile(`${repository}/logs/run.log`, "ignored log\n");
  py.FS.writeFile(`${repository}/nested/drop.tmp`, "nested ignored\n");
  py.FS.writeFile(`${repository}/nested/keep.tmp`, "nested reinclude\n");
  py.FS.writeFile(`${repository}/mask.rules`, "*.masked\n");
  py.FS.symlink("../mask.rules", `${repository}/mask-scope/.gitignore`);
  py.FS.writeFile("/home/web/check-ignore-outside-target", "must not be read\n");
  py.FS.symlink("/home/web/check-ignore-outside-target", `${repository}/final.ignored-link`);
  py.FS.symlink("/home/web", `${repository}/linkdir`);

  const snapshotTree = (path: string): string => {
    const rows: Array<[string, string, string?]> = [];
    const visit = (current: string, relative: string): void => {
      for (const name of py.FS.readdir(current).filter((value) => value !== "." && value !== "..").sort()) {
        const child = `${current}/${name}`;
        const childRelative = relative ? `${relative}/${name}` : name;
        const stat = py.FS.lstat(child);
        if (py.FS.isLink?.(stat.mode)) rows.push([childRelative, "link", py.FS.readlink(child)]);
        else if (py.FS.isDir(stat.mode)) visit(child, childRelative);
        else rows.push([childRelative, Buffer.from(py.FS.readFile(child) as Uint8Array).toString("hex")]);
      }
    };
    visit(path, "");
    return JSON.stringify(rows);
  };
  const repositoryBefore = snapshotTree(repository);
  const bytes = (value: string) => new TextEncoder().encode(value);
  const run = (cwd: string, args: string[], stdin?: Uint8Array) => runGitEngineCommand({
    py,
    cwd,
    args: ["git-engine", "check-ignore", ...args],
    ...(stdin ? { stdin } : {}),
  });
  const assertResponse = (
    response: Awaited<ReturnType<typeof runGitEngineCommand>>,
    exitCode: number,
    stdout = "",
    stderr = "",
  ): void => {
    assert.equal(response.exitCode, exitCode);
    assert.deepEqual(response.stdout ?? new Uint8Array(), bytes(stdout));
    assert.deepEqual(response.stderr ?? new Uint8Array(), bytes(stderr));
  };
  const usage =
    "usage: git check-ignore [-q|--quiet] [--] PATH...\n" +
    "       git check-ignore --stdin -z\n";

  assertResponse(await run(repository, ["future.o"]), 0, "future.o\n");
  assertResponse(await run(repository, ["prospective.o"]), 0, "prospective.o\n");
  assertResponse(await run(repository, ["build/out.js"]), 0, "build/out.js\n");
  assertResponse(await run(repository, ["build/keep.txt"]), 0, "build/keep.txt\n");
  assertResponse(await run(repository, ["logs/run.log"]), 0, "logs/run.log\n");
  assertResponse(await run(repository, ["nested/drop.tmp"]), 0, "nested/drop.tmp\n");
  assertResponse(await run(repository, ["nested/keep.tmp"]), 1);
  assertResponse(await run(repository, ["plain.txt"]), 1);
  assertResponse(await run(repository, ["forced.o"]), 1);
  assertResponse(await run(repository, ["future.secret"]), 0, "future.secret\n");
  assertResponse(await run(repository, ["final.ignored-link"]), 0, "final.ignored-link\n");
  assertResponse(await run(repository, ["mask-scope/file.masked"]), 1);
  assertResponse(
    await run(repository, ["plain.txt", "future.o", "logs/run.log", "future.o"]),
    0,
    "future.o\nlogs/run.log\nfuture.o\n",
  );
  assertResponse(await run(repository, ["-q", "future.o"]), 0);
  assertResponse(await run(repository, ["--quiet", "plain.txt"]), 1);
  assertResponse(await runGitEngineCommand({
    py,
    cwd: "/home/web",
    args: ["git-engine", "-C", "check-ignore-protocol", "check-ignore", "-q", "future.o"],
  }), 0);
  assertResponse(await run(
    repository,
    ["-q", "future.o"],
    bytes("plain.txt\0must be ignored in operand mode"),
  ), 0);
  assertResponse(await run(repository, ["--", "-cache.o"]), 0, "-cache.o\n");
  assertResponse(
    await run(`${repository}/nested`, ["../prospective.o"]),
    0,
    "../prospective.o\n",
  );
  assertResponse(
    await run("/home/web", ["normal.o"]),
    128,
    "",
    "git check-ignore: not a git worktree\n",
  );
  const absolute = `${repository}/absolute.o`;
  assertResponse(await run(repository, [absolute]), 0, `${absolute}\n`);

  assertResponse(
    await run(repository, ["--stdin", "-z"], bytes("future.o\0plain.txt\0logs/run.log")),
    0,
    "future.o\0logs/run.log\0",
  );
  assertResponse(
    await run(repository, ["-z", "--stdin"], bytes("plain.txt\0missing.txt\0")),
    1,
  );
  assertResponse(
    await run(
      repository,
      ["--stdin", "-z"],
      bytes("-cache.o\0tab\tname.o\0line\nbreak.o\0tracked\nignored.o\0"),
    ),
    0,
    "-cache.o\0tab\tname.o\0line\nbreak.o\0",
  );
  assertResponse(
    await run(repository, ["--stdin", "-z"], bytes("future.o\0line\nbreak.o\0plain.txt\0")),
    0,
    "future.o\0line\nbreak.o\0",
  );
  assertResponse(
    await run(`${repository}/nested`, ["--stdin", "-z"], bytes("../line\nbreak.o\0")),
    0,
    "../line\nbreak.o\0",
  );
  assertResponse(await run(repository, ["--stdin", "-z"], new Uint8Array()), 1);
  assertResponse(
    await run(repository, ["--stdin", "-z"], bytes("future.o\0\0plain.txt")),
    128,
    "",
    "git check-ignore: invalid pathname\n",
  );
  assertResponse(
    await run(repository, ["--stdin", "-z"], new Uint8Array([0xff, 0])),
    128,
    "",
    "git check-ignore: invalid pathname\n",
  );
  const maximumStdin = bytes(`${"x".repeat(3_999)}\0`.repeat(250));
  assert.equal(maximumStdin.byteLength, 1_000_000);
  assertResponse(await run(repository, ["--stdin", "-z"], maximumStdin), 1);
  assertResponse(
    await run(repository, ["--stdin", "-z"], new Uint8Array(1_000_001).fill(97)),
    128,
    "",
    "git check-ignore: input limit exceeded\n",
  );
  const maximumRecords = `${"forced.o\0".repeat(4_096)}`;
  assertResponse(await run(repository, ["--stdin", "-z"], bytes(maximumRecords)), 1);
  assertResponse(
    await run(repository, ["--stdin", "-z"], bytes(`${maximumRecords}forced.o\0`)),
    128,
    "",
    "git check-ignore: input limit exceeded\n",
  );

  for (const path of [
    "../outside.o",
    "/home/web/outside.o",
    "linkdir/child.o",
    `${"part/".repeat(129)}file.o`,
    "line\nbreak.o",
    "nul\0byte.o",
    "\ud800",
  ]) {
    assertResponse(
      await run(repository, [path]),
      128,
      "",
      "git check-ignore: invalid pathname\n",
    );
  }
  assertResponse(
    await run(repository, ["x".repeat(4_095) + ".o"]),
    128,
    "",
    "git check-ignore: input limit exceeded\n",
  );
  assertResponse(
    await run(repository, ["future.o", "../outside.o"]),
    128,
    "",
    "git check-ignore: invalid pathname\n",
  );

  const maximumOperands = Array.from({ length: 100 }, () => "forced.o");
  assertResponse(await run(repository, maximumOperands), 1);
  assertResponse(await run(repository, [...maximumOperands, "forced.o"]), 2, "", usage);

  for (const args of [
    [],
    ["--"],
    ["-q"],
    ["-q", "future.o", "plain.txt"],
    ["-q", "-q", "future.o"],
    ["--quiet", "-q", "future.o"],
    ["-qz", "future.o"],
    ["--stdin"],
    ["-z"],
    ["--stdin", "-z", "future.o"],
    ["-q", "--stdin", "-z"],
    ["-v", "future.o"],
    ["--no-index", "future.o"],
    ["-q", "--help", "future.o"],
  ]) assertResponse(await run("/home/web/check-ignore-no-repository", args), 2, "", usage);

  py.FS.mkdirTree("/home/web/check-ignore-no-repository");
  assertResponse(
    await run("/home/web/check-ignore-no-repository", ["future.o"]),
    128,
    "",
    "git check-ignore: not a git worktree\n",
  );

  const badIgnore = "/home/web/check-ignore-bad-patterns";
  py.FS.mkdirTree(badIgnore);
  await git(py, badIgnore, "init", "-b", "main");
  py.FS.writeFile(`${badIgnore}/.gitignore`, new Uint8Array([0xff, 0xfe]));
  assertResponse(
    await run(badIgnore, ["future.o"]),
    128,
    "",
    "git check-ignore: cannot inspect repository\n",
  );

  const tooManyPatterns = "/home/web/check-ignore-pattern-limit";
  py.FS.mkdirTree(tooManyPatterns);
  await git(py, tooManyPatterns, "init", "-b", "main");
  py.FS.writeFile(`${tooManyPatterns}/.gitignore`, "x\n".repeat(100_001));
  assertResponse(
    await run(tooManyPatterns, ["future.o"]),
    128,
    "",
    "git check-ignore: input limit exceeded\n",
  );

  const largeIgnore = "/home/web/check-ignore-file-limit";
  py.FS.mkdirTree(largeIgnore);
  await git(py, largeIgnore, "init", "-b", "main");
  py.FS.writeFile(`${largeIgnore}/.gitignore`, new Uint8Array(1024 * 1024 + 1).fill(120));
  assertResponse(
    await run(largeIgnore, ["future.o"]),
    128,
    "",
    "git check-ignore: input limit exceeded\n",
  );

  const manyIgnoreFiles = "/home/web/check-ignore-file-count";
  py.FS.mkdirTree(manyIgnoreFiles);
  await git(py, manyIgnoreFiles, "init", "-b", "main");
  py.FS.writeFile(`${manyIgnoreFiles}/.gitignore`, "root-never-match\n");
  let nestedPath = manyIgnoreFiles;
  const nestedParts: string[] = [];
  for (let index = 0; index < 127; index++) {
    const part = `d${index}`;
    nestedParts.push(part);
    nestedPath += `/${part}`;
    py.FS.mkdirTree(nestedPath);
    py.FS.writeFile(`${nestedPath}/.gitignore`, "never-match-this-name\n");
  }
  assertResponse(
    await run(manyIgnoreFiles, [`${nestedParts.join("/")}/future.txt`]),
    128,
    "",
    "git check-ignore: input limit exceeded\n",
  );

  const aggregateIgnore = "/home/web/check-ignore-aggregate-limit";
  py.FS.mkdirTree(aggregateIgnore);
  await git(py, aggregateIgnore, "init", "-b", "main");
  nestedPath = aggregateIgnore;
  const aggregateParts: string[] = [];
  const oneMiBPattern = "x".repeat(1024 * 1024);
  for (let index = 0; index < 9; index++) {
    const part = `d${index}`;
    aggregateParts.push(part);
    nestedPath += `/${part}`;
    py.FS.mkdirTree(nestedPath);
    py.FS.writeFile(`${nestedPath}/.gitignore`, oneMiBPattern);
  }
  assertResponse(
    await run(aggregateIgnore, [`${aggregateParts.join("/")}/future.txt`]),
    128,
    "",
    "git check-ignore: input limit exceeded\n",
  );

  const corruptIndex = "/home/web/check-ignore-corrupt-index";
  py.FS.mkdirTree(corruptIndex);
  await git(py, corruptIndex, "init", "-b", "main");
  py.FS.writeFile(`${corruptIndex}/tracked.txt`, "tracked\n");
  await git(py, corruptIndex, "add", "tracked.txt");
  py.FS.writeFile(`${corruptIndex}/.git/index`, "not an index");
  assertResponse(
    await run(corruptIndex, ["future.o"]),
    128,
    "",
    "git check-ignore: cannot inspect repository\n",
  );

  const help = await git(py, repository, "help", "check-ignore");
  assert.match(help, /check-ignore \[-q\|--quiet\].*PATH/s);
  assert.match(help, /--stdin -z reads literal cwd-relative NUL records/);
  assert.match(help, /tabs, newlines, and leading dashes are preserved/);
  assert.match(help, /output are staged before publication/);
  assert.match(help, /0 any path ignored, 1 none ignored, 2 usage, 128/s);
  assert.equal(await git(py, repository, "check-ignore", "--help"), help);
  assertResponse(await run(repository, ["--", "--help"]), 1);
  assert.equal(snapshotTree(repository), repositoryBefore);

  // Finish on a successful native call so wasm-git's process.exitCode does
  // not mask the assertion result in a filtered Node test run.
  assert.match(await git(py, repository, "rev-parse", "HEAD"), /^[0-9a-f]{40}\n$/);
});

test("bounded Git show-ref inventories and verifies logical refs atomically", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/show-ref-protocol";
  py.FS.mkdirTree(repository);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/value.txt`, "first\n");
  await git(py, repository, "add", "value.txt");
  await git(py, repository, "commit", "-m", "first");
  const parent = (await git(py, repository, "rev-parse", "HEAD")).trim();
  py.FS.writeFile(`${repository}/value.txt`, "second\n");
  await git(py, repository, "add", "value.txt");
  await git(py, repository, "commit", "-m", "second");
  const head = (await git(py, repository, "rev-parse", "HEAD")).trim();

  py.FS.mkdirTree(`${repository}/.git/refs/remotes/origin`);
  py.FS.mkdirTree(`${repository}/.git/refs/custom`);
  py.FS.mkdirTree(`${repository}/.git/refs/tags`);
  py.FS.writeFile(`${repository}/.git/refs/remotes/origin/main`, `${head}\n`);
  py.FS.writeFile(
    `${repository}/.git/refs/remotes/origin/HEAD`,
    "ref: refs/remotes/origin/main\n",
  );
  py.FS.writeFile(`${repository}/.git/refs/custom/dangling`, "ref: refs/heads/missing\n");
  py.FS.writeFile(`${repository}/.git/refs/tags/upper`, `${head.toUpperCase()}\n`);
  py.FS.writeFile(`${repository}/.git/refs/tags/missing-object`, `${"f".repeat(40)}\n`);
  py.FS.writeFile(
    `${repository}/.git/packed-refs`,
    "# pack-refs with: peeled fully-peeled sorted\n" +
      `${parent} refs/heads/main\n` +
      `${parent} refs/tags/packed\n` +
      `^${head}\n`,
  );

  const bytes = (value: string) => new TextEncoder().encode(value);
  const run = (cwd: string, args: string[]) => runGitEngineCommand({
    py,
    cwd,
    args: ["git-engine", "show-ref", ...args],
  });
  const assertResponse = (
    response: Awaited<ReturnType<typeof runGitEngineCommand>>,
    exitCode: number,
    stdout = "",
    stderr = "",
  ): void => {
    assert.equal(response.exitCode, exitCode);
    assert.deepEqual(response.stdout ?? new Uint8Array(), bytes(stdout));
    assert.deepEqual(response.stderr ?? new Uint8Array(), bytes(stderr));
  };
  const snapshotTree = (path: string): string => {
    const rows: Array<[string, string, string?]> = [];
    const visit = (current: string, relative: string): void => {
      for (const name of py.FS.readdir(current).filter((value) => value !== "." && value !== "..").sort()) {
        const child = `${current}/${name}`;
        const childRelative = relative ? `${relative}/${name}` : name;
        const stat = py.FS.lstat(child);
        if (py.FS.isLink?.(stat.mode)) rows.push([childRelative, "link", py.FS.readlink(child)]);
        else if (py.FS.isDir(stat.mode)) visit(child, childRelative);
        else rows.push([childRelative, Buffer.from(py.FS.readFile(child) as Uint8Array).toString("hex")]);
      }
    };
    visit(path, "");
    return JSON.stringify(rows);
  };
  const expected =
    `${head} refs/heads/main\n` +
    `${head} refs/remotes/origin/HEAD\n` +
    `${head} refs/remotes/origin/main\n` +
    `${"f".repeat(40)} refs/tags/missing-object\n` +
    `${parent} refs/tags/packed\n` +
    `${head} refs/tags/upper\n`;
  const repositoryBefore = snapshotTree(repository);

  assertResponse(await run(repository, []), 0, expected);
  assertResponse(await run(`${repository}/.git/objects`, []), 0, expected);
  assertResponse(await run(repository, ["--head"]), 0, `${head} HEAD\n${expected}`);
  assertResponse(
    await run(repository, ["--verify", "refs/remotes/origin/HEAD"]),
    0,
    `${head} refs/remotes/origin/HEAD\n`,
  );
  assertResponse(
    await run(repository, ["--verify", "--", "refs/tags/missing-object"]),
    0,
    `${"f".repeat(40)} refs/tags/missing-object\n`,
  );
  assertResponse(await run(repository, ["--quiet", "--verify", "refs/tags/packed"]), 0);
  assertResponse(
    await run(repository, ["--verify", "refs/heads/missing"]),
    1,
    "",
    "git show-ref: ref not found\n",
  );
  assertResponse(await run(repository, ["--verify", "--quiet", "refs/heads/missing"]), 1);
  assertResponse(
    await runGitEngineCommand({
      py,
      cwd: "/home/web",
      args: ["git-engine", "-C", "show-ref-protocol", "show-ref", "--verify", "refs/heads/main"],
    }),
    0,
    `${head} refs/heads/main\n`,
  );

  const help = "usage: git show-ref [--head] | git show-ref --verify [--quiet] [--] REF\n";
  assertResponse(await run(repository, ["--help"]), 0, help);
  assert.equal(await git(py, repository, "help", "show-ref"), help);
  for (const args of [
    ["--"],
    ["--quiet"],
    ["--head", "--verify", "refs/heads/main"],
    ["--verify"],
    ["--verify", "refs/heads/main", "--"],
    ["--verify", "refs/heads/main", "refs/tags/packed"],
    ["--verify", "--verify", "refs/heads/main"],
    ["--head", "--head"],
    ["--dereference"],
    ["-d"],
    ["refs/heads/main"],
  ]) assertResponse(await run("/home/web/show-ref-no-repository", args), 2, "", help);
  for (const ref of ["main", "refs/heads/.bad", "refs/heads/a..b", `refs/${"x".repeat(1_020)}`, "\ud800"]) {
    assertResponse(
      await run("/home/web/show-ref-no-repository", ["--verify", ref]),
      2,
      "",
      "git show-ref: invalid ref\n",
    );
  }
  py.FS.mkdirTree("/home/web/show-ref-no-repository");
  assertResponse(
    await run("/home/web/show-ref-no-repository", []),
    128,
    "",
    "git: not a Git repository: /home/web/show-ref-no-repository\n",
  );

  py.FS.writeFile(`${repository}/.git/HEAD`, `${head.toUpperCase()}\n`);
  assertResponse(await run(repository, ["--head"]), 0, `${head} HEAD\n${expected}`);
  py.FS.writeFile(`${repository}/.git/HEAD`, "ref: refs/heads/main\n");
  assert.equal(snapshotTree(repository), repositoryBefore);

  const empty = "/home/web/show-ref-empty";
  py.FS.mkdirTree(empty);
  await git(py, empty, "init", "-b", "main");
  assertResponse(await run(empty, []), 1);
  assertResponse(await run(empty, ["--head"]), 1);

  const bare = "/home/web/show-ref-bare";
  py.FS.mkdirTree(`${bare}/objects`);
  py.FS.mkdirTree(`${bare}/refs/heads`);
  py.FS.writeFile(`${bare}/config`, "[core]\n\tbare = true\n");
  py.FS.writeFile(`${bare}/HEAD`, `${head}\n`);
  py.FS.writeFile(`${bare}/refs/heads/main`, `${parent}\n`);
  assertResponse(
    await run(`${bare}/objects`, ["--head"]),
    0,
    `${head} HEAD\n${parent} refs/heads/main\n`,
  );

  const chains = "/home/web/show-ref-chains";
  py.FS.mkdirTree(chains);
  await git(py, chains, "init", "-b", "main");
  py.FS.mkdirTree(`${chains}/.git/refs/chains`);
  py.FS.writeFile(`${chains}/.git/refs/chains/terminal`, `${head}\n`);
  for (let index = 31; index >= 0; index--) {
    const target = index === 31 ? "terminal" : String(index + 1).padStart(2, "0");
    py.FS.writeFile(
      `${chains}/.git/refs/chains/${String(index).padStart(2, "0")}`,
      `ref: refs/chains/${target}\n`,
    );
  }
  assertResponse(
    await run(chains, ["--verify", "refs/chains/00"]),
    0,
    `${head} refs/chains/00\n`,
  );
  py.FS.writeFile(`${chains}/.git/refs/chains/over`, "ref: refs/chains/00\n");
  assertResponse(
    await run(chains, ["--verify", "refs/chains/00"]),
    128,
    "",
    "git show-ref: repository inspection failed\n",
  );

  const loop = "/home/web/show-ref-loop";
  py.FS.mkdirTree(loop);
  await git(py, loop, "init", "-b", "main");
  py.FS.mkdirTree(`${loop}/.git/refs/loop`);
  py.FS.writeFile(`${loop}/.git/refs/loop/a`, "ref: refs/loop/b\n");
  py.FS.writeFile(`${loop}/.git/refs/loop/b`, "ref: refs/loop/a\n");
  assertResponse(
    await run(loop, []),
    128,
    "",
    "git show-ref: repository inspection failed\n",
  );

  const corruptPacked = "/home/web/show-ref-corrupt-packed";
  py.FS.mkdirTree(corruptPacked);
  await git(py, corruptPacked, "init", "-b", "main");
  py.FS.writeFile(
    `${corruptPacked}/.git/packed-refs`,
    `${head} refs/tags/duplicate\n${parent} refs/tags/duplicate\n`,
  );
  assertResponse(
    await run(corruptPacked, []),
    128,
    "",
    "git show-ref: repository inspection failed\n",
  );

  const looseLimit = "/home/web/show-ref-loose-limit";
  py.FS.mkdirTree(looseLimit);
  await git(py, looseLimit, "init", "-b", "main");
  py.FS.mkdirTree(`${looseLimit}/.git/refs/heads`);
  py.FS.writeFile(`${looseLimit}/.git/refs/heads/large`, "x".repeat(4_097));
  assertResponse(
    await run(looseLimit, []),
    2,
    "",
    "git show-ref: limit exceeded\n",
  );

  const packedLimit = "/home/web/show-ref-packed-limit";
  py.FS.mkdirTree(packedLimit);
  await git(py, packedLimit, "init", "-b", "main");
  py.FS.writeFile(`${packedLimit}/.git/packed-refs`, new Uint8Array(1_000_001).fill(120));
  assertResponse(
    await run(packedLimit, []),
    2,
    "",
    "git show-ref: limit exceeded\n",
  );

  const refLimit = "/home/web/show-ref-count-limit";
  py.FS.mkdirTree(refLimit);
  await git(py, refLimit, "init", "-b", "main");
  const packedRows = Array.from(
    { length: 4_097 },
    (_, index) => `${head} refs/tags/r${String(index).padStart(4, "0")}\n`,
  ).join("");
  assert.ok(bytes(packedRows).byteLength < 1_000_000);
  py.FS.writeFile(`${refLimit}/.git/packed-refs`, packedRows);
  assertResponse(
    await run(refLimit, []),
    2,
    "",
    "git show-ref: limit exceeded\n",
  );

  // Finish on a successful native call so wasm-git's process.exitCode does
  // not mask the assertion result in a filtered Node test run.
  assert.equal(await git(py, repository, "rev-parse", "HEAD"), `${head}\n`);
});

test("bounded Git ls-tree exposes canonical trees with raw paths and atomic limits", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/ls-tree-protocol";
  py.FS.mkdirTree(`${repository}/dir`);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/a.txt`, "alpha\n");
  py.FS.writeFile(`${repository}/dir/b.txt`, "beta\n");
  py.FS.writeFile(`${repository}/space name.txt`, "space\n");
  py.FS.symlink("a.txt", `${repository}/link`);
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "tree fixture");
  const head = (await git(py, repository, "rev-parse", "HEAD")).trim();
  const tree = (await git(py, repository, "rev-parse", "HEAD^{tree}")).trim();
  const a = (await git(py, repository, "rev-parse", "HEAD:a.txt")).trim();
  const dir = (await git(py, repository, "rev-parse", "HEAD:dir")).trim();
  const b = (await git(py, repository, "rev-parse", "HEAD:dir/b.txt")).trim();
  const link = (await git(py, repository, "rev-parse", "HEAD:link")).trim();
  const space = (await git(py, repository, "rev-parse", "HEAD:space name.txt")).trim();

  const bytes = (value: string) => new TextEncoder().encode(value);
  const run = (cwd: string, args: string[], stdin?: Uint8Array) => runGitEngineCommand({
    py,
    cwd,
    args: ["git-engine", "ls-tree", ...args],
    ...(stdin ? { stdin } : {}),
  });
  const assertResponse = (
    response: Awaited<ReturnType<typeof runGitEngineCommand>>,
    exitCode: number,
    stdout: string | Uint8Array = "",
    stderr = "",
  ): void => {
    assert.equal(response.exitCode, exitCode);
    assert.deepEqual(
      response.stdout ?? new Uint8Array(),
      typeof stdout === "string" ? bytes(stdout) : stdout,
    );
    assert.deepEqual(response.stderr ?? new Uint8Array(), bytes(stderr));
  };
  const concat = (...parts: Uint8Array[]): Uint8Array => {
    const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  };
  const hexBytes = (hex: string): Uint8Array => new Uint8Array(
    Array.from({ length: hex.length / 2 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)),
  );
  const rawEntry = (mode: string, name: Uint8Array, oid: string): Uint8Array =>
    concat(bytes(`${mode} `), name, new Uint8Array([0]), hexBytes(oid));
  const objectFs = createIsomorphicGitFs(py);
  const writeTree = (entries: Uint8Array[]) => isomorphicGit.writeObject({
    fs: objectFs,
    dir: repository,
    type: "tree",
    format: "content",
    object: concat(...entries),
  });
  const blob = await isomorphicGit.writeObject({
    fs: objectFs,
    dir: repository,
    type: "blob",
    format: "content",
    object: bytes("raw leaf\n"),
  });

  const immediate =
    `100644 blob ${a}\ta.txt\n` +
    `040000 tree ${dir}\tdir\n` +
    `120000 blob ${link}\tlink\n` +
    `100644 blob ${space}\tspace name.txt\n`;
  const recursive =
    `100644 blob ${a}\ta.txt\n` +
    `100644 blob ${b}\tdir/b.txt\n` +
    `120000 blob ${link}\tlink\n` +
    `100644 blob ${space}\tspace name.txt\n`;
  const recursiveTrees =
    `100644 blob ${a}\ta.txt\n` +
    `040000 tree ${dir}\tdir\n` +
    `100644 blob ${b}\tdir/b.txt\n` +
    `120000 blob ${link}\tlink\n` +
    `100644 blob ${space}\tspace name.txt\n`;

  assertResponse(await run(repository, ["HEAD"]), 0, immediate);
  assertResponse(await run(repository, [tree]), 0, immediate);
  assertResponse(await run(repository, ["-t", "HEAD"]), 0, immediate);
  assertResponse(await run(repository, ["-r", "HEAD"]), 0, recursive);
  assertResponse(await run(repository, ["-r", "-t", "HEAD"]), 0, recursiveTrees);
  assertResponse(
    await run(repository, ["-r", "--name-only", "HEAD"]),
    0,
    "a.txt\ndir/b.txt\nlink\nspace name.txt\n",
  );
  assertResponse(
    await run(repository, ["-r", "--name-only", "-z", "HEAD"]),
    0,
    bytes("a.txt\0dir/b.txt\0link\0space name.txt\0"),
  );
  assertResponse(
    await run(`${repository}/dir`, ["-r", "HEAD"]),
    0,
    recursive,
  );
  assertResponse(await run(repository, ["--max-count=1", "HEAD"]), 0, immediate.split("\n")[0] + "\n");
  assertResponse(
    await runGitEngineCommand({
      py,
      cwd: "/home/web",
      args: ["git-engine", "-C", "ls-tree-protocol", "ls-tree", "--name-only", "HEAD"],
    }),
    0,
    "a.txt\ndir\nlink\nspace name.txt\n",
  );

  const looseOutput = (await run(repository, ["-r", "-z", "HEAD"])).stdout;
  await git(py, repository, "gc");
  assert.deepEqual((await run(repository, ["-r", "-z", "HEAD"])).stdout, looseOutput);

  const emptyTree = await writeTree([]);
  assertResponse(await run(repository, [emptyTree]), 0);

  const specialEntries: Array<{ mode: string; type: string; name: Uint8Array; text: string; oid: string }> = [
    { mode: "100644", type: "blob", name: bytes("space name"), text: "space name", oid: blob },
    { mode: "100644", type: "blob", name: bytes("tab\tname"), text: '"tab\\tname"', oid: blob },
    { mode: "100644", type: "blob", name: bytes("line\nname"), text: '"line\\nname"', oid: blob },
    { mode: "100644", type: "blob", name: new Uint8Array([0xc3, 0xa9]), text: '"\\303\\251"', oid: blob },
    { mode: "100644", type: "blob", name: new Uint8Array([0xff]), text: '"\\377"', oid: blob },
    { mode: "100644", type: "blob", name: bytes('quote"name'), text: '"quote\\"name"', oid: blob },
    { mode: "120000", type: "blob", name: bytes("back\\name"), text: '"back\\\\name"', oid: blob },
    { mode: "160000", type: "commit", name: bytes("gitlink"), text: "gitlink", oid: head },
  ];
  const specialTree = await writeTree(specialEntries.map((entry) => rawEntry(entry.mode, entry.name, entry.oid)));
  const specialText = specialEntries.map((entry) =>
    `${entry.mode} ${entry.type} ${entry.oid}\t${entry.text}\n`
  ).join("");
  assertResponse(await run(repository, [specialTree]), 0, specialText);
  const specialRaw = concat(...specialEntries.flatMap((entry) => [
    bytes(`${entry.mode} ${entry.type} ${entry.oid}\t`), entry.name, new Uint8Array([0]),
  ]));
  assertResponse(await run(repository, ["-z", specialTree]), 0, specialRaw);
  assertResponse(
    await run(repository, ["--name-only", "-z", specialTree]),
    0,
    concat(...specialEntries.flatMap((entry) => [entry.name, new Uint8Array([0])])),
  );

  const missingTreeOid = "f".repeat(40);
  const prefixTree = await writeTree([
    rawEntry("100644", bytes("a"), blob),
    rawEntry("40000", bytes("z"), missingTreeOid),
  ]);
  assertResponse(
    await run(repository, ["-r", "--max-count=1", prefixTree]),
    0,
    `100644 blob ${blob}\ta\n`,
  );
  assertResponse(
    await run(repository, ["-r", prefixTree]),
    2,
    "",
    "git ls-tree: invalid tree object\n",
  );
  assertResponse(
    await run(repository, [prefixTree]),
    0,
    `100644 blob ${blob}\ta\n040000 tree ${missingTreeOid}\tz\n`,
  );

  const duplicateTree = await writeTree([
    rawEntry("100644", bytes("same"), blob),
    rawEntry("100755", bytes("same"), blob),
  ]);
  assertResponse(
    await run(repository, [duplicateTree]),
    2,
    "",
    "git ls-tree: invalid tree object\n",
  );
  const malformedTree = await writeTree([bytes("100644 truncated\0")]);
  assertResponse(
    await run(repository, [malformedTree]),
    2,
    "",
    "git ls-tree: invalid tree object\n",
  );

  let depthTree = await writeTree([rawEntry("100644", bytes("leaf"), blob)]);
  for (let index = 0; index < 127; index++) {
    depthTree = await writeTree([rawEntry("40000", bytes("d"), depthTree)]);
  }
  assertResponse(await run(repository, ["-r", "--name-only", depthTree]), 0, `${"d/".repeat(127)}leaf\n`);
  const tooDeepTree = await writeTree([rawEntry("40000", bytes("d"), depthTree)]);
  assertResponse(
    await run(repository, ["-r", tooDeepTree]),
    2,
    "",
    "git ls-tree: traversal limit exceeded\n",
  );

  const writeFixedNameTree = async (count: number): Promise<string> => {
    const prefix = bytes("100644 ");
    const rowLength = prefix.byteLength + 7 + 1 + 20;
    const raw = new Uint8Array(count * rowLength);
    const oid = hexBytes(blob);
    let offset = 0;
    for (let index = 0; index < count; index++) {
      raw.set(prefix, offset);
      offset += prefix.byteLength;
      raw.set(bytes(`r${String(index).padStart(6, "0")}`), offset);
      offset += 7;
      raw[offset++] = 0;
      raw.set(oid, offset);
      offset += 20;
    }
    return isomorphicGit.writeObject({
      fs: objectFs,
      dir: repository,
      type: "tree",
      format: "content",
      object: raw,
    });
  };
  const maximumEntriesTree = await writeFixedNameTree(100_000);
  const maximumEntries = await run(repository, ["--name-only", "-z", maximumEntriesTree]);
  assert.equal(maximumEntries.exitCode, 0);
  assert.equal(maximumEntries.stdout?.byteLength, 800_000);
  assert.equal(maximumEntries.stderr?.byteLength ?? 0, 0);
  const tooManyEntriesTree = await writeFixedNameTree(100_001);
  assertResponse(
    await run(repository, ["--name-only", "-z", tooManyEntriesTree]),
    2,
    "",
    "git ls-tree: traversal limit exceeded\n",
  );
  assertResponse(
    await run(repository, ["--name-only", "-z", "--max-count=1", tooManyEntriesTree]),
    0,
    bytes("r000000\0"),
  );

  const exactOutputTree = await writeTree(Array.from({ length: 1_000 }, (_, index) =>
    rawEntry("100644", bytes(`${"x".repeat(995)}${String(index).padStart(4, "0")}`), blob)
  ));
  const exactOutput = await run(repository, ["--name-only", "-z", exactOutputTree]);
  assert.equal(exactOutput.exitCode, 0);
  assert.equal(exactOutput.stdout?.byteLength, 1_000_000);
  assert.equal(exactOutput.stderr?.byteLength ?? 0, 0);
  const excessiveOutputEntries = Array.from({ length: 1_000 }, (_, index) => rawEntry(
    "100644",
    bytes(`${"x".repeat(index === 999 ? 996 : 995)}${String(index).padStart(4, "0")}`),
    blob,
  ));
  const excessiveOutputTree = await writeTree(excessiveOutputEntries);
  assertResponse(
    await run(repository, ["--name-only", "-z", excessiveOutputTree]),
    2,
    "",
    "git ls-tree: output limit exceeded\n",
  );

  const writeTag = (
    target: string,
    targetType: "tree" | "tag",
    size: number,
  ): Promise<string> => {
    const header = bytes(
      `object ${target}\ntype ${targetType}\ntag bounded\n` +
      "tagger Piodide <piodide@localhost> 0 +0000\n\n",
    );
    assert.ok(header.byteLength <= size);
    return isomorphicGit.writeObject({
      fs: objectFs,
      dir: repository,
      type: "tag",
      format: "content",
      object: concat(header, new Uint8Array(size - header.byteLength).fill(120)),
    });
  };
  const oneMiBTag = await writeTag(tree, "tree", 1_000_000);
  assertResponse(await run(repository, [oneMiBTag]), 0, immediate);
  const oversizedTag = await writeTag(tree, "tree", 1_000_001);
  assertResponse(
    await run(repository, [oversizedTag]),
    2,
    "",
    "git ls-tree: traversal limit exceeded\n",
  );
  let fourMiBTagChain = oneMiBTag;
  for (let index = 0; index < 3; index++) {
    fourMiBTagChain = await writeTag(fourMiBTagChain, "tag", 1_000_000);
  }
  assertResponse(await run(repository, [fourMiBTagChain]), 0, immediate);
  const excessiveTagChain = await writeTag(fourMiBTagChain, "tag", 128);
  assertResponse(
    await run(repository, [excessiveTagChain]),
    2,
    "",
    "git ls-tree: traversal limit exceeded\n",
  );

  py.FS.writeFile(`${repository}/a.txt`, "dirty worktree must be ignored\n");
  py.FS.writeFile(`${repository}/untracked.txt`, "untracked must be ignored\n");
  const snapshotTree = (path: string): string => {
    const rows: Array<[string, number, number, string?]> = [];
    const visit = (current: string, relative: string): void => {
      for (const name of py.FS.readdir(current).filter((value) => value !== "." && value !== "..").sort()) {
        const child = `${current}/${name}`;
        const childRelative = relative ? `${relative}/${name}` : name;
        const stat = py.FS.lstat(child);
        if (py.FS.isDir(stat.mode)) visit(child, childRelative);
        else rows.push([
          childRelative,
          stat.mode,
          Number(stat.mtime),
          py.FS.isLink?.(stat.mode)
            ? py.FS.readlink(child)
            : Buffer.from(py.FS.readFile(child) as Uint8Array).toString("hex"),
        ]);
      }
    };
    visit(path, "");
    return JSON.stringify(rows);
  };
  const repositoryBefore = snapshotTree(repository);

  const help = "usage: git ls-tree [-r] [-t] [-z] [--name-only] [--max-count=N] [--] <tree-ish>\n";
  assertResponse(await run(repository, ["--help"]), 0, help);
  assert.equal(await git(py, repository, "help", "ls-tree"), help);
  for (const args of [
    [],
    ["HEAD", "extra"],
    ["HEAD", "--name-only"],
    ["-rz", "HEAD"],
    ["-d", "HEAD"],
    ["--long", "HEAD"],
    ["--max-count", "1", "HEAD"],
    ["--max-count=", "HEAD"],
    ["--max-count=0", "HEAD"],
    ["--max-count=100001", "HEAD"],
    ["--max-count=+1", "HEAD"],
    ["--max-count=1", "--max-count=2", "HEAD"],
    ["HEAD", "--"],
  ]) assertResponse(await run("/home/web/ls-tree-no-repository", args), 2, "", help);
  assertResponse(
    await run(repository, ["missing-treeish"]),
    2,
    "",
    "git ls-tree: invalid tree-ish\n",
  );
  assertResponse(
    await run(repository, [blob]),
    2,
    "",
    "git ls-tree: invalid tree-ish\n",
  );
  assertResponse(
    await run(repository, ["--", "--help"]),
    2,
    "",
    "git ls-tree: invalid tree-ish\n",
  );
  py.FS.mkdirTree("/home/web/ls-tree-no-repository");
  assertResponse(
    await run("/home/web/ls-tree-no-repository", ["HEAD"]),
    2,
    "",
    "git: not a Git repository: /home/web/ls-tree-no-repository\n",
  );
  const withStdin = await run(repository, ["-r", "HEAD"], bytes("different-treeish\n"));
  assertResponse(withStdin, 0, recursive);
  assert.equal(snapshotTree(repository), repositoryBefore);

  // Finish on a successful native call so wasm-git's process.exitCode does
  // not mask the assertion result in a filtered Node test run.
  assert.equal(await git(py, repository, "rev-parse", "HEAD"), `${head}\n`);
});

test("bounded Git grep searches tracked worktree and historical bytes atomically", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/git-grep-protocol";
  py.FS.mkdirTree(`${repository}/src`);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/-dash.txt`, "-leading\n");
  py.FS.writeFile(`${repository}/--help`, "help path\n");
  py.FS.writeFile(`${repository}/a.txt`, "old needle\nold only\n");
  py.FS.writeFile(`${repository}/binary.bin`, new Uint8Array([
    ...new TextEncoder().encode("old "), 0, ...new TextEncoder().encode("needle\n"),
  ]));
  py.FS.writeFile(`${repository}/invalid.bin`, new Uint8Array([
    0xff, ...new TextEncoder().encode(" needle\n"),
  ]));
  py.FS.writeFile(`${repository}/line\nbreak.txt`, "needle newline path\n");
  py.FS.writeFile(`${repository}/src/code.ts`, "foofoo\nbar\nregex123\n");
  py.FS.writeFile(`${repository}/src/space name.txt`, "old needle space\n");
  py.FS.writeFile(`${repository}/target.txt`, "needle target\n");
  py.FS.symlink("target.txt", `${repository}/tracked-link`);
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "grep fixture");
  const historical = (await git(py, repository, "rev-parse", "HEAD")).trim();

  py.FS.writeFile(`${repository}/a.txt`, "zero\nneedle current\nneedle twice needle\n");
  py.FS.writeFile(`${repository}/binary.bin`, new Uint8Array([
    ...new TextEncoder().encode("current "), 0, ...new TextEncoder().encode("needle\n"),
  ]));
  py.FS.writeFile(`${repository}/src/space name.txt`, "needle space\n");
  py.FS.unlink(`${repository}/target.txt`);
  py.FS.writeFile(`${repository}/untracked.txt`, "needle untracked\n");

  const bytes = (value: string) => new TextEncoder().encode(value);
  const concat = (...parts: Uint8Array[]): Uint8Array => {
    const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
    return output;
  };
  const run = (cwd: string, args: string[], stdin?: Uint8Array) => runGitEngineCommand({
    py,
    cwd,
    args: ["git-engine", "grep", ...args],
    ...(stdin ? { stdin } : {}),
  });
  const assertResponse = (
    response: Awaited<ReturnType<typeof runGitEngineCommand>>,
    exitCode: number,
    stdout: string | Uint8Array = "",
    stderr = "",
  ): void => {
    assert.equal(response.exitCode, exitCode);
    assert.deepEqual(
      response.stdout ?? new Uint8Array(),
      typeof stdout === "string" ? bytes(stdout) : stdout,
    );
    assert.deepEqual(response.stderr ?? new Uint8Array(), bytes(stderr));
  };

  assertResponse(
    await run(repository, ["-F", "needle"]),
    0,
    concat(
      bytes("a.txt:needle current\na.txt:needle twice needle\nBinary file binary.bin matches\ninvalid.bin:"),
      new Uint8Array([0xff]),
      bytes(" needle\nline\nbreak.txt:needle newline path\nsrc/space name.txt:needle space\n"),
    ),
  );
  assertResponse(
    await run(repository, ["-n", "-F", "needle", historical]),
    0,
    concat(
      bytes(`${historical}:a.txt:1:old needle\nBinary file ${historical}:binary.bin matches\n`),
      bytes(`${historical}:invalid.bin:1:`), new Uint8Array([0xff]), bytes(" needle\n"),
      bytes(`${historical}:line\nbreak.txt:1:needle newline path\n`),
      bytes(`${historical}:src/space name.txt:1:old needle space\n`),
      bytes(`${historical}:target.txt:1:needle target\n`),
    ),
  );
  assertResponse(
    await run(repository, ["-z", "-n", "-F", "needle", "--", "line\nbreak.txt"]),
    0,
    concat(bytes("line\nbreak.txt"), new Uint8Array([0]), bytes("1\0needle newline path\0")),
  );
  assertResponse(
    await run(repository, ["-z", "-l", "-F", "needle", historical, "--", "binary.bin", "line\nbreak.txt"]),
    0,
    bytes(`${historical}:binary.bin\0${historical}:line\nbreak.txt\0`),
  );
  assertResponse(await run(repository, ["-q", "-F", "needle"]), 0);
  assertResponse(await run(repository, ["-q", "-F", "absent"]), 1);

  assertResponse(
    await run(repository, ["-n", "-E", "^(foo|bar)+$", "--", "src/*.ts"]),
    0,
    "src/code.ts:1:foofoo\nsrc/code.ts:2:bar\n",
  );
  assertResponse(
    await run(repository, ["-n", "^\\(foo\\|bar\\)\\+$", "--", "src"]),
    0,
    "src/code.ts:1:foofoo\nsrc/code.ts:2:bar\n",
  );
  assertResponse(await run(repository, ["-i", "-F", "NEEDLE", "--", "a.txt"]), 0,
    "a.txt:needle current\na.txt:needle twice needle\n");
  assertResponse(await run(repository, ["-F", "-e", "-leading", "--", "-dash.txt"]), 0,
    "-dash.txt:-leading\n");
  assertResponse(await run(repository, ["-F", "help", "--", "--help"]), 0,
    "--help:help path\n");
  assertResponse(await run(repository, ["-F", "[", "--", "a.txt"]), 1);
  assertResponse(await run(repository, ["-E", "(", "--", "a.txt"]), 2, "",
    "git grep: unterminated regular expression group\n");

  assertResponse(
    await run(`${repository}/src`, ["-n", "-E", "^(foo|bar)+$"]),
    0,
    "code.ts:1:foofoo\ncode.ts:2:bar\n",
  );
  assertResponse(
    await run(`${repository}/src`, ["-F", "needle", "--", "../a.txt"]),
    0,
    "../a.txt:needle current\n../a.txt:needle twice needle\n",
  );
  assertResponse(
    await run(repository, ["-F", "needle", "--", "src", "src/space name.txt"]),
    0,
    "src/space name.txt:needle space\n",
  );
  assertResponse(
    await run(repository, ["--max-results=1", "-F", "needle", "--", "."]),
    0,
    "a.txt:needle current\n",
  );
  assertResponse(await run(repository, ["-F", "needle", "--", "missing"]), 1);

  const objectFs = createIsomorphicGitFs(py);
  const rawBlob = await isomorphicGit.writeObject({
    fs: objectFs, dir: repository, type: "blob", format: "content", object: bytes("raw needle\n"),
  });
  const rawTreeBytes = concat(
    bytes("100644 raw-"), new Uint8Array([0xff]), new Uint8Array([0]),
    new Uint8Array(Array.from({ length: 20 }, (_, index) => Number.parseInt(rawBlob.slice(index * 2, index * 2 + 2), 16))),
  );
  const rawTree = await isomorphicGit.writeObject({
    fs: objectFs, dir: repository, type: "tree", format: "content", object: rawTreeBytes,
  });
  assertResponse(
    await run(repository, ["-z", "-n", "-F", "needle", rawTree]),
    0,
    concat(bytes(`${rawTree}:raw-`), new Uint8Array([0xff, 0]), bytes("1\0raw needle\0")),
  );
  assertResponse(await run(repository, ["-F", "needle", rawBlob]), 2, "",
    "git grep: revision does not resolve to a commit or tree\n");

  py.FS.writeFile(`${repository}/early.txt`, "needle first\n");
  py.FS.writeFile(`${repository}/z-large.txt`, "small\n");
  await git(py, repository, "add", "early.txt", "z-large.txt");
  py.FS.writeFile(`${repository}/z-large.txt`, new Uint8Array(8 * 1024 * 1024 + 1).fill(0x78));
  assertResponse(
    await run(repository, ["--max-results=1", "-F", "needle"]),
    0,
    "a.txt:needle current\n",
  );
  assertResponse(await run(repository, ["-F", "needle"]), 2, "",
    "git grep: file exceeds 8388608 bytes\n");
  assertResponse(
    await run(repository, ["-F", "needle", "--", "early.txt"], new Uint8Array(1024 * 1024 + 1).fill(1)),
    0,
    "early.txt:needle first\n",
  );

  const help = "usage: git grep [-n|--line-number] [-i|--ignore-case] [-F|--fixed-strings|-E|--extended-regexp] [-l|--files-with-matches|-q|--quiet] [-z] [--max-results=N] [-e] PATTERN [REVISION] [-- [PATHSPEC...]]\n       tracked worktree bytes or one historical tree; stdin is ignored\n       limits: 100000 candidates/matches, depth 128, file 8 MiB, files 64 MiB, trees 16 MiB/200000 objects, pattern 64 KiB, index 16 MiB, path 4096 bytes, output 1000000 bytes\n";
  assertResponse(await run(repository, ["--help"]), 0, help);
  assert.equal(await git(py, repository, "help", "grep"), help);
  for (const args of [
    [], ["-x", "needle"], ["-F", "-E", "needle"], ["-l", "-q", "needle"],
    ["--max-results=0", "needle"], ["--max-results=100001", "needle"],
    ["--max-results=01", "needle"], ["needle", "HEAD", "extra"],
    ["needle", "-n"], ["--", "needle"], ["-e"], ["needle", "--", "/absolute"],
    ["needle", "--", ":(glob)src/*"], ["needle", "--", "../../outside"],
  ]) {
    const response = await run(repository, args);
    assert.equal(response.exitCode, 2, args.join(" "));
    assert.equal(response.stdout?.byteLength ?? 0, 0, args.join(" "));
    assert.match(new TextDecoder().decode(response.stderr), /^git grep: /, args.join(" "));
  }

  // Finish on a successful native call so wasm-git's process.exitCode does
  // not mask the assertion result in a filtered Node test run.
  assert.equal(await git(py, repository, "rev-parse", "HEAD"), `${historical}\n`);
});

test("bounded Git grep honors exact resource limits and explicit prefixes", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/git-grep-limits";
  py.FS.mkdirTree(repository);
  await git(py, repository, "init", "-b", "main");
  const tracked = [
    ...Array.from({ length: 8 }, (_, index) => `c${index}`),
    "d", "m", "n", "o", "p", "r", "t",
  ];
  for (const path of tracked) py.FS.writeFile(`${repository}/${path}`, "seed\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "limit fixtures");

  const eightMiB = new Uint8Array(8 * 1024 * 1024).fill(0x79);
  for (let index = 0; index < 8; index++) py.FS.writeFile(`${repository}/c${index}`, eightMiB);
  py.FS.writeFile(`${repository}/d`, "y");
  py.FS.writeFile(`${repository}/t`, new Uint8Array(8 * 1024 * 1024 + 1).fill(0x79));
  py.FS.writeFile(`${repository}/r`, "x".repeat(65_536));
  py.FS.writeFile(`${repository}/o`, "xxxxxxx\n".repeat(100_000));
  py.FS.writeFile(`${repository}/p`, "xxxxxxx\n".repeat(99_999) + "xxxxxxxx\n");
  py.FS.writeFile(`${repository}/n`, new Uint8Array(100_000).fill(0x0a));
  py.FS.writeFile(`${repository}/m`, new Uint8Array(100_001).fill(0x0a));

  const bytes = (value: string) => new TextEncoder().encode(value);
  const run = (args: string[], stdin?: Uint8Array) => runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "grep", ...args],
    ...(stdin ? { stdin } : {}),
  });
  const assertFailure = async (args: string[], diagnostic: string): Promise<void> => {
    const response = await run(args);
    assert.equal(response.exitCode, 2, args.join(" "));
    assert.equal(response.stdout?.byteLength ?? 0, 0, args.join(" "));
    assert.equal(new TextDecoder().decode(response.stderr), `git grep: ${diagnostic}\n`);
  };

  const indexBefore = new Uint8Array(py.FS.readFile(`${repository}/.git/index`) as Uint8Array);
  const headBefore = py.FS.readFile(`${repository}/.git/HEAD`, { encoding: "utf8" });
  const statusBefore = await git(py, repository, "status", "--short");

  let response = await run(["-q", "-F", "y", "--", "c0"]);
  assert.equal(response.exitCode, 0);
  assert.equal(response.stdout?.byteLength ?? 0, 0);
  await assertFailure(["-q", "-F", "y", "--", "t"], "file exceeds 8388608 bytes");

  response = await run(["-F", "needle", "--", "c?"]);
  assert.equal(response.exitCode, 1);
  assert.equal(response.stdout?.byteLength ?? 0, 0);
  await assertFailure(["-F", "needle", "--", "c?", "d"], "cumulative file bytes exceed 67108864");

  response = await run(["-q", "-F", "x".repeat(65_536), "--", "r"]);
  assert.equal(response.exitCode, 0);
  await assertFailure(["-F", "x".repeat(65_537), "--", "r"], "pattern exceeds 65536 bytes or contains NUL");

  response = await run(["-F", "x", "--", "o"]);
  assert.equal(response.exitCode, 0);
  assert.equal(response.stdout?.byteLength, 1_000_000);
  assert.deepEqual(response.stdout?.subarray(0, 10), bytes("o:xxxxxxx\n"));
  assert.deepEqual(response.stdout?.subarray(-10), bytes("o:xxxxxxx\n"));
  await assertFailure(["-F", "x", "--", "p"], "output exceeds 1000000 bytes");
  response = await run(["--max-results=1", "-F", "x", "--", "p"]);
  assert.equal(response.exitCode, 0);
  assert.deepEqual(response.stdout, bytes("p:xxxxxxx\n"));

  response = await run(["-e", "", "--", "n"]);
  assert.equal(response.exitCode, 0);
  assert.equal(response.stdout?.byteLength, 300_000);
  await assertFailure(["-e", "", "--", "m"], "more than 100000 matches");

  const objectFs = createIsomorphicGitFs(py);
  const blob = await isomorphicGit.writeObject({
    fs: objectFs, dir: repository, type: "blob", format: "content", object: bytes("x\n"),
  });
  const blobBytes = new Uint8Array(
    Array.from({ length: 20 }, (_, index) => Number.parseInt(blob.slice(index * 2, index * 2 + 2), 16)),
  );
  const writeFixedTree = (count: number): Promise<string> => {
    const prefix = bytes("100644 ");
    const rowLength = prefix.byteLength + 7 + 1 + blobBytes.byteLength;
    const raw = new Uint8Array(count * rowLength);
    let offset = 0;
    for (let index = 0; index < count; index++) {
      raw.set(prefix, offset); offset += prefix.byteLength;
      raw.set(bytes(`r${String(index).padStart(6, "0")}`), offset); offset += 7;
      raw[offset++] = 0; raw.set(blobBytes, offset); offset += blobBytes.byteLength;
    }
    return isomorphicGit.writeObject({
      fs: objectFs, dir: repository, type: "tree", format: "content", object: raw,
    });
  };
  const maximumTree = await writeFixedTree(100_000);
  response = await run(["--max-results=1", "-F", "x", maximumTree]);
  assert.equal(response.exitCode, 0);
  assert.deepEqual(response.stdout, bytes(`${maximumTree}:r000000:x\n`));
  const excessiveTree = await writeFixedTree(100_001);
  await assertFailure(["--max-results=1", "-F", "x", excessiveTree], "more than 100000 candidate entries");

  const exactTreeBytes = new Uint8Array(16 * 1024 * 1024);
  const treePrefix = bytes("100644 ");
  let treeOffset = 0;
  for (let index = 0; index < 100_000; index++) {
    const nameLength = index < 77_216 ? 140 : 139;
    const name = bytes(`r${String(index).padStart(6, "0")}${"x".repeat(nameLength - 7)}`);
    exactTreeBytes.set(treePrefix, treeOffset); treeOffset += treePrefix.byteLength;
    exactTreeBytes.set(name, treeOffset); treeOffset += name.byteLength;
    exactTreeBytes[treeOffset++] = 0;
    exactTreeBytes.set(blobBytes, treeOffset); treeOffset += blobBytes.byteLength;
  }
  assert.equal(treeOffset, exactTreeBytes.byteLength);
  const exactTreeData = await isomorphicGit.writeObject({
    fs: objectFs, dir: repository, type: "tree", format: "content", object: exactTreeBytes,
  });
  response = await run(["--max-results=1", "-F", "x", exactTreeData]);
  assert.equal(response.exitCode, 0);
  const excessiveTreeBytes = new Uint8Array(exactTreeBytes.byteLength + 1);
  excessiveTreeBytes.set(exactTreeBytes); excessiveTreeBytes[excessiveTreeBytes.length - 1] = 0x78;
  const excessiveTreeData = await isomorphicGit.writeObject({
    fs: objectFs, dir: repository, type: "tree", format: "content", object: excessiveTreeBytes,
  });
  await assertFailure(
    ["--max-results=1", "-F", "x", excessiveTreeData],
    "historical tree decoding exceeds 16777216 bytes",
  );

  const rawTreeEntry = (mode: string, name: string, oid: string): Uint8Array => {
    const oidBytes = new Uint8Array(
      Array.from({ length: 20 }, (_, index) => Number.parseInt(oid.slice(index * 2, index * 2 + 2), 16)),
    );
    const prefix = bytes(`${mode} ${name}`);
    const output = new Uint8Array(prefix.byteLength + 1 + oidBytes.byteLength);
    output.set(prefix); output[prefix.byteLength] = 0; output.set(oidBytes, prefix.byteLength + 1);
    return output;
  };
  let depthTree = await isomorphicGit.writeObject({
    fs: objectFs, dir: repository, type: "tree", format: "content",
    object: rawTreeEntry("100644", "leaf", blob),
  });
  for (let index = 0; index < 127; index++) {
    depthTree = await isomorphicGit.writeObject({
      fs: objectFs, dir: repository, type: "tree", format: "content",
      object: rawTreeEntry("40000", "d", depthTree),
    });
  }
  response = await run(["-q", "-F", "x", depthTree]);
  assert.equal(response.exitCode, 0);
  const tooDeepTree = await isomorphicGit.writeObject({
    fs: objectFs, dir: repository, type: "tree", format: "content",
    object: rawTreeEntry("40000", "d", depthTree),
  });
  await assertFailure(["-q", "-F", "x", tooDeepTree], "historical tree depth exceeds 128");

  response = await run(["-F", "absent", "--", ...Array(100).fill("missing")]);
  assert.equal(response.exitCode, 1);
  await assertFailure(["-F", "absent", "--", ...Array(101).fill("missing")], "more than 100 pathspecs");
  response = await run(["-F", "absent", "--", "n"], new Uint8Array(2 * 1024 * 1024).fill(0xff));
  assert.equal(response.exitCode, 1);

  assert.deepEqual(py.FS.readFile(`${repository}/.git/index`) as Uint8Array, indexBefore);
  assert.equal(py.FS.readFile(`${repository}/.git/HEAD`, { encoding: "utf8" }), headBefore);
  assert.equal(await git(py, repository, "status", "--short"), statusBefore);
});

test("bounded Git log path projections are first-parent, framed, filtered, and raw-safe", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/log-path-protocol";
  py.FS.mkdirTree(repository);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/binary.bin`, new Uint8Array([1, 0, 2]));
  py.FS.writeFile(`${repository}/delete.txt`, "delete root\n");
  py.FS.writeFile(`${repository}/keep.txt`, "keep root\n");
  py.FS.writeFile(`${repository}/line\nbreak.txt`, "line root\n");
  py.FS.writeFile(`${repository}/rename-old.txt`, "rename payload\n");
  py.FS.writeFile(`${repository}/space name.txt`, "space root\n");
  py.FS.writeFile(`${repository}/tab\tname.txt`, "tab root\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "root paths");
  const rootCommit = (await git(py, repository, "rev-parse", "HEAD")).trim();

  py.FS.writeFile(`${repository}/added.txt`, "added mixed\n");
  py.FS.writeFile(`${repository}/binary.bin`, new Uint8Array([3, 0, 4]));
  py.FS.unlink(`${repository}/delete.txt`);
  py.FS.writeFile(`${repository}/keep.txt`, "keep mixed\n");
  py.FS.rename(`${repository}/rename-old.txt`, `${repository}/rename-new.txt`);
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "mixed delta");
  const mixed = (await git(py, repository, "rev-parse", "HEAD")).trim();

  await git(py, repository, "switch", "-c", "side");
  py.FS.writeFile(`${repository}/side.txt`, "side only\n");
  await git(py, repository, "add", "side.txt");
  await git(py, repository, "commit", "-m", "unmerged side");
  const side = (await git(py, repository, "rev-parse", "HEAD")).trim();
  await git(py, repository, "switch", "main");

  await git(py, repository, "switch", "-c", "feature");
  py.FS.writeFile(`${repository}/feature.txt`, "feature only\n");
  py.FS.writeFile(`${repository}/space name.txt`, "space feature\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "feature delta");
  const feature = (await git(py, repository, "rev-parse", "HEAD")).trim();
  await git(py, repository, "switch", "main");
  py.FS.writeFile(`${repository}/keep.txt`, "keep main\n");
  await git(py, repository, "add", "keep.txt");
  await git(py, repository, "commit", "-m", "main delta");
  const main = (await git(py, repository, "rev-parse", "HEAD")).trim();
  await git(py, repository, "merge", "feature");
  const merge = (await git(py, repository, "rev-parse", "HEAD")).trim();
  await git(py, repository, "commit", "--allow-empty", "-m", "empty tip");
  const empty = (await git(py, repository, "rev-parse", "HEAD")).trim();

  const mixedStatus =
    "A\tadded.txt\n" +
    "M\tbinary.bin\n" +
    "D\tdelete.txt\n" +
    "M\tkeep.txt\n" +
    "A\trename-new.txt\n" +
    "D\trename-old.txt\n";
  const rootStatus =
    "A\tbinary.bin\n" +
    "A\tdelete.txt\n" +
    "A\tkeep.txt\n" +
    "A\t\"line\\012break.txt\"\n" +
    "A\trename-old.txt\n" +
    "A\tspace name.txt\n" +
    "A\t\"tab\\011name.txt\"\n";
  assert.equal(
    await git(
      py, repository, "log", "-n", "2", "--format=%H%x1f%s", "--name-status", mixed,
    ),
    `${mixed}\x1fmixed delta\n${mixedStatus}\n` +
      `${rootCommit}\x1froot paths\n${rootStatus}\n`,
  );

  assert.equal(
    await git(py, repository, "log", "-n2", "--format=%h", "--name-only", mixed),
    `${mixed.slice(0, 7)}\n` +
      "added.txt\nbinary.bin\ndelete.txt\nkeep.txt\nrename-new.txt\nrename-old.txt\n\n" +
      `${rootCommit.slice(0, 7)}\n` +
      "binary.bin\ndelete.txt\nkeep.txt\n\"line\\012break.txt\"\n" +
      "rename-old.txt\nspace name.txt\n\"tab\\011name.txt\"\n\n",
  );

  const rawStatus = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "log", "-n", "2", "--format=%H", "--name-status", "-z", mixed],
  });
  assert.equal(rawStatus.exitCode, 0);
  assert.deepEqual(
    rawStatus.stdout,
    new TextEncoder().encode(
      `${mixed}\n` +
      "A\x00added.txt\x00M\x00binary.bin\x00D\x00delete.txt\x00M\x00keep.txt\x00" +
      "A\x00rename-new.txt\x00D\x00rename-old.txt\x00\x00" +
      `${rootCommit}\n` +
      "A\x00binary.bin\x00A\x00delete.txt\x00A\x00keep.txt\x00A\x00line\nbreak.txt\x00" +
      "A\x00rename-old.txt\x00A\x00space name.txt\x00A\x00tab\tname.txt\x00\x00",
    ),
  );

  const mixedNumstat =
    "1\t0\tadded.txt\n" +
    "-\t-\tbinary.bin\n" +
    "0\t1\tdelete.txt\n" +
    "1\t1\tkeep.txt\n" +
    "1\t0\trename-new.txt\n" +
    "0\t1\trename-old.txt\n";
  const rootNumstat =
    "-\t-\tbinary.bin\n" +
    "1\t0\tdelete.txt\n" +
    "1\t0\tkeep.txt\n" +
    "1\t0\t\"line\\012break.txt\"\n" +
    "1\t0\trename-old.txt\n" +
    "1\t0\tspace name.txt\n" +
    "1\t0\t\"tab\\011name.txt\"\n";
  assert.equal(
    await git(py, repository, "log", "--max-count=2", "--format=%H", "--numstat", mixed),
    `${mixed}\n${mixedNumstat}\n${rootCommit}\n${rootNumstat}\n`,
  );
  const rawNumstat = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "log", "-n1", "--oneline", "--numstat", "-z", mixed],
  });
  assert.equal(rawNumstat.exitCode, 0);
  assert.deepEqual(
    rawNumstat.stdout,
    new TextEncoder().encode(
      `${mixed.slice(0, 7)} mixed delta\n` +
      "1\t0\tadded.txt\x00-\t-\tbinary.bin\x000\t1\tdelete.txt\x00" +
      "1\t1\tkeep.txt\x001\t0\trename-new.txt\x000\t1\trename-old.txt\x00\x00",
    ),
  );

  assert.equal(
    await git(py, repository, "log", "-n1", "--format=%H", "--name-status", merge),
    `${merge}\nA\tfeature.txt\nM\tspace name.txt\n\n`,
  );
  assert.equal(
    await git(py, repository, "log", "-n1", "--oneline", "--name-only", empty),
    `${empty.slice(0, 7)} empty tip\n\n`,
  );
  assert.match(
    await git(py, repository, "log", "-n1", "--pretty=oneline", "--name-only", merge),
    new RegExp(`^${merge} Merge[^\n]*\nfeature\\.txt\nspace name\\.txt\n\n$`),
  );
  assert.match(
    await git(py, repository, "log", "-n1", "--name-status", mixed),
    new RegExp(`^commit ${mixed}[\\s\\S]*    mixed delta\n\n${mixedStatus.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n$`),
  );
  const plainDefault = await git(py, repository, "log", "-n", "1", mixed);
  const projectedDefault = await git(py, repository, "log", "-n", "1", "--name-status", mixed);
  assert.equal(projectedDefault.slice(0, plainDefault.length), plainDefault);

  const keepHistory = await git(
    py, repository, "log", "--format=%H", "--name-status", "--", "keep.txt",
  );
  assert.match(keepHistory, new RegExp(`^${main}$`, "m"));
  assert.match(keepHistory, new RegExp(`^${mixed}$`, "m"));
  assert.doesNotMatch(keepHistory, new RegExp(`^${empty}$`, "m"));
  assert.equal(
    await git(py, repository, "log", "-n1", "--format=%H", "--name-status", "--", "keep.txt"),
    `${keepHistory.split("\n\n", 1)[0]}\n\n`,
  );
  assert.equal(
    await git(py, repository, "log", "--format=%H", "--name-status", mixed, "--", "rename-old.txt"),
    `${mixed}\nD\trename-old.txt\n\n${rootCommit}\nA\trename-old.txt\n\n`,
  );
  assert.equal(
    await git(py, repository, "log", "--format=%H", "--name-status", mixed, "--", "rename-new.txt"),
    `${mixed}\nA\trename-new.txt\n\n`,
  );
  assert.equal(
    await git(py, repository, "log", "--format=%H", "--name-only", "--", "not-present.txt"),
    "",
  );
  const rawWeirdPath = await runGitEngineCommand({
    py,
    cwd: repository,
    args: [
      "git-engine", "log", "--format=%H", "--name-only", "-z", "--", "line\nbreak.txt",
    ],
  });
  assert.deepEqual(
    rawWeirdPath.stdout,
    new TextEncoder().encode(`${rootCommit}\nline\nbreak.txt\x00\x00`),
  );

  const all = await git(py, repository, "log", "--all", "--format=%H", "--name-only");
  assert.match(all, new RegExp(`^${side}$`, "m"));
  assert.match(all, new RegExp(`^${feature}$`, "m"));
  assert.equal((all.match(new RegExp(rootCommit, "g")) ?? []).length, 1);

  for (const args of [
    ["log", "--name-only", "--name-status"],
    ["log", "--name-only", "--numstat"],
    ["log", "-z"],
    ["log", "--name-only", "--stat"],
    ["log", "--name-status", "--graph"],
    ["log", "--format=", "--name-only"],
    ["log", "--format=%s", "--name-only"],
    ["log", "--format=%H%n%s", "--name-only"],
    ["log", "--format=%H%x00%s", "--name-only"],
    ["log", "--format=%H%x0A%s", "--name-only"],
    ["log", "--format=%H%x0d%s", "--name-only"],
    ["log", "--all", "--name-only", mixed],
  ]) {
    const rejected = await runGitEngineCommand({
      py,
      cwd: repository,
      args: ["git-engine", ...args],
    });
    assert.equal(rejected.exitCode, 2, `${args.join(" ")}: ${new TextDecoder().decode(rejected.stderr)}`);
    assert.equal(rejected.stdout?.byteLength ?? 0, 0, args.join(" "));
  }
  assert.match(
    (await gitResult(py, repository, "log", "--format=%s", "--name-only")).output,
    /projected log format must be single-line and contain %H or %h/,
  );
  assert.match(
    (await gitResult(py, repository, "log", "--name-only", "--graph")).output,
    /path projections cannot be combined with --graph/,
  );

  const dateRepository = "/home/web/log-date-protocol";
  py.FS.mkdirTree(dateRepository);
  await git(py, dateRepository, "init", "-b", "main");
  const commitAt = async (
    message: string,
    authorDate: string,
    committerDate: string,
  ): Promise<string> => {
    const committed = await runGitEngineCommand({
      py,
      cwd: dateRepository,
      args: ["git-engine", "commit", "-m", message],
      env: {
        GIT_AUTHOR_DATE: authorDate,
        GIT_COMMITTER_DATE: committerDate,
      },
    });
    const output = new TextDecoder().decode(committed.stdout ?? committed.stderr ?? new Uint8Array());
    assert.equal(committed.exitCode, 0, output);
    return (await git(py, dateRepository, "rev-parse", "HEAD")).trim();
  };
  py.FS.writeFile(`${dateRepository}/dated.txt`, "first\n");
  await git(py, dateRepository, "add", "dated.txt");
  const east = await commitAt(
    "east date",
    "2020-01-07T03:04:05+09:00",
    "2020-01-08T06:07:08-05:30",
  );
  py.FS.writeFile(`${dateRepository}/dated.txt`, "second\n");
  await git(py, dateRepository, "add", "dated.txt");
  const west = await commitAt(
    "west date",
    "2021-02-09T10:11:12-05:30",
    "2021-02-10T13:14:15+09:00",
  );
  for (const [oid, expectedDate] of [
    [east, "Date:   Tue Jan  7 03:04:05 2020 +0900\n"],
    [west, "Date:   Tue Feb  9 10:11:12 2021 -0530\n"],
  ]) {
    const plain = await git(py, dateRepository, "log", "-n", "1", oid);
    assert.match(plain, new RegExp(expectedDate.replace(/[+]/g, "\\+")));
    for (const projectionName of ["--name-only", "--name-status", "--numstat"]) {
      for (const raw of [false, true]) {
        const projected = await git(
          py, dateRepository, "log", "-n", "1", projectionName, ...(raw ? ["-z"] : []), oid,
        );
        assert.equal(projected.slice(0, plain.length), plain);
      }
    }
  }

  const help = await git(py, repository, "help", "log");
  assert.match(help, /--stat\|--name-only\|--name-status\|--numstat.*\[-z\]/);
  assert.match(help, /1000 commits, 100000 records, and 8 MiB output/);
  assert.match(help, /single-line and contain %H or %h/);
});

test("bounded Git path reset expands directories without corrupting the index", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/reset-path-protocol";
  py.FS.mkdirTree(`${repository}/d`);
  py.FS.mkdirTree(`${repository}/e`);
  py.FS.mkdirTree(`${repository}/tab\tarea`);
  py.FS.mkdirTree(`${repository}/-dash-dir`);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/d/a.txt`, "a0\n");
  py.FS.writeFile(`${repository}/d/b.txt`, "b0\n");
  py.FS.writeFile(`${repository}/e/f.txt`, "f0\n");
  py.FS.writeFile(`${repository}/swap`, "file0\n");
  py.FS.writeFile(`${repository}/tab\tarea/line\nfile.txt`, "raw0\n");
  py.FS.writeFile(`${repository}/-dash-dir/value.txt`, "dash0\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "reset path base");

  py.FS.writeFile(`${repository}/d/a.txt`, "a1\n");
  await git(py, repository, "add", "--", "d");
  const worktreeBefore = new Uint8Array(py.FS.readFile(`${repository}/d/a.txt`) as Uint8Array);
  await git(py, repository, "reset", "HEAD", "--", "d");
  assert.deepEqual(py.FS.readFile(`${repository}/d/a.txt`) as Uint8Array, worktreeBefore);
  assert.equal((await gitResult(py, repository, "status", "--short")).output, " M d/a.txt\n");
  const staged = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "ls-files", "--stage", "-z", "--", "d"],
  });
  assert.equal(staged.exitCode, 0);
  const records = new TextDecoder().decode(staged.stdout).split("\0").filter(Boolean);
  assert.equal(records.length, 2);
  assert.match(records[0], /^100644 [0-9a-f]{40} 0\td\/a\.txt$/);
  assert.match(records[1], /^100644 [0-9a-f]{40} 0\td\/b\.txt$/);

  await git(py, repository, "reset", "--hard", "HEAD");
  py.FS.writeFile(`${repository}/d/a.txt`, "a2\n");
  py.FS.writeFile(`${repository}/d/b.txt`, "b2\n");
  await git(py, repository, "add", "--", "d");
  await git(py, repository, "reset", "HEAD", "--", "d/a.txt");
  assert.equal(await git(py, repository, "diff", "--cached", "--name-only"), "d/b.txt\n");
  assert.equal(await git(py, repository, "diff", "--name-only"), "d/a.txt\n");
  await git(py, repository, "reset", "HEAD", "--", "d", "e/f.txt");
  assert.equal(await git(py, repository, "diff", "--cached", "--name-only"), "");
  assert.equal(
    await git(py, repository, "diff", "--name-only"),
    "d/a.txt\nd/b.txt\n",
  );

  await git(py, repository, "reset", "--hard", "HEAD");
  py.FS.writeFile(`${repository}/tab\tarea/line\nfile.txt`, "raw1\n");
  py.FS.writeFile(`${repository}/-dash-dir/value.txt`, "dash1\n");
  await git(py, repository, "add", "--", "tab\tarea", "-dash-dir");
  await git(py, repository, "reset", "HEAD", "--", "tab\tarea", "-dash-dir");
  const rawStatus = await runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "status", "--porcelain=v1", "-z"],
  });
  assert.deepEqual(
    rawStatus.stdout,
    new TextEncoder().encode(" M -dash-dir/value.txt\0 M tab\tarea/line\nfile.txt\0"),
  );

  await git(py, repository, "reset", "--hard", "HEAD");
  py.FS.unlink(`${repository}/d/a.txt`);
  py.FS.writeFile(`${repository}/d/new.txt`, "new\n");
  await git(py, repository, "add", "-A");
  const deletionWorktree = new Uint8Array(py.FS.readFile(`${repository}/d/new.txt`) as Uint8Array);
  await git(py, repository, "reset", "HEAD", "--", "d");
  assert.equal(py.FS.analyzePath(`${repository}/d/a.txt`).exists, false);
  assert.deepEqual(py.FS.readFile(`${repository}/d/new.txt`) as Uint8Array, deletionWorktree);
  assert.equal(
    await git(py, repository, "ls-files", "--", "d"),
    "d/a.txt\nd/b.txt\n",
  );
  assert.equal(
    (await gitResult(py, repository, "status", "--short")).output,
    " D d/a.txt\n?? d/new.txt\n",
  );

  await git(py, repository, "reset", "--hard", "HEAD");
  py.FS.unlink(`${repository}/d/a.txt`);
  py.FS.unlink(`${repository}/d/b.txt`);
  py.FS.unlink(`${repository}/d/new.txt`);
  py.FS.rmdir(`${repository}/d`);
  py.FS.writeFile(`${repository}/d`, "directory became file\n");
  await git(py, repository, "add", "-A");
  const replacedDirectory = new Uint8Array(py.FS.readFile(`${repository}/d`) as Uint8Array);
  await git(py, repository, "reset", "HEAD", "--", "d");
  assert.deepEqual(py.FS.readFile(`${repository}/d`) as Uint8Array, replacedDirectory);
  assert.equal(await git(py, repository, "ls-files", "--", "d"), "d/a.txt\nd/b.txt\n");

  py.FS.unlink(`${repository}/d`);
  py.FS.mkdir(`${repository}/d`);
  await git(py, repository, "reset", "--hard", "HEAD");
  py.FS.unlink(`${repository}/swap`);
  py.FS.mkdir(`${repository}/swap`);
  py.FS.writeFile(`${repository}/swap/child.txt`, "child\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "reset", "HEAD", "--", "swap");
  assert.equal(await git(py, repository, "ls-files", "--", "swap"), "swap\n");
  assert.equal(py.FS.isDir(py.FS.lstat(`${repository}/swap`).mode), true);
  assert.equal(py.FS.readFile(`${repository}/swap/child.txt`, { encoding: "utf8" }), "child\n");

  py.FS.unlink(`${repository}/swap/child.txt`);
  py.FS.rmdir(`${repository}/swap`);
  await git(py, repository, "reset", "--hard", "HEAD");
  py.FS.writeFile(`${repository}/d/a.txt`, "subdir\n");
  await git(py, repository, "add", "d/a.txt");
  await git(py, `${repository}/d`, "reset", "HEAD", "--", ".");
  assert.equal(await git(py, repository, "diff", "--cached", "--name-only"), "");
  assert.equal(await git(py, repository, "diff", "--name-only"), "d/a.txt\n");
});

test("bounded Git path reset preflights limits and swaps one complete index", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/reset-path-limits";
  const indexPath = `${repository}/.git/index`;
  py.FS.mkdirTree(`${repository}/d`);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/d/a.txt`, "base\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "reset limits base");
  const head = (await git(py, repository, "rev-parse", "HEAD")).trim();
  py.FS.writeFile(`${repository}/d/a.txt`, "work\n");
  await git(py, repository, "add", "d/a.txt");

  const run = (...args: string[]) => runGitEngineCommand({
    py,
    cwd: repository,
    args: ["git-engine", "reset", ...args],
  });
  const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes ?? new Uint8Array());
  const worktreeBefore = new Uint8Array(py.FS.readFile(`${repository}/d/a.txt`) as Uint8Array);
  const stableIndex = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  const assertStable = () => {
    assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, stableIndex);
    assert.deepEqual(py.FS.readFile(`${repository}/d/a.txt`) as Uint8Array, worktreeBefore);
    assert.equal(py.FS.readFile(`${repository}/.git/HEAD`, { encoding: "utf8" }), `ref: refs/heads/main\n`);
  };
  const assertUsageFailure = async (...args: string[]) => {
    const response = await run(...args);
    assert.equal(response.exitCode, 2, args.join(" "));
    assert.equal(response.stdout?.byteLength ?? 0, 0);
    assert.ok((response.stderr?.byteLength ?? 0) > 0);
    assertStable();
  };

  const noMatch = await run("HEAD", "--", "absent");
  assert.equal(noMatch.exitCode, 0, text(noMatch.stderr));
  assert.equal(noMatch.stdout?.byteLength ?? 0, 0);
  assertStable();
  assert.equal((await run("HEAD", "--", ...Array(100).fill("absent"))).exitCode, 0);
  assertStable();
  await assertUsageFailure("HEAD", "--", ...Array(101).fill("absent"));
  assert.equal((await run("HEAD", "--", "p".repeat(4_096))).exitCode, 0);
  assertStable();
  await assertUsageFailure("HEAD", "--", "p".repeat(4_097));
  assert.equal(
    (await run("HEAD", "--", ...Array(16).fill("q".repeat(4_096)))).exitCode,
    0,
  );
  assertStable();
  await assertUsageFailure(
    "HEAD", "--", ...Array(16).fill("q".repeat(4_096)), "x",
  );
  await assertUsageFailure("NO_SUCH_REV", "--", "d");
  await assertUsageFailure("HEAD", "--", "");
  await assertUsageFailure("HEAD", "--", "\ud800");
  await assertUsageFailure("HEAD", "--", "../reset-path-outside");
  await assertUsageFailure("--soft", "HEAD", "--", "d");
  await assertUsageFailure("--hard", "HEAD", "--", "d");
  await assertUsageFailure("HEAD", "--");
  await assertUsageFailure("HEAD", "other-revision");

  const sourceOid = (await git(py, repository, "rev-parse", "HEAD:d/a.txt")).trim();
  const sourceObjectPath = `${repository}/.git/objects/${sourceOid.slice(0, 2)}/${sourceOid.slice(2)}`;
  const sourceObject = new Uint8Array(py.FS.readFile(sourceObjectPath) as Uint8Array);
  py.FS.unlink(sourceObjectPath);
  try {
    const missingObject = await run("HEAD", "--", "d/a.txt");
    assert.equal(missingObject.exitCode, 1);
    assert.equal(missingObject.stdout?.byteLength ?? 0, 0);
    assert.match(text(missingObject.stderr), /not found|Could not find/i);
    assertStable();
  } finally {
    py.FS.writeFile(sourceObjectPath, sourceObject);
  }

  py.FS.writeFile(indexPath, "not an index");
  const corruptIndex = new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  try {
    const rejected = await run("HEAD", "--", "d");
    assert.equal(rejected.exitCode, 1);
    assert.equal(rejected.stdout?.byteLength ?? 0, 0);
    assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, corruptIndex);
    assert.deepEqual(py.FS.readFile(`${repository}/d/a.txt`) as Uint8Array, worktreeBefore);
  } finally {
    py.FS.writeFile(indexPath, stableIndex);
  }

  const originalWriteFile = py.FS.writeFile;
  let rejectedIndexWrite = false;
  (py.FS as any).writeFile = (path: string, ...args: unknown[]) => {
    if (path === indexPath && !rejectedIndexWrite) {
      rejectedIndexWrite = true;
      throw new Error("injected index write failure");
    }
    return Reflect.apply(originalWriteFile, py.FS, [path, ...args]);
  };
  try {
    const rejected = await run("HEAD", "--", "d/a.txt");
    assert.equal(rejected.exitCode, 1);
    assert.match(text(rejected.stderr), /injected index write failure/);
  } finally {
    (py.FS as any).writeFile = originalWriteFile;
  }
  assert.equal(rejectedIndexWrite, true);
  assertStable();
  assert.equal(
    py.FS.readdir(`${repository}/.git`).some((name: string) => name.startsWith("piodide-reset-index-")),
    false,
  );

  const writeSyntheticIndex = (paths: string[]): Uint8Array => {
    const encodedPaths = paths.map((path) => new TextEncoder().encode(path));
    const entrySizes = encodedPaths.map((path) => (62 + path.byteLength + 1 + 7) & ~7);
    const entriesLength = entrySizes.reduce((total, length) => total + length, 0);
    const bytes = new Uint8Array(12 + entriesLength + 20);
    bytes.set(new TextEncoder().encode("DIRC"), 0);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, 2);
    view.setUint32(8, paths.length);
    let offset = 12;
    for (let index = 0; index < encodedPaths.length; index++) {
      const path = encodedPaths[index];
      view.setUint32(offset + 24, 0o100644);
      view.setUint16(offset + 60, Math.min(path.byteLength, 0x0fff));
      bytes.set(path, offset + 62);
      offset += entrySizes[index];
    }
    bytes.set(createHash("sha1").update(bytes.subarray(0, offset)).digest(), offset);
    py.FS.writeFile(indexPath, bytes);
    return bytes;
  };
  const oneEntryIndex = (size: number): Uint8Array => {
    assert.equal((size - 32) % 8, 0);
    return writeSyntheticIndex(["z".repeat(size - 32 - 63)]);
  };
  try {
    let synthetic = writeSyntheticIndex(Array.from(
      { length: 100_000 },
      (_, index) => `r${String(index).padStart(6, "0")}`,
    ));
    let response = await run("HEAD", "--", "absent");
    assert.equal(response.exitCode, 0, text(response.stderr));
    assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, synthetic);

    synthetic = writeSyntheticIndex(Array.from(
      { length: 100_001 },
      (_, index) => `r${String(index).padStart(6, "0")}`,
    ));
    response = await run("HEAD", "--", "absent");
    assert.equal(response.exitCode, 2);
    assert.match(text(response.stderr), /entry limit exceeded \(100000\)/);
    assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, synthetic);

    synthetic = oneEntryIndex(16 * 1024 * 1024 - 72);
    response = await run("HEAD", "--", "d/a.txt");
    assert.equal(response.exitCode, 0, text(response.stderr));
    assert.equal((py.FS.stat(indexPath) as { size: number }).size, 16 * 1024 * 1024);

    synthetic = oneEntryIndex(16 * 1024 * 1024);
    response = await run("HEAD", "--", "d/a.txt");
    assert.equal(response.exitCode, 2);
    assert.match(text(response.stderr), /resulting index exceeds 16777216 bytes/);
    assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, synthetic);

    const oneByteOver = new Uint8Array(synthetic.byteLength + 1);
    oneByteOver.set(synthetic);
    py.FS.writeFile(indexPath, oneByteOver);
    response = await run("HEAD", "--", "absent");
    assert.equal(response.exitCode, 2);
    assert.match(text(response.stderr), /index exceeds 16777216 bytes/);
    assert.deepEqual(py.FS.readFile(indexPath) as Uint8Array, oneByteOver);
  } finally {
    py.FS.writeFile(indexPath, stableIndex);
  }
  assertStable();
  assert.match(await git(py, repository, "help", "reset"), /literal exact files or directory prefixes/);
  assert.match(await git(py, repository, "help", "reset"), /100 paths.*4096 UTF-8 bytes\/path.*16 MiB index/);
  assert.equal((await git(py, repository, "rev-parse", "HEAD")).trim(), head);
});

test("bounded Git restore publishes index and worktree transactionally with exact limits", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/restore-transaction-protocol";
  const indexPath = `${repository}/.git/index`;
  py.FS.mkdirTree(`${repository}/dir`);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/.gitignore`, "*.ignored\n");
  for (const [path, value] of [
    ["a.txt", "a base\n"],
    ["b.txt", "b base\n"],
    ["dir/one", "one base\n"],
    ["dir/two", "two base\n"],
    ["-dash", "dash base\n"],
    ["tab\tname", "tab base\n"],
    ["line\nname", "line base\n"],
    ["exec.sh", "#!/bin/sh\nexit 0\n"],
  ]) py.FS.writeFile(`${repository}/${path}`, value);
  py.FS.chmod(`${repository}/exec.sh`, 0o755);
  py.FS.symlink("a.txt", `${repository}/link`);
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "restore transaction base");
  const head = (await git(py, repository, "rev-parse", "HEAD")).trim();

  const index = () => new Uint8Array(py.FS.readFile(indexPath) as Uint8Array);
  const bytes = (path: string) => new Uint8Array(py.FS.readFile(`${repository}/${path}`) as Uint8Array);
  const scratchFree = () => py.FS.readdir(`${repository}/.git`).every(
    (name: string) => !name.startsWith("piodide-restore-index-") && name !== "index.lock",
  );

  py.FS.writeFile(`${repository}/a.txt`, "a staged\n");
  py.FS.writeFile(`${repository}/b.txt`, "b staged\n");
  await git(py, repository, "add", "--", "a.txt", "b.txt");
  py.FS.writeFile(`${repository}/a.txt`, "a work\n");
  py.FS.writeFile(`${repository}/b.txt`, "b work\n");
  const faultIndex = index();
  const faultA = bytes("a.txt");
  const faultB = bytes("b.txt");
  const originalWriteFile = py.FS.writeFile;
  let worktreeFault = false;
  (py.FS as any).writeFile = (path: string, ...args: unknown[]) => {
    if (path === `${repository}/b.txt` && !worktreeFault) {
      worktreeFault = true;
      throw new Error("injected restore worktree write failure");
    }
    return Reflect.apply(originalWriteFile, py.FS, [path, ...args]);
  };
  try {
    const failed = await gitResult(
      py, repository, "restore", "--staged", "--worktree", "--", "a.txt", "b.txt",
    );
    assert.equal(failed.exitCode, 1);
    assert.match(failed.output, /injected restore worktree write failure/);
  } finally {
    (py.FS as any).writeFile = originalWriteFile;
  }
  assert.equal(worktreeFault, true);
  assert.deepEqual(index(), faultIndex);
  assert.deepEqual(bytes("a.txt"), faultA);
  assert.deepEqual(bytes("b.txt"), faultB);
  assert.equal(scratchFree(), true);

  let indexFault = false;
  (py.FS as any).writeFile = (path: string, ...args: unknown[]) => {
    if (path === indexPath && !indexFault) {
      indexFault = true;
      throw new Error("injected restore index publication failure");
    }
    return Reflect.apply(originalWriteFile, py.FS, [path, ...args]);
  };
  try {
    const failed = await gitResult(
      py, repository, "restore", "--staged", "--worktree", "--", "a.txt", "b.txt",
    );
    assert.equal(failed.exitCode, 1);
    assert.match(failed.output, /injected restore index publication failure/);
  } finally {
    (py.FS as any).writeFile = originalWriteFile;
  }
  assert.equal(indexFault, true);
  assert.deepEqual(index(), faultIndex);
  assert.deepEqual(bytes("a.txt"), faultA);
  assert.deepEqual(bytes("b.txt"), faultB);
  assert.equal(scratchFree(), true);

  const originalReadFile = py.FS.readFile;
  let raceInjected = false;
  (py.FS as any).readFile = (path: string, ...args: unknown[]) => {
    const value = Reflect.apply(originalReadFile, py.FS, [path, ...args]);
    if (path.includes("/.git/piodide-restore-index-") && path.endsWith("/index") && !raceInjected) {
      raceInjected = true;
      originalWriteFile.call(py.FS, `${repository}/a.txt`, "external replacement\n");
    }
    return value;
  };
  try {
    const failed = await gitResult(
      py, repository, "restore", "--staged", "--worktree", "--", "a.txt", "b.txt",
    );
    assert.equal(failed.exitCode, 1);
    assert.match(failed.output, /worktree changed during the operation/);
  } finally {
    (py.FS as any).readFile = originalReadFile;
  }
  assert.equal(raceInjected, true);
  assert.deepEqual(index(), faultIndex);
  assert.equal(py.FS.readFile(`${repository}/a.txt`, { encoding: "utf8" }), "external replacement\n");
  assert.deepEqual(bytes("b.txt"), faultB);
  assert.equal(scratchFree(), true);

  py.FS.writeFile(`${repository}/a.txt`, "a work\n");
  await git(py, repository, "restore", "--staged", "--worktree", "--", "a.txt", "b.txt");
  assert.equal(py.FS.readFile(`${repository}/a.txt`, { encoding: "utf8" }), "a base\n");
  assert.equal(py.FS.readFile(`${repository}/b.txt`, { encoding: "utf8" }), "b base\n");
  assert.equal((await gitResult(py, repository, "status", "--short", "--", "a.txt", "b.txt")).output, "");

  py.FS.writeFile(`${repository}/new.txt`, "new staged bytes\n");
  await git(py, repository, "add", "--", "new.txt");
  await git(py, repository, "restore", "--staged", "--", "new.txt");
  assert.equal(py.FS.readFile(`${repository}/new.txt`, { encoding: "utf8" }), "new staged bytes\n");
  assert.equal((await gitResult(py, repository, "status", "--short", "--", "new.txt")).output, "?? new.txt\n");
  py.FS.unlink(`${repository}/a.txt`);
  await git(py, repository, "add", "-u", "--", "a.txt");
  await git(py, repository, "restore", "--staged", "--", "a.txt");
  assert.equal((await gitResult(py, repository, "status", "--short", "--", "a.txt")).output, " D a.txt\n");
  await git(py, repository, "restore", "--worktree", "--", "a.txt");
  assert.equal(py.FS.readFile(`${repository}/a.txt`, { encoding: "utf8" }), "a base\n");
  py.FS.writeFile(`${repository}/intent.txt`, "intent bytes\n");
  await git(py, repository, "add", "-N", "--", "intent.txt");
  assert.deepEqual(
    gitIndexIntentToAddPaths(index()),
    new Set(["intent.txt"]),
  );
  await git(py, repository, "restore", "--staged", "--", "intent.txt");
  assert.deepEqual(gitIndexIntentToAddPaths(index()), new Set());
  assert.equal((await gitResult(py, repository, "status", "--short", "--", "intent.txt")).output, "?? intent.txt\n");
  py.FS.unlink(`${repository}/new.txt`);
  py.FS.unlink(`${repository}/intent.txt`);

  for (const path of ["dir/one", "dir/two", "-dash", "tab\tname", "line\nname", "exec.sh"]) {
    py.FS.writeFile(`${repository}/${path}`, `dirty ${path}\n`);
  }
  py.FS.chmod(`${repository}/exec.sh`, 0o644);
  py.FS.unlink(`${repository}/link`);
  py.FS.writeFile(`${repository}/link`, "not a link\n");
  await git(
    py, repository, "restore", "--worktree", "--",
    "dir", "-dash", "tab\tname", "line\nname", "exec.sh", "link",
  );
  assert.equal(py.FS.readFile(`${repository}/dir/one`, { encoding: "utf8" }), "one base\n");
  assert.equal(py.FS.readFile(`${repository}/dir/two`, { encoding: "utf8" }), "two base\n");
  assert.equal(py.FS.readFile(`${repository}/-dash`, { encoding: "utf8" }), "dash base\n");
  assert.equal(py.FS.readFile(`${repository}/tab\tname`, { encoding: "utf8" }), "tab base\n");
  assert.equal(py.FS.readFile(`${repository}/line\nname`, { encoding: "utf8" }), "line base\n");
  assert.notEqual(py.FS.stat(`${repository}/exec.sh`).mode & 0o111, 0);
  assert.equal(Boolean(py.FS.isLink?.(py.FS.lstat(`${repository}/link`).mode)), true);
  assert.equal((await gitResult(py, repository, "status", "--short")).output, "");

  py.FS.writeFile(`${repository}/dir/one`, "one must survive collision\n");
  py.FS.unlink(`${repository}/dir/two`);
  py.FS.mkdir(`${repository}/dir/two`);
  py.FS.writeFile(`${repository}/dir/two/untracked`, "protected\n");
  const collisionIndex = index();
  const collision = await gitResult(
    py, repository, "restore", "--staged", "--worktree", "--", "dir",
  );
  assert.equal(collision.exitCode, 1);
  assert.match(collision.output, /cannot replace directory: dir\/two/);
  assert.deepEqual(index(), collisionIndex);
  assert.equal(py.FS.readFile(`${repository}/dir/one`, { encoding: "utf8" }), "one must survive collision\n");
  assert.equal(py.FS.readFile(`${repository}/dir/two/untracked`, { encoding: "utf8" }), "protected\n");
  py.FS.unlink(`${repository}/dir/two/untracked`);
  py.FS.rmdir(`${repository}/dir/two`);
  await git(py, repository, "restore", "--worktree", "--", "dir");

  py.FS.writeFile(`${repository}/a.txt`, "lock protected\n");
  py.FS.writeFile(`${repository}/.git/index.lock`, "held\n");
  const locked = await gitResult(py, repository, "restore", "--worktree", "--", "a.txt");
  assert.equal(locked.exitCode, 1);
  assert.match(locked.output, /cannot acquire the index lock/);
  assert.equal(py.FS.readFile(`${repository}/a.txt`, { encoding: "utf8" }), "lock protected\n");
  py.FS.unlink(`${repository}/.git/index.lock`);
  await git(py, repository, "restore", "--worktree", "--", "a.txt");

  const assertRejectedUnchanged = async (expected: number, pattern: RegExp, ...args: string[]) => {
    const beforeIndex = index();
    const beforeA = bytes("a.txt");
    const rejected = await gitResult(py, repository, "restore", ...args);
    assert.equal(rejected.exitCode, expected, rejected.output);
    assert.match(rejected.output, pattern);
    assert.deepEqual(index(), beforeIndex);
    assert.deepEqual(bytes("a.txt"), beforeA);
    assert.equal((await git(py, repository, "rev-parse", "HEAD")).trim(), head);
    assert.equal(scratchFree(), true);
  };
  await assertRejectedUnchanged(1, /did not match any files/, "--worktree", "--", "a.txt", "missing");
  py.FS.writeFile(`${repository}/ignored.ignored`, "ignored\n");
  await assertRejectedUnchanged(1, /did not match any files/, "--worktree", "--", "a.txt", "ignored.ignored");
  await assertRejectedUnchanged(2, /requires at least one path/, "--worktree");
  await assertRejectedUnchanged(2, /specified only once/, "--staged", "-S", "--", "a.txt");
  await assertRejectedUnchanged(2, /specified only once/, "--worktree", "-W", "--", "a.txt");
  await assertRejectedUnchanged(2, /accepts one source/, "--source", "HEAD", "-s", "HEAD", "--", "a.txt");
  await assertRejectedUnchanged(2, /unsupported restore option/, "--unknown", "--", "a.txt");
  await assertRejectedUnchanged(2, /at most 100 paths/, "--", ...Array(101).fill("a.txt"));
  assert.equal((await gitResult(py, repository, "restore", "--", ...Array(100).fill("a.txt"))).exitCode, 0);
  await assertRejectedUnchanged(1, /did not match any files/, "--", "p".repeat(4_096));
  await assertRejectedUnchanged(2, /path exceeds 4096 bytes/, "--", "p".repeat(4_097));
  await assertRejectedUnchanged(
    2, /exceed 65536 aggregate bytes/, "--", ...Array(17).fill("q".repeat(4_096)),
  );
  await assertRejectedUnchanged(
    2, /more than 128 components/, "--",
    Array.from({ length: 129 }, (_, index) => `d${index}`).join("/"),
  );
  await assertRejectedUnchanged(2, /source must be at most 4096/, `--source=${"r".repeat(4_097)}`, "--", "a.txt");
  await assertRejectedUnchanged(2, /relative to the worktree/, "--", `${repository}/a.txt`);
  await assertRejectedUnchanged(2, /path escapes the worktree/, "--", "../outside");

  const oversized = new Uint8Array(16 * 1024 * 1024 + 1);
  oversized[0] = 1;
  oversized[oversized.byteLength - 1] = 2;
  py.FS.writeFile(`${repository}/a.txt`, oversized);
  await assertRejectedUnchanged(2, /worktree file exceeds 16777216 bytes/, "--worktree", "--", "a.txt");
  assert.equal((py.FS.stat(`${repository}/a.txt`) as { size: number }).size, oversized.byteLength);
  assert.equal((py.FS.readFile(`${repository}/a.txt`) as Uint8Array)[0], 1);
  assert.equal((py.FS.readFile(`${repository}/a.txt`) as Uint8Array).at(-1), 2);

  const help = await git(py, repository, "help", "restore");
  assert.match(help, /literal cwd-relative exact tracked files or directory prefixes/);
  assert.match(help, /private scratch index and rollback-backed worktree publication/);
  assert.match(help, /status: 0 restored\/no-op, 1 .*runtime failure, 2 grammar\/path\/bounds failure/);
  assert.match(help, /100 paths.*4096 bytes\/path.*16 MiB\/file.*64 MiB rollback bytes/);
});

test("bounded Git recovery preserves layers, paths, and validation atomicity", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/recovery-protocol";
  py.FS.mkdirTree(`${repository}/dir`);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/a.txt`, "a0\n");
  py.FS.writeFile(`${repository}/b.txt`, "b0\n");
  py.FS.writeFile(`${repository}/dir/nested.txt`, "nested0\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "recovery base");
  const base = (await git(py, repository, "rev-parse", "HEAD")).trim();
  py.FS.writeFile(`${repository}/a.txt`, "a1\n");
  py.FS.writeFile(`${repository}/b.txt`, "b1\n");
  py.FS.writeFile(`${repository}/dir/nested.txt`, "nested1\n");
  py.FS.writeFile(`${repository}/tip.txt`, "tip\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "recovery tip");
  const tip = (await git(py, repository, "rev-parse", "HEAD")).trim();

  py.FS.writeFile(`${repository}/a.txt`, "a-staged\n");
  await git(py, repository, "add", "a.txt");
  py.FS.writeFile(`${repository}/a.txt`, "a-work\n");
  await git(py, repository, "restore", "--worktree", "a.txt");
  assert.equal(py.FS.readFile(`${repository}/a.txt`, { encoding: "utf8" }), "a-staged\n");
  assert.equal((await gitResult(py, repository, "status", "--short", "--", "a.txt")).output, "M  a.txt\n");
  py.FS.writeFile(`${repository}/a.txt`, "a-work-again\n");
  await git(py, repository, "restore", "a.txt");
  assert.equal(py.FS.readFile(`${repository}/a.txt`, { encoding: "utf8" }), "a-staged\n");
  assert.equal((await gitResult(py, repository, "status", "--short", "--", "a.txt")).output, "M  a.txt\n");
  await git(py, repository, "reset", "--hard", "HEAD");

  await git(py, repository, "restore", `--source=${base}`, "a.txt");
  assert.equal(py.FS.readFile(`${repository}/a.txt`, { encoding: "utf8" }), "a0\n");
  assert.equal((await gitResult(py, repository, "status", "--short", "--", "a.txt")).output, " M a.txt\n");
  assert.equal((await gitResult(py, repository, "diff", "--cached", "--", "a.txt")).output, "");
  await git(py, repository, "restore", "--worktree", "a.txt");

  py.FS.writeFile(`${repository}/a.txt`, "stage-for-unstage\n");
  await git(py, repository, "add", "a.txt");
  py.FS.writeFile(`${repository}/a.txt`, "work-must-survive\n");
  await git(py, repository, "restore", "--staged", "a.txt");
  assert.equal(py.FS.readFile(`${repository}/a.txt`, { encoding: "utf8" }), "work-must-survive\n");
  assert.equal((await gitResult(py, repository, "status", "--short", "--", "a.txt")).output, " M a.txt\n");
  await git(py, repository, "restore", "--worktree", "a.txt");

  py.FS.writeFile(`${repository}/a.txt`, "staged-before-both\n");
  await git(py, repository, "add", "a.txt");
  py.FS.writeFile(`${repository}/a.txt`, "work-before-both\n");
  await git(py, repository, "restore", "--source", base, "--staged", "--worktree", "a.txt");
  assert.equal(py.FS.readFile(`${repository}/a.txt`, { encoding: "utf8" }), "a0\n");
  assert.equal((await gitResult(py, repository, "status", "--short", "--", "a.txt")).output, "M  a.txt\n");
  await git(py, repository, "reset", "--hard", "HEAD");

  py.FS.writeFile(`${repository}/a.txt`, "keep-a\n");
  py.FS.writeFile(`${repository}/b.txt`, "keep-b\n");
  const restoreAtomic = await gitResult(py, repository, "restore", "a.txt", "missing.txt", "b.txt");
  assert.equal(restoreAtomic.exitCode, 1);
  assert.match(restoreAtomic.output, /pathspec 'missing\.txt' did not match/);
  assert.equal(py.FS.readFile(`${repository}/a.txt`, { encoding: "utf8" }), "keep-a\n");
  assert.equal(py.FS.readFile(`${repository}/b.txt`, { encoding: "utf8" }), "keep-b\n");
  const checkoutAtomic = await gitResult(py, repository, "checkout", "--", "a.txt", "missing.txt", "b.txt");
  assert.equal(checkoutAtomic.exitCode, 1);
  assert.match(checkoutAtomic.output, /pathspec 'missing\.txt' did not match/);
  assert.equal(py.FS.readFile(`${repository}/a.txt`, { encoding: "utf8" }), "keep-a\n");
  assert.equal(py.FS.readFile(`${repository}/b.txt`, { encoding: "utf8" }), "keep-b\n");
  await git(py, repository, "reset", "--hard", "HEAD");

  await git(py, repository, "checkout", base, "--", "a.txt");
  assert.equal((await git(py, repository, "rev-parse", "HEAD")).trim(), tip);
  assert.equal(py.FS.readFile(`${repository}/a.txt`, { encoding: "utf8" }), "a0\n");
  assert.equal(py.FS.readFile(`${repository}/b.txt`, { encoding: "utf8" }), "b1\n");
  assert.equal(py.FS.readFile(`${repository}/dir/nested.txt`, { encoding: "utf8" }), "nested1\n");
  assert.equal(py.FS.readFile(`${repository}/tip.txt`, { encoding: "utf8" }), "tip\n");
  assert.equal((await gitResult(py, repository, "status", "--short")).output, "M  a.txt\n");
  await git(py, repository, "reset", "--hard", "HEAD");

  py.FS.writeFile(`${repository}/a.txt`, "checkout-staged\n");
  await git(py, repository, "add", "a.txt");
  py.FS.writeFile(`${repository}/a.txt`, "checkout-work\n");
  await git(py, repository, "checkout", "--", "a.txt");
  assert.equal(py.FS.readFile(`${repository}/a.txt`, { encoding: "utf8" }), "checkout-staged\n");
  assert.equal((await gitResult(py, repository, "status", "--short", "--", "a.txt")).output, "M  a.txt\n");
  await git(py, repository, "reset", "--hard", "HEAD");

  await git(py, repository, "restore", `--source=${base}`, "--", "tip.txt");
  assert.equal(py.FS.analyzePath(`${repository}/tip.txt`).exists, false);
  assert.equal((await gitResult(py, repository, "status", "--short", "--", "tip.txt")).output, " D tip.txt\n");
  await git(py, repository, "restore", "tip.txt");
  await git(py, repository, "checkout", base, "--", "tip.txt");
  assert.equal((await git(py, repository, "rev-parse", "HEAD")).trim(), tip);
  assert.equal(py.FS.analyzePath(`${repository}/tip.txt`).exists, false);
  assert.equal((await gitResult(py, repository, "status", "--short", "--", "tip.txt")).output, "D  tip.txt\n");
  await git(py, repository, "reset", "--hard", "HEAD");

  py.FS.writeFile(`${repository}/a.txt`, "reset-conflict-staged\n");
  await git(py, repository, "add", "a.txt");
  const statusBeforeConflict = (await gitResult(py, repository, "status", "--short")).output;
  const resetConflict = await gitResult(py, repository, "reset", "--hard", "--soft", base);
  assert.equal(resetConflict.exitCode, 2);
  assert.match(resetConflict.output, /accepts at most one/);
  assert.equal((await git(py, repository, "rev-parse", "HEAD")).trim(), tip);
  assert.equal((await gitResult(py, repository, "status", "--short")).output, statusBeforeConflict);
  assert.equal(
    py.FS.readFile(`${repository}/a.txt`, { encoding: "utf8" }),
    "reset-conflict-staged\n",
  );
  const duplicateMode = await gitResult(py, repository, "reset", "--hard", "--hard", base);
  assert.equal(duplicateMode.exitCode, 2);
  assert.equal((await git(py, repository, "rev-parse", "HEAD")).trim(), tip);

  const resetExpressionIndex = new Uint8Array(
    py.FS.readFile(`${repository}/.git/index`) as Uint8Array,
  );
  const resetExpressionWorktree = new Uint8Array(
    py.FS.readFile(`${repository}/a.txt`) as Uint8Array,
  );
  await git(py, repository, "reset", "--soft", "HEAD^");
  assert.equal((await git(py, repository, "rev-parse", "HEAD")).trim(), base);
  assert.deepEqual(py.FS.readFile(`${repository}/.git/index`) as Uint8Array, resetExpressionIndex);
  assert.deepEqual(py.FS.readFile(`${repository}/a.txt`) as Uint8Array, resetExpressionWorktree);
  await git(py, repository, "reset", "--soft", tip);

  await git(py, repository, "reset", "--mixed", "HEAD~1");
  assert.equal((await git(py, repository, "rev-parse", "HEAD")).trim(), base);
  assert.deepEqual(py.FS.readFile(`${repository}/a.txt`) as Uint8Array, resetExpressionWorktree);
  await git(py, repository, "reset", "--hard", tip);
  await git(py, repository, "reset", "--hard", "HEAD^");
  assert.equal((await git(py, repository, "rev-parse", "HEAD")).trim(), base);
  assert.equal(py.FS.readFile(`${repository}/a.txt`, { encoding: "utf8" }), "a0\n");
  await git(py, repository, "reset", "--hard", tip);

  py.FS.writeFile(`${repository}/a.txt`, "reset-expression-stage\n");
  await git(py, repository, "add", "a.txt");
  py.FS.writeFile(`${repository}/a.txt`, "reset-expression-worktree\n");
  await git(py, repository, "reset", "HEAD^", "--", "a.txt");
  assert.equal((await git(py, repository, "rev-parse", "HEAD")).trim(), tip);
  assert.equal(py.FS.readFile(`${repository}/a.txt`, { encoding: "utf8" }), "reset-expression-worktree\n");
  assert.equal((await gitResult(py, repository, "status", "--short", "--", "a.txt")).output, "MM a.txt\n");

  const expressionFailureIndex = new Uint8Array(
    py.FS.readFile(`${repository}/.git/index`) as Uint8Array,
  );
  const expressionFailureWorktree = new Uint8Array(
    py.FS.readFile(`${repository}/a.txt`) as Uint8Array,
  );
  const blob = (await git(py, repository, "rev-parse", "HEAD:a.txt")).trim();
  const blobReset = await gitResult(py, repository, "reset", "--soft", blob);
  assert.equal(blobReset.exitCode, 2);
  assert.match(blobReset.output, /unknown revision|not a commit/);
  const oversizedRevision = await gitResult(py, repository, "reset", "r".repeat(4_097));
  assert.equal(oversizedRevision.exitCode, 2);
  assert.match(oversizedRevision.output, /invalid reset revision/);
  assert.equal((await git(py, repository, "rev-parse", "HEAD")).trim(), tip);
  assert.deepEqual(py.FS.readFile(`${repository}/.git/index`) as Uint8Array, expressionFailureIndex);
  assert.deepEqual(py.FS.readFile(`${repository}/a.txt`) as Uint8Array, expressionFailureWorktree);
  await git(py, repository, "reset", "--hard", "HEAD");

  assert.match(await git(py, repository, "help", "checkout"), /\[ref\] -- <paths/);
  assert.match(await git(py, repository, "help", "restore"), /--source ref/);
  assert.match(await git(py, repository, "help", "reset"), /ancestry expressions such as HEAD\^ or HEAD~2/);
});

test("bounded Git clean is cwd-scoped, path-scoped, compact, and deterministic", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/clean-protocol";
  const scoped = `${repository}/scoped`;
  py.FS.mkdirTree(scoped);
  py.FS.mkdirTree(`${repository}/sibling`);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/.gitignore`, "*.log\nignored-dir/\n");
  py.FS.writeFile(`${repository}/root.txt`, "root base\n");
  py.FS.writeFile(`${scoped}/tracked.txt`, "scoped base\n");
  py.FS.writeFile(`${repository}/sibling/tracked.txt`, "sibling base\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "clean base");

  py.FS.writeFile(`${repository}/root.txt`, "root work must survive\n");
  py.FS.writeFile(`${scoped}/tracked.txt`, "scoped staged must survive\n");
  await git(py, repository, "add", "scoped/tracked.txt");
  py.FS.writeFile(`${repository}/root-u.txt`, "root untracked\n");
  py.FS.writeFile(`${repository}/sibling/sibling-u.txt`, "sibling untracked\n");
  py.FS.writeFile(`${scoped}/-dash.txt`, "dash untracked\n");
  py.FS.writeFile(`${scoped}/direct.txt`, "direct untracked\n");
  py.FS.mkdirTree(`${scoped}/nested`);
  py.FS.writeFile(`${scoped}/nested/deep.txt`, "deep untracked\n");
  py.FS.mkdirTree(`${scoped}/empty/a/b`);
  py.FS.writeFile(`${scoped}/ignored.log`, "ignored\n");
  py.FS.mkdirTree(`${scoped}/ignored-dir`);
  py.FS.writeFile(`${scoped}/ignored-dir/keep.txt`, "ignored directory\n");

  const compactPreview = await gitResult(py, scoped, "clean", "-nd");
  assert.equal(compactPreview.exitCode, 0, compactPreview.output);
  assert.equal(
    compactPreview.output,
    "Would remove scoped/-dash.txt\n" +
      "Would remove scoped/direct.txt\n" +
      "Would remove scoped/nested/deep.txt\n" +
      "Would remove scoped/nested/\n",
  );
  assert.equal(py.FS.analyzePath(`${repository}/root-u.txt`).exists, true);
  assert.equal(py.FS.analyzePath(`${repository}/sibling/sibling-u.txt`).exists, true);
  const compactAction = await gitResult(py, scoped, "clean", "-fd");
  assert.equal(compactAction.exitCode, 0, compactAction.output);
  assert.equal(compactAction.output, compactPreview.output.replaceAll("Would remove ", "Removing "));
  assert.equal(py.FS.analyzePath(`${scoped}/-dash.txt`).exists, false);
  assert.equal(py.FS.analyzePath(`${scoped}/direct.txt`).exists, false);
  assert.equal(py.FS.analyzePath(`${scoped}/nested`).exists, false);
  assert.equal(py.FS.analyzePath(scoped).exists, true);
  assert.equal(py.FS.analyzePath(`${scoped}/empty/a/b`).exists, true);
  assert.equal(py.FS.analyzePath(`${scoped}/ignored.log`).exists, true);
  assert.equal(py.FS.analyzePath(`${scoped}/ignored-dir/keep.txt`).exists, true);
  assert.equal(py.FS.readFile(`${repository}/root.txt`, { encoding: "utf8" }), "root work must survive\n");
  assert.equal(
    py.FS.readFile(`${scoped}/tracked.txt`, { encoding: "utf8" }),
    "scoped staged must survive\n",
  );

  py.FS.mkdirTree(`${repository}/bucket`);
  py.FS.writeFile(`${repository}/bucket/one.txt`, "one\n");
  py.FS.writeFile(`${repository}/bucket/two.txt`, "two\n");
  const exactPreview = await gitResult(py, repository, "clean", "--dry-run", "--", "bucket/one.txt");
  assert.equal(exactPreview.exitCode, 0, exactPreview.output);
  assert.equal(exactPreview.output, "Would remove bucket/one.txt\n");
  await git(py, repository, "clean", "--force", "--", "bucket/one.txt");
  assert.equal(py.FS.analyzePath(`${repository}/bucket/one.txt`).exists, false);
  assert.equal(py.FS.readFile(`${repository}/bucket/two.txt`, { encoding: "utf8" }), "two\n");
  const prefixPreview = await gitResult(py, repository, "clean", "-n", "-d", "--", "bucket");
  assert.equal(prefixPreview.exitCode, 0, prefixPreview.output);
  assert.equal(prefixPreview.output, "Would remove bucket/two.txt\nWould remove bucket/\n");
  const prefixAction = await git(py, repository, "clean", "-f", "-d", "--", "bucket");
  assert.equal(prefixAction, prefixPreview.output.replaceAll("Would remove ", "Removing "));
  assert.equal(py.FS.analyzePath(`${repository}/bucket`).exists, false);

  py.FS.writeFile(`${repository}/multi-a.txt`, "a\n");
  py.FS.writeFile(`${repository}/multi-b.txt`, "b\n");
  py.FS.writeFile(`${repository}/-root-dash.txt`, "dash\n");
  const dryRunWins = await gitResult(
    py, repository, "clean", "-nf", "--", "multi-a.txt", "-root-dash.txt",
  );
  assert.equal(dryRunWins.exitCode, 0, dryRunWins.output);
  assert.equal(
    dryRunWins.output,
    "Would remove -root-dash.txt\nWould remove multi-a.txt\n",
  );
  assert.equal(py.FS.analyzePath(`${repository}/multi-a.txt`).exists, true);
  await git(py, repository, "clean", "-f", "--", "multi-a.txt", "-root-dash.txt");
  assert.equal(py.FS.analyzePath(`${repository}/multi-a.txt`).exists, false);
  assert.equal(py.FS.analyzePath(`${repository}/-root-dash.txt`).exists, false);
  assert.equal(py.FS.readFile(`${repository}/multi-b.txt`, { encoding: "utf8" }), "b\n");

  py.FS.writeFile(`${scoped}/local.txt`, "local\n");
  assert.equal(
    (await gitResult(py, scoped, "clean", "-n", "--", "local.txt")).output,
    "Would remove scoped/local.txt\n",
  );
  await git(py, scoped, "clean", "-f", "--", "local.txt");
  assert.equal(py.FS.analyzePath(`${scoped}/local.txt`).exists, false);
  assert.deepEqual(await gitResult(py, repository, "clean", "-n", "--", "missing.txt"), {
    exitCode: 0,
    output: "",
  });

  const nulPaths = [
    "-nul-dash.txt",
    "nul-line\nbreak.txt",
    "nul-plain.txt",
    "nul-tab\tname.txt",
  ];
  for (const path of nulPaths) py.FS.writeFile(`${repository}/${path}`, `${path.length}\n`);
  const nulExpected = `${nulPaths.join("\0")}\0`;
  const nulPreview = await gitResult(py, repository, "clean", "-nz", "--", ...nulPaths);
  assert.equal(nulPreview.exitCode, 0, nulPreview.output);
  assert.equal(nulPreview.output, nulExpected);
  for (const path of nulPaths) assert.equal(py.FS.analyzePath(`${repository}/${path}`).exists, true);
  const nulDryRunWins = await gitResult(
    py, repository, "clean", "-nfz", "--", ...nulPaths,
  );
  assert.equal(nulDryRunWins.exitCode, 0, nulDryRunWins.output);
  assert.equal(nulDryRunWins.output, nulExpected);
  for (const path of nulPaths) assert.equal(py.FS.analyzePath(`${repository}/${path}`).exists, true);
  const nulAction = await gitResult(
    py, repository, "clean", "--force", "--null", "--", ...nulPaths,
  );
  assert.equal(nulAction.exitCode, 0, nulAction.output);
  assert.equal(nulAction.output, nulExpected);
  for (const path of nulPaths) assert.equal(py.FS.analyzePath(`${repository}/${path}`).exists, false);
  assert.deepEqual(await gitResult(py, repository, "clean", "-nz", "--", "missing.txt"), {
    exitCode: 0,
    output: "",
  });

  const exactSelectors = Array(100).fill("multi-b.txt");
  assert.equal((await gitResult(
    py, repository, "clean", "-nz", "--", ...exactSelectors,
  )).output, "multi-b.txt\0");
  const tooManySelectors = await gitResult(
    py, repository, "clean", "-nz", "--", ...exactSelectors, "multi-b.txt",
  );
  assert.equal(tooManySelectors.exitCode, 2);
  assert.match(tooManySelectors.output, /at most 100 path selectors/);
  assert.equal((await gitResult(
    py, repository, "clean", "-nz", "--", "x".repeat(4_096),
  )).exitCode, 0);
  const oversizedSelector = await gitResult(
    py, repository, "clean", "-nz", "--", "x".repeat(4_097),
  );
  assert.equal(oversizedSelector.exitCode, 2);
  assert.match(oversizedSelector.output, /selector exceeds 4096 bytes/);
  assert.equal((await gitResult(
    py, repository, "clean", "-nz", "--", ...Array(16).fill("x".repeat(4_096)),
  )).exitCode, 0);
  const oversizedSelectorBatch = await gitResult(
    py, repository, "clean", "-nz", "--", ...Array(17).fill("x".repeat(4_096)),
  );
  assert.equal(oversizedSelectorBatch.exitCode, 2);
  assert.match(oversizedSelectorBatch.output, /exceed 65536 aggregate bytes/);
  assert.equal(py.FS.analyzePath(`${repository}/multi-b.txt`).exists, true);

  py.FS.writeFile(`${repository}/failure-a.txt`, "removed before failure\n");
  py.FS.writeFile(`${repository}/failure-line\nname.txt`, "must survive failure\n");
  const unlink = py.FS.unlink.bind(py.FS);
  py.FS.unlink = (path: string) => {
    if (path === `${repository}/failure-line\nname.txt`) {
      throw new Error("injected clean unlink failure");
    }
    unlink(path);
  };
  try {
    const runtimeFailure = await gitResult(
      py, repository, "clean", "-fz", "--", "failure-a.txt", "failure-line\nname.txt",
    );
    assert.equal(runtimeFailure.exitCode, 1);
    assert.match(runtimeFailure.output, /clean failed to remove "failure-line\\012name\.txt"/);
    assert.match(runtimeFailure.output, /injected clean unlink failure/);
    assert.doesNotMatch(runtimeFailure.output, /\0/);
  } finally {
    py.FS.unlink = unlink;
  }
  assert.equal(py.FS.analyzePath(`${repository}/failure-a.txt`).exists, false);
  assert.equal(py.FS.analyzePath(`${repository}/failure-line\nname.txt`).exists, true);
  py.FS.unlink(`${repository}/failure-line\nname.txt`);

  for (const args of [
    ["clean", "-d"],
    ["clean", "--bogus"],
    ["clean", "-n", "multi-b.txt"],
  ]) {
    const rejected = await gitResult(py, repository, ...args);
    assert.equal(rejected.exitCode, 2, `${args.join(" ")}: ${rejected.output}`);
  }
  const escaped = await gitResult(py, scoped, "clean", "-n", "--", "../../outside.txt");
  assert.equal(escaped.exitCode, 1);
  assert.match(escaped.output, /outside the repository/);
  assert.equal(py.FS.analyzePath(`${repository}/root-u.txt`).exists, true);
  assert.equal(py.FS.analyzePath(`${repository}/sibling/sibling-u.txt`).exists, true);
  assert.equal(py.FS.analyzePath(`${repository}/multi-b.txt`).exists, true);

  const help = await git(py, repository, "help", "clean");
  assert.match(help, /--dry-run.*--force.*--null.*\[-- paths/);
  assert.match(help, /compact -nfdz\/-nXdz.*-X selects only ignored untracked entries/s);
});

test("bounded Git clean -X removes only ignored leaves and wholly ignored directories", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/clean-ignored-protocol";
  py.FS.mkdirTree(repository);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(
    `${repository}/.gitignore`,
    "/ignored.txt\n" +
      "/ignored-tree/\n" +
      "/empty-ignored/\n" +
      "/mixed/*.ign\n" +
      "/nested/*.log\n" +
      "!/nested/keep.log\n" +
      "/parent/*\n" +
      "!/parent/reinclude.txt\n" +
      "/weird/*\n" +
      "/race-*.ign\n" +
      "/race-dir/\n",
  );
  py.FS.writeFile(`${repository}/tracked.txt`, "tracked\n");
  py.FS.writeFile(`${repository}/staged.txt`, "staged base\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "ignored clean base");
  py.FS.writeFile(`${repository}/staged.txt`, "staged work\n");
  await git(py, repository, "add", "staged.txt");

  py.FS.writeFile(`${repository}/ordinary.txt`, "ordinary\n");
  py.FS.writeFile(`${repository}/ignored.txt`, "ignored\n");
  py.FS.mkdirTree(`${repository}/ignored-tree/sub`);
  py.FS.writeFile(`${repository}/ignored-tree/a`, "a\n");
  py.FS.writeFile(`${repository}/ignored-tree/sub/b`, "b\n");
  py.FS.mkdirTree(`${repository}/empty-ignored`);
  py.FS.mkdirTree(`${repository}/mixed`);
  py.FS.writeFile(`${repository}/mixed/drop.ign`, "drop\n");
  py.FS.writeFile(`${repository}/mixed/ordinary.txt`, "ordinary mixed\n");
  py.FS.mkdirTree(`${repository}/nested`);
  py.FS.writeFile(`${repository}/nested/bad.log`, "bad\n");
  py.FS.writeFile(`${repository}/nested/keep.log`, "keep\n");
  py.FS.writeFile(`${repository}/nested/plain`, "plain\n");
  py.FS.mkdirTree(`${repository}/parent`);
  py.FS.writeFile(`${repository}/parent/drop`, "drop\n");
  py.FS.writeFile(`${repository}/parent/reinclude.txt`, "keep\n");
  py.FS.mkdirTree(`${repository}/link-target`);
  py.FS.writeFile(`${repository}/link-target/inside`, "target\n");
  py.FS.symlink("link-target", `${repository}/linkdir`);
  py.FS.mkdirTree(`${repository}/weird`);
  py.FS.writeFile(`${repository}/weird/-lead`, "dash\n");
  py.FS.writeFile(`${repository}/weird/tab\tname`, "tab\n");
  py.FS.writeFile(`${repository}/weird/line\nname`, "line\n");
  py.FS.symlink("../link-target/inside", `${repository}/weird/ignored-sym`);

  const ignoredLeaves = [
    "ignored-tree/a",
    "ignored-tree/sub/b",
    "ignored.txt",
    "mixed/drop.ign",
    "nested/bad.log",
    "parent/drop",
    "weird/-lead",
    "weird/ignored-sym",
    "weird/line\nname",
    "weird/tab\tname",
  ];
  const leafOutput = `${ignoredLeaves.join("\0")}\0`;
  const leafPreview = await gitResult(py, repository, "clean", "-nXz");
  assert.deepEqual(leafPreview, { exitCode: 0, output: leafOutput });
  for (const path of ignoredLeaves) {
    assert.equal(py.FS.analyzePath(`${repository}/${path}`).exists, true, path);
  }
  assert.equal((await gitResult(py, repository, "clean", "--dry-run", "--ignored-only", "--null")).output, leafOutput);
  assert.equal((await gitResult(py, repository, "clean", "-nfXz")).output, leafOutput);

  const directoryOutput = leafOutput +
    "ignored-tree/sub/\0empty-ignored/\0ignored-tree/\0";
  assert.equal((await gitResult(py, repository, "clean", "-nXdz")).output, directoryOutput);
  assert.equal(
    (await gitResult(py, repository, "clean", "-nXdz", "--", "ignored-tree")).output,
    "ignored-tree/a\0ignored-tree/sub/b\0ignored-tree/sub/\0ignored-tree/\0",
  );
  assert.deepEqual(await gitResult(py, repository, "clean", "-nXdz", "--", "missing"), {
    exitCode: 0,
    output: "",
  });
  assert.equal(
    (await gitResult(py, `${repository}/nested`, "clean", "-nXz")).output,
    "nested/bad.log\0",
  );
  assert.equal(
    (await gitResult(py, repository, "clean", "-nXz", "--", "mixed", "parent")).output,
    "mixed/drop.ign\0parent/drop\0",
  );

  const symlinkTraversal = await gitResult(
    py, repository, "clean", "-fXdz", "--", "linkdir/inside", "ignored.txt",
  );
  assert.equal(symlinkTraversal.exitCode, 1);
  assert.match(symlinkTraversal.output, /refuses symlink ancestry/);
  assert.equal(py.FS.analyzePath(`${repository}/ignored.txt`).exists, true);
  assert.equal(py.FS.readFile(`${repository}/link-target/inside`, { encoding: "utf8" }), "target\n");
  for (const option of ["-x", "-xX", "--exclude-standard"]) {
    const rejected = await gitResult(py, repository, "clean", "-n", option);
    assert.equal(rejected.exitCode, 2, `${option}: ${rejected.output}`);
    assert.match(rejected.output, /unsupported clean option/);
  }

  const action = await gitResult(py, repository, "clean", "-fXdz");
  assert.deepEqual(action, { exitCode: 0, output: directoryOutput });
  for (const path of ignoredLeaves) {
    assert.equal(py.FS.analyzePath(`${repository}/${path}`).exists, false, path);
  }
  assert.equal(py.FS.analyzePath(`${repository}/ignored-tree`).exists, false);
  assert.equal(py.FS.analyzePath(`${repository}/empty-ignored`).exists, false);
  assert.equal(py.FS.analyzePath(`${repository}/mixed`).exists, true);
  assert.equal(py.FS.readFile(`${repository}/mixed/ordinary.txt`, { encoding: "utf8" }), "ordinary mixed\n");
  assert.equal(py.FS.readFile(`${repository}/nested/keep.log`, { encoding: "utf8" }), "keep\n");
  assert.equal(py.FS.readFile(`${repository}/nested/plain`, { encoding: "utf8" }), "plain\n");
  assert.equal(py.FS.readFile(`${repository}/parent/reinclude.txt`, { encoding: "utf8" }), "keep\n");
  assert.equal(py.FS.readFile(`${repository}/ordinary.txt`, { encoding: "utf8" }), "ordinary\n");
  assert.equal(py.FS.readFile(`${repository}/tracked.txt`, { encoding: "utf8" }), "tracked\n");
  assert.equal(py.FS.readFile(`${repository}/staged.txt`, { encoding: "utf8" }), "staged work\n");
  assert.equal(py.FS.readFile(`${repository}/link-target/inside`, { encoding: "utf8" }), "target\n");

  py.FS.writeFile(`${repository}/race-a.ign`, "first\n");
  py.FS.writeFile(`${repository}/race-b.ign`, "original\n");
  const unlink = py.FS.unlink.bind(py.FS);
  py.FS.unlink = (path: string) => {
    unlink(path);
    if (path === `${repository}/race-a.ign`) {
      unlink(`${repository}/race-b.ign`);
      py.FS.writeFile(`${repository}/race-b.ign`, "replacement\n");
    }
  };
  let raced;
  try {
    raced = await runGitEngineCommand({
      py,
      cwd: repository,
      args: ["git-engine", "clean", "-fXz", "--", "race-a.ign", "race-b.ign"],
    });
  } finally {
    py.FS.unlink = unlink;
  }
  assert.equal(raced.exitCode, 1);
  assert.equal(new TextDecoder().decode(raced.stdout), "race-a.ign\0");
  assert.match(new TextDecoder().decode(raced.stderr), /race-b\.ign.*changed during the operation/);
  assert.equal(py.FS.analyzePath(`${repository}/race-a.ign`).exists, false);
  assert.equal(py.FS.readFile(`${repository}/race-b.ign`, { encoding: "utf8" }), "replacement\n");

  py.FS.mkdirTree(`${repository}/race-dir`);
  py.FS.writeFile(`${repository}/race-dir/leaf`, "leaf\n");
  const unlinkWithChild = py.FS.unlink.bind(py.FS);
  py.FS.unlink = (path: string) => {
    unlinkWithChild(path);
    if (path === `${repository}/race-dir/leaf`) {
      py.FS.writeFile(`${repository}/race-dir/appeared`, "new\n");
    }
  };
  try {
    raced = await runGitEngineCommand({
      py,
      cwd: repository,
      args: ["git-engine", "clean", "-fXdz", "--", "race-dir"],
    });
  } finally {
    py.FS.unlink = unlinkWithChild;
  }
  assert.equal(raced.exitCode, 1);
  assert.equal(new TextDecoder().decode(raced.stdout), "race-dir/leaf\0");
  assert.match(new TextDecoder().decode(raced.stderr), /race-dir\/.*contents changed/);
  assert.equal(py.FS.readFile(`${repository}/race-dir/appeared`, { encoding: "utf8" }), "new\n");

  const help = await git(py, repository, "help", "clean");
  assert.match(help, /-X\|--ignored-only/);
  assert.match(help, /compact -nfdz\/-nXdz/);
  assert.match(help, /ordinary-untracked.*re-included.*git-dir.*out-of-scope/s);
  assert.match(help, /-x is unavailable/);
});

test("bounded Git stash validates top-entry workflows and retains recovery refs", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const repository = "/home/web/stash-protocol";
  py.FS.mkdirTree(repository);
  await git(py, repository, "init", "-b", "main");
  py.FS.writeFile(`${repository}/f.txt`, "base f\n");
  py.FS.writeFile(`${repository}/g.txt`, "base g\n");
  py.FS.writeFile(`${repository}/delete.txt`, "base delete\n");
  py.FS.writeFile(`${repository}/binary.bin`, new Uint8Array([0, 1, 2, 0xfe, 0xff]));
  py.FS.symlink("f.txt", `${repository}/relative-link`);
  py.FS.writeFile(`${repository}/.gitignore`, "*.ignored\n");
  await git(py, repository, "add", "-A");
  await git(py, repository, "commit", "-m", "stash base");

  assert.deepEqual(await gitResult(py, repository, "stash", "push"), {
    exitCode: 0,
    output: "No local changes to save\n",
  });
  py.FS.writeFile(`${repository}/untracked.txt`, "untracked survives\n");
  py.FS.writeFile(`${repository}/keep.ignored`, "ignored survives\n");
  assert.deepEqual(await gitResult(py, repository, "stash"), {
    exitCode: 0,
    output: "No local changes to save\n",
  });
  assert.equal((await gitResult(py, repository, "stash", "list")).output, "");

  py.FS.writeFile(`${repository}/f.txt`, "staged f\n");
  await git(py, repository, "add", "f.txt");
  py.FS.writeFile(`${repository}/g.txt`, "work g\n");
  py.FS.unlink(`${repository}/delete.txt`);
  py.FS.writeFile(`${repository}/binary.bin`, new Uint8Array([9, 8, 7, 0, 0xff]));
  py.FS.unlink(`${repository}/relative-link`);
  py.FS.symlink("g.txt", `${repository}/relative-link`);
  const pushed = await gitResult(py, repository, "stash", "push");
  assert.equal(pushed.exitCode, 0, pushed.output);
  assert.match(pushed.output, /^Saved working directory WIP on main:/);
  assert.equal((await gitResult(py, repository, "status", "--short")).output, "?? untracked.txt\n");
  assert.match((await gitResult(py, repository, "stash", "list")).output, /^stash@\{0\}: WIP on main:/);
  const firstRef = (await git(py, repository, "rev-parse", "refs/stash")).trim();

  await git(py, repository, "stash", "apply");
  const appliedStatus = (await gitResult(py, repository, "status", "--short")).output;
  assert.match(appliedStatus, /^ M f\.txt$/m);
  assert.match(appliedStatus, /^ M g\.txt$/m);
  assert.match(appliedStatus, /^ D delete\.txt$/m);
  assert.match(appliedStatus, /^ M binary\.bin$/m);
  assert.match(appliedStatus, /^ M relative-link$/m);
  assert.match(appliedStatus, /^\?\? untracked\.txt$/m);
  assert.equal(py.FS.readFile(`${repository}/f.txt`, { encoding: "utf8" }), "staged f\n");
  assert.equal(py.FS.readFile(`${repository}/g.txt`, { encoding: "utf8" }), "work g\n");
  assert.deepEqual(py.FS.readFile(`${repository}/binary.bin`), new Uint8Array([9, 8, 7, 0, 0xff]));
  assert.equal(py.FS.readlink(`${repository}/relative-link`), "g.txt");
  assert.equal((await git(py, repository, "rev-parse", "refs/stash")).trim(), firstRef);
  assert.match((await gitResult(py, repository, "stash", "list")).output, /^stash@\{0\}:/);
  const dropped = await gitResult(py, repository, "stash", "drop");
  assert.deepEqual(dropped, { exitCode: 0, output: "Dropped refs/stash@{0}\n" });
  assert.equal((await gitResult(py, repository, "stash", "list")).output, "");
  assert.equal((await gitResult(py, repository, "rev-parse", "--verify", "--quiet", "refs/stash")).exitCode, 1);
  assert.equal(py.FS.readFile(`${repository}/untracked.txt`, { encoding: "utf8" }), "untracked survives\n");
  assert.equal(py.FS.readFile(`${repository}/keep.ignored`, { encoding: "utf8" }), "ignored survives\n");

  await git(py, repository, "reset", "--hard", "HEAD");
  py.FS.writeFile(`${repository}/f.txt`, "stash one\n");
  await git(py, repository, "stash");
  const oneRef = (await git(py, repository, "rev-parse", "refs/stash")).trim();
  py.FS.writeFile(`${repository}/f.txt`, "stash two\n");
  await git(py, repository, "stash", "push");
  const twoRef = (await git(py, repository, "rev-parse", "refs/stash")).trim();
  assert.notEqual(twoRef, oneRef);
  assert.equal((await gitResult(py, repository, "stash", "list")).output.trim().split("\n").length, 2);
  await git(py, repository, "stash", "pop");
  assert.equal(py.FS.readFile(`${repository}/f.txt`, { encoding: "utf8" }), "stash two\n");
  assert.equal((await git(py, repository, "rev-parse", "refs/stash")).trim(), oneRef);
  assert.equal((await gitResult(py, repository, "stash", "list")).output.trim().split("\n").length, 1);
  await git(py, repository, "reset", "--hard", "HEAD");
  await git(py, repository, "stash", "pop");
  assert.equal(py.FS.readFile(`${repository}/f.txt`, { encoding: "utf8" }), "stash one\n");
  assert.equal((await gitResult(py, repository, "stash", "list")).output, "");
  assert.equal((await gitResult(py, repository, "rev-parse", "--verify", "--quiet", "refs/stash")).exitCode, 1);

  await git(py, repository, "reset", "--hard", "HEAD");
  py.FS.writeFile(`${repository}/f.txt`, "stashed conflict\n");
  await git(py, repository, "stash", "push");
  const conflictRef = (await git(py, repository, "rev-parse", "refs/stash")).trim();
  py.FS.writeFile(`${repository}/f.txt`, "divergent commit\n");
  await git(py, repository, "add", "f.txt");
  await git(py, repository, "commit", "-m", "divergent stash base");
  const conflicted = await gitResult(py, repository, "stash", "pop");
  assert.equal(conflicted.exitCode, 1, conflicted.output);
  assert.match(conflicted.output, /stash apply produced conflicts in f\.txt; stash retained/);
  assert.match(
    py.FS.readFile(`${repository}/f.txt`, { encoding: "utf8" }) as string,
    /<<<<<<< Updated upstream/,
  );
  assert.equal((await git(py, repository, "rev-parse", "refs/stash")).trim(), conflictRef);
  assert.match((await gitResult(py, repository, "stash", "list")).output, /^stash@\{0\}:/);

  const statusBeforeRejected = (await gitResult(py, repository, "status", "--short")).output;
  const refBeforeRejected = (await git(py, repository, "rev-parse", "refs/stash")).trim();
  for (const args of [
    ["stash", "apply", "stash@{1}"],
    ["stash", "drop", "stash@{99}"],
    ["stash", "pop", "--index"],
    ["stash", "push", "-m", "message"],
    ["stash", "push", "-u"],
    ["stash", "clear"],
    ["stash", "show"],
  ]) {
    const rejected = await gitResult(py, repository, ...args);
    assert.equal(rejected.exitCode, 2, `${args.join(" ")}: ${rejected.output}`);
    assert.equal((await gitResult(py, repository, "status", "--short")).output, statusBeforeRejected);
    assert.equal((await git(py, repository, "rev-parse", "refs/stash")).trim(), refBeforeRejected);
    assert.match((await gitResult(py, repository, "stash", "list")).output, /^stash@\{0\}:/);
  }
  assert.match(
    (await gitResult(py, repository, "stash", "push", "-m", "message")).output,
    /^git: custom stash messages are unavailable\n$/,
  );
  assert.match(
    (await gitResult(py, repository, "stash", "apply", "stash@{1}")).output,
    /^git: stash apply targets the top entry and accepts no options or operands\n$/,
  );

  await git(py, repository, "reset", "--hard", "HEAD");
  await git(py, repository, "stash", "drop");
  for (const operation of ["apply", "pop", "drop"] as const) {
    const empty = await gitResult(py, repository, "stash", operation);
    assert.deepEqual(empty, { exitCode: 1, output: "git: no stash entries found\n" });
  }
  assert.deepEqual(await gitResult(py, repository, "stash", "list"), { exitCode: 0, output: "" });
  const help = await git(py, repository, "help", "stash");
  assert.match(help, /stash apply.*stash pop.*stash drop/);
  assert.match(help, /tracked changes only.*top entry/s);
  assert.match(help, /custom messages.*--index.*include-untracked/s);
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
    py.FS.mkdirTree("/home/web/smart/untracked-dir/sub");
    py.FS.writeFile("/home/web/smart/untracked-dir/sub/value.txt", "remove tree\n");
    const cleanDirectories = await gitResult(py, "/home/web/smart", "clean", "-n", "-d");
    assert.match(cleanDirectories.output, /Would remove untracked-dir\/sub\/value\.txt/);
    assert.match(cleanDirectories.output, /Would remove untracked-dir\/sub\//);
    assert.match(cleanDirectories.output, /Would remove untracked-dir\//);
    assert.equal(py.FS.analyzePath("/home/web/smart/untracked-dir").exists, true);
    const removedDirectories = await git(py, "/home/web/smart", "clean", "-f", "-d");
    assert.equal(removedDirectories, cleanDirectories.output.replaceAll("Would remove ", "Removing "));
    assert.equal(py.FS.analyzePath("/home/web/smart/untracked-dir").exists, false);

    py.FS.mkdirTree("/home/web/smart/requires-d/sub");
    py.FS.writeFile("/home/web/smart/requires-d/sub/value.txt", "keep without d\n");
    await git(py, "/home/web/smart", "clean", "-f");
    assert.equal(py.FS.readFile("/home/web/smart/requires-d/sub/value.txt", { encoding: "utf8" }), "keep without d\n");
    await git(py, "/home/web/smart", "clean", "-f", "-d");
    assert.equal(py.FS.analyzePath("/home/web/smart/requires-d").exists, false);

    py.FS.mkdirTree("/home/web/smart/tracked-dir");
    py.FS.writeFile("/home/web/smart/tracked-dir/keep.txt", "tracked\n");
    py.FS.writeFile("/home/web/smart/.gitignore", "mixed/ignored.keep\n");
    await git(py, "/home/web/smart", "add", "tracked-dir", ".gitignore");
    await git(py, "/home/web/smart", "commit", "-m", "clean safety fixtures");
    py.FS.mkdirTree("/home/web/smart/mixed");
    py.FS.writeFile("/home/web/smart/mixed/remove.txt", "remove\n");
    py.FS.writeFile("/home/web/smart/mixed/ignored.keep", "ignored\n");
    py.FS.symlink("tracked-dir", "/home/web/smart/untracked-link");
    await git(py, "/home/web/smart", "clean", "-f", "-d");
    assert.equal(py.FS.analyzePath("/home/web/smart/mixed/remove.txt").exists, false);
    assert.equal(py.FS.analyzePath("/home/web/smart/mixed/ignored.keep").exists, true);
    assert.equal(py.FS.analyzePath("/home/web/smart/mixed").exists, true);
    assert.equal(py.FS.analyzePath("/home/web/smart/untracked-link").exists, false);
    assert.equal(py.FS.readFile("/home/web/smart/tracked-dir/keep.txt", { encoding: "utf8" }), "tracked\n");
    await git(py, "/home/web/smart", "config", "browser.test", "yes");
    assert.match((await gitResult(py, "/home/web/smart", "config", "--list")).output, /browser\.test=yes/);
    await git(py, "/home/web/smart", "branch", "at-main", "main");
    await git(py, "/home/web/smart", "branch", "-m", "at-main", "renamed-main");
    assert.equal((await gitResult(py, "/home/web/smart", "branch", "--show-current")).output, "main\n");
    for (const [topic, feature] of [
      ["branch", /--show-current/],
      ["status", /-sb/],
      ["rev-parse", /--abbrev-ref HEAD/],
      ["remote", /get-url/],
      ["config", /--global\|--local/],
      ["switch", /--create/],
      ["init", /--initial-branch/],
      ["restore", /-S\|--staged/],
    ] as const) {
      const commandHelp = await gitResult(py, "/home/web/smart", "help", topic);
      assert.equal(commandHelp.exitCode, 0, commandHelp.output);
      assert.match(commandHelp.output, feature);
    }
    for (const [malformed, message] of [
      [["branch", "--show-current", "extra"], /accepts no other options or operands/],
      [["branch", "-d"], /requires exactly one branch name/],
      [["branch", "-d", "renamed-main", "extra"], /requires exactly one branch name/],
      [["branch", "--list", "would-create"], /does not accept patterns/],
      [["branch", "-a", "would-create"], /does not accept patterns/],
      [["branch", "-m", "-d", "renamed-main"], /mutually exclusive/],
    ] as const) {
      const rejected = await gitResult(py, "/home/web/smart", ...malformed);
      assert.equal(rejected.exitCode, 2, rejected.output);
      assert.match(rejected.output, message);
    }
    const branchesAfterRejectedCommands = (await gitResult(py, "/home/web/smart", "branch")).output;
    assert.match(branchesAfterRejectedCommands, /renamed-main/);
    assert.doesNotMatch(branchesAfterRejectedCommands, /would-create/);
    assert.match((await gitResult(py, "/home/web/smart", "fsck")).output, /no errors/);
    assert.match((await gitResult(py, "/home/web/smart", "gc")).output, /Packed and pruned/);
    const packFiles = py.FS.readdir("/home/web/smart/.git/objects/pack");
    assert.ok(packFiles.some((name) => name.endsWith(".pack")));
    assert.ok(packFiles.some((name) => name.endsWith(".idx")));
    const looseObjects = py.FS.readdir("/home/web/smart/.git/objects").filter((name) => /^[0-9a-f]{2}$/.test(name));
    assert.equal(looseObjects.length, 0);
    assert.match((await gitResult(py, "/home/web/smart", "fsck")).output, /no errors/);
    assert.equal((await gitResult(py, "/home/web/smart", "rev-parse", "--abbrev-ref", "HEAD")).output, "main\n");
    const verifiedHead = (await gitResult(py, "/home/web/smart", "rev-parse", "--verify", "HEAD")).output.trim();
    assert.match(verifiedHead, /^[0-9a-f]{40}$/);
    assert.equal((await gitResult(py, "/home/web/smart", "rev-parse", "--short", "HEAD")).output, `${verifiedHead.slice(0, 7)}\n`);
    assert.equal((await gitResult(py, "/home/web/smart", "rev-parse", "--verify", "--short=12", "HEAD")).output, `${verifiedHead.slice(0, 12)}\n`);
    assert.equal((await gitResult(py, "/home/web/smart", "rev-parse", "--git-common-dir")).output, "/home/web/smart/.git\n");
    assert.deepEqual(await gitResult(py, "/home/web/smart", "rev-parse", "--verify", "--quiet", "missing-ref"), { exitCode: 1, output: "" });
    const invalidShort = await gitResult(py, "/home/web/smart", "rev-parse", "--short=2", "HEAD");
    assert.equal(invalidShort.exitCode, 2);
    assert.match(invalidShort.output, /short length must be from 4 to 40/);

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
