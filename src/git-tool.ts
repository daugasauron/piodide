import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  type Pyodide,
  fsExists,
  fsIsDir,
  fsReadText,
  fsResolve,
  fsWriteText,
} from "./pyodide-host.ts";

const DULWICH_VERSION = "1.2.12";
const MAX_OUTPUT_BYTES = 50_000;
const MAX_REPOSITORY_BYTES = 32 * 1024 * 1024;
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_REPOSITORY_FILES = 3_000;
const MAX_PUSH_BYTES = 8 * 1024 * 1024;
const MAX_PUSH_ACTIONS = 100;
const GITHUB_API_VERSION = "2026-03-10";

const GitParams = Type.Object({
  operation: Type.Union([
    Type.Literal("init"),
    Type.Literal("status"),
    Type.Literal("add"),
    Type.Literal("commit"),
    Type.Literal("log"),
    Type.Literal("diff"),
    Type.Literal("clone"),
    Type.Literal("pull"),
    Type.Literal("push"),
  ]),
  cwd: Type.Optional(
    Type.String({
      description:
        "Repository directory. Defaults to the Python working directory; for clone, defaults to /home/web/<project>.",
    }),
  ),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Paths for add or diff, relative to the repository.",
      maxItems: 100,
    }),
  ),
  message: Type.Optional(
    Type.String({
      description: "Commit message. Required for commit; optional for push.",
      maxLength: 10_000,
    }),
  ),
  project: Type.Optional(
    Type.String({
      description:
        "GitHub repository URL or owner/repository. Required for clone.",
      maxLength: 2_000,
    }),
  ),
  branch: Type.Optional(
    Type.String({ description: "Remote branch. Defaults to the repository's default branch." }),
  ),
  staged: Type.Optional(
    Type.Boolean({ description: "For diff, compare staged changes instead of the worktree." }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum log entries (default 10, maximum 50).",
      minimum: 1,
      maximum: 50,
    }),
  ),
});

type GitParamsValue = Static<typeof GitParams>;

export interface GitHubCredentials {
  apiBaseUrl: string;
  token: string;
  login: string;
  id: number;
  name: string;
  email?: string;
}

export interface GitDetails {
  operation: string;
  cwd: string;
  files?: number;
  commit?: string;
}

interface BaselineEntry {
  id: string;
  mode: string;
}

interface GitHubRepository {
  name: string;
  full_name: string;
  default_branch: string;
}

interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    tree: { sha: string };
  };
}

interface GitHubTree {
  sha: string;
  truncated: boolean;
  tree: Array<{
    path: string;
    mode: string;
    type: "blob" | "tree" | "commit";
    sha: string;
    size?: number;
  }>;
}

interface GitHubMetadata {
  version: 1;
  apiBaseUrl: string;
  repository: string;
  branch: string;
  remoteCommit: string;
  localHead: string;
  baseline: Record<string, BaselineEntry>;
}

interface WorktreeEntry {
  bytes: Uint8Array;
  mode: string;
  id: string;
}

interface GitStatus {
  staged: Record<string, string[]>;
  unstaged: string[];
  untracked: string[];
  clean: boolean;
}

let dulwichReady: Promise<void> | null = null;

function text(value: string) {
  return { type: "text" as const, text: value };
}

