/** Git CLI adapter backed by libgit2 compiled to WebAssembly. */
import type { Pyodide } from "./pyodide-host.ts";
import { fsExists, fsIsDir, fsReadText, fsWriteText } from "./pyodide-host.ts";
import {
  markGitRemoteHead,
  isGitHubRemoteRepository,
  listGitHubRemoteRefs,
  readGitHubSnapshotInfo,
  readGitRemoteMarker,
  retargetGitHubSnapshotBranch,
  runGitRemoteCommand,
} from "./git-remote.ts";
import { runLibgit2, type Libgit2Result } from "./libgit2.ts";
import {
  createIsomorphicGitFs,
  isomorphicGit,
  smartClone,
  smartFetch,
  smartListServerRefs,
  smartPull,
  smartPush,
} from "./git-smart-http.ts";
import type { HostCommandContext, HostCommandResult } from "./slop-host-commands.ts";
import { normalizePath } from "./wasi/abi.ts";

const encoder = new TextEncoder();

const HELP = `usage: git <command> [options]

Local repositories use canonical .git objects, refs, index, and config.

  init, clone, status, add, commit, diff, log
  branch, switch, checkout, merge, restore, reset
  remote, fetch, pull, push, ls-remote
  tag, stash, blame, rev-list, rev-parse, cat-file
  cherry-pick, clean, fsck, gc, config

Run git help <command> for the supported subset. Global -C is supported; -c is
limited to user.name, user.email, and http.corsProxy.

Smart HTTP requires CORS or a trusted --cors-proxy. Direct GitHub uses a
bounded snapshot: run git snapshot info for its upstream identity and limits.
`;

const COMMAND_HELP: Record<string, string> = {
  init: "usage: git init [-b branch] [directory]  # --bare is unavailable\n",
  clone: "usage: git clone [-b branch] [--depth n] [--single-branch] [--cors-proxy URL] <repository> [directory]\n",
  status: "usage: git status [--short] [--branch] [--porcelain[=v1]]\n",
  add: "usage: git add [-A] [--] <paths...>\n",
  commit: "usage: git commit -m <message> | git commit -F -\n",
  diff: "usage: git diff [--cached] [revisions...] [-- paths...]\n",
  log: "usage: git log [--oneline] [-n count] [--all] [--graph] [--stat]\n",
  branch: "usage: git branch [-a|-r|-v] | git branch <name> [start-point] | git branch -m [old] <new> | git branch -d|-D <name>\n",
  switch: "usage: git switch [-c branch [start-point]] | [--detach] <branch-or-commit>\n",
  checkout: "usage: git checkout [-b branch] [start-point] | git checkout [ref] [--] [paths...]\n",
  merge: "usage: git merge <branch> | git merge --abort | git merge --continue\n",
  restore: "usage: git restore [--source ref] [--staged] [--worktree] <paths...>\n",
  reset: "usage: git reset [--mixed|--soft|--hard] [commit] | git reset [commit] -- <paths...>\n",
  snapshot: "usage: git snapshot [info] | git snapshot checkout <branch>\n",
  pull: "usage: git pull [--cors-proxy URL] [remote] [branch]\n",
  push: "usage: git push [--cors-proxy URL] [remote] [refspec]\n",
  fetch: "usage: git fetch [--cors-proxy URL] [remote] [branch]\n",
  "ls-remote": "usage: git ls-remote [--cors-proxy URL] [repository] [patterns...]\n",
  clean: "usage: git clean -n | git clean -f [-d]\n",
  config: "usage: git config [--list] | git config [--get] <name> | git config <name> <value>\n",
  remote: "usage: git remote [-v] | git remote add <name> <url> | git remote remove <name>\n",
  stash: "usage: git stash [push] | git stash list | git stash pop  # custom messages are unavailable\n",
  tag: "usage: git tag | git tag [-a] <name> [-m message] [commit]\n",
  blame: "usage: git blame [revision] -- <path>\n",
  "rev-list": "usage: git rev-list [--max-count n] <revision>\n",
  "rev-parse": "usage: git rev-parse <revision> | git rev-parse --show-toplevel|--show-prefix|--git-dir\n",
  "cat-file": "usage: git cat-file -t|-s|-p <object>\n",
  "cherry-pick": "usage: git cherry-pick <commit>\n",
  fsck: "usage: git fsck\n",
  gc: "usage: git gc\n",
  "ls-files": "usage: git ls-files [--stage]\n",
};

type GitCommandContext = HostCommandContext & { gitConfigOverrides?: Record<string, string> };

function configOverrides(context: HostCommandContext): Record<string, string> {
  return (context as GitCommandContext).gitConfigOverrides ?? {};
}

function result(exitCode: number, output: string): HostCommandResult {
  return { exitCode, stdout: encoder.encode(output) };
}

function errorResult(exitCode: number, output: string): HostCommandResult {
  return { exitCode, stderr: encoder.encode(output) };
}

function workspacePath(cwd: string, value: string): string {
  const path = value.startsWith("/") ? normalizePath(value) : normalizePath(`${cwd}/${value}`);
  if (path !== "/home/web" && !path.startsWith("/home/web/")) {
    throw new Error(`path must stay inside /home/web: ${value}`);
  }
  return path;
}

function identity(context: HostCommandContext) {
  const credentials = context.getGitHubCredentials?.();
  const fallback = credentials ? {
    name: credentials.name || credentials.login,
    email: credentials.email || `${credentials.id}+${credentials.login}@users.noreply.github.com`,
  } : undefined;
  const overrides = configOverrides(context);
  const name = context.env?.GIT_AUTHOR_NAME || context.env?.GIT_COMMITTER_NAME ||
    overrides["user.name"] || fallback?.name;
  const email = context.env?.GIT_AUTHOR_EMAIL || context.env?.GIT_COMMITTER_EMAIL ||
    overrides["user.email"] || fallback?.email;
  return name && email ? { name, email } : fallback;
}

async function invoke(
  context: HostCommandContext,
  args: string[],
  cwd = context.cwd,
): Promise<Libgit2Result> {
  return runLibgit2(context.py, args, cwd, identity(context));
}

function normalizeLibgitOutput(output: string): string {
  return output
    .replace(/Fetching ([^\r\n]+) for repo 0x[0-9a-f]+/gi, "Fetching $1")
    .replaceAll("(null)", "")
    .replace(/\/workspace(?=\/|\b)/g, "/home/web");
}

function render(value: Libgit2Result): HostCommandResult {
  const stdout = normalizeLibgitOutput(value.stdout);
  const stderr = normalizeLibgitOutput(value.stderr);
  return {
    exitCode: value.exitCode,
    ...(stdout ? { stdout: encoder.encode(stdout) } : {}),
    ...(stderr ? { stderr: encoder.encode(stderr) } : {}),
  };
}

