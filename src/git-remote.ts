/** Browser-fetch transport for the native Slop Git command. */
import {
  type Pyodide,
  fsExists,
  fsReadText,
  fsWriteText,
} from "./pyodide-host.ts";
import {
  forgetEmscriptenSymlinkTarget,
  preserveEmscriptenSymlinkTarget,
} from "./wasi/emscripten-fs.ts";

const MAX_REPOSITORY_BYTES = 32 * 1024 * 1024;
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_REPOSITORY_FILES = 3_000;
const MAX_PUSH_BYTES = 8 * 1024 * 1024;
const MAX_PUSH_ACTIONS = 100;
const GITHUB_API_VERSION = "2026-03-10";
const encoder = new TextEncoder();

export interface GitHubCredentials {
  apiBaseUrl: string;
  token: string;
  login: string;
  id: number;
  name: string;
  email?: string;
}

export interface GitRemoteContext {
  py: Pyodide;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  getGitHubCredentials?: () => GitHubCredentials | null;
}

export interface GitRemoteResult {
  exitCode: number;
  stdout?: Uint8Array;
  stderr?: Uint8Array;
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
  version: 2;
  apiBaseUrl: string;
  repository: string;
  branch: string;
  localBranch: string;
  remoteCommit: string;
  baseline: Record<string, BaselineEntry>;
}

export interface GitHubSnapshotInfo {
  repository: string;
  upstreamBranch: string;
  upstreamCommit: string;
  localBranch: string;
}

interface WorktreeEntry {
  bytes: Uint8Array;
  mode: string;
  id: string;
}

type GitHubAuth = Pick<GitHubCredentials, "apiBaseUrl" | "token">;

function success(value: string): GitRemoteResult {
  return { exitCode: 0, stdout: encoder.encode(value) };
}