export function normalizeGitHubApiUrl(value: string): string {
  const url = new URL(value.trim() || "https://api.github.com");
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("GitHub API URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("Do not put credentials in the GitHub API URL.");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export async function verifyGitHubCredentials(
  apiBaseUrl: string,
  token: string,
): Promise<GitHubCredentials> {
  const normalized = normalizeGitHubApiUrl(apiBaseUrl);
  if (!token.trim()) throw new Error("GitHub token is empty.");
  const user = await gitHubJson<{
    login?: string;
    id?: number;
    name?: string | null;
    email?: string | null;
  }>(normalized, "/user", { apiBaseUrl: normalized, token }, undefined);
  if (!user.login || !Number.isFinite(user.id)) {
    throw new Error("GitHub returned an invalid user response.");
  }
  return {
    apiBaseUrl: normalized,
    token,
    login: user.login,
    id: user.id!,
    name: user.name || user.login,
    email: user.email || undefined,
  };
}

export function createGitTool(
  py: Pyodide,
  getCredentials: () => GitHubCredentials | null,
): AgentTool<typeof GitParams, GitDetails> {
  return {
    name: "git",
    label: "Git",
    description:
      "Use a real local Git repository in the shared Pyodide filesystem, powered by " +
      "Dulwich. Supports init, status, add, commit, log, and diff. GitHub clone/pull/push " +
      "use its browser-compatible API because browser CORS blocks normal Git smart HTTP. " +
      "Run /github to register a private-repository token. Remote " +
      "synchronization is snapshot-based: commit before push, and push before pull.",
    parameters: GitParams,
    executionMode: "sequential",
    async execute(_id, params, signal) {
      await ensureDulwich(py);
      const credentials = getCredentials();
      const identity = gitIdentity(credentials);

      switch (params.operation) {
        case "init": {
          const cwd = repositoryPath(py, params.cwd);
          py.FS.mkdirTree(cwd);
          await pythonJson(py, `
from dulwich import porcelain
porcelain.init(${pythonString(cwd)})
json.dumps(True)
`);
          return {
            content: [text(`Initialized Git repository in ${cwd}\n`)],
            details: { operation: "init", cwd },
          };
        }

        case "status": {
          const cwd = repositoryPath(py, params.cwd);
          const status = await readStatus(py, cwd);
          return {
            content: [text(formatStatus(status))],
            details: { operation: "status", cwd },
          };
        }

        case "add": {
          const cwd = repositoryPath(py, params.cwd);
          assertRepository(py, cwd);
          const paths = params.paths?.length ? params.paths : null;
          validateInputPaths(paths);
          const result = await pythonJson<{ added: string[]; ignored: string[] }>(py, `
from dulwich import porcelain
_added, _ignored = porcelain.add(${pythonString(cwd)}, paths=${pythonValue(paths)})
json.dumps({
    "added": [os.fsdecode(p) for p in _added],
    "ignored": [os.fsdecode(p) for p in _ignored],
})
`);
          const suffix = result.ignored.length
            ? ` (${result.ignored.length} ignored)`
            : "";
          return {
            content: [text(`Staged ${result.added.length} path(s)${suffix} in ${cwd}\n`)],
            details: { operation: "add", cwd, files: result.added.length },
          };
        }

        case "commit": {
          const cwd = repositoryPath(py, params.cwd);
          assertRepository(py, cwd);
          if (!params.message?.trim()) throw new Error("commit requires a non-empty message.");
          const commit = await commitLocal(py, cwd, params.message.trim(), identity, false);
          return {
            content: [text(`Committed ${commit.slice(0, 12)} · ${params.message.trim()}\n`)],
            details: { operation: "commit", cwd, commit },
          };
        }

        case "log": {
          const cwd = repositoryPath(py, params.cwd);
          assertRepository(py, cwd);
          const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? 10)));
          const output = await pythonJson<string>(py, `
from dulwich import porcelain
import io
_out = io.StringIO()
porcelain.log(
    ${pythonString(cwd)},
    outstream=_out,
    max_entries=${limit},
    oneline=True,
    abbrev_commit=True,
)
json.dumps(_out.getvalue())
`);
          return {
            content: [text(capOutput(output || "(no commits)\n"))],
            details: { operation: "log", cwd },
          };
        }

        case "diff": {
          const cwd = repositoryPath(py, params.cwd);
          assertRepository(py, cwd);
          validateInputPaths(params.paths ?? null);
          const output = await pythonJson<string>(py, `
from dulwich import porcelain
import io
_out = io.BytesIO()
porcelain.diff(
    ${pythonString(cwd)},
    staged=${params.staged === true ? "True" : "False"},
    paths=${pythonValue(params.paths?.length ? params.paths : null)},
    outstream=_out,
)
json.dumps(_out.getvalue().decode("utf-8", "replace"))
`);
          return {
            content: [text(capOutput(output || "(no differences)\n"))],
            details: { operation: "diff", cwd },
          };
        }

        case "clone":
          return cloneFromGitHub(py, params, credentials, identity, signal);

        case "pull":
          return pullFromGitHub(py, params, credentials, identity, signal);

        case "push":
          return pushToGitHub(py, params, credentials, signal);
      }
    },
  };
}

async function ensureDulwich(py: Pyodide): Promise<void> {
  if (!dulwichReady) {
    dulwichReady = py
      .runPythonAsync(`
import importlib.util
if importlib.util.find_spec("dulwich") is None:
    import micropip
    await micropip.install("dulwich==${DULWICH_VERSION}")
`)
      .then(() => undefined)
      .catch((error) => {
        dulwichReady = null;
        throw error;
      });
  }
  await dulwichReady;
}