function assertBranchName(name: string): void {
  if (
    !name || name === "@" || name.startsWith("-") || name.startsWith("/") ||
    name.endsWith("/") || name.endsWith(".") || name.includes("..") || name.includes("@{") ||
    /[\x00-\x20\x7f~^:?*[\\]/.test(name) ||
    name.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new Error(`invalid branch name: ${name}`);
  }
}

function currentBranch(py: Pyodide, cwd: string): string | null {
  const path = `${cwd}/.git/HEAD`;
  if (!fsExists(py, path)) throw new Error(`not a Git repository: ${cwd}`);
  const head = fsReadText(py, path).trim();
  const prefix = "ref: refs/heads/";
  return head.startsWith(prefix) ? head.slice(prefix.length) : null;
}

function repositoryRoot(py: Pyodide, cwd: string): string {
  let directory = cwd;
  while (directory === "/home/web" || directory.startsWith("/home/web/")) {
    if (fsExists(py, `${directory}/.git`)) return directory;
    if (directory === "/home/web") break;
    directory = directory.slice(0, directory.lastIndexOf("/")) || "/";
  }
  throw new Error(`not a Git repository: ${cwd}`);
}

function gitFs(context: HostCommandContext) {
  return createIsomorphicGitFs(context.py);
}

interface ConfigEntry {
  key: string;
  value: string;
}

function parseConfig(text: string): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  let section = "";
  let subsection = "";
  for (const source of text.split(/\r?\n/)) {
    const line = source.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([^\s\]"]+)(?:\s+"([^"]+)")?\]$/.exec(line);
    if (header) {
      section = header[1].toLowerCase();
      subsection = header[2] || "";
      continue;
    }
    const setting = /^([^=\s]+)\s*(?:=\s*)?(.*)$/.exec(line);
    if (!section || !setting) continue;
    const prefix = subsection ? `${section}.${subsection}` : section;
    entries.push({ key: `${prefix}.${setting[1]}`, value: setting[2].trim() });
  }
  return entries;
}

function configEntries(py: Pyodide, root?: string): ConfigEntry[] {
  const paths = ["/home/web/.gitconfig", ...(root ? [`${root}/.git/config`] : [])];
  return paths.flatMap((path) => fsExists(py, path) ? parseConfig(fsReadText(py, path)) : []);
}

function configValue(py: Pyodide, root: string, key: string): string | undefined {
  const normalized = key.toLowerCase();
  return configEntries(py, root).filter(
    (entry) => entry.key.toLowerCase() === normalized,
  ).at(-1)?.value;
}

function remoteUrl(py: Pyodide, root: string, remote = "origin"): string | undefined {
  return configValue(py, root, `remote.${remote}.url`);
}

function isHttpRemote(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function assertSupportedRemote(value: string): void {
  if (/^(?:git|ssh):\/\//i.test(value) || /^[^/\s]+@[^:]+:/.test(value)) {
    throw new Error("browsers cannot open Git or SSH sockets; use an HTTPS remote");
  }
}

function isGitHubUrl(value: string): boolean {
  try {
    return new URL(value).hostname.toLowerCase() === "github.com";
  } catch {
    return /^(?:git@github\.com:|github:)/i.test(value) || /^[^/\s]+\/[^/\s]+(?:\.git)?$/.test(value);
  }
}

function configuredCorsProxy(py: Pyodide, root?: string): string | undefined {
  const value = root ? configValue(py, root, "http.corsProxy") : configEntries(py).filter(
    (entry) => entry.key.toLowerCase() === "http.corsproxy",
  ).at(-1)?.value;
  return value?.trim() || undefined;
}

function contextCorsProxy(context: HostCommandContext, root?: string): string | undefined {
  return configOverrides(context)["http.corsproxy"] || configuredCorsProxy(context.py, root);
}

function browserNetworkError(error: unknown, url: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/cors|failed to fetch|networkerror|load failed/i.test(message)) {
    return new Error(
      `cannot access ${url} from this browser (the server blocked CORS); ` +
      "use --cors-proxy URL with a proxy you trust",
    );
  }
  return error instanceof Error ? error : new Error(message);
}

function author(context: HostCommandContext): { name: string; email: string } {
  return identity(context) || { name: "Piodide", email: "piodide@localhost" };
}

function pathFromRepository(root: string, cwd: string, path: string): string {
  const absolute = workspacePath(cwd, path);
  if (absolute !== root && !absolute.startsWith(`${root}/`)) {
    throw new Error(`path is outside the repository: ${path}`);
  }
  return absolute === root ? "." : absolute.slice(root.length + 1);
}

async function headId(context: HostCommandContext, cwd: string): Promise<string> {
  const resolved = await invoke(context, ["rev-parse", "HEAD"], cwd);
  if (resolved.exitCode !== 0) throw new Error(`${resolved.stdout}${resolved.stderr}`.trim());
  return resolved.stdout.trim();
}

async function statusMatrix(context: HostCommandContext, cwd: string) {
  return isomorphicGit.statusMatrix({ fs: gitFs(context), dir: cwd });
}

async function isClean(context: HostCommandContext, cwd: string): Promise<boolean> {
  return (await statusMatrix(context, cwd)).every(([, head, workdir, stage]) =>
    head === workdir && workdir === stage
  );
}

async function hasStagedChanges(context: HostCommandContext, cwd: string): Promise<boolean> {
  return (await statusMatrix(context, cwd)).some(([, head, , stage]) => head !== stage);
}

async function runAdd(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  const paths: string[] = [];
  let all = false;
  let options = true;
  for (const arg of args) {
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (options && (arg === "-A" || arg === "--all")) {
      all = true;
      continue;
    }
    if (options && arg.startsWith("-")) throw new Error(`unsupported add option: ${arg}`);
    paths.push(pathFromRepository(root, context.cwd, arg));
  }
  if (!all && !paths.length) throw new Error("add requires at least one path (use -A or . to stage all changes)");
  const requested = all ? ["."] : paths;
  const selected = (filepath: string, path: string) =>
    path === "." || filepath === path || filepath.startsWith(`${path}/`);
  const matrix = await statusMatrix(context, root);
  if (!all) {
    for (const path of requested) {
      if (path === "." || matrix.some(([filepath]) => selected(filepath, path))) continue;
      const ignored = path !== "." && await isomorphicGit.isIgnored({ fs: gitFs(context), dir: root, filepath: path });
      if (ignored) throw new Error(`path is ignored: ${path}`);
      throw new Error(`pathspec '${path}' did not match any files`);
    }
  }
  const fs = gitFs(context);
  for (const [filepath, , workdir] of matrix) {
    if (!requested.some((path) => selected(filepath, path))) continue;
    if (workdir === 0) await isomorphicGit.remove({ fs, dir: root, filepath });
    else await isomorphicGit.add({ fs, dir: root, filepath });
  }
  return result(0, "");
}

function branchRef(cwd: string, name: string): string {
  assertBranchName(name);
  return `${cwd}/.git/refs/heads/${name}`;
}

function packedBranches(py: Pyodide, cwd: string): Map<string, string> {
  const path = `${cwd}/.git/packed-refs`;
  const branches = new Map<string, string>();
  if (!fsExists(py, path)) return branches;
  for (const line of fsReadText(py, path).split(/\r?\n/)) {
    const match = /^([0-9a-f]{40,64}) refs\/heads\/(.+)$/.exec(line);
    if (match) branches.set(match[2], match[1]);
  }
  return branches;
}

function looseBranches(py: Pyodide, cwd: string): Map<string, string> {
  const branches = new Map<string, string>();
  const root = `${cwd}/.git/refs/heads`;
  const visit = (directory: string, prefix: string) => {
    if (!fsExists(py, directory)) return;
    for (const name of py.FS.readdir(directory).sort()) {
      if (name === "." || name === "..") continue;
      const path = `${directory}/${name}`;
      const relative = prefix ? `${prefix}/${name}` : name;
      if (py.FS.isDir(py.FS.stat(path).mode)) visit(path, relative);
      else branches.set(relative, fsReadText(py, path).trim());
    }
  };
  visit(root, "");
  return branches;
}

async function runBranch(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const cwd = repositoryRoot(context.py, context.cwd);
  currentBranch(context.py, cwd);
  let deletion = false;
  let forceDelete = false;
  let rename = false;
  let all = false;
  let remotesOnly = false;
  let verbose = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "-d" || arg === "--delete") deletion = true;
    else if (arg === "-D") {
      deletion = true;
      forceDelete = true;
    } else if (arg === "-m" || arg === "--move") rename = true;
    else if (arg === "-a" || arg === "--all") all = true;
    else if (arg === "-r" || arg === "--remotes") remotesOnly = true;
    else if (arg === "-v" || arg === "-vv" || arg === "--verbose") verbose = true;
    else if (arg === "--show-current") return result(0, `${currentBranch(context.py, cwd) || ""}\n`);
    else if (arg === "--list") continue;
    else if (arg.startsWith("-")) throw new Error(`unsupported branch option: ${arg}`);
    else positional.push(arg);
  }
  if (rename) {
    if (positional.length < 1 || positional.length > 2) {
      throw new Error("branch -m accepts [old-name] new-name");
    }
    const oldName = positional.length === 2 ? positional[0] : currentBranch(context.py, cwd);
    const newName = positional.at(-1)!;
    if (!oldName) throw new Error("cannot rename a detached HEAD");
    assertBranchName(oldName);
    assertBranchName(newName);
    await isomorphicGit.renameBranch({ fs: gitFs(context), dir: cwd, oldref: oldName, ref: newName });
    return result(0, "");
  }
  if (positional.length > 2) throw new Error("branch accepts a branch name and optional start-point");
  const name = positional[0];
  if (!name) {
    const current = currentBranch(context.py, cwd);
    const branches = packedBranches(context.py, cwd);
    for (const [branch, oid] of looseBranches(context.py, cwd)) branches.set(branch, oid);
    const local = remotesOnly ? [] : [...branches].map(([branch, oid]) => ({ branch, oid, remote: false }));
    const remoteBranches: Array<{ remote: string; branch: string }> = [];
    if ((all || remotesOnly) && !isGitHubRemoteRepository(context.py, cwd)) {
      for (const { remote } of await isomorphicGit.listRemotes({ fs: gitFs(context), dir: cwd })) {
        const names = await isomorphicGit.listBranches({ fs: gitFs(context), dir: cwd, remote }).catch(() => []);
        remoteBranches.push(...names.map((branch) => ({ remote, branch })));
      }
    }
    const remote = remoteBranches.map(({ remote, branch }) => ({
      branch: `remotes/${remote}/${branch}`,
      oid: "",
      remote: true,
    }));
    const output = [...local, ...remote].sort((a, b) => a.branch.localeCompare(b.branch)).map(
      ({ branch, oid, remote }) => `${!remote && branch === current ? "*" : " "} ${branch}` +
        `${verbose && oid ? ` ${oid.slice(0, 7)}` : ""}\n`,
    ).join("");
    return result(0, output);
  }
  assertBranchName(name);
  const loose = branchRef(cwd, name);
  const packed = packedBranches(context.py, cwd);
  const exists = fsExists(context.py, loose) || packed.has(name);
  if (deletion) {
    if (!exists) throw new Error(`branch '${name}' not found`);
    if (currentBranch(context.py, cwd) === name) throw new Error(`cannot delete checked out branch '${name}'`);
    if (!forceDelete) {
      const branchOid = fsExists(context.py, loose) ? fsReadText(context.py, loose).trim() : packed.get(name)!;
      const head = await headId(context, cwd);
      const merged = branchOid === head || await isomorphicGit.isDescendent({
        fs: gitFs(context),
        dir: cwd,
        oid: head,
        ancestor: branchOid,
        depth: 100_000,
      });
      if (!merged) {
        throw new Error(`branch '${name}' is not fully merged; use -D to force deletion`);
      }
    }
    if (fsExists(context.py, loose)) context.py.FS.unlink(loose);
    if (packed.has(name)) removePackedBranch(context.py, cwd, name);
    return result(0, `Deleted branch ${name}.\n`);
  }
  if (exists) throw new Error(`a branch named '${name}' already exists`);
  const startPoint = positional[1] || "HEAD";
  const resolved = await invoke(context, ["rev-parse", startPoint], cwd);
  if (resolved.exitCode !== 0) throw new Error(`${resolved.stdout}${resolved.stderr}`.trim());
  fsWriteText(context.py, loose, `${resolved.stdout.trim()}\n`);
  return result(0, "");
}

async function runSwitch(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  let create = false;
  let detach = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "-c" || arg === "--create") create = true;
    else if (arg === "--detach") detach = true;
    else if (arg.startsWith("-")) throw new Error(`unsupported switch option: ${arg}`);
    else positional.push(arg);
  }
  if (create) {
    if (positional.length < 1 || positional.length > 2) throw new Error("switch -c requires a branch and optional start-point");
    assertBranchName(positional[0]);
    await isomorphicGit.branch({
      fs: gitFs(context),
      dir: root,
      ref: positional[0],
      object: positional[1] || "HEAD",
    });
  } else if (positional.length !== 1) throw new Error("switch requires exactly one branch or commit");
  const ref = positional[0];
  const localExists = fsExists(context.py, branchRef(root, ref)) || packedBranches(context.py, root).has(ref);
  if (!create && !detach && !localExists && isGitHubRemoteRepository(context.py, root)) {
    throw new Error(
      `branch '${ref}' is not materialized in this GitHub snapshot; ` +
      `use 'git snapshot checkout ${ref}' to import it explicitly`,
    );
  }
  await isomorphicGit.checkout({
    fs: gitFs(context),
    dir: root,
    ref,
    track: !detach,
  });
  return result(0, detach ? `HEAD is now at ${ref}\n` : `Switched to branch '${ref}'\n`);
}

