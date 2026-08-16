import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { loadPyodide } from "pyodide";

import { runGitEngineCommand } from "../src/git-engine.ts";
import { smartListServerRefs } from "../src/git-smart-http.ts";
import type { GitHubCredentials } from "../src/git-remote.ts";
import type { Pyodide } from "../src/pyodide-host.ts";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function archive(path: string, value: string): Response {
  const data = Buffer.from(value);
  const header = Buffer.alloc(512);
  header.write(`snapshot/${path}`, 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0", 257, "ascii");
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
  const tar = Buffer.concat([header, data, padding, Buffer.alloc(1024)]);
  return new Response(gzipSync(tar), { status: 200, headers: { "Content-Type": "application/x-gzip" } });
}

test("native Git remote bridge clones and pushes GitHub snapshots", { timeout: 120_000 }, async () => {
  const py = (await loadPyodide()) as unknown as Pyodide;
  const root = "/home/web/repo";

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; authorization: string | null; body: string }> = [];
  let remoteCommit = "remote0";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      method,
      authorization: headers.get("Authorization"),
      body: typeof init?.body === "string" ? init.body : "",
    });
    if (url.endsWith("/repos/acme/demo")) {
      return json({ name: "demo", full_name: "acme/demo", default_branch: "main" });
    }
    if (url.endsWith("/repos/acme/demo/commits/main")) {
      return json({
        sha: remoteCommit,
        commit: { message: "remote", tree: { sha: remoteCommit === "remote2" ? "tree2" : "tree0" } },
      });
    }
    if (url.endsWith("/repos/acme/demo/commits/remote2")) {
      return json({ sha: "remote2", commit: { message: "remote", tree: { sha: "tree2" } } });
    }
    if (url.endsWith("/repos/acme/demo/commits/published")) {
      return new Response(JSON.stringify({ message: "No commit found for SHA: published" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/repos/acme/demo/git/trees/tree0?recursive=1")) {
      return json({
        sha: "tree0",
        truncated: false,
        tree: [{ path: "hello.txt", mode: "100644", type: "blob", sha: "blob0", size: 6 }],
      });
    }
    if (url.includes("/repos/acme/demo/git/trees/tree2?recursive=1")) {
      return json({
        sha: "tree2",
        truncated: false,
        tree: [{ path: "hello.txt", mode: "100644", type: "blob", sha: "blob2", size: 12 }],
      });
    }
    if (url.endsWith("/repos/acme/demo/tarball/remote0")) return archive("hello.txt", "hello\n");
    if (url.endsWith("/repos/acme/demo/tarball/remote2")) return archive("hello.txt", "from remote\n");
    if (url.endsWith("/repos/acme/demo/git/matching-refs/heads/")) {
      return json([
        { ref: "refs/heads/main", object: { sha: remoteCommit } },
        { ref: "refs/heads/feature", object: { sha: "feature0" } },
      ]);
    }
    if (url.endsWith("/repos/acme/demo/git/matching-refs/tags/")) {
      return json([{ ref: "refs/tags/v1", object: { sha: "tag0" } }]);
    }
    if (url.endsWith("/repos/acme/demo/git/blobs/blob0")) {
      return json({ content: btoa("hello\n"), encoding: "base64", size: 6 });
    }
    if (url.endsWith("/repos/acme/demo/git/blobs/blob2")) {
      return json({ content: btoa("from remote\n"), encoding: "base64", size: 12 });
    }
    if (url.endsWith("/repos/acme/demo/git/blobs") && method === "POST") {
      return json({ sha: "blob1" });
    }
    if (url.endsWith("/repos/acme/demo/git/trees") && method === "POST") {
      return json({ sha: "tree1" });
    }
    if (url.endsWith("/repos/acme/demo/git/commits") && method === "POST") {
      return json({ sha: "remote1" });
    }
    if (url.endsWith("/repos/acme/demo/git/refs/heads/main") && method === "PATCH") {
      remoteCommit = "remote1";
      return json({ object: { sha: remoteCommit } });
    }
    if (url.endsWith("/repos/acme/demo/git/refs") && method === "POST") {
      return json({ ref: "refs/heads/published", object: { sha: remoteCommit } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const cloned = await runGitEngineCommand({
      py,
      cwd: "/home/web",
      args: ["git-engine", "clone", "acme/demo", "repo"],
    });
    assert.equal(cloned.exitCode, 0, new TextDecoder().decode(cloned.stdout));
    assert.equal(py.FS.readFile(`${root}/hello.txt`, { encoding: "utf8" }), "hello\n");
    assert.equal(requests.some((request) => request.url.endsWith("/git/blobs/blob0")), false);
    assert.match(
      py.FS.readFile(`${root}/.git/config`, { encoding: "utf8" }) as string,
      /\[remote "origin"\]/,
    );
    const remoteBranches = await runGitEngineCommand({
      py,
      cwd: root,
      args: ["git-engine", "branch", "-r"],
    });
    assert.equal(new TextDecoder().decode(remoteBranches.stdout), "");
    const snapshotInfo = await runGitEngineCommand({
      py,
      cwd: root,
      args: ["git-engine", "snapshot", "info"],
    });
    assert.match(new TextDecoder().decode(snapshotInfo.stdout), /mode=github-snapshot/);
    assert.match(new TextDecoder().decode(snapshotInfo.stdout), /upstream_commit=remote0/);
    const virtualRef = await runGitEngineCommand({
      py,
      cwd: root,
      args: ["git-engine", "rev-parse", "origin/feature"],
    });
    assert.equal(virtualRef.exitCode, 1);
    assert.match(new TextDecoder().decode(virtualRef.stderr), /not materialized/);
    const implicitSwitch = await runGitEngineCommand({
      py,
      cwd: root,
      args: ["git-engine", "switch", "feature"],
    });
    assert.equal(implicitSwitch.exitCode, 1);
    assert.match(new TextDecoder().decode(implicitSwitch.stderr), /git snapshot checkout feature/);
    const fetchSnapshot = await runGitEngineCommand({
      py,
      cwd: root,
      args: ["git-engine", "fetch"],
    });
    assert.equal(fetchSnapshot.exitCode, 1);
    assert.match(new TextDecoder().decode(fetchSnapshot.stderr), /cannot materialize objects/);
    const remoteRefs = await runGitEngineCommand({
      py,
      cwd: root,
      args: ["git-engine", "ls-remote", "origin"],
    });
    assert.match(new TextDecoder().decode(remoteRefs.stdout), /refs\/tags\/v1/);

    py.FS.writeFile(`${root}/hello.txt`, "changed\n");
    const credentials: GitHubCredentials = {
      apiBaseUrl: "https://api.github.com",
      token: "test-token",
      login: "tester",
      id: 42,
      name: "Test User",
    };
    const added = await runGitEngineCommand({
      py,
      cwd: root,
      args: ["git-engine", "add", "hello.txt"],
      getGitHubCredentials: () => credentials,
    });
    assert.equal(added.exitCode, 0);
    const committed = await runGitEngineCommand({
      py,
      cwd: root,
      args: ["git-engine", "commit", "-m", "browser update"],
      getGitHubCredentials: () => credentials,
    });
    assert.equal(committed.exitCode, 0, new TextDecoder().decode(committed.stdout));
    const pushed = await runGitEngineCommand({
      py,
      cwd: root,
      args: ["git-engine", "push"],
      getGitHubCredentials: () => credentials,
    });
    assert.equal(pushed.exitCode, 0, new TextDecoder().decode(pushed.stdout));
    assert.match(new TextDecoder().decode(pushed.stdout), /Pushed 1 file action/);
    assert.match(
      py.FS.readFile(`${root}/.git/piodide/remote-local-head`, { encoding: "utf8" }) as string,
      /^[0-9a-f]{40}\n$/,
    );
    assert.ok(requests.some((request) => request.method === "PATCH"));
    assert.ok(
      requests
        .filter((request) => request.method !== "GET")
        .every((request) => request.authorization === "Bearer test-token"),
    );
    const commitRequest = requests.find((request) => request.url.endsWith("/git/commits") && request.method === "POST");
    assert.match(commitRequest?.body ?? "", /browser update/);

    remoteCommit = "remote2";
    const pulled = await runGitEngineCommand({
      py,
      cwd: root,
      args: ["git-engine", "pull"],
      getGitHubCredentials: () => credentials,
    });
    assert.equal(pulled.exitCode, 0, new TextDecoder().decode(pulled.stdout));
    assert.equal(py.FS.readFile(`${root}/hello.txt`, { encoding: "utf8" }), "from remote\n");

    const created = await runGitEngineCommand({
      py,
      cwd: root,
      args: ["git-engine", "switch", "-c", "published"],
      getGitHubCredentials: () => credentials,
    });
    assert.equal(created.exitCode, 0, new TextDecoder().decode(created.stdout));
    const published = await runGitEngineCommand({
      py,
      cwd: root,
      args: ["git-engine", "push", "-u", "origin", "published"],
      getGitHubCredentials: () => credentials,
    });
    assert.equal(published.exitCode, 0, new TextDecoder().decode(published.stdout));
    assert.match(new TextDecoder().decode(published.stdout), /(?:Published|Pushed).*acme\/demo@published/);
    assert.ok(requests.some((request) => request.method === "POST" && request.url.endsWith("/git/refs")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("smart HTTP never offers a GitHub token to another host or a CORS proxy", async () => {
  const originalFetch = globalThis.fetch;
  const authorization: Array<string | null> = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    authorization.push(new Headers(init?.headers).get("Authorization"));
    return new Response("authentication required", { status: 401 });
  }) as typeof fetch;
  const credentials: GitHubCredentials = {
    apiBaseUrl: "https://api.github.com",
    token: "must-not-leak",
    login: "tester",
    id: 42,
    name: "Test",
  };
  try {
    await assert.rejects(() => smartListServerRefs({
      py: {} as Pyodide,
      url: "https://attacker.invalid/repository.git",
      credentials,
    }));
    await assert.rejects(() => smartListServerRefs({
      py: {} as Pyodide,
      url: "https://github.com/private/repository.git",
      corsProxy: "https://proxy.invalid",
      credentials,
    }));
    assert.deepEqual(authorization, [null, null]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