async function pythonJson<T = unknown>(py: Pyodide, body: string): Promise<T> {
  const result = await py.runPythonAsync(`
import json
import os
${body.trim()}
`);
  if (typeof result !== "string") throw new Error("Git helper returned an invalid result.");
  return JSON.parse(result) as T;
}

function pythonString(value: string): string {
  return JSON.stringify(value);
}

function pythonValue(value: unknown): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return JSON.stringify(value);
}

function repositoryPath(py: Pyodide, value?: string): string {
  const resolved = fsResolve(py, value?.trim() || ".");
  if (resolved !== "/home/web" && !resolved.startsWith("/home/web/")) {
    throw new Error("Git repositories must stay inside /home/web.");
  }
  return resolved;
}

function validateInputPaths(paths: readonly string[] | null): void {
  for (const path of paths ?? []) {
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\0") ||
      path.split("/").some((part) => part === "..")
    ) {
      throw new Error(`Git path must stay inside the repository: ${path}`);
    }
  }
}

function assertRepository(py: Pyodide, cwd: string): void {
  if (!fsExists(py, `${cwd}/.git`) || !fsIsDir(py, `${cwd}/.git`)) {
    throw new Error(`Not a Git repository: ${cwd}`);
  }
}

function gitIdentity(credentials: GitHubCredentials | null): string {
  const name = credentials?.name || credentials?.login || "piodide";
  const email =
    credentials?.email ||
    (credentials
      ? `${credentials.id}+${credentials.login}@users.noreply.github.com`
      : "piodide@browser.local");
  return `${name.replace(/[<>\n\r]/g, "")} <${email.replace(/[<>\n\r]/g, "")}>`;
}

async function readStatus(py: Pyodide, cwd: string): Promise<GitStatus> {
  assertRepository(py, cwd);
  return pythonJson<GitStatus>(py, `
from dulwich import porcelain
_status = porcelain.status(${pythonString(cwd)}, untracked_files="all")
json.dumps({
    "staged": {
        kind: [os.fsdecode(path) for path in paths]
        for kind, paths in _status.staged.items()
    },
    "unstaged": [os.fsdecode(path) for path in _status.unstaged],
    "untracked": [os.fsdecode(path) for path in _status.untracked],
    "clean": (
        not any(_status.staged.values())
        and not _status.unstaged
        and not _status.untracked
    ),
})
`);
}

function formatStatus(status: GitStatus): string {
  if (status.clean) return "Working tree clean\n";
  const lines: string[] = [];
  for (const [kind, paths] of Object.entries(status.staged)) {
    for (const path of paths) lines.push(`staged ${kind}: ${path}`);
  }
  for (const path of status.unstaged) lines.push(`unstaged: ${path}`);
  for (const path of status.untracked) lines.push(`untracked: ${path}`);
  return capOutput(lines.join("\n") + "\n");
}

async function commitLocal(
  py: Pyodide,
  cwd: string,
  message: string,
  identity: string,
  addAll: boolean,
): Promise<string> {
  return pythonJson<string>(py, `
from dulwich import porcelain
${addAll ? `porcelain.add(${pythonString(cwd)}, paths=None)` : ""}
from dulwich.repo import Repo
_repo = Repo(${pythonString(cwd)})
# Browser Python has no subprocess support. Dulwich's default hook objects
# shell out even when no hook file exists, so disable hooks for this runtime.
_repo.hooks.clear()
_commit = porcelain.commit(
    _repo,
    message=${pythonString(message)},
    author=${pythonString(identity)}.encode(),
    committer=${pythonString(identity)}.encode(),
    no_verify=True,
)
json.dumps(_commit.decode())
`);
}

async function localHead(py: Pyodide, cwd: string): Promise<string> {
  return pythonJson<string>(py, `
from dulwich.repo import Repo
json.dumps(Repo(${pythonString(cwd)}).head().decode())
`);
}