async function runSnapshot(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  if (!isGitHubRemoteRepository(context.py, root)) {
    throw new Error("this is a full Git repository, not a GitHub snapshot");
  }
  const info = readGitHubSnapshotInfo(context.py, root);
  if (args.length === 0 || (args.length === 1 && args[0] === "info")) {
    const localHead = await headId(context, root);
    return result(0,
      `mode=github-snapshot\nrepository=${info.repository}\n` +
      `upstream_branch=${info.upstreamBranch}\nupstream_commit=${info.upstreamCommit}\n` +
      `local_branch=${currentBranch(context.py, root) || "(detached)"}\n` +
      `local_commit=${localHead}\nhistory=not-materialized\n`,
    );
  }
  if (args.length !== 2 || args[0] !== "checkout") {
    throw new Error("usage: git snapshot [info] | git snapshot checkout <branch>");
  }
  const branch = args[1];
  assertBranchName(branch);
  if (!(await isClean(context, root))) {
    throw new Error("commit or discard local changes before importing a snapshot branch");
  }
  const remoteRefs = await listGitHubRemoteRefs(
    context.py,
    root,
    context.getGitHubCredentials?.() ?? null,
    context.signal,
  );
  if (!remoteRefs.some((entry) => entry.ref === `refs/heads/${branch}`)) {
    throw new Error(`upstream branch '${branch}' not found`);
  }
  const localExists = fsExists(context.py, branchRef(root, branch)) || packedBranches(context.py, root).has(branch);
  if (localExists) throw new Error(`local branch '${branch}' already exists; use git switch ${branch}`);
  await isomorphicGit.branch({ fs: gitFs(context), dir: root, ref: branch, object: "HEAD" });
  await isomorphicGit.checkout({ fs: gitFs(context), dir: root, ref: branch, track: false });
  const fetched = await runGitRemoteCommand({
    ...context,
    cwd: root,
    args: ["git-remote", "checkout", branch],
  });
  const fetchedText = new TextDecoder().decode(fetched.stdout ?? fetched.stderr ?? new Uint8Array());
  if (fetched.exitCode !== 0) return fetched.stderr
    ? { exitCode: fetched.exitCode, stderr: fetched.stderr }
    : errorResult(fetched.exitCode, fetchedText);
  const added = await runAdd({ ...context, cwd: root }, ["."]);
  if (added.exitCode !== 0) return added;
  const message = readGitRemoteMarker(context.py, root, "remote-message") || `Import snapshot branch ${branch}`;
  const committed = await invoke(context, ["commit", "-m", message], root);
  if (committed.exitCode !== 0) return render(committed);
  const head = await headId(context, root);
  markGitRemoteHead(context.py, root, head);
  await setUpstream(context, root, "origin", branch);
  return result(0,
    `Imported ${info.repository}@${branch} as synthetic local commit ${head.slice(0, 7)}.\n` +
    "Upstream history and remote-tracking refs are not materialized.\n" + fetchedText,
  );
}

function removePackedBranch(py: Pyodide, cwd: string, branch: string): void {
  const path = `${cwd}/.git/packed-refs`;
  const lines = fsReadText(py, path).split(/\r?\n/);
  const target = ` refs/heads/${branch}`;
  const kept: string[] = [];
  let removed = false;
  for (const line of lines) {
    if (line.endsWith(target)) {
      removed = true;
      continue;
    }
    if (removed && line.startsWith("^")) {
      removed = false;
      continue;
    }
    removed = false;
    kept.push(line);
  }
  fsWriteText(py, path, kept.join("\n"));
}

function cloneArguments(args: string[], cwd: string): {
  project: string;
  destination: string;
  branch?: string;
  corsProxy?: string;
  depth?: number;
  singleBranch: boolean;
} {
  let branch: string | undefined;
  let corsProxy: string | undefined;
  let depth: number | undefined;
  let singleBranch = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-b" || arg === "--branch") {
      branch = args[++index];
      if (!branch) throw new Error(`${arg} requires a branch name`);
    } else if (arg === "--cors-proxy") {
      corsProxy = args[++index];
      if (!corsProxy) throw new Error("--cors-proxy requires a URL");
    } else if (arg === "--depth") {
      depth = Number(args[++index]);
      if (!Number.isSafeInteger(depth) || depth < 1) throw new Error("--depth requires a positive integer");
    } else if (arg.startsWith("--depth=")) {
      depth = Number(arg.slice(8));
      if (!Number.isSafeInteger(depth) || depth < 1) throw new Error("--depth requires a positive integer");
    } else if (arg === "--single-branch") {
      singleBranch = true;
    } else if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    } else if (arg.startsWith("-")) {
      throw new Error(`unsupported clone option: ${arg}`);
    } else positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2) {
    throw new Error("usage: git clone [-b branch] <repository> [directory]");
  }
  const project = positional[0];
  const inferred = project.replace(/\/+$/, "").slice(project.replace(/\/+$/, "").lastIndexOf("/") + 1)
    .replace(/\.git$/i, "");
  if (!inferred || inferred === "." || inferred === "..") throw new Error("cannot derive clone directory");
  return {
    project,
    destination: workspacePath(cwd, positional[1] || inferred),
    branch,
    corsProxy,
    depth,
    singleBranch,
  };
}

function libgitPath(path: string): string {
  return path === "/home/web" ? "/workspace" : `/workspace/${path.slice("/home/web/".length)}`;
}

function localCloneSource(context: HostCommandContext, project: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(project) || /^git@/i.test(project)) return null;
  try {
    const source = workspacePath(context.cwd, project);
    return fsExists(context.py, source) ? source : null;
  } catch {
    return null;
  }
}

function cleanupFailedClone(py: Pyodide, destination: string, destinationExisted: boolean): void {
  if (!fsExists(py, destination) || !fsIsDir(py, destination)) return;
  for (const name of py.FS.readdir(destination)) {
    if (name === "." || name === "..") continue;
    const child = `${destination}/${name}`;
    if (py.FS.isDir(py.FS.lstat(child).mode)) removeDirectory(py, child);
    else py.FS.unlink(child);
  }
  if (!destinationExisted) py.FS.rmdir(destination);
}

async function runClone(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const parsed = cloneArguments(args, context.cwd);
  if (parsed.branch) assertBranchName(parsed.branch);
  const destinationExisted = fsExists(context.py, parsed.destination);
  const localSource = localCloneSource(context, parsed.project);
  if (localSource) {
    if (localSource === parsed.destination) throw new Error("source and destination are the same repository");
    if (fsExists(context.py, parsed.destination) && (
      !fsIsDir(context.py, parsed.destination) || context.py.FS.readdir(parsed.destination).length > 2
    )) {
      throw new Error(`destination is not empty: ${parsed.destination}`);
    }
    const cloned = await invoke(
      context,
      ["clone", libgitPath(localSource), libgitPath(parsed.destination)],
      "/home/web",
    );
    if (cloned.exitCode !== 0) {
      cleanupFailedClone(context.py, parsed.destination, destinationExisted);
      return render(cloned);
    }
    if (parsed.branch) {
      const checkedOut = await invoke(context, ["checkout", parsed.branch], parsed.destination);
      if (checkedOut.exitCode !== 0) {
        cleanupFailedClone(context.py, parsed.destination, destinationExisted);
        return render(checkedOut);
      }
      cloned.stdout += checkedOut.stdout;
      cloned.stderr += checkedOut.stderr;
    }
    return render(cloned);
  }
  const proxy = parsed.corsProxy || contextCorsProxy(context);
  if (!isGitHubUrl(parsed.project) || proxy) {
    assertSupportedRemote(parsed.project);
    if (!isHttpRemote(parsed.project)) {
      throw new Error("browser smart HTTP clone requires an http(s) repository URL");
    }
    if (fsExists(context.py, parsed.destination) && (
      !fsIsDir(context.py, parsed.destination) || context.py.FS.readdir(parsed.destination).length > 2
    )) {
      throw new Error(`destination is not empty: ${parsed.destination}`);
    }
    try {
      await smartClone({
        py: context.py,
        dir: parsed.destination,
        url: parsed.project,
        ref: parsed.branch,
        singleBranch: parsed.singleBranch,
        depth: parsed.depth,
        corsProxy: proxy,
        credentials: context.getGitHubCredentials?.(),
        signal: context.signal,
      });
      return result(0, `Cloned ${parsed.project} into ${parsed.destination}\n`);
    } catch (error) {
      cleanupFailedClone(context.py, parsed.destination, destinationExisted);
      throw browserNetworkError(error, parsed.project);
    }
  }
  if (fsExists(context.py, parsed.destination)) {
    if (!fsIsDir(context.py, parsed.destination) || context.py.FS.readdir(parsed.destination).length > 2) {
      throw new Error(`destination is not empty: ${parsed.destination}`);
    }
  } else context.py.FS.mkdirTree(parsed.destination);

  const initialized = await invoke(context, ["init", "."], parsed.destination);
  if (initialized.exitCode !== 0) {
    cleanupFailedClone(context.py, parsed.destination, destinationExisted);
    return render(initialized);
  }
  let fetched: HostCommandResult;
  try {
    fetched = await runGitRemoteCommand({
      ...context,
      cwd: parsed.destination,
      args: ["git-remote", "clone", parsed.project, parsed.branch || ""],
    });
  } catch (error) {
    cleanupFailedClone(context.py, parsed.destination, destinationExisted);
    throw error;
  }
  const fetchedText = new TextDecoder().decode(fetched.stdout ?? fetched.stderr ?? new Uint8Array());
  if (fetched.exitCode !== 0) {
    cleanupFailedClone(context.py, parsed.destination, destinationExisted);
    return fetched;
  }
  const added = await runAdd({ ...context, cwd: parsed.destination }, ["."]);
  if (added.exitCode !== 0) {
    cleanupFailedClone(context.py, parsed.destination, destinationExisted);
    return added;
  }
  const message = readGitRemoteMarker(context.py, parsed.destination, "remote-message") || "Import repository";
  const committed = await invoke(context, ["commit", "-m", message], parsed.destination);
  if (committed.exitCode !== 0) {
    cleanupFailedClone(context.py, parsed.destination, destinationExisted);
    return render(committed);
  }
  const head = await headId(context, parsed.destination);
  markGitRemoteHead(context.py, parsed.destination, head);
  return result(
    0,
    `Snapshot-cloned ${parsed.project} into ${parsed.destination}\n${fetchedText}` +
      `Created synthetic local commit ${head.slice(0, 7)}. ` +
      "Upstream history, tags, and remote-tracking refs are not materialized.\n",
  );
}