function failure(error: unknown): GitRemoteResult {
  const message = error instanceof Error ? error.message : String(error);
  return { exitCode: 1, stderr: encoder.encode(`git: ${message}\n`) };
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

export async function runGitRemoteCommand(
  context: GitRemoteContext,
): Promise<GitRemoteResult> {
  try {
    const operation = context.args[1];
    const credentials = context.getGitHubCredentials?.() ?? null;
    if (operation === "clone") {
      const project = context.args[2]?.trim();
      const requestedBranch = context.args[3]?.trim() || undefined;
      if (!project) throw new Error("clone requires a GitHub repository");
      return success(await cloneSnapshot(
        context.py,
        context.cwd,
        project,
        requestedBranch,
        credentials,
        context.signal,
      ));
    }
    if (operation === "pull") {
      const localHead = context.args[2]?.trim();
      if (!localHead) throw new Error("pull requires the local HEAD");
      return success(await pullSnapshot(
        context.py,
        context.cwd,
        localHead,
        credentials,
        context.signal,
      ));
    }
    if (operation === "checkout") {
      const branch = context.args[2]?.trim();
      if (!branch) throw new Error("checkout requires a remote branch");
      return success(await checkoutSnapshot(
        context.py,
        context.cwd,
        branch,
        credentials,
        context.signal,
      ));
    }
    if (operation === "push") {
      const localHead = context.args[2]?.trim();
      if (!localHead) throw new Error("push requires the local HEAD");
      return success(await pushSnapshot(
        context.py,
        context.cwd,
        localHead,
        context.args[3]?.trim() || "Update from piodide",
        credentials,
        context.signal,
      ));
    }
    throw new Error(`unsupported remote operation: ${operation || "(missing)"}`);
  } catch (error) {
    return failure(error);
  }
}

async function checkoutSnapshot(
  py: Pyodide,
  cwd: string,
  branch: string,
  credentials: GitHubCredentials | null,
  signal: AbortSignal | undefined,
): Promise<string> {
  const metadata = readMetadata(py, cwd);
  githubRefPath(branch);
  const snapshot = await fetchGitHubSnapshot(
    metadata.apiBaseUrl,
    metadata.repository,
    branch,
    credentials,
    signal,
  );
  const files = await fetchGitHubSnapshotFiles(
    metadata.apiBaseUrl,
    metadata.repository,
    snapshot.commit.sha,
    snapshot.baseline,
    credentials,
    signal,
  );
  for (const oldPath of Object.keys(metadata.baseline)) {
    if (!snapshot.baseline[oldPath]) removeWorktreePath(py, cwd, oldPath);
  }
  writeSnapshotFiles(py, cwd, files);
  writeMetadata(py, cwd, {
    ...metadata,
    branch,
    localBranch: branch,
    remoteCommit: snapshot.commit.sha,
    baseline: snapshot.baseline,
  });
  writeMarker(py, cwd, "remote-message", `Import ${metadata.repository}@${snapshot.commit.sha.slice(0, 7)}`);
  return `Fetched snapshot ${metadata.repository}@${branch}\n`;
}

async function cloneSnapshot(
  py: Pyodide,
  cwd: string,
  project: string,
  requestedBranch: string | undefined,
  credentials: GitHubCredentials | null,
  signal: AbortSignal | undefined,
): Promise<string> {
  assertNativeRepository(py, cwd);
  const target = parseGitHubTarget(project, credentials);
  const repository = await gitHubJson<GitHubRepository>(
    target.apiBaseUrl,
    `/repos/${githubRepositoryPath(target.repository)}`,
    credentials,
    signal,
  );
  const branch = requestedBranch || repository.default_branch;
  if (!branch) throw new Error("the GitHub repository has no default branch");
  assertEmptyWorktree(py, cwd);
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
    snapshot.commit.sha,
    snapshot.baseline,
    credentials,
    signal,
  );
  writeSnapshotFiles(py, cwd, files);
  writeMetadata(py, cwd, {
    version: 2,
    apiBaseUrl: target.apiBaseUrl,
    repository: repository.full_name,
    branch,
    localBranch: branch,
    remoteCommit: snapshot.commit.sha,
    baseline: snapshot.baseline,
  });
  fsWriteText(py, `${cwd}/.git/HEAD`, `ref: refs/heads/${branch}\n`);
  const configPath = `${cwd}/.git/config`;
  const config = fsExists(py, configPath) ? fsReadText(py, configPath).trimEnd() : "";
  fsWriteText(
    py,
    configPath,
    `${config}\n[remote "origin"]\n\turl = https://github.com/${repository.full_name}.git\n` +
      `\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
  writeMarker(py, cwd, "remote-message", `Import ${repository.full_name}@${snapshot.commit.sha.slice(0, 7)}`);
  return `Fetched ${Object.keys(snapshot.baseline).length} file(s) from ${repository.full_name}@${branch}\n`;
}

async function pullSnapshot(
  py: Pyodide,
  cwd: string,
  localHead: string,
  credentials: GitHubCredentials | null,
  signal: AbortSignal | undefined,
): Promise<string> {
  const metadata = readMetadata(py, cwd);
  assertTrackedBranchState(py, cwd, metadata, localHead);
  const remote = await getGitHubCommit(
    metadata.apiBaseUrl,
    metadata.repository,
    metadata.branch,
    credentials,
    signal,
  );
  if (remote.sha === metadata.remoteCommit) {
    return `Already up to date with ${metadata.repository}@${metadata.branch}\n`;
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
    snapshot.commit.sha,
    snapshot.baseline,
    credentials,
    signal,
  );
  for (const oldPath of Object.keys(metadata.baseline)) {
    if (!snapshot.baseline[oldPath]) removeWorktreePath(py, cwd, oldPath);
  }
  writeSnapshotFiles(py, cwd, files);
  writeMetadata(py, cwd, {
    ...metadata,
    remoteCommit: snapshot.commit.sha,
    baseline: snapshot.baseline,
  });
  writeMarker(py, cwd, "remote-message", `Pull ${metadata.repository}@${snapshot.commit.sha.slice(0, 7)}`);
  return `Fetched updated snapshot ${metadata.repository}@${metadata.branch}\n`;
}

async function pushSnapshot(
  py: Pyodide,
  cwd: string,
  head: string,
  message: string,
  credentials: GitHubCredentials | null,
  signal: AbortSignal | undefined,
): Promise<string> {
  const metadata = readMetadata(py, cwd);
  assertTrackedBranchState(py, cwd, metadata, head, false);
  const previousLocalHead = readMarker(py, cwd, "remote-local-head");
  const authorized = requireGitHubCredentials(credentials, metadata.apiBaseUrl);
  let createBranch = false;
  let remote: GitHubCommit;
  try {
    remote = await getGitHubCommit(
      metadata.apiBaseUrl,
      metadata.repository,
      metadata.branch,
      authorized,
      signal,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // GitHub returns 422 "No commit found for SHA" (rather than 404) when
    // resolving a not-yet-created branch through the commits endpoint.
    if (!/GitHub HTTP (?:404:|422: No commit found for SHA:)/.test(message)) throw error;
    createBranch = true;
    remote = await getGitHubCommit(
      metadata.apiBaseUrl,
      metadata.repository,
      metadata.remoteCommit,
      authorized,
      signal,
    );
  }
  if (!createBranch && remote.sha !== metadata.remoteCommit) {
    throw new Error("the GitHub branch changed remotely; pull before pushing");
  }
  if (!createBranch && head === previousLocalHead) return "Nothing to push\n";

  const worktree = await readWorktree(py, cwd);
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
    if (createBranch) {
      await gitHubJson(
        metadata.apiBaseUrl,
        `/repos/${githubRepositoryPath(metadata.repository)}/git/refs`,
        authorized,
        signal,
        {
          method: "POST",
          body: JSON.stringify({ ref: `refs/heads/${metadata.branch}`, sha: remote.sha }),
        },
      );
      writeMarker(py, cwd, "remote-local-head", head);
      return `Published ${metadata.repository}@${metadata.branch}\n`;
    }
    writeMarker(py, cwd, "remote-local-head", head);
    return "Nothing to push\n";
  }
  if (actionCount > MAX_PUSH_ACTIONS) {
    throw new Error(`push has ${actionCount} file actions; limit is ${MAX_PUSH_ACTIONS}`);
  }
  if (pushBytes > MAX_PUSH_BYTES) {
    throw new Error(`push contains ${formatBytes(pushBytes)}; limit is ${formatBytes(MAX_PUSH_BYTES)}`);
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
  const author = {
    name: authorized.name,
    email: authorized.email || `${authorized.id}+${authorized.login}@users.noreply.github.com`,
  };
  const commit = await gitHubJson<{ sha: string }>(
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
    createBranch
      ? `/repos/${apiRepository}/git/refs`
      : `/repos/${apiRepository}/git/refs/heads/${githubRefPath(metadata.branch)}`,
    authorized,
    signal,
    createBranch
      ? { method: "POST", body: JSON.stringify({ ref: `refs/heads/${metadata.branch}`, sha: commit.sha }) }
      : { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) },
  );
  const baseline: Record<string, BaselineEntry> = {};
  for (const [path, entry] of worktree) baseline[path] = { id: entry.id, mode: entry.mode };
  writeMetadata(py, cwd, {
    ...metadata,
    remoteCommit: commit.sha,
    baseline,
  });
  writeMarker(py, cwd, "remote-local-head", head);
  return `Pushed ${actionCount} file action(s) to ${metadata.repository}@${metadata.branch}\nremote ${commit.sha.slice(0, 7)} · ${message.split(/\r?\n/, 1)[0]}\n`;
}

function assertNativeRepository(py: Pyodide, cwd: string): void {
  if (!fsExists(py, `${cwd}/.git/HEAD`) || !fsExists(py, `${cwd}/.git/objects`)) {
    throw new Error(`not a Git repository: ${cwd}`);
  }
}

function assertEmptyWorktree(py: Pyodide, cwd: string): void {
  const entries = py.FS.readdir(cwd).filter((name) => ![".", "..", ".git"].includes(name));
  if (entries.length) throw new Error(`clone destination is not empty: ${cwd}`);
}

function metadataPath(cwd: string): string {
  return `${cwd}/.git/piodide/remote.json`;
}

export function isGitHubRemoteRepository(py: Pyodide, cwd: string): boolean {
  return fsExists(py, metadataPath(cwd));
}

export function readGitHubSnapshotInfo(py: Pyodide, cwd: string): GitHubSnapshotInfo {
  const metadata = readMetadata(py, cwd);
  return {
    repository: metadata.repository,
    upstreamBranch: metadata.branch,
    upstreamCommit: metadata.remoteCommit,
    localBranch: metadata.localBranch,
  };
}

export interface GitHubRemoteRef {
  ref: string;
  oid: string;
}

/** Enumerate snapshot-fallback refs without pretending they exist in the local object database. */
export async function listGitHubRemoteRefs(
  py: Pyodide,
  cwd: string,
  credentials: GitHubCredentials | null,
  signal?: AbortSignal,
): Promise<GitHubRemoteRef[]> {
  const metadata = readMetadata(py, cwd);
  const fetchKind = async (kind: "heads" | "tags") => {
    const refs = await gitHubJson<Array<{
      ref: string;
      object: { sha: string };
    }>>(
      metadata.apiBaseUrl,
      `/repos/${githubRepositoryPath(metadata.repository)}/git/matching-refs/${kind}/`,
      credentials,
      signal,
    );
    return refs.map((entry) => ({ ref: entry.ref, oid: entry.object.sha }));
  };
  return (await Promise.all([fetchKind("heads"), fetchKind("tags")])).flat();
}

function readMetadata(py: Pyodide, cwd: string): GitHubMetadata {
  assertNativeRepository(py, cwd);
  const path = metadataPath(cwd);
  if (!fsExists(py, path)) throw new Error("this repository is not linked to GitHub; use git clone first");
  const value = JSON.parse(fsReadText(py, path)) as GitHubMetadata;
  if (
    value.version !== 2 ||
    !value.apiBaseUrl ||
    !value.repository ||
    !value.branch ||
    !value.localBranch ||
    !value.remoteCommit ||
    !value.baseline
  ) {
    throw new Error("GitHub repository metadata is invalid");
  }
  return value;
}

function writeMetadata(py: Pyodide, cwd: string, value: GitHubMetadata): void {
  fsWriteText(py, metadataPath(cwd), JSON.stringify(value));
}

function markerPath(cwd: string, name: string): string {
  return `${cwd}/.git/piodide/${name}`;
}

function readMarker(py: Pyodide, cwd: string, name: string): string {
  const path = markerPath(cwd, name);
  return fsExists(py, path) ? fsReadText(py, path).trim() : "";
}

function writeMarker(py: Pyodide, cwd: string, name: string, value: string): void {
  fsWriteText(py, markerPath(cwd, name), `${value.replace(/[\r\n].*$/s, "")}\n`);
}

function currentBranch(py: Pyodide, cwd: string): string {
  const head = fsReadText(py, `${cwd}/.git/HEAD`).trim();
  const prefix = "ref: refs/heads/";
  if (!head.startsWith(prefix)) throw new Error("detached HEAD is not supported");
  return head.slice(prefix.length);
}

function assertTrackedBranchState(
  py: Pyodide,
  cwd: string,
  metadata: GitHubMetadata,
  head: string,
  requireSynchronized = true,
): string {
  const branch = currentBranch(py, cwd);
  if (branch !== metadata.localBranch) {
    throw new Error(`switch to the tracked branch '${metadata.localBranch}' before synchronizing`);
  }
  if (requireSynchronized && head !== readMarker(py, cwd, "remote-local-head")) {
    throw new Error("local commits have not been pushed; push before pulling");
  }
  return head;
}

export function readGitRemoteMarker(py: Pyodide, cwd: string, name: string): string {
  return readMarker(py, cwd, name);
}

export function markGitRemoteHead(py: Pyodide, cwd: string, head: string): void {
  writeMarker(py, cwd, "remote-local-head", head);
}

export function retargetGitHubSnapshotBranch(
  py: Pyodide,
  cwd: string,
  localBranch: string,
  remoteBranch: string,
): void {
  githubRefPath(localBranch);
  githubRefPath(remoteBranch);
  const metadata = readMetadata(py, cwd);
  writeMetadata(py, cwd, { ...metadata, localBranch, branch: remoteBranch });
}

async function readWorktree(py: Pyodide, cwd: string): Promise<Map<string, WorktreeEntry>> {
  const entries = new Map<string, WorktreeEntry>();
  let total = 0;
  const visit = async (relative: string): Promise<void> => {
    const base = relative ? `${cwd}/${relative}` : cwd;
    for (const name of py.FS.readdir(base).sort()) {
      if (name === "." || name === ".." || (!relative && name === ".git")) continue;
      const path = relative ? `${relative}/${name}` : name;
      validateRelativePath(path);
      const full = `${cwd}/${path}`;
      const stat = py.FS.lstat(full);
      if (py.FS.isDir(stat.mode)) {
        await visit(path);
        continue;
      }
      if (entries.size >= MAX_REPOSITORY_FILES) {
        throw new Error(`repository exceeds the ${MAX_REPOSITORY_FILES}-file browser limit`);
      }
      const link = py.FS.isLink?.(stat.mode) === true;
      const bytes = link
        ? encoder.encode(py.FS.readlink(full))
        : (py.FS.readFile(full) as Uint8Array).slice();
      if (bytes.byteLength > MAX_BLOB_BYTES) {
        throw new Error(`file exceeds the ${formatBytes(MAX_BLOB_BYTES)} browser limit: ${path}`);
      }
      total += bytes.byteLength;
      if (total > MAX_REPOSITORY_BYTES) {
        throw new Error(`repository exceeds the ${formatBytes(MAX_REPOSITORY_BYTES)} browser limit`);
      }
      const mode = link ? "120000" : (stat.mode & 0o111) ? "100755" : "100644";
      entries.set(path, { bytes, mode, id: await gitBlobId(bytes) });
    }
  };
  await visit("");
  return entries;
}

async function gitBlobId(bytes: Uint8Array): Promise<string> {
  const header = encoder.encode(`blob ${bytes.byteLength}\0`);
  const value = new Uint8Array(header.byteLength + bytes.byteLength);
  value.set(header);
  value.set(bytes, header.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseGitHubTarget(
  value: string,
  credentials: GitHubCredentials | null,
): { apiBaseUrl: string; repository: string } {
  const trimmed = value.trim();
  let repository = trimmed;
  let apiBaseUrl = normalizeGitHubApiUrl(credentials?.apiBaseUrl || "https://api.github.com");
  if (/^git@github\.com:/i.test(trimmed)) {
    repository = trimmed.slice(trimmed.indexOf(":") + 1);
    apiBaseUrl = "https://api.github.com";
  } else if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    if (url.username || url.password) throw new Error("do not put credentials in a GitHub URL");
    if (["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) {
      repository = url.pathname;
      apiBaseUrl = "https://api.github.com";
    } else if (url.hostname.toLowerCase() === "api.github.com") {
      repository = url.pathname.replace(/^\/?repos\//, "");
      apiBaseUrl = "https://api.github.com";
    } else if (credentials && url.origin === new URL(credentials.apiBaseUrl).origin) {
      const apiUrl = new URL(apiBaseUrl);
      const prefix = apiUrl.pathname.replace(/\/+$/, "");
      repository = url.pathname.slice(prefix.length).replace(/^\/?repos\//, "");
    } else {
      throw new Error("GitHub repository URL must use github.com or the registered API host");
    }
  }
  repository = repository.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error("GitHub repository must be owner/repository");
  }
  return { apiBaseUrl, repository: parts.join("/") };
}

function githubRepositoryPath(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error("invalid GitHub repository metadata");
  }
  return parts.map(encodeURIComponent).join("/");
}

function githubRefPath(branch: string): string {
  if (
    !branch ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[\x00-\x20\x7f~^:?*[\\]/.test(branch) ||
    branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new Error("invalid GitHub branch");
  }
  return branch.split("/").map(encodeURIComponent).join("/");
}

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
  if (!matching) throw new Error("run /github before pushing");
  return matching;
}

async function gitHubJson<T>(
  apiBaseUrl: string,
  path: string,
  credentials: GitHubAuth | null,
  signal: AbortSignal | undefined,
  init: RequestInit = {},
): Promise<T> {
  const response = await gitHubFetch(apiBaseUrl, path, credentials, signal, init);
  return (await response.json()) as T;
}

async function gitHubFetch(
  apiBaseUrl: string,
  path: string,
  credentials: GitHubAuth | null,
  signal: AbortSignal | undefined,
  init: RequestInit = {},
): Promise<Response> {
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
  return response;
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
): Promise<{ commit: GitHubCommit; baseline: Record<string, BaselineEntry> }> {
  const commit = await getGitHubCommit(apiBaseUrl, repository, branch, credentials, signal);
  const tree = await gitHubJson<GitHubTree>(
    apiBaseUrl,
    `/repos/${githubRepositoryPath(repository)}/git/trees/${commit.commit.tree.sha}?recursive=1`,
    credentials,
    signal,
  );
  if (tree.truncated) throw new Error("GitHub truncated the repository tree; repository is too large");
  const baseline: Record<string, BaselineEntry> = {};
  for (const entry of tree.tree) {
    if (entry.type === "commit") throw new Error(`GitHub submodules are not supported: ${entry.path}`);
    if (entry.type !== "blob") continue;
    validateRelativePath(entry.path);
    if ((entry.size ?? 0) > MAX_BLOB_BYTES) {
      throw new Error(`GitHub file exceeds the ${formatBytes(MAX_BLOB_BYTES)} limit: ${entry.path}`);
    }
    baseline[entry.path] = { id: entry.sha, mode: entry.mode };
  }
  if (Object.keys(baseline).length > MAX_REPOSITORY_FILES) {
    throw new Error(`repository exceeds the ${MAX_REPOSITORY_FILES}-file browser limit`);
  }
  return { commit, baseline };
}

async function fetchGitHubSnapshotFiles(
  apiBaseUrl: string,
  repository: string,
  archiveRef: string,
  baseline: Record<string, BaselineEntry>,
  credentials: GitHubCredentials | null,
  signal: AbortSignal | undefined,
): Promise<Map<string, { bytes: Uint8Array; mode: string }>> {
  try {
    return await fetchGitHubArchive(
      apiBaseUrl,
      repository,
      archiveRef,
      baseline,
      credentials,
      signal,
    );
  } catch {
    // Older GitHub Enterprise servers and test transports may not expose
    // tarballs. The bounded blob route remains a compatible fallback.
  }
  const pending = Object.entries(baseline);
  const result = new Map<string, { bytes: Uint8Array; mode: string }>();
  let cursor = 0;
  let total = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const [path, entry] = pending[cursor++];
      const blob = await gitHubJson<{ content: string; encoding: string; size: number }>(
        apiBaseUrl,
        `/repos/${githubRepositoryPath(repository)}/git/blobs/${encodeURIComponent(entry.id)}`,
        credentials,
        signal,
      );
      if (blob.encoding !== "base64") throw new Error(`unsupported GitHub blob encoding: ${blob.encoding}`);
      if (blob.size > MAX_BLOB_BYTES) throw new Error(`GitHub file exceeds the ${formatBytes(MAX_BLOB_BYTES)} limit`);
      const bytes = base64ToBytes(blob.content);
      if (bytes.byteLength !== blob.size) throw new Error(`GitHub returned an invalid blob size for ${path}`);
      total += bytes.byteLength;
      if (total > MAX_REPOSITORY_BYTES) {
        throw new Error(`repository exceeds the ${formatBytes(MAX_REPOSITORY_BYTES)} browser limit`);
      }
      result.set(path, { bytes, mode: entry.mode });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => worker()));
  return result;
}

async function fetchGitHubArchive(
  apiBaseUrl: string,
  repository: string,
  archiveRef: string,
  baseline: Record<string, BaselineEntry>,
  credentials: GitHubCredentials | null,
  signal: AbortSignal | undefined,
): Promise<Map<string, { bytes: Uint8Array; mode: string }>> {
  const response = await gitHubFetch(
    apiBaseUrl,
    `/repos/${githubRepositoryPath(repository)}/tarball/${encodeURIComponent(
      archiveRef,
    )}`,
    credentials,
    signal,
    { headers: { Accept: "application/octet-stream" } },
  );
  const compressed = await readBoundedBody(response.body, MAX_REPOSITORY_BYTES);
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) throw new Error("GitHub archive is not gzip data");
  if (typeof DecompressionStream !== "function") throw new Error("gzip decompression is unavailable");
  const compressedBuffer = compressed.buffer.slice(
    compressed.byteOffset,
    compressed.byteOffset + compressed.byteLength,
  ) as ArrayBuffer;
  const decompressed = new Blob([compressedBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  const tar = await readBoundedBody(decompressed, MAX_REPOSITORY_BYTES + MAX_REPOSITORY_FILES * 1_024);
  return extractTarSnapshot(tar, baseline);
}

async function readBoundedBody(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!stream) throw new Error("GitHub returned an empty response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error(`GitHub archive exceeds the ${formatBytes(limit)} limit`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function tarText(bytes: Uint8Array, start: number, length: number): string {
  const field = bytes.subarray(start, start + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end < 0 ? field : field.subarray(0, end)).trim();
}

function tarNumber(bytes: Uint8Array, start: number, length: number): number {
  const text = tarText(bytes, start, length).replace(/\0/g, "").trim();
  const value = Number.parseInt(text || "0", 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid GitHub tar header");
  return value;
}

function paxValues(bytes: Uint8Array): Record<string, string> {
  const text = new TextDecoder().decode(bytes);
  const values: Record<string, string> = {};
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(" ", offset);
    if (space < 0) break;
    const length = Number(text.slice(offset, space));
    if (!Number.isSafeInteger(length) || length < 3 || offset + length > text.length) break;
    const record = text.slice(space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0) values[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return values;
}

function extractTarSnapshot(
  tar: Uint8Array,
  baseline: Record<string, BaselineEntry>,
): Map<string, { bytes: Uint8Array; mode: string }> {
  const files = new Map<string, { bytes: Uint8Array; mode: string }>();
  let offset = 0;
  let extended: Record<string, string> = {};
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const size = tarNumber(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.byteLength) throw new Error("truncated GitHub tar archive");
    if (type === "x" || type === "g") {
      extended = { ...extended, ...paxValues(tar.subarray(dataStart, dataEnd)) };
    } else {
      const rawName = extended.path || [tarText(header, 345, 155), tarText(header, 0, 100)]
        .filter(Boolean).join("/");
      const slash = rawName.indexOf("/");
      const path = slash < 0 ? "" : rawName.slice(slash + 1).replace(/\/$/, "");
      if (path && baseline[path]) {
        validateRelativePath(path);
        let bytes: Uint8Array;
        if (type === "2") bytes = encoder.encode(extended.linkpath || tarText(header, 157, 100));
        else if (type === "0" || type === "\0") bytes = tar.slice(dataStart, dataEnd);
        else throw new Error(`unsupported GitHub tar entry type for ${path}`);
        if (bytes.byteLength > MAX_BLOB_BYTES) throw new Error(`GitHub file exceeds the ${formatBytes(MAX_BLOB_BYTES)} limit`);
        files.set(path, { bytes, mode: baseline[path].mode });
      }
      extended = {};
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  const missing = Object.keys(baseline).find((path) => !files.has(path));
  if (missing) throw new Error(`GitHub archive omitted ${missing}`);
  return files;
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
      const target = new TextDecoder().decode(entry.bytes);
      py.FS.symlink(target, path);
      preserveEmscriptenSymlinkTarget(py.FS, path, target);
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
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`unsafe repository path: ${path}`);
  }
}

function removeWorktreePath(py: Pyodide, cwd: string, relative: string): void {
  const path = `${cwd}/${relative}`;
  try {
    const stat = py.FS.lstat(path);
    if (py.FS.isDir(stat.mode)) py.FS.rmdir(path);
    else {
      forgetEmscriptenSymlinkTarget(py.FS, path);
      py.FS.unlink(path);
    }
  } catch {
    // Missing paths and non-empty parent directories require no action.
  }
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
    throw new Error(`base64 blob exceeds the ${formatBytes(MAX_BLOB_BYTES)} limit`);
  }
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${Math.round(value / 1024 / 1024)} MB`;
  return `${Math.round(value / 1024)} KB`;
}