async function cloneFromGitHub(
  py: Pyodide,
  params: GitParamsValue,
  credentials: GitHubCredentials | null,
  identity: string,
  signal: AbortSignal | undefined,
): Promise<{ content: ReturnType<typeof text>[]; details: GitDetails }> {
  if (!params.project?.trim()) throw new Error("clone requires project.");
  const target = parseGitHubTarget(params.project, credentials);
  const repository = await gitHubJson<GitHubRepository>(
    target.apiBaseUrl,
    `/repos/${githubRepositoryPath(target.repository)}`,
    credentials,
    signal,
  );
  const branch = params.branch?.trim() || repository.default_branch;
  if (!branch) throw new Error("The GitHub repository has no default branch.");
  const cwd = params.cwd?.trim()
    ? repositoryPath(py, params.cwd)
    : repositoryPath(py, `/home/web/${repository.name}`);
  assertCloneDestination(py, cwd);

  const snapshot = await fetchGitHubSnapshot(
    target.apiBaseUrl,
    repository.full_name,
    branch,
    credentials,
    signal,
  );
  const files = await fetchGitHubSnapshotFiles(
    target.apiBaseUrl,
    repository.full_name,
    snapshot.baseline,
    credentials,
    signal,
  );
  py.FS.mkdirTree(cwd);
  writeSnapshotFiles(py, cwd, files);
  await pythonJson(py, `
from dulwich import porcelain
porcelain.init(${pythonString(cwd)})
json.dumps(True)
`);
  const localCommit = await commitLocal(
    py,
    cwd,
    `Import ${repository.full_name}@${snapshot.commit.sha.slice(0, 7)}`,
    identity,
    true,
  );
  writeGitHubMetadata(py, cwd, {
    version: 1,
    apiBaseUrl: target.apiBaseUrl,
    repository: repository.full_name,
    branch,
    remoteCommit: snapshot.commit.sha,
    localHead: localCommit,
    baseline: snapshot.baseline,
  });
  return {
    content: [
      text(
        `Cloned GitHub snapshot ${repository.full_name}@${branch} into ${cwd}\n` +
          `${Object.keys(snapshot.baseline).length} files · remote ${snapshot.commit.sha.slice(0, 7)}\n`,
      ),
    ],
    details: {
      operation: "clone",
      cwd,
      files: Object.keys(snapshot.baseline).length,
      commit: localCommit,
    },
  };
}

async function pullFromGitHub(
  py: Pyodide,
  params: GitParamsValue,
  credentials: GitHubCredentials | null,
  identity: string,
  signal: AbortSignal | undefined,
): Promise<{ content: ReturnType<typeof text>[]; details: GitDetails }> {
  const cwd = repositoryPath(py, params.cwd);
  const metadata = readGitHubMetadata(py, cwd);
  const status = await readStatus(py, cwd);
  if (!status.clean) throw new Error("Working tree is not clean; commit or remove changes first.");
  const head = await localHead(py, cwd);
  if (head !== metadata.localHead) {
    throw new Error("Local commits have not been pushed; push before pulling.");
  }

  const remote = await getGitHubCommit(
    metadata.apiBaseUrl,
    metadata.repository,
    metadata.branch,
    credentials,
    signal,
  );
  if (remote.sha === metadata.remoteCommit) {
    return {
      content: [text(`Already up to date with ${metadata.repository}@${metadata.branch}\n`)],
      details: { operation: "pull", cwd, commit: head },
    };
  }

  const snapshot = await fetchGitHubSnapshot(
    metadata.apiBaseUrl,
    metadata.repository,
    metadata.branch,
    credentials,
    signal,
  );
  const files = await fetchGitHubSnapshotFiles(
    metadata.apiBaseUrl,
    metadata.repository,
    snapshot.baseline,
    credentials,
    signal,
  );
  for (const oldPath of Object.keys(metadata.baseline)) {
    if (!snapshot.baseline[oldPath]) removeWorktreePath(py, cwd, oldPath);
  }
  writeSnapshotFiles(py, cwd, files);
  const localCommit = await commitLocal(
    py,
    cwd,
    `Pull ${metadata.repository}@${snapshot.commit.sha.slice(0, 7)}`,
    identity,
    true,
  );
  writeGitHubMetadata(py, cwd, {
    ...metadata,
    remoteCommit: snapshot.commit.sha,
    localHead: localCommit,
    baseline: snapshot.baseline,
  });
  return {
    content: [
      text(
        `Pulled GitHub snapshot ${metadata.repository}@${metadata.branch}\n` +
          `${Object.keys(snapshot.baseline).length} files · remote ${snapshot.commit.sha.slice(0, 7)}\n`,
      ),
    ],
    details: {
      operation: "pull",
      cwd,
      files: Object.keys(snapshot.baseline).length,
      commit: localCommit,
    },
  };
}