function networkArguments(args: string[]): {
  positional: string[];
  corsProxy?: string;
  prune: boolean;
  pruneTags: boolean;
  setUpstream: boolean;
} {
  const positional: string[] = [];
  let corsProxy: string | undefined;
  let prune = false;
  let pruneTags = false;
  let setUpstream = false;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--cors-proxy") {
      corsProxy = args[++index];
      if (!corsProxy) throw new Error("--cors-proxy requires a URL");
    } else if (value.startsWith("--cors-proxy=")) corsProxy = value.slice(13);
    else if (value === "--prune" || value === "-p") prune = true;
    else if (value === "--prune-tags") pruneTags = true;
    else if (value === "-u" || value === "--set-upstream") setUpstream = true;
    else if (value === "--") positional.push(...args.slice(index + 1));
    else if (value.startsWith("-")) throw new Error(`unsupported network option: ${value}`);
    else positional.push(value);
  }
  return { positional, corsProxy, prune, pruneTags, setUpstream };
}

async function runFetch(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const cwd = repositoryRoot(context.py, context.cwd);
  if (isGitHubRemoteRepository(context.py, cwd)) {
    throw new Error(
      "git fetch cannot materialize objects in GitHub snapshot mode; " +
      "use git pull for the tracked snapshot or clone through a trusted CORS proxy for full history",
    );
  }
  const parsed = networkArguments(args);
  const remote = parsed.positional[0] || "origin";
  const url = remoteUrl(context.py, cwd, remote);
  if (!url) throw new Error(`remote '${remote}' has no URL`);
  assertSupportedRemote(url);
  if (!isHttpRemote(url)) return render(await invoke(context, ["fetch", remote, ...parsed.positional.slice(1)], cwd));
  try {
    await smartFetch({
      py: context.py,
      dir: cwd,
      url,
      remote,
      ref: parsed.positional[1],
      corsProxy: parsed.corsProxy || contextCorsProxy(context, cwd),
      prune: parsed.prune,
      pruneTags: parsed.pruneTags,
      credentials: context.getGitHubCredentials?.(),
      signal: context.signal,
    });
    return result(0, `Fetched ${remote}\n`);
  } catch (error) {
    throw browserNetworkError(error, url);
  }
}

async function runPull(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const cwd = repositoryRoot(context.py, context.cwd);
  if (!(await isClean(context, cwd))) throw new Error("commit or discard local changes before pulling");
  if (!isGitHubRemoteRepository(context.py, cwd)) {
    const branch = currentBranch(context.py, cwd);
    if (!branch) throw new Error("cannot pull with a detached HEAD");
    const parsed = networkArguments(args);
    const remote = parsed.positional[0] || "origin";
    const requestedBranch = parsed.positional[1] || branch;
    const url = remoteUrl(context.py, cwd, remote);
    if (!url) throw new Error(`remote '${remote}' has no URL`);
    assertSupportedRemote(url);
    if (isHttpRemote(url)) {
      try {
        await smartPull({
          py: context.py,
          dir: cwd,
          url,
          remote,
          ref: branch,
          remoteRef: requestedBranch,
          corsProxy: parsed.corsProxy || contextCorsProxy(context, cwd),
          credentials: context.getGitHubCredentials?.(),
          signal: context.signal,
        }, author(context));
        return result(0, "Already up to date or fast-forwarded.\n");
      } catch (error) {
        throw browserNetworkError(error, url);
      }
    }
    const fetched = await invoke(context, ["fetch", remote], cwd);
    if (fetched.exitCode !== 0) return render(fetched);
    const merged = await runLibgitCommand(context, cwd, ["merge", `${remote}/${requestedBranch}`]);
    return {
      exitCode: merged.exitCode,
      stdout: encoder.encode(
        `${normalizeLibgitOutput(fetched.stdout)}${new TextDecoder().decode(merged.stdout ?? new Uint8Array())}`,
      ),
      ...(fetched.stderr || merged.stderr ? {
        stderr: encoder.encode(
          `${normalizeLibgitOutput(fetched.stderr)}${new TextDecoder().decode(merged.stderr ?? new Uint8Array())}`,
        ),
      } : {}),
    };
  }
  if (args.length) throw new Error("the GitHub snapshot pull accepts no remote or branch arguments");
  const head = await headId(context, cwd);
  const pulled = await runGitRemoteCommand({ ...context, cwd, args: ["git-remote", "pull", head] });
  const output = new TextDecoder().decode(pulled.stdout ?? pulled.stderr ?? new Uint8Array());
  if (pulled.exitCode !== 0) return pulled;
  if (output.startsWith("Already up to date")) return result(0, output);
  const added = await runAdd({ ...context, cwd }, ["."]);
  if (added.exitCode !== 0) return added;
  const message = readGitRemoteMarker(context.py, cwd, "remote-message") || "Pull remote snapshot";
  const committed = await invoke(context, ["commit", "-m", message], cwd);
  if (committed.exitCode !== 0) return render(committed);
  markGitRemoteHead(context.py, cwd, await headId(context, cwd));
  return result(0, output);
}

async function runPush(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const cwd = repositoryRoot(context.py, context.cwd);
  if (!isGitHubRemoteRepository(context.py, cwd)) {
    const parsed = networkArguments(args);
    const remote = parsed.positional[0] || "origin";
    const url = remoteUrl(context.py, cwd, remote);
    if (url) assertSupportedRemote(url);
    if (!url || !isHttpRemote(url)) {
      // wasm-git's local transport only accepts the configured default push.
      // Treat an explicit `origin <current-branch>` (as emitted by the agent
      // tool) as that default instead of forwarding unsupported arguments.
      const branch = currentBranch(context.py, cwd);
      const explicitDefault = parsed.positional.length > 0 && remote === "origin" &&
        parsed.positional.length <= 2 && (!parsed.positional[1] || parsed.positional[1] === branch);
      if (parsed.positional.length && !explicitDefault) {
        throw new Error("local push only supports origin and the checked-out branch");
      }
      const pushed = await invoke(context, ["push"], cwd);
      if (pushed.exitCode === 0 && parsed.setUpstream) await setUpstream(context, cwd, remote, branch || undefined);
      return render(pushed);
    }
    const branch = currentBranch(context.py, cwd);
    if (!branch) throw new Error("cannot push a detached HEAD without an explicit refspec");
    const refspec = parsed.positional[1];
    const [ref, remoteRef] = refspec?.includes(":") ? refspec.split(":", 2) : [refspec || branch, undefined];
    try {
      const pushed = await smartPush({
        py: context.py,
        dir: cwd,
        url,
        remote,
        ref,
        remoteRef,
        corsProxy: parsed.corsProxy || contextCorsProxy(context, cwd),
        credentials: context.getGitHubCredentials?.(),
        signal: context.signal,
      });
      if (pushed.ok && parsed.setUpstream) await setUpstream(context, cwd, remote, remoteRef || ref);
      return pushed.ok
        ? result(0, `Pushed ${ref} to ${remote}\n`)
        : errorResult(1, `git: push rejected by ${remote}\n`);
    } catch (error) {
      throw browserNetworkError(error, url);
    }
  }
  const parsed = networkArguments(args);
  const remote = parsed.positional[0] || "origin";
  if (remote !== "origin") throw new Error("the GitHub snapshot fallback only has the 'origin' remote");
  const branch = currentBranch(context.py, cwd);
  if (!branch) throw new Error("cannot push a detached HEAD");
  const refspec = parsed.positional[1];
  const [localRef, remoteRef] = refspec?.includes(":")
    ? refspec.split(":", 2)
    : [refspec || branch, refspec || branch];
  if (localRef !== branch) throw new Error("the GitHub snapshot fallback can only push the checked-out branch");
  retargetGitHubSnapshotBranch(context.py, cwd, branch, remoteRef);
  if (!(await isClean(context, cwd))) throw new Error("commit or discard local changes before pushing");
  const head = await headId(context, cwd);
  const log = await invoke(context, ["log", "--oneline", "-n", "1"], cwd);
  const message = log.stdout.trim().replace(/^[0-9a-f]+\s+/, "") || "Update from piodide";
  const pushed = await runGitRemoteCommand({
    ...context,
    cwd,
    args: ["git-remote", "push", head, message],
  });
  if (pushed.exitCode === 0 && parsed.setUpstream) await setUpstream(context, cwd, "origin", remoteRef);
  return pushed;
}

async function setUpstream(
  context: HostCommandContext,
  root: string,
  remote: string,
  branch = currentBranch(context.py, root) || "",
): Promise<void> {
  if (!branch) throw new Error("cannot set upstream for a detached HEAD");
  const local = currentBranch(context.py, root) || branch;
  const fs = gitFs(context);
  await isomorphicGit.setConfig({ fs, dir: root, path: `branch.${local}.remote`, value: remote });
  await isomorphicGit.setConfig({ fs, dir: root, path: `branch.${local}.merge`, value: `refs/heads/${branch}` });
}

