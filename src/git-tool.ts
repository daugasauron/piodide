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
        "GitLab project URL, numeric project ID, or namespace/project. Required for clone.",
      maxLength: 2_000,
    }),
  ),
  branch: Type.Optional(
    Type.String({ description: "GitLab branch. Defaults to the project's default branch." }),
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

export interface GitLabCredentials {
  baseUrl: string;
  token: string;
  username: string;
  name: string;
  email?: string;
}

export interface GitDetails {
  operation: string;
  cwd: string;
  files?: number;
  commit?: string;
}

interface GitLabProject {
  id: number;
  path: string;
  path_with_namespace: string;
  default_branch: string | null;
}

interface GitLabCommit {
  id: string;
  short_id: string;
  title: string;
}

interface GitLabTreeEntry {
  id: string;
  mode: string;
  path: string;
  type: "blob" | "tree" | "commit";
}

interface BaselineEntry {
  id: string;
  mode: string;
}

interface GitLabMetadata {
  version: 1;
  baseUrl: string;
  projectId: string;
  projectPath: string;
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

export function normalizeGitLabBaseUrl(value: string): string {
  const url = new URL(value.trim() || "https://gitlab.com");
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("GitLab URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("Do not put credentials in the GitLab URL.");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export async function verifyGitLabCredentials(
  baseUrl: string,
  token: string,
): Promise<GitLabCredentials> {
  const normalized = normalizeGitLabBaseUrl(baseUrl);
  if (!token.trim()) throw new Error("GitLab token is empty.");
  const response = await fetch(`${normalized}/api/v4/user`, {
    headers: { "PRIVATE-TOKEN": token },
  });
  if (!response.ok) throw await gitLabError(response);
  const user = (await response.json()) as {
    username?: string;
    name?: string;
    public_email?: string;
    email?: string;
  };
  if (!user.username) throw new Error("GitLab returned an invalid user response.");
  return {
    baseUrl: normalized,
    token,
    username: user.username,
    name: user.name || user.username,
    email: user.public_email || user.email || undefined,
  };
}

export function createGitTool(
  py: Pyodide,
  getCredentials: () => GitLabCredentials | null,
): AgentTool<typeof GitParams, GitDetails> {
  return {
    name: "git",
    label: "Git",
    description:
      "Use a real local Git repository in the shared Pyodide filesystem, powered by " +
      "Dulwich. Supports init, status, add, commit, log, and diff. GitLab clone/pull/push " +
      "use GitLab's browser-compatible API because browser CORS blocks normal Git smart " +
      "HTTP. Run /gitlab to register a private-project token. Remote synchronization is " +
      "snapshot-based: commit local changes before push, and push before pull.",
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
          return cloneFromGitLab(py, params, credentials, identity, signal);

        case "pull":
          return pullFromGitLab(py, params, credentials, identity, signal);

        case "push":
          return pushToGitLab(py, params, credentials, signal);
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

function gitIdentity(credentials: GitLabCredentials | null): string {
  const name = credentials?.name || credentials?.username || "piodide";
  const email = credentials?.email || `${credentials?.username || "piodide"}@browser.local`;
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

async function cloneFromGitLab(
  py: Pyodide,
  params: GitParamsValue,
  credentials: GitLabCredentials | null,
  identity: string,
  signal: AbortSignal | undefined,
): Promise<{ content: ReturnType<typeof text>[]; details: GitDetails }> {
  if (!params.project?.trim()) throw new Error("clone requires project.");
  const target = parseGitLabTarget(params.project, credentials);
  const project = await gitLabJson<GitLabProject>(
    target.baseUrl,
    `/projects/${encodeURIComponent(target.project)}`,
    credentials,
    signal,
  );
  const branch = params.branch?.trim() || project.default_branch;
  if (!branch) throw new Error("The GitLab project has no default branch.");
  const cwd = params.cwd?.trim()
    ? repositoryPath(py, params.cwd)
    : repositoryPath(py, `/home/web/${project.path}`);
  assertCloneDestination(py, cwd);

  const snapshot = await fetchSnapshot(
    target.baseUrl,
    String(project.id),
    branch,
    credentials,
    signal,
  );
  const files = await fetchSnapshotFiles(
    target.baseUrl,
    String(project.id),
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
    `Import ${project.path_with_namespace}@${snapshot.commit.short_id}`,
    identity,
    true,
  );
  writeMetadata(py, cwd, {
    version: 1,
    baseUrl: target.baseUrl,
    projectId: String(project.id),
    projectPath: project.path_with_namespace,
    branch,
    remoteCommit: snapshot.commit.id,
    localHead: localCommit,
    baseline: snapshot.baseline,
  });
  return {
    content: [
      text(
        `Cloned GitLab snapshot ${project.path_with_namespace}@${branch} into ${cwd}\n` +
          `${Object.keys(snapshot.baseline).length} files · remote ${snapshot.commit.short_id}\n`,
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

async function pullFromGitLab(
  py: Pyodide,
  params: GitParamsValue,
  credentials: GitLabCredentials | null,
  identity: string,
  signal: AbortSignal | undefined,
): Promise<{ content: ReturnType<typeof text>[]; details: GitDetails }> {
  const cwd = repositoryPath(py, params.cwd);
  const metadata = readMetadata(py, cwd);
  const status = await readStatus(py, cwd);
  if (!status.clean) throw new Error("Working tree is not clean; commit or remove changes first.");
  const head = await localHead(py, cwd);
  if (head !== metadata.localHead) {
    throw new Error("Local commits have not been pushed; push before pulling.");
  }

  const remote = await getRemoteCommit(
    metadata.baseUrl,
    metadata.projectId,
    metadata.branch,
    credentials,
    signal,
  );
  if (remote.id === metadata.remoteCommit) {
    return {
      content: [text(`Already up to date with ${metadata.projectPath}@${metadata.branch}\n`)],
      details: { operation: "pull", cwd, commit: head },
    };
  }

  const snapshot = await fetchSnapshot(
    metadata.baseUrl,
    metadata.projectId,
    metadata.branch,
    credentials,
    signal,
  );
  const files = await fetchSnapshotFiles(
    metadata.baseUrl,
    metadata.projectId,
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
    `Pull ${metadata.projectPath}@${snapshot.commit.short_id}`,
    identity,
    true,
  );
  writeMetadata(py, cwd, {
    ...metadata,
    remoteCommit: snapshot.commit.id,
    localHead: localCommit,
    baseline: snapshot.baseline,
  });
  return {
    content: [
      text(
        `Pulled GitLab snapshot ${metadata.projectPath}@${metadata.branch}\n` +
          `${Object.keys(snapshot.baseline).length} files · remote ${snapshot.commit.short_id}\n`,
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

async function pushToGitLab(
  py: Pyodide,
  params: GitParamsValue,
  credentials: GitLabCredentials | null,
  signal: AbortSignal | undefined,
): Promise<{ content: ReturnType<typeof text>[]; details: GitDetails }> {
  const cwd = repositoryPath(py, params.cwd);
  const metadata = readMetadata(py, cwd);
  const status = await readStatus(py, cwd);
  if (!status.clean) throw new Error("Working tree is not clean; add and commit changes first.");
  const head = await localHead(py, cwd);
  if (head === metadata.localHead) {
    return {
      content: [text("Nothing to push\n")],
      details: { operation: "push", cwd, commit: head },
    };
  }
  const authorized = requireCredentials(credentials, metadata.baseUrl);

  const remote = await getRemoteCommit(
    metadata.baseUrl,
    metadata.projectId,
    metadata.branch,
    authorized,
    signal,
  );
  if (remote.id !== metadata.remoteCommit) {
    throw new Error("The GitLab branch changed remotely; pull before pushing.");
  }

  const worktree = await readCommittedTree(py, cwd);
  const actions: Array<Record<string, unknown>> = [];
  let pushBytes = 0;

  for (const [path, entry] of worktree) {
    const previous = metadata.baseline[path];
    if (previous?.id === entry.id && previous.mode === entry.mode) continue;
    if (entry.mode === "120000") {
      throw new Error(`GitLab API sync cannot push a changed symbolic link: ${path}`);
    }
    pushBytes += entry.bytes.byteLength;
    actions.push({
      action: previous ? "update" : "create",
      file_path: path,
      content: bytesToBase64(entry.bytes),
      encoding: "base64",
      execute_filemode: entry.mode === "100755",
    });
  }
  for (const path of Object.keys(metadata.baseline)) {
    if (!worktree.has(path)) actions.push({ action: "delete", file_path: path });
  }

  if (actions.length === 0) {
    writeMetadata(py, cwd, { ...metadata, localHead: head });
    return {
      content: [text("Nothing to push\n")],
      details: { operation: "push", cwd, commit: head },
    };
  }
  if (actions.length > MAX_PUSH_ACTIONS) {
    throw new Error(`Push has ${actions.length} file actions; limit is ${MAX_PUSH_ACTIONS}.`);
  }
  if (pushBytes > MAX_PUSH_BYTES) {
    throw new Error(
      `Push contains ${formatBytes(pushBytes)}; limit is ${formatBytes(MAX_PUSH_BYTES)}.`,
    );
  }

  const message = params.message?.trim() || (await localCommitMessage(py, cwd));
  const response = await gitLabJson<GitLabCommit>(
    metadata.baseUrl,
    `/projects/${encodeURIComponent(metadata.projectId)}/repository/commits`,
    authorized,
    signal,
    {
      method: "POST",
      body: JSON.stringify({
        branch: metadata.branch,
        commit_message: message,
        actions,
        author_name: authorized.name,
        author_email: authorized.email || `${authorized.username}@users.noreply.gitlab.com`,
      }),
    },
  );

  const baseline: Record<string, BaselineEntry> = {};
  for (const [path, entry] of worktree) baseline[path] = { id: entry.id, mode: entry.mode };
  writeMetadata(py, cwd, {
    ...metadata,
    remoteCommit: response.id,
    localHead: head,
    baseline,
  });
  return {
    content: [
      text(
        `Pushed ${actions.length} file action(s) to ${metadata.projectPath}@${metadata.branch}\n` +
          `remote ${response.short_id} · ${response.title}\n`,
      ),
    ],
    details: { operation: "push", cwd, files: actions.length, commit: response.id },
  };
}

function assertCloneDestination(py: Pyodide, cwd: string): void {
  if (!fsExists(py, cwd)) return;
  if (!fsIsDir(py, cwd)) throw new Error(`Clone destination is not a directory: ${cwd}`);
  const entries = py.FS.readdir(cwd).filter((name) => name !== "." && name !== "..");
  if (entries.length > 0) throw new Error(`Clone destination is not empty: ${cwd}`);
}

function metadataPath(cwd: string): string {
  return `${cwd}/.git/piodide-gitlab.json`;
}

function readMetadata(py: Pyodide, cwd: string): GitLabMetadata {
  assertRepository(py, cwd);
  const path = metadataPath(cwd);
  if (!fsExists(py, path)) {
    throw new Error("This repository is not linked to GitLab; use git clone first.");
  }
  const metadata = JSON.parse(fsReadText(py, path)) as GitLabMetadata;
  if (metadata.version !== 1 || !metadata.projectId || !metadata.branch) {
    throw new Error("The GitLab repository metadata is invalid.");
  }
  return metadata;
}

function writeMetadata(py: Pyodide, cwd: string, metadata: GitLabMetadata): void {
  fsWriteText(py, metadataPath(cwd), JSON.stringify(metadata));
}

function parseGitLabTarget(
  value: string,
  credentials: GitLabCredentials | null,
): { baseUrl: string; project: string } {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    const credentialBase = credentials ? new URL(credentials.baseUrl) : null;
    let baseUrl = `${url.protocol}//${url.host}`;
    let projectPath = url.pathname.replace(/^\/+|\/+$/g, "");
    if (
      credentialBase &&
      credentialBase.origin === url.origin &&
      credentialBase.pathname !== "/" &&
      url.pathname.startsWith(credentialBase.pathname.replace(/\/+$/, "") + "/")
    ) {
      baseUrl = credentials!.baseUrl;
      projectPath = url.pathname
        .slice(credentialBase.pathname.replace(/\/+$/, "").length)
        .replace(/^\/+|\/+$/g, "");
    }
    return { baseUrl, project: projectPath.replace(/\.git$/, "") };
  }
  return {
    baseUrl: credentials?.baseUrl || "https://gitlab.com",
    project: trimmed.replace(/^\/+|\/+$/g, "").replace(/\.git$/, ""),
  };
}

function credentialsFor(
  credentials: GitLabCredentials | null,
  baseUrl: string,
): GitLabCredentials | null {
  if (!credentials) return null;
  return normalizeGitLabBaseUrl(credentials.baseUrl) === normalizeGitLabBaseUrl(baseUrl)
    ? credentials
    : null;
}

function requireCredentials(
  credentials: GitLabCredentials | null,
  baseUrl: string,
): GitLabCredentials {
  const matching = credentialsFor(credentials, baseUrl);
  if (!matching) throw new Error(`Run /gitlab ${baseUrl} before pushing.`);
  return matching;
}

async function gitLabJson<T>(
  baseUrl: string,
  path: string,
  credentials: GitLabCredentials | null,
  signal: AbortSignal | undefined,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  const matching = credentialsFor(credentials, baseUrl);
  if (matching) headers.set("PRIVATE-TOKEN", matching.token);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(`${normalizeGitLabBaseUrl(baseUrl)}/api/v4${path}`, {
    ...init,
    headers,
    signal,
  });
  if (!response.ok) throw await gitLabError(response);
  return (await response.json()) as T;
}

async function gitLabError(response: Response): Promise<Error> {
  const body = (await response.text()).slice(0, 1_000);
  let message = body;
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    message =
      typeof parsed.message === "string"
        ? parsed.message
        : typeof parsed.error === "string"
          ? parsed.error
          : body;
  } catch {
    // Keep the bounded text response.
  }
  return new Error(`GitLab HTTP ${response.status}: ${message || response.statusText}`);
}

async function getRemoteCommit(
  baseUrl: string,
  projectId: string,
  branch: string,
  credentials: GitLabCredentials | null,
  signal: AbortSignal | undefined,
): Promise<GitLabCommit> {
  return gitLabJson<GitLabCommit>(
    baseUrl,
    `/projects/${encodeURIComponent(projectId)}/repository/commits/${encodeURIComponent(branch)}`,
    credentials,
    signal,
  );
}

async function fetchSnapshot(
  baseUrl: string,
  projectId: string,
  branch: string,
  credentials: GitLabCredentials | null,
  signal: AbortSignal | undefined,
): Promise<{
  commit: GitLabCommit;
  baseline: Record<string, BaselineEntry>;
}> {
  const [commit, baseline] = await Promise.all([
    getRemoteCommit(baseUrl, projectId, branch, credentials, signal),
    fetchRemoteTree(baseUrl, projectId, branch, credentials, signal),
  ]);
  return { commit, baseline };
}

async function fetchRemoteTree(
  baseUrl: string,
  projectId: string,
  branch: string,
  credentials: GitLabCredentials | null,
  signal: AbortSignal | undefined,
): Promise<Record<string, BaselineEntry>> {
  const baseline: Record<string, BaselineEntry> = {};
  let page = 1;
  while (true) {
    const entries = await gitLabJson<GitLabTreeEntry[]>(
      baseUrl,
      `/projects/${encodeURIComponent(projectId)}/repository/tree` +
        `?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(branch)}`,
      credentials,
      signal,
    );
    for (const entry of entries) {
      if (entry.type === "blob") baseline[entry.path] = { id: entry.id, mode: entry.mode };
    }
    if (Object.keys(baseline).length > MAX_REPOSITORY_FILES) {
      throw new Error(`Repository exceeds the ${MAX_REPOSITORY_FILES}-file browser limit.`);
    }
    if (entries.length < 100) break;
    page++;
    if (page > 100) throw new Error("Repository tree has too many API pages.");
  }
  return baseline;
}

async function fetchSnapshotFiles(
  baseUrl: string,
  projectId: string,
  baseline: Record<string, BaselineEntry>,
  credentials: GitLabCredentials | null,
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
      const headers = new Headers();
      const matching = credentialsFor(credentials, baseUrl);
      if (matching) headers.set("PRIVATE-TOKEN", matching.token);
      const url =
        `${normalizeGitLabBaseUrl(baseUrl)}/api/v4/projects/${encodeURIComponent(projectId)}` +
        `/repository/blobs/${encodeURIComponent(entry.id)}/raw`;
      const response = await fetch(url, { headers, signal });
      if (!response.ok) throw await gitLabError(response);
      const bytes = await readBoundedResponse(response, MAX_BLOB_BYTES);
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

async function readBoundedResponse(response: Response, limit: number): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length") || "0");
  if (length > limit) {
    throw new Error(`GitLab file exceeds the ${formatBytes(limit)} browser limit.`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error(`Response exceeds ${formatBytes(limit)}.`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`GitLab file exceeds the ${formatBytes(limit)} browser limit.`);
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
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
    throw new Error(`GitLab returned an unsafe repository path: ${path}`);
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
      throw new Error(`GitLab API sync cannot push a changed submodule: ${entry.path}`);
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

function capOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_BYTES) return value;
  return value.slice(0, MAX_OUTPUT_BYTES) + "\n…<truncated>\n";
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${Math.round(value / 1024 / 1024)} MB`;
  return `${Math.round(value / 1024)} KB`;
}