async function pushToGitHub(
  py: Pyodide,
  params: GitParamsValue,
  credentials: GitHubCredentials | null,
  signal: AbortSignal | undefined,
): Promise<{ content: ReturnType<typeof text>[]; details: GitDetails }> {
  const cwd = repositoryPath(py, params.cwd);
  const metadata = readGitHubMetadata(py, cwd);
  const status = await readStatus(py, cwd);
  if (!status.clean) throw new Error("Working tree is not clean; add and commit changes first.");
  const head = await localHead(py, cwd);
  if (head === metadata.localHead) {
    return {
      content: [text("Nothing to push\n")],
      details: { operation: "push", cwd, commit: head },
    };
  }
  const authorized = requireGitHubCredentials(credentials, metadata.apiBaseUrl);
  const remote = await getGitHubCommit(
    metadata.apiBaseUrl,
    metadata.repository,
    metadata.branch,
    authorized,
    signal,
  );
  if (remote.sha !== metadata.remoteCommit) {
    throw new Error("The GitHub branch changed remotely; pull before pushing.");
  }

  const worktree = await readCommittedTree(py, cwd);
  const changed: Array<{ path: string; entry: WorktreeEntry }> = [];
  const deleted: Array<{ path: string; entry: BaselineEntry }> = [];
  let pushBytes = 0;
  for (const [path, entry] of worktree) {
    const previous = metadata.baseline[path];
    if (previous?.id === entry.id && previous.mode === entry.mode) continue;
    pushBytes += entry.bytes.byteLength;
    changed.push({ path, entry });
  }
  for (const [path, entry] of Object.entries(metadata.baseline)) {
    if (!worktree.has(path)) deleted.push({ path, entry });
  }
  const actionCount = changed.length + deleted.length;
  if (actionCount === 0) {
    writeGitHubMetadata(py, cwd, { ...metadata, localHead: head });
    return {
      content: [text("Nothing to push\n")],
      details: { operation: "push", cwd, commit: head },
    };
  }
  if (actionCount > MAX_PUSH_ACTIONS) {
    throw new Error(`Push has ${actionCount} file actions; limit is ${MAX_PUSH_ACTIONS}.`);
  }
  if (pushBytes > MAX_PUSH_BYTES) {
    throw new Error(
      `Push contains ${formatBytes(pushBytes)}; limit is ${formatBytes(MAX_PUSH_BYTES)}.`,
    );
  }

  const apiRepository = githubRepositoryPath(metadata.repository);
  const treeEntries: Array<{
    path: string;
    mode: string;
    type: "blob";
    sha: string | null;
  }> = [];
  for (const { path, entry } of changed) {
    const blob = await gitHubJson<{ sha: string }>(
      metadata.apiBaseUrl,
      `/repos/${apiRepository}/git/blobs`,
      authorized,
      signal,
      {
        method: "POST",
        body: JSON.stringify({
          content: bytesToBase64(entry.bytes),
          encoding: "base64",
        }),
      },
    );
    treeEntries.push({ path, mode: entry.mode, type: "blob", sha: blob.sha });
  }
  for (const { path, entry } of deleted) {
    treeEntries.push({ path, mode: entry.mode, type: "blob", sha: null });
  }

  const tree = await gitHubJson<{ sha: string }>(
    metadata.apiBaseUrl,
    `/repos/${apiRepository}/git/trees`,
    authorized,
    signal,
    {
      method: "POST",
      body: JSON.stringify({
        base_tree: remote.commit.tree.sha,
        tree: treeEntries,
      }),
    },
  );
  const message = params.message?.trim() || (await localCommitMessage(py, cwd));
  const author = {
    name: authorized.name,
    email:
      authorized.email ||
      `${authorized.id}+${authorized.login}@users.noreply.github.com`,
  };
  const commit = await gitHubJson<{ sha: string; message: string }>(
    metadata.apiBaseUrl,
    `/repos/${apiRepository}/git/commits`,
    authorized,
    signal,
    {
      method: "POST",
      body: JSON.stringify({
        message,
        tree: tree.sha,
        parents: [remote.sha],
        author,
        committer: author,
      }),
    },
  );
  await gitHubJson(
    metadata.apiBaseUrl,
    `/repos/${apiRepository}/git/refs/heads/${githubRefPath(metadata.branch)}`,
    authorized,
    signal,
    {
      method: "PATCH",
      body: JSON.stringify({ sha: commit.sha, force: false }),
    },
  );

  const baseline: Record<string, BaselineEntry> = {};
  for (const [path, entry] of worktree) baseline[path] = { id: entry.id, mode: entry.mode };
  writeGitHubMetadata(py, cwd, {
    ...metadata,
    remoteCommit: commit.sha,
    localHead: head,
    baseline,
  });
  return {
    content: [
      text(
        `Pushed ${actionCount} file action(s) to ${metadata.repository}@${metadata.branch}\n` +
          `remote ${commit.sha.slice(0, 7)} · ${message.split(/\r?\n/, 1)[0]}\n`,
      ),
    ],
    details: { operation: "push", cwd, files: actionCount, commit: commit.sha },
  };
}