async function runLsRemote(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const parsed = networkArguments(args);
  let target = parsed.positional[0] || "origin";
  let root: string | undefined;
  try { root = repositoryRoot(context.py, context.cwd); } catch { /* URL-only form */ }
  const url = root && !isHttpRemote(target) ? remoteUrl(context.py, root, target) : target;
  if (!url) throw new Error(`remote '${target}' has no URL`);
  assertSupportedRemote(url);
  if (root && isGitHubRemoteRepository(context.py, root) && !parsed.corsProxy) {
    const refs = await listGitHubRemoteRefs(
      context.py,
      root,
      context.getGitHubCredentials?.() ?? null,
      context.signal,
    );
    const patterns = parsed.positional.slice(1);
    const selected = patterns.length ? refs.filter(({ ref }) => patterns.some(
      (pattern) => ref === pattern || ref.endsWith(`/${pattern}`),
    )) : refs;
    return result(0, selected.map(({ oid, ref }) => `${oid}\t${ref}\n`).join(""));
  }
  if (!isHttpRemote(url)) return render(await invoke(context, ["ls-remote", target, ...parsed.positional.slice(1)], context.cwd));
  const refs = await smartListServerRefs({
    py: context.py,
    url,
    corsProxy: parsed.corsProxy || contextCorsProxy(context, root),
    credentials: context.getGitHubCredentials?.(),
    signal: context.signal,
  }).catch((error) => { throw browserNetworkError(error, url); });
  const patterns = parsed.positional.slice(1);
  const selected = patterns.length ? refs.filter(({ ref }) => patterns.some(
    (pattern) => ref === pattern || ref.endsWith(`/${pattern}`),
  )) : refs;
  return result(0, selected.flatMap(({ oid, ref, peeled }) => [
    `${oid}\t${ref}\n`,
    ...(peeled ? [`${peeled}\t${ref}^{}\n`] : []),
  ]).join(""));
}

async function runConfig(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const global = args.includes("--global");
  const local = args.includes("--local");
  if (global && local) throw new Error("--global and --local are mutually exclusive");
  args = args.filter((arg) => arg !== "--global" && arg !== "--local");
  let root: string | undefined;
  try { root = repositoryRoot(context.py, context.cwd); } catch { /* global config only */ }
  const storedEntries = global
    ? (fsExists(context.py, "/home/web/.gitconfig") ? parseConfig(fsReadText(context.py, "/home/web/.gitconfig")) : [])
    : configEntries(context.py, root);
  const entries = [
    ...storedEntries,
    ...Object.entries(configOverrides(context)).map(([key, value]) => ({ key, value })),
  ];
  if (args.length === 0 || args[0] === "--list" || args[0] === "-l") {
    return result(0, entries.map(({ key, value }) => `${key}=${value}\n`).join(""));
  }
  const valuesOnly = args[0] === "--get";
  const effective = valuesOnly ? args.slice(1) : args;
  if (effective.length === 1) {
    const key = effective[0].toLowerCase();
    const values = entries.filter((entry) => entry.key.toLowerCase() === key);
    return values.length ? result(0, `${values.at(-1)!.value}\n`) : result(1, "");
  }
  if (effective.length === 2) {
    if (global) appendConfig(context.py, "/home/web/.gitconfig", effective[0], effective[1]);
    else {
      if (!root) throw new Error("not a Git repository (use --global outside one)");
      await isomorphicGit.setConfig({ fs: gitFs(context), dir: root, path: effective[0], value: effective[1] });
    }
    return result(0, "");
  }
  throw new Error("usage: git config [--list] | git config [--get] name | git config name value");
}

function appendConfig(py: Pyodide, path: string, key: string, value: string): void {
  const parts = key.split(".");
  if (parts.length < 2 || parts.some((part) => !part || /[\r\n\[\]]/.test(part))) {
    throw new Error(`invalid config key: ${key}`);
  }
  if (/[\r\n]/.test(value)) throw new Error("config value must be one line");
  const section = parts.shift()!;
  const name = parts.pop()!;
  const subsection = parts.join(".");
  const previous = fsExists(py, path) ? fsReadText(py, path).trimEnd() : "";
  const header = subsection ? `[${section} "${subsection.replaceAll("\"", "\\\"")}"]` : `[${section}]`;
  fsWriteText(py, path, `${previous}${previous ? "\n" : ""}${header}\n\t${name} = ${value}\n`);
}

async function runRemote(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  const fs = gitFs(context);
  const verbose = args[0] === "-v" || args[0] === "--verbose";
  if (args.length === 0 || verbose) {
    const remotes = await isomorphicGit.listRemotes({ fs, dir: root });
    return result(0, remotes.map(({ remote, url }) => verbose
      ? `${remote}\t${url} (fetch)\n${remote}\t${url} (push)\n`
      : `${remote}\n`).join(""));
  }
  if (args[0] === "get-url" && args.length === 2) {
    const url = remoteUrl(context.py, root, args[1]);
    return url ? result(0, `${url}\n`) : errorResult(2, `error: No such remote '${args[1]}'\n`);
  }
  if (args[0] === "add" && args.length === 3) {
    await isomorphicGit.addRemote({ fs, dir: root, remote: args[1], url: args[2] });
    return result(0, "");
  }
  if ((args[0] === "remove" || args[0] === "rm") && args.length === 2) {
    await isomorphicGit.deleteRemote({ fs, dir: root, remote: args[1] });
    return result(0, "");
  }
  throw new Error("usage: git remote [-v] | git remote add <name> <url> | git remote remove <name>");
}

async function runRestore(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  let source = "HEAD";
  let staged = false;
  let worktree = false;
  const paths: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--staged" || value === "-S") staged = true;
    else if (value === "--worktree" || value === "-W") worktree = true;
    else if (value === "--source" || value === "-s") {
      source = args[++index];
      if (!source) throw new Error(`${value} requires a ref`);
    } else if (value.startsWith("--source=")) source = value.slice(9);
    else if (value === "--") {
      paths.push(...args.slice(index + 1));
      break;
    } else if (value.startsWith("-")) throw new Error(`unsupported restore option: ${value}`);
    else paths.push(value);
  }
  if (!paths.length) throw new Error("restore requires at least one path");
  const filepaths = paths.map((path) => pathFromRepository(root, context.cwd, path));
  const fs = gitFs(context);
  if (staged) {
    for (const filepath of filepaths) {
      await isomorphicGit.resetIndex({ fs, dir: root, filepath, ref: source });
    }
  }
  if (worktree || !staged) {
    await isomorphicGit.checkout({
      fs,
      dir: root,
      ref: source,
      filepaths,
      noUpdateHead: true,
      force: true,
    });
  }
  return result(0, "");
}

type ResetMode = "mixed" | "soft" | "hard";

async function resetIndexPaths(
  context: HostCommandContext,
  root: string,
  ref: string,
  paths?: string[],
): Promise<void> {
  const fs = gitFs(context);
  const filepaths = paths ?? [...new Set([
    ...await isomorphicGit.listFiles({ fs, dir: root }),
    ...await isomorphicGit.listFiles({ fs, dir: root, ref }),
  ])];
  for (const filepath of filepaths) {
    await isomorphicGit.resetIndex({ fs, dir: root, filepath, ref });
  }
}

function clearMergeState(py: Pyodide, root: string): void {
  for (const name of ["MERGE_HEAD", "MERGE_MODE", "MERGE_MSG"]) {
    const path = `${root}/.git/${name}`;
    if (fsExists(py, path)) py.FS.unlink(path);
  }
}

async function moveHead(context: HostCommandContext, root: string, oid: string): Promise<void> {
  const branch = currentBranch(context.py, root);
  await isomorphicGit.writeRef({
    fs: gitFs(context),
    dir: root,
    ref: branch ? `refs/heads/${branch}` : "HEAD",
    value: oid,
    force: true,
  });
}

async function runReset(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  let mode: ResetMode = "mixed";
  let separator = -1;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--") {
      separator = index;
      positional.push(...args.slice(index + 1));
      break;
    }
    if (value === "--mixed" || value === "--soft" || value === "--hard") {
      mode = value.slice(2) as ResetMode;
    } else if (value.startsWith("-")) {
      throw new Error(`unsupported reset option: ${value}`);
    } else positional.push(value);
  }

  let ref = "HEAD";
  let paths: string[] = [];
  if (separator >= 0) {
    const before = args.slice(0, separator).filter((value) => !value.startsWith("--"));
    if (before.length > 1) throw new Error("reset accepts at most one revision before --");
    ref = before[0] || "HEAD";
    paths = args.slice(separator + 1);
  } else if (positional.length > 0) {
    ref = positional[0];
    paths = positional.slice(1);
  }
  if (paths.length && mode !== "mixed") {
    throw new Error(`reset --${mode} does not accept paths`);
  }

  const fs = gitFs(context);
  let oid: string;
  try {
    oid = await isomorphicGit.resolveRef({ fs, dir: root, ref });
  } catch {
    throw new Error(`unknown revision: ${ref}`);
  }
  if (paths.length) {
    await resetIndexPaths(
      context,
      root,
      oid,
      paths.map((path) => pathFromRepository(root, context.cwd, path)),
    );
    return result(0, "");
  }

  if (mode === "hard") {
    await isomorphicGit.checkout({ fs, dir: root, ref: oid, noUpdateHead: true, force: true });
  } else if (mode === "mixed") {
    await resetIndexPaths(context, root, oid);
  }
  await moveHead(context, root, oid);
  clearMergeState(context.py, root);
  return result(0, mode === "hard" ? `HEAD is now at ${oid.slice(0, 7)}\n` : "");
}