function assertCloneDestination(py: Pyodide, cwd: string): void {
  if (!fsExists(py, cwd)) return;
  if (!fsIsDir(py, cwd)) throw new Error(`Clone destination is not a directory: ${cwd}`);
  const entries = py.FS.readdir(cwd).filter((name) => name !== "." && name !== "..");
  if (entries.length > 0) throw new Error(`Clone destination is not empty: ${cwd}`);
}

function gitHubMetadataPath(cwd: string): string {
  return `${cwd}/.git/piodide-github.json`;
}

function readGitHubMetadata(py: Pyodide, cwd: string): GitHubMetadata {
  assertRepository(py, cwd);
  const path = gitHubMetadataPath(cwd);
  if (!fsExists(py, path)) {
    throw new Error("This repository is not linked to GitHub; use git clone first.");
  }
  const metadata = JSON.parse(fsReadText(py, path)) as GitHubMetadata;
  if (
    metadata.version !== 1 ||
    !metadata.apiBaseUrl ||
    !metadata.repository ||
    !metadata.branch
  ) {
    throw new Error("The GitHub repository metadata is invalid.");
  }
  return metadata;
}

function writeGitHubMetadata(py: Pyodide, cwd: string, metadata: GitHubMetadata): void {
  fsWriteText(py, gitHubMetadataPath(cwd), JSON.stringify(metadata));
}

function parseGitHubTarget(
  value: string,
  credentials: GitHubCredentials | null,
): { apiBaseUrl: string; repository: string } {
  const trimmed = value.trim();
  let repository = trimmed;
  let apiBaseUrl = normalizeGitHubApiUrl(
    credentials?.apiBaseUrl || "https://api.github.com",
  );
  if (/^git@github\.com:/i.test(trimmed)) {
    repository = trimmed.slice(trimmed.indexOf(":") + 1);
    apiBaseUrl = "https://api.github.com";
  } else if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    if (url.username || url.password) {
      throw new Error("Do not put credentials in a GitHub URL.");
    }
    if (
      url.hostname.toLowerCase() === "github.com" ||
      url.hostname.toLowerCase() === "www.github.com"
    ) {
      repository = url.pathname;
      apiBaseUrl = "https://api.github.com";
    } else if (url.hostname.toLowerCase() === "api.github.com") {
      repository = url.pathname.replace(/^\/?repos\//, "");
      apiBaseUrl = "https://api.github.com";
    } else if (
      credentials &&
      url.origin === new URL(credentials.apiBaseUrl).origin
    ) {
      const apiUrl = new URL(apiBaseUrl);
      const apiPrefix = apiUrl.pathname.replace(/\/+$/, "");
      repository = url.pathname.slice(apiPrefix.length).replace(/^\/?repos\//, "");
    } else {
      throw new Error("GitHub repository URL must use github.com or the registered API host.");
    }
  }
  repository = repository.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const parts = repository.split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))
  ) {
    throw new Error("GitHub repository must be owner/repository.");
  }
  return {
    apiBaseUrl,
    repository: parts.join("/"),
  };
}

function githubRepositoryPath(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new Error("Invalid GitHub repository metadata.");
  }
  return parts.map(encodeURIComponent).join("/");
}

function githubRefPath(branch: string): string {
  if (
    !branch ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("\0") ||
    branch.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Invalid GitHub branch.");
  }
  return branch.split("/").map(encodeURIComponent).join("/");
}

type GitHubAuth = Pick<GitHubCredentials, "apiBaseUrl" | "token">;

function gitHubCredentialsFor<T extends GitHubAuth>(
  credentials: T | null,
  apiBaseUrl: string,
): T | null {
  if (!credentials) return null;
  return normalizeGitHubApiUrl(credentials.apiBaseUrl) === normalizeGitHubApiUrl(apiBaseUrl)
    ? credentials
    : null;
}

function requireGitHubCredentials(
  credentials: GitHubCredentials | null,
  apiBaseUrl: string,
): GitHubCredentials {
  const matching = gitHubCredentialsFor(credentials, apiBaseUrl);
  if (!matching) throw new Error("Run /github before pushing.");
  return matching;
}

async function gitHubJson<T>(
  apiBaseUrl: string,
  path: string,
  credentials: GitHubAuth | null,
  signal: AbortSignal | undefined,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", GITHUB_API_VERSION);
  const matching = gitHubCredentialsFor(credentials, apiBaseUrl);
  if (matching) headers.set("Authorization", `Bearer ${matching.token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${normalizeGitHubApiUrl(apiBaseUrl)}${path}`, {
    ...init,
    headers,
    signal,
  });
  if (!response.ok) throw await gitHubError(response);
  return (await response.json()) as T;
}

async function gitHubError(response: Response): Promise<Error> {
  const body = (await response.text()).slice(0, 1_000);
  let message = body;
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    message = typeof parsed.message === "string" ? parsed.message : body;
  } catch {
    // Keep the bounded text response.
  }
  return new Error(`GitHub HTTP ${response.status}: ${message || response.statusText}`);
}

async function getGitHubCommit(
  apiBaseUrl: string,
  repository: string,
  branch: string,
  credentials: GitHubCredentials | null,
  signal: AbortSignal | undefined,
): Promise<GitHubCommit> {
  return gitHubJson<GitHubCommit>(
    apiBaseUrl,
    `/repos/${githubRepositoryPath(repository)}/commits/${encodeURIComponent(branch)}`,
    credentials,
    signal,
  );
}

async function fetchGitHubSnapshot(
  apiBaseUrl: string,
  repository: string,
  branch: string,
  credentials: GitHubCredentials | null,
  signal: AbortSignal | undefined,
): Promise<{
  commit: GitHubCommit;
  baseline: Record<string, BaselineEntry>;
}> {
  const commit = await getGitHubCommit(
    apiBaseUrl,
    repository,
    branch,
    credentials,
    signal,
  );
  const tree = await gitHubJson<GitHubTree>(
    apiBaseUrl,
    `/repos/${githubRepositoryPath(repository)}/git/trees/${commit.commit.tree.sha}?recursive=1`,
    credentials,
    signal,
  );
  if (tree.truncated) {
    throw new Error("GitHub truncated the repository tree; this repository is too large.");
  }
  const baseline: Record<string, BaselineEntry> = {};
  for (const entry of tree.tree) {
    if (entry.type === "commit") {
      throw new Error(`GitHub submodules are not supported: ${entry.path}`);
    }
    if (entry.type !== "blob") continue;
    validateRelativePath(entry.path);
    if ((entry.size ?? 0) > MAX_BLOB_BYTES) {
      throw new Error(
        `GitHub file exceeds the ${formatBytes(MAX_BLOB_BYTES)} browser limit: ${entry.path}`,
      );
    }
    baseline[entry.path] = { id: entry.sha, mode: entry.mode };
  }
  if (Object.keys(baseline).length > MAX_REPOSITORY_FILES) {
    throw new Error(`Repository exceeds the ${MAX_REPOSITORY_FILES}-file browser limit.`);
  }
  return { commit, baseline };
}

async function fetchGitHubSnapshotFiles(
  apiBaseUrl: string,
  repository: string,
  baseline: Record<string, BaselineEntry>,
  credentials: GitHubCredentials | null,
  signal: AbortSignal | undefined,
): Promise<Map<string, { bytes: Uint8Array; mode: string }>> {
  const pending = Object.entries(baseline);
  const result = new Map<string, { bytes: Uint8Array; mode: string }>();
  let cursor = 0;
  let total = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const [path, entry] = pending[cursor++];
      validateRelativePath(path);
      const blob = await gitHubJson<{
        content: string;
        encoding: string;
        size: number;
      }>(
        apiBaseUrl,
        `/repos/${githubRepositoryPath(repository)}/git/blobs/${encodeURIComponent(entry.id)}`,
        credentials,
        signal,
      );
      if (blob.encoding !== "base64") {
        throw new Error(`GitHub returned an unsupported blob encoding: ${blob.encoding}`);
      }
      if (blob.size > MAX_BLOB_BYTES) {
        throw new Error(`GitHub file exceeds the ${formatBytes(MAX_BLOB_BYTES)} browser limit.`);
      }
      const bytes = base64ToBytes(blob.content);
      if (bytes.byteLength !== blob.size) {
        throw new Error(`GitHub returned an invalid blob size for ${path}.`);
      }
      total += bytes.byteLength;
      if (total > MAX_REPOSITORY_BYTES) {
        throw new Error(
          `Repository exceeds the ${formatBytes(MAX_REPOSITORY_BYTES)} browser limit.`,
        );
      }
      result.set(path, { bytes, mode: entry.mode });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => worker()));
  return result;
}