async function runClean(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  const force = args.includes("-f") || args.includes("--force");
  const dryRun = args.includes("-n") || args.includes("--dry-run");
  const directories = args.includes("-d");
  if (!force && !dryRun) throw new Error("clean requires -n (preview) or -f");
  for (const arg of args) {
    if (!["-f", "--force", "-n", "--dry-run", "-d"].includes(arg)) {
      throw new Error(`unsupported clean option: ${arg}`);
    }
  }
  const matrix = await isomorphicGit.statusMatrix({ fs: gitFs(context), dir: root });
  const untracked = matrix.filter(([, head, workdir, stage]) => head === 0 && workdir === 2 && stage === 0)
    .map(([filepath]) => filepath).sort();
  for (const filepath of untracked) {
    const absolute = `${root}/${filepath}`;
    if (!directories && fsIsDir(context.py, absolute)) continue;
    if (!dryRun) {
      if (fsIsDir(context.py, absolute)) removeDirectory(context.py, absolute);
      else context.py.FS.unlink(absolute);
    }
  }
  return result(0, untracked.map((path) => `Would remove ${path}\n`).join("").replaceAll(
    "Would remove ", dryRun ? "Would remove " : "Removing ",
  ));
}

function removeDirectory(py: Pyodide, path: string): void {
  for (const name of py.FS.readdir(path)) {
    if (name === "." || name === "..") continue;
    const child = `${path}/${name}`;
    if (py.FS.isDir(py.FS.lstat(child).mode)) removeDirectory(py, child);
    else py.FS.unlink(child);
  }
  py.FS.rmdir(path);
}

async function runCherryPick(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  if (args.length !== 1 || args[0].startsWith("-")) throw new Error("usage: git cherry-pick <commit>");
  const oid = await isomorphicGit.resolveRef({ fs: gitFs(context), dir: root, ref: args[0] });
  try {
    const created = await isomorphicGit.cherryPick({
      fs: gitFs(context),
      dir: root,
      oid,
      committer: author(context),
      abortOnConflict: false,
    });
    return result(0, `[${currentBranch(context.py, root) || "detached"} ${created.slice(0, 7)}] cherry-pick\n`);
  } catch (error) {
    return errorResult(1, `git: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

async function runGc(context: HostCommandContext): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  const objects = `${root}/.git/objects`;
  const oids: string[] = [];
  if (fsExists(context.py, objects)) {
    for (const prefix of context.py.FS.readdir(objects)) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
      for (const suffix of context.py.FS.readdir(`${objects}/${prefix}`)) {
        if (/^[0-9a-f]{38}$/.test(suffix)) oids.push(`${prefix}${suffix}`);
      }
    }
  }
  if (!oids.length) return result(0, "Nothing to pack.\n");
  const fs = gitFs(context);
  const packed = await isomorphicGit.packObjects({ fs, dir: root, oids, write: true });
  const packPath = `.git/objects/pack/${packed.filename}`;
  await isomorphicGit.indexPack({ fs, dir: root, filepath: packPath });
  const indexName = packed.filename.replace(/\.pack$/, ".idx");
  if (!fsExists(context.py, `${root}/.git/objects/pack/${indexName}`)) {
    throw new Error(`failed to index ${packed.filename}; loose objects were retained`);
  }
  // Only prune after the companion index exists and the pack can serve reads.
  await isomorphicGit.readObject({ fs, dir: root, oid: oids[0] });
  for (const oid of oids) {
    const directory = `${objects}/${oid.slice(0, 2)}`;
    context.py.FS.unlink(`${directory}/${oid.slice(2)}`);
    try {
      if (context.py.FS.readdir(directory).every((name) => name === "." || name === "..")) {
        context.py.FS.rmdir(directory);
      }
    } catch { /* another loose object still uses the directory */ }
  }
  return result(0, `Packed and pruned ${oids.length} object(s) into ${packed.filename}.\n`);
}

function looseRefs(py: Pyodide, root: string): string[] {
  const refs: string[] = [];
  const visit = (directory: string, prefix: string) => {
    if (!fsExists(py, directory)) return;
    for (const name of py.FS.readdir(directory)) {
      if (name === "." || name === "..") continue;
      const path = `${directory}/${name}`;
      const ref = prefix ? `${prefix}/${name}` : name;
      if (py.FS.isDir(py.FS.lstat(path).mode)) visit(path, ref);
      else refs.push(ref);
    }
  };
  visit(`${root}/.git/refs`, "refs");
  return refs;
}

function objectId(bytes: Uint8Array, offset: number): string {
  let value = "";
  for (let index = offset; index < offset + 20; index++) value += bytes[index].toString(16).padStart(2, "0");
  return value;
}

function packedObjectIds(py: Pyodide, root: string): string[] {
  const directory = `${root}/.git/objects/pack`;
  if (!fsExists(py, directory)) return [];
  const ids: string[] = [];
  for (const name of py.FS.readdir(directory)) {
    if (!name.endsWith(".idx")) continue;
    const bytes = py.FS.readFile(`${directory}/${name}`) as Uint8Array;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version2 = bytes.length >= 8 && view.getUint32(0) === 0xff744f63;
    const fanout = version2 ? 8 : 0;
    if (version2 && view.getUint32(4) !== 2) throw new Error(`unsupported pack index version in ${name}`);
    if (bytes.length < fanout + 1024) throw new Error(`truncated pack index: ${name}`);
    const count = view.getUint32(fanout + 255 * 4);
    if (count > 100_000) throw new Error("fsck object limit exceeded (100000)");
    if (version2) {
      const table = fanout + 256 * 4;
      if (bytes.length < table + count * 20) throw new Error(`truncated pack index: ${name}`);
      for (let index = 0; index < count; index++) ids.push(objectId(bytes, table + index * 20));
    } else {
      const table = 256 * 4;
      if (bytes.length < table + count * 24) throw new Error(`truncated pack index: ${name}`);
      for (let index = 0; index < count; index++) ids.push(objectId(bytes, table + index * 24 + 4));
    }
  }
  return ids;
}

function conciseObjectError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const mismatch = /SHA check failed! Expected ([0-9a-f]+), computed ([0-9a-f]+)/.exec(message);
  if (mismatch) return `object hash mismatch (expected ${mismatch[1]}, computed ${mismatch[2]})`;
  if (/incorrect data check|Cannot create property 'caller'/.test(message)) return "object is corrupt or unreadable";
  return message.split(/\r?\n/, 1)[0];
}

async function runFsck(context: HostCommandContext): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  const fs = gitFs(context);
  const refs = new Set(["HEAD", ...looseRefs(context.py, root)]);
  const packedRefs = `${root}/.git/packed-refs`;
  if (fsExists(context.py, packedRefs)) {
    for (const line of fsReadText(context.py, packedRefs).split(/\r?\n/)) {
      const match = /^[0-9a-f]{40}\s+(refs\/\S+)$/.exec(line);
      if (match) refs.add(match[1]);
    }
  }
  const objects = new Set<string>(packedObjectIds(context.py, root));
  const loose = `${root}/.git/objects`;
  if (fsExists(context.py, loose)) {
    for (const prefix of context.py.FS.readdir(loose)) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
      for (const suffix of context.py.FS.readdir(`${loose}/${prefix}`)) {
        if (/^[0-9a-f]{38}$/.test(suffix)) objects.add(`${prefix}${suffix}`);
      }
    }
  }
  if (objects.size > 100_000) throw new Error("fsck object limit exceeded (100000)");
  const pending = [...objects];
  const failures: string[] = [];
  for (const ref of refs) {
    try { pending.push(await isomorphicGit.resolveRef({ fs, dir: root, ref })); }
    catch (error) { failures.push(`${ref}: ${conciseObjectError(error)}`); }
  }
  const seen = new Set<string>();
  while (pending.length) {
    const oid = pending.pop()!;
    if (seen.has(oid)) continue;
    if (seen.size >= 100_000) throw new Error("fsck object limit exceeded (100000)");
    seen.add(oid);
    try {
      const object = await isomorphicGit.readObject({ fs, dir: root, oid, format: "parsed" }) as any;
      if (object.type === "commit") pending.push(object.object.tree, ...object.object.parent);
      else if (object.type === "tree") pending.push(...object.object.map((entry: { oid: string }) => entry.oid));
      else if (object.type === "tag") pending.push(object.object.object);
    } catch (error) {
      failures.push(`${oid}: ${conciseObjectError(error)}`);
    }
  }
  if (failures.length) return errorResult(1, failures.map((line) => `error: ${line}\n`).join(""));
  return result(0, `Checked ${seen.size} object(s); no errors.\n`);
}

async function runLsFiles(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  const stage = args.includes("--stage") || args.includes("-s");
  for (const arg of args) {
    if (!["--stage", "-s"].includes(arg)) throw new Error(`unsupported ls-files option: ${arg}`);
  }
  const fs = gitFs(context);
  if (!stage) {
    const files = await isomorphicGit.listFiles({ fs, dir: root });
    return result(0, files.map((path) => `${path}\n`).join(""));
  }
  const entries = await isomorphicGit.walk({
    fs,
    dir: root,
    trees: [isomorphicGit.STAGE()],
    map: async (filepath, [entry]) => {
      if (filepath === "." || !entry || await entry.type() === "tree") return undefined;
      return `${(await entry.mode()).toString(8).padStart(6, "0")} ${await entry.oid()} 0\t${filepath}\n`;
    },
  });
  return result(0, (entries as Array<string | undefined>).filter(Boolean).join(""));
}

const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function quoteDiffPath(path: string): string {
  const bytes = encoder.encode(path);
  if ([...bytes].every((byte) => byte >= 0x20 && byte < 0x7f && byte !== 0x22 && byte !== 0x5c)) {
    return path;
  }
  let quoted = '"';
  for (const byte of bytes) {
    if (byte === 0x22 || byte === 0x5c) quoted += `\\${String.fromCharCode(byte)}`;
    else if (byte >= 0x20 && byte < 0x7f) quoted += String.fromCharCode(byte);
    else quoted += `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return `${quoted}"`;
}

function filterDiffPaths(output: string, paths: string[]): string {
  if (!paths.length || !output) return output;
  const starts = [...output.matchAll(/^diff --git /gm)].map((match) => match.index!);
  if (!starts.length) return output;
  starts.push(output.length);
  const wanted = new Set(paths.flatMap((path) => [quoteDiffPath(`a/${path}`), quoteDiffPath(`b/${path}`)]));
  const selected: string[] = [];
  for (let index = 0; index + 1 < starts.length; index++) {
    const section = output.slice(starts[index], starts[index + 1]);
    const header = section.slice(0, section.indexOf("\n") < 0 ? section.length : section.indexOf("\n"));
    if ([...wanted].some((path) => header.includes(path))) selected.push(section);
  }
  return selected.join("");
}

async function runDiff(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  const separator = args.indexOf("--");
  const commandArgs = (separator < 0 ? args : args.slice(0, separator)).map((arg) =>
    arg === "--staged" ? "--cached" : arg
  );
  const paths = separator < 0 ? [] : args.slice(separator + 1).map((path) =>
    pathFromRepository(root, context.cwd, path)
  );
  const branch = currentBranch(context.py, root);
  const unborn = Boolean(branch && !fsExists(context.py, branchRef(root, branch)) && !packedBranches(context.py, root).has(branch));
  if (unborn && commandArgs.includes("--cached")) {
    const empty = await isomorphicGit.writeTree({ fs: gitFs(context), dir: root, tree: [] });
    if (empty !== EMPTY_TREE_OID) throw new Error("failed to create the canonical empty tree");
    commandArgs.push(empty);
  }
  const value = await invoke(context, ["diff", ...commandArgs], root);
  if (value.exitCode !== 0) return render(value);
  return {
    exitCode: 0,
    ...(value.stdout ? { stdout: encoder.encode(filterDiffPaths(value.stdout, paths)) } : {}),
    ...(value.stderr ? { stderr: encoder.encode(value.stderr) } : {}),
  };
}

async function runLog(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const supported = args.some((arg) => ["--all", "--graph", "--stat"].includes(arg));
  if (!supported) return runLibgitCommand(context, context.cwd, ["log", ...args]);
  const root = repositoryRoot(context.py, context.cwd);
  const fs = gitFs(context);
  let depth = 100;
  let oneline = false;
  let graph = false;
  let stat = false;
  let all = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--all") all = true;
    else if (arg === "--graph") graph = true;
    else if (arg === "--stat") stat = true;
    else if (arg === "--oneline") oneline = true;
    else if (arg === "-n" || arg === "--max-count") depth = Number(args[++index]);
    else if (arg.startsWith("--max-count=")) depth = Number(arg.slice(12));
    else if (/^-[0-9]+$/.test(arg)) depth = Number(arg.slice(1));
    else throw new Error(`unsupported browser log option: ${arg}`);
  }
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 10_000) throw new Error("invalid log count");
  const refs = all
    ? [
        ...(await isomorphicGit.listBranches({ fs, dir: root })),
        ...(await isomorphicGit.listTags({ fs, dir: root })).map((tag) => `refs/tags/${tag}`),
        ...(await isomorphicGit.listBranches({ fs, dir: root, remote: "origin" }).catch(() => []))
          .map((branch) => `refs/remotes/origin/${branch}`),
      ]
    : ["HEAD"];
  const commits = new Map<string, Awaited<ReturnType<typeof isomorphicGit.log>>[number]>();
  for (const ref of refs.length ? refs : ["HEAD"]) {
    for (const entry of await isomorphicGit.log({
      fs,
      dir: root,
      ref,
      depth,
      includeChanges: stat,
    }).catch(() => [])) commits.set(entry.oid, entry);
  }
  const ordered = [...commits.values()].sort(
    (a, b) => b.commit.committer.timestamp - a.commit.committer.timestamp,
  ).slice(0, depth);
  return result(0, ordered.map(({ oid, commit }) => {
    const prefix = graph ? "* " : "";
    const subject = commit.message.split(/\r?\n/, 1)[0];
    if (oneline) return `${prefix}${oid.slice(0, 7)} ${subject}\n`;
    let text = `${prefix}commit ${oid}\nAuthor: ${commit.author.name} <${commit.author.email}>\n` +
      `Date:   ${new Date(commit.author.timestamp * 1000).toISOString()}\n\n    ${subject}\n`;
    if (stat && commit.changes?.length) {
      text += `${commit.changes.map((change) => ` ${change[2]} | changed\n`).join("")}` +
        ` ${commit.changes.length} file(s) changed\n`;
    }
    return `${text}\n`;
  }).join(""));
}