function writeSnapshotFiles(
  py: Pyodide,
  cwd: string,
  files: Map<string, { bytes: Uint8Array; mode: string }>,
): void {
  for (const [relative, entry] of files) {
    validateRelativePath(relative);
    const path = `${cwd}/${relative}`;
    const slash = path.lastIndexOf("/");
    if (slash > 0) py.FS.mkdirTree(path.slice(0, slash));
    removeWorktreePath(py, cwd, relative);
    if (entry.mode === "120000") {
      py.FS.symlink(new TextDecoder().decode(entry.bytes), path);
    } else {
      py.FS.writeFile(path, entry.bytes);
      py.FS.chmod(path, entry.mode === "100755" ? 0o755 : 0o644);
    }
  }
}

function validateRelativePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Remote returned an unsafe repository path: ${path}`);
  }
}

function removeWorktreePath(py: Pyodide, cwd: string, relative: string): void {
  const path = `${cwd}/${relative}`;
  try {
    const stat = py.FS.lstat(path);
    if (py.FS.isDir(stat.mode)) py.FS.rmdir(path);
    else py.FS.unlink(path);
  } catch {
    // Missing paths and non-empty directories need no action here.
  }
}

async function readCommittedTree(
  py: Pyodide,
  cwd: string,
): Promise<Map<string, WorktreeEntry>> {
  const tracked = await pythonJson<Array<{ path: string; id: string; mode: string }>>(py, `
from dulwich.repo import Repo
_repo = Repo(${pythonString(cwd)})
_commit = _repo[_repo.head()]
json.dumps([
    {
        "path": entry.path.decode("utf-8", "surrogateescape"),
        "id": entry.sha.decode(),
        "mode": format(entry.mode, "o"),
    }
    for entry in _repo.object_store.iter_tree_contents(_commit.tree)
])
`);
  if (tracked.length > MAX_REPOSITORY_FILES) {
    throw new Error(`Repository exceeds the ${MAX_REPOSITORY_FILES}-file browser limit.`);
  }
  const entries = new Map<string, WorktreeEntry>();
  let total = 0;
  for (const entry of tracked) {
    validateRelativePath(entry.path);
    if (entry.mode === "160000") {
      throw new Error(`Remote API sync cannot push a changed submodule: ${entry.path}`);
    }
    const path = `${cwd}/${entry.path}`;
    const bytes =
      entry.mode === "120000"
        ? new TextEncoder().encode(py.FS.readlink(path))
        : (py.FS.readFile(path) as Uint8Array);
    total += bytes.byteLength;
    if (total > MAX_REPOSITORY_BYTES) {
      throw new Error(`Repository exceeds the ${formatBytes(MAX_REPOSITORY_BYTES)} browser limit.`);
    }
    entries.set(entry.path, { bytes, mode: entry.mode, id: entry.id });
  }
  return entries;
}

async function localCommitMessage(py: Pyodide, cwd: string): Promise<string> {
  return pythonJson<string>(py, `
from dulwich.objects import Commit
from dulwich.repo import Repo
_repo = Repo(${pythonString(cwd)})
_commit = _repo[_repo.head()]
assert isinstance(_commit, Commit)
json.dumps(_commit.message.decode("utf-8", "replace").strip() or "Update from piodide")
`);
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return btoa(chunks.join(""));
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, "");
  if (normalized.length > Math.ceil(MAX_BLOB_BYTES / 3) * 4 + 4) {
    throw new Error(`Base64 blob exceeds the ${formatBytes(MAX_BLOB_BYTES)} browser limit.`);
  }
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function capOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_BYTES) return value;
  return value.slice(0, MAX_OUTPUT_BYTES) + "\n…<truncated>\n";
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${Math.round(value / 1024 / 1024)} MB`;
  return `${Math.round(value / 1024)} KB`;
}