async function runRevList(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  let depth = 10_000;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--max-count") depth = Number(args[++index]);
    else if (arg.startsWith("--max-count=")) depth = Number(arg.slice(12));
    else if (arg.startsWith("-")) throw new Error(`unsupported rev-list option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1) throw new Error("rev-list requires exactly one revision");
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 10_000) throw new Error("invalid rev-list count");
  const entries = await isomorphicGit.log({ fs: gitFs(context), dir: root, ref: positional[0], depth });
  return result(0, entries.map(({ oid }) => `${oid}\n`).join(""));
}

async function runMerge(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  if (args.length === 1 && args[0] === "--abort") {
    if (!fsExists(context.py, `${root}/.git/MERGE_HEAD`)) throw new Error("there is no merge to abort");
    // isomorphic-git's abortMerge currently decodes blobs as UTF-8 while
    // rebuilding the worktree, corrupting arbitrary binary files. A hard
    // restore from ORIG_HEAD uses checkout's byte-preserving object path.
    const original = fsExists(context.py, `${root}/.git/ORIG_HEAD`)
      ? fsReadText(context.py, `${root}/.git/ORIG_HEAD`).trim()
      : await headId(context, root);
    await isomorphicGit.checkout({
      fs: gitFs(context),
      dir: root,
      ref: original,
      noUpdateHead: true,
      force: true,
    });
    await resetIndexPaths(context, root, original);
    await moveHead(context, root, original);
    clearMergeState(context.py, root);
    return result(0, "");
  }
  if (args.length === 1 && args[0] === "--continue") {
    if (!fsExists(context.py, `${root}/.git/MERGE_HEAD`)) throw new Error("there is no merge in progress");
    const status = await runLibgitCommand(context, root, ["status", "--porcelain"]);
    const output = new TextDecoder().decode(status.stdout ?? new Uint8Array());
    if (/^UU /m.test(output)) throw new Error("resolve conflicts and stage the files before continuing");
    const message = fsReadText(context.py, `${root}/.git/MERGE_MSG`).trim() || "Merge commit";
    const committed = await invoke(context, ["commit", "-m", message], root);
    return render(committed);
  }
  return runLibgitCommand(context, root, ["merge", ...args]);
}

function translate(py: Pyodide, cwd: string, args: string[]): string[] {
  if (args[0] === "add" && args.includes("-A")) return ["add", "."];
  if (args[0] === "add") {
    const root = repositoryRoot(py, cwd);
    return args.map((arg, index) => index > 0 && !arg.startsWith("-")
      ? pathFromRepository(root, cwd, arg)
      : arg);
  }
  if (args[0] === "diff" || args[0] === "checkout") {
    const root = repositoryRoot(py, cwd);
    const separator = args.indexOf("--");
    return args.map((arg, index) => {
      if (arg === "--staged") return "--cached";
      return separator >= 0 && index > separator ? pathFromRepository(root, cwd, arg) : arg;
    });
  }
  if (args[0] === "status") {
    return args.map((arg) => arg === "--porcelain=v1" ? "--porcelain" : arg);
  }
  if (args[0] === "switch") {
    const create = args[1] === "-c" || args[1] === "--create";
    const name = args[create ? 2 : 1];
    if (!name) throw new Error("switch requires a branch name");
    assertBranchName(name);
    return create ? ["checkout", "-b", name, "HEAD"] : ["checkout", name];
  }
  if (args[0] === "checkout" && args[1] === "-b" && args.length === 3) {
    assertBranchName(args[2]);
    return ["checkout", "-b", args[2], "HEAD"];
  }
  return args;
}

function normalizeStatus(py: Pyodide, root: string, args: string[], output: string): string {
  const porcelain = args.some((arg) => arg === "--porcelain" || arg === "--porcelain=v1");
  const conflicts = [...output.matchAll(/^conflict:\s+a:(\S+)\s+o:(\S+)\s+t:(\S+)$/gm)].map(
    (match) => [match[1], match[2], match[3]].find((path) => path !== "NULL")!,
  );
  let normalized = output.replace(/^conflict:.*(?:\n|$)/gm, "");
  if (porcelain && !args.some((arg) => arg === "--branch" || arg === "-b" || arg === "-sb")) {
    normalized = normalized.replace(/^# .*\n?/gm, "");
  }
  for (const path of conflicts) {
    normalized = normalized.replace(new RegExp(`^ {3}${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "m"), "");
  }
  if (conflicts.length) {
    normalized += porcelain
      ? conflicts.map((path) => `UU ${path}\n`).join("")
      : `Unmerged paths:\n${conflicts.map((path) => `\tboth modified: ${path}\n`).join("")}`;
  }
  const branch = currentBranch(py, root);
  if (branch && !fsExists(py, branchRef(root, branch)) && !packedBranches(py, root).has(branch)) {
    normalized = normalized.replace(/^error: reference 'refs\/heads\/[^']+' not found\n?/gm, "");
    normalized = normalized.replace(/Not currently on any branch\.?/g, branch);
    normalized = normalized.replace(/HEAD \(no branch\)/g, branch);
  }
  return normalized;
}

function rejectVirtualSnapshotRefs(context: HostCommandContext, command: string, args: string[]): void {
  if (!new Set([
    "branch", "checkout", "diff", "log", "blame", "rev-list", "rev-parse", "cat-file", "merge",
    "restore", "reset", "cherry-pick",
  ]).has(command)) return;
  if (!isGitHubRemoteRepository(context.py, repositoryRoot(context.py, context.cwd))) return;
  const separator = args.indexOf("--");
  const revisions = separator < 0 ? args : args.slice(0, separator);
  const remoteRef = revisions.find((value) =>
    /^(?:refs\/remotes\/origin\/|remotes\/origin\/|origin\/)/.test(value),
  );
  if (remoteRef) {
    throw new Error(
      `remote ref '${remoteRef}' is not materialized in GitHub snapshot mode; ` +
      "use git ls-remote to inspect upstream IDs or clone through a trusted CORS proxy for full history",
    );
  }
}

async function runLibgitCommand(
  context: HostCommandContext,
  cwd: string,
  args: string[],
): Promise<HostCommandResult> {
  const value = await invoke(context, translate(context.py, cwd, args), cwd);
  let stdout = value.stdout;
  let stderr = value.stderr;
  if (args[0] === "status") {
    const root = repositoryRoot(context.py, cwd);
    stdout = normalizeStatus(context.py, root, args, stdout);
    const branch = currentBranch(context.py, root);
    const unborn = Boolean(branch && !fsExists(context.py, branchRef(root, branch)) && !packedBranches(context.py, root).has(branch));
    if (unborn) stderr = stderr.replace(/^error: reference 'refs\/heads\/[^']+' not found\n?/gm, "");
  }
  if (args[0] === "checkout" || args[0] === "switch") {
    stdout = stdout.replace(/^Branch '.*' set up to track remote branch 'origin\/.*'\.?\n?/gm, "");
  }
  let exitCode = value.exitCode;
  if (args[0] === "merge") {
    const root = repositoryRoot(context.py, cwd);
    if (fsExists(context.py, `${root}/.git/MERGE_HEAD`) || /^conflict:/m.test(`${stdout}${stderr}`)) {
      exitCode = 1;
    }
  }
  return {
    exitCode,
    ...(stdout ? { stdout: encoder.encode(stdout) } : {}),
    ...(stderr ? { stderr: encoder.encode(stderr) } : {}),
  };
}

export async function runGitEngineCommand(context: HostCommandContext): Promise<HostCommandResult> {
  try {
    let cwd = context.cwd;
    const args = context.args.slice(1);
    const overrides: Record<string, string> = {};
    while (args[0] === "-C" || args[0] === "-c") {
      const option = args[0];
      const value = args[1];
      if (!value) throw new Error(`${option} requires a value`);
      if (option === "-C") {
        cwd = workspacePath(cwd, value);
      } else {
        const equals = value.indexOf("=");
        if (equals <= 0) throw new Error("-c requires name=value");
        const key = value.slice(0, equals).toLowerCase();
        if (!["user.name", "user.email", "http.corsproxy"].includes(key)) {
          throw new Error(`unsupported -c setting: ${value.slice(0, equals)}`);
        }
        overrides[key] = value.slice(equals + 1);
      }
      args.splice(0, 2);
    }
    const scoped: GitCommandContext = { ...context, cwd, gitConfigOverrides: overrides };
    const command = args[0];
    if (!command) return errorResult(1, HELP);
    if (command === "help" || command === "-h" || command === "--help") {
      const topic = command === "help" ? args[1] : undefined;
      return result(0, topic ? (COMMAND_HELP[topic] || `usage: git ${topic} [options]\n`) : HELP);
    }
    if (args.slice(1).some((arg) => arg === "-h" || arg === "--help")) {
      return result(0, COMMAND_HELP[command] || `usage: git ${command} [options]\n`);
    }
    if (command === "--version" || command === "version") {
      return result(0, "git version 2.0.0-piodide (libgit2 + isomorphic-git)\n");
    }
    rejectVirtualSnapshotRefs(scoped, command, args.slice(1));
    if (command === "branch") return await runBranch(scoped, args.slice(1));
    if (command === "switch") return await runSwitch(scoped, args.slice(1));
    if (command === "snapshot") return await runSnapshot(scoped, args.slice(1));
    if (command === "clone") return await runClone(scoped, args.slice(1));
    if (command === "fetch") return await runFetch(scoped, args.slice(1));
    if (command === "pull") return await runPull(scoped, args.slice(1));
    if (command === "push") return await runPush(scoped, args.slice(1));
    if (command === "ls-remote") return await runLsRemote(scoped, args.slice(1));
    if (command === "config") return await runConfig(scoped, args.slice(1));
    if (command === "add") return await runAdd(scoped, args.slice(1));
    if (command === "diff") return await runDiff(scoped, args.slice(1));
    if (command === "remote") return await runRemote(scoped, args.slice(1));
    if (command === "restore") return await runRestore(scoped, args.slice(1));
    if (command === "reset") return await runReset(scoped, args.slice(1));
    if (command === "clean") return await runClean(scoped, args.slice(1));
    if (command === "cherry-pick") return await runCherryPick(scoped, args.slice(1));
    if (command === "gc") return await runGc(scoped);
    if (command === "fsck") return await runFsck(scoped);
    if (command === "ls-files") return await runLsFiles(scoped, args.slice(1));
    if (command === "log") return await runLog(scoped, args.slice(1));
    if (command === "rev-list") return await runRevList(scoped, args.slice(1));
    if (command === "merge") return await runMerge(scoped, args.slice(1));
    if (command === "init") {
      let branch: string | undefined;
      const target: string[] = [];
      for (let index = 1; index < args.length; index++) {
        if (args[index] === "-b" || args[index] === "--initial-branch") {
          branch = args[++index];
          if (!branch) throw new Error("initial branch name is missing");
          assertBranchName(branch);
        } else {
          if (args[index].startsWith("-")) throw new Error(`unsupported init option: ${args[index]}`);
          target.push(args[index]);
        }
      }
      if (target.length > 1) throw new Error("init accepts at most one directory");
      const repository = target[0] ? workspacePath(cwd, target[0]) : cwd;
      const reinitializing = fsExists(context.py, `${repository}/.git`);
      const initialized = await invoke(scoped, ["init", ...(target.length ? target : ["."])], cwd);
      if (initialized.exitCode === 0 && branch) {
        fsWriteText(context.py, `${repository}/.git/HEAD`, `ref: refs/heads/${branch}\n`);
      }
      if (initialized.exitCode === 0 && reinitializing) {
        initialized.stdout = initialized.stdout.replace("Initialized empty Git repository", "Reinitialized existing Git repository");
      }
      return render(initialized);
    }
    if (command === "commit") {
      const root = repositoryRoot(context.py, cwd);
      const merging = fsExists(context.py, `${root}/.git/MERGE_HEAD`);
      if (!merging && !(await hasStagedChanges(scoped, root))) {
        return errorResult(1, "nothing to commit, working tree clean\n");
      }
      const commitArgs = [...args];
      const fileIndex = commitArgs.findIndex((value) => value === "-F" || value === "--file");
      if (fileIndex >= 0 && commitArgs[fileIndex + 1] === "-") {
        if (scoped.stdin === undefined) throw new Error("commit -F - requires piped stdin");
        const message = new TextDecoder().decode(scoped.stdin).replace(/\0/g, "").trimEnd();
        if (!message) throw new Error("empty commit message from stdin");
        commitArgs.splice(fileIndex, 2, "-m", message);
      }
      const explicitIdentity = Boolean(
        scoped.env?.GIT_AUTHOR_NAME || scoped.env?.GIT_AUTHOR_EMAIL ||
        scoped.env?.GIT_COMMITTER_NAME || scoped.env?.GIT_COMMITTER_EMAIL ||
        overrides["user.name"] || overrides["user.email"],
      );
      let committed: Libgit2Result | null = null;
      if (explicitIdentity) {
        const messages: string[] = [];
        for (let index = 1; index < commitArgs.length; index++) {
          const value = commitArgs[index];
          if (value === "-m" || value === "--message") {
            const message = commitArgs[++index];
            if (message === undefined) throw new Error(`${value} requires a message`);
            messages.push(message);
          } else if (value.startsWith("--message=")) messages.push(value.slice(10));
          else throw new Error(`explicit Git identity currently supports commit -m or commit -F -; unsupported option: ${value}`);
        }
        if (!messages.length) throw new Error("commit requires -m or -F -");
        const fallback = identity(scoped) || { name: "Piodide", email: "piodide@browser.local" };
        const configuredName = configValue(context.py, root, "user.name") || fallback.name;
        const configuredEmail = configValue(context.py, root, "user.email") || fallback.email;
        const authorIdentity = {
          name: scoped.env?.GIT_AUTHOR_NAME || overrides["user.name"] || configuredName,
          email: scoped.env?.GIT_AUTHOR_EMAIL || overrides["user.email"] || configuredEmail,
        };
        const committerIdentity = {
          name: scoped.env?.GIT_COMMITTER_NAME || overrides["user.name"] || configuredName,
          email: scoped.env?.GIT_COMMITTER_EMAIL || overrides["user.email"] || configuredEmail,
        };
        await isomorphicGit.commit({
          fs: gitFs(scoped),
          dir: root,
          message: messages.join("\n\n"),
          author: authorIdentity,
          committer: committerIdentity,
          disallowEmpty: !merging,
        });
      } else {
        committed = await invoke(scoped, commitArgs, cwd);
        if (committed.exitCode !== 0) return render(committed);
      }
      const summary = await invoke(scoped, ["log", "--oneline", "-n", "1"], cwd);
      return result(0, summary.exitCode === 0 ? summary.stdout : (committed?.stdout ?? ""));
    }
    if (command === "rev-parse" && args.length === 2) {
      const root = repositoryRoot(context.py, cwd);
      if (args[1] === "--show-toplevel") return result(0, `${root}\n`);
      if (args[1] === "--show-prefix") {
        return result(0, cwd === root ? "\n" : `${cwd.slice(root.length + 1)}/\n`);
      }
      if (args[1] === "--is-inside-work-tree") return result(0, "true\n");
      if (args[1] === "--git-dir") return result(0, `${root}/.git\n`);
      if (args[1] === "--abbrev-ref") throw new Error("--abbrev-ref requires a revision");
    }
    if (command === "rev-parse" && args.length === 3 && args[1] === "--abbrev-ref") {
      const root = repositoryRoot(context.py, cwd);
      if (args[2] === "HEAD") return result(0, `${currentBranch(context.py, root) || "HEAD"}\n`);
    }
    return await runLibgitCommand(scoped, cwd, args);
  } catch (error) {
    return errorResult(1, `git: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
