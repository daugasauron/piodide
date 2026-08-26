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
  gitIndexIntentToAddPaths,
  markGitIndexIntentToAdd,
} from "./git-index-compat.ts";
import {
  createIsomorphicGitFs,
  gitSymlinkTarget,
  isomorphicGit,
  smartClone,
  smartFetch,
  smartListServerRefs,
  smartPull,
  smartPush,
} from "./git-smart-http.ts";
import type { HostCommandContext, HostCommandResult } from "./slop-host-commands.ts";
import { normalizePath } from "./wasi/abi.ts";
import {
  forgetEmscriptenSymlinkTarget,
  preserveEmscriptenSymlinkTarget,
  preservedEmscriptenSymlinkTarget,
} from "./wasi/emscripten-fs.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_FSCK_OBJECTS = 100_000;
const MAX_APPLY_BYTES = 8 * 1024 * 1024;
const MAX_APPLY_FILES = 100;
const MAX_APPLY_HUNKS = 10_000;
const MAX_APPLY_LINES = 100_000;
const MAX_APPLY_PATH_BYTES = 4_096;
const MAX_APPLY_FILE_BYTES = 16 * 1024 * 1024;
const MAX_APPLY_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_GIT_PREFLIGHT_PATHS = 100_000;
const MAX_GIT_COLLISION_DIAGNOSTICS = 100;
const MAX_BRANCH_DIVERGENCE_COMMITS = 100_000;
const MAX_REV_LIST_COMMITS = 100_000;
const MAX_MERGE_BASE_ANCESTOR_COMMITS = 100_000;
const MAX_MERGE_BASE_ANCESTOR_EDGES = 1_000_000;
const MAX_GIT_REVISION_BYTES = 4_096;
const MAX_BRANCH_UPSTREAMS = 1_000;
const MAX_NUMSTAT_RECORDS = 10_000;
const MAX_NUMSTAT_PATH_BYTES = 4_096;
const MAX_NUMSTAT_BLOB_BYTES = 16 * 1024 * 1024;
const MAX_NUMSTAT_TOTAL_BLOB_BYTES = 64 * 1024 * 1024;
const MAX_NUMSTAT_LINE_COUNT = 10_000_000;
const MAX_NUMSTAT_OUTPUT_BYTES = 8 * 1024 * 1024;
const NUMSTAT_BINARY_PROBE_BYTES = 8_000;
const MAX_DIFF_PROJECTION_RECORDS = 100_000;
const MAX_DIFF_PROJECTION_PATH_BYTES = 4_096;
const MAX_DIFF_PROJECTION_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_CONTEXT = 1_000;
const MAX_PROJECTED_LOG_COMMITS = 1_000;
const MAX_PROJECTED_LOG_RECORDS = 100_000;
const MAX_PROJECTED_LOG_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_CHECK_IGNORE_OPERANDS = 100;
const MAX_CHECK_IGNORE_RECORDS = 4_096;
const MAX_CHECK_IGNORE_STDIN_BYTES = 1_000_000;
const MAX_CHECK_IGNORE_PATH_BYTES = 4_096;
const MAX_CHECK_IGNORE_PATH_COMPONENTS = 128;
const MAX_CHECK_IGNORE_FILES = 128;
const MAX_CHECK_IGNORE_FILE_BYTES = 1024 * 1024;
const MAX_CHECK_IGNORE_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_CHECK_IGNORE_PATTERNS = 100_000;
const MAX_CHECK_IGNORE_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_CHECK_IGNORE_INDEX_ENTRIES = 100_000;
const MAX_CHECK_IGNORE_OUTPUT_BYTES = 1024 * 1024;
const MAX_ADD_INTENT_PATHS = 100;
const MAX_ADD_INTENT_PATH_BYTES = 4_096;
const MAX_ADD_INTENT_TOTAL_PATH_BYTES = 65_536;
const MAX_ADD_INTENT_DEPTH = 128;
const MAX_ADD_INTENT_CANDIDATES = 100_000;
const MAX_ADD_INTENT_INDEX_ENTRIES = 100_000;
const MAX_ADD_INTENT_INDEX_BYTES = 16 * 1024 * 1024;
const EMPTY_BLOB_OID = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const MAX_SHOW_REF_REFS = 4_096;
const MAX_SHOW_REF_FS_ENTRIES = 8_192;
const MAX_SHOW_REF_NAME_BYTES = 1_024;
const MAX_SHOW_REF_LOOSE_BYTES = 4_096;
const MAX_SHOW_REF_TOTAL_LOOSE_BYTES = 4_000_000;
const MAX_SHOW_REF_PACKED_BYTES = 1_000_000;
const MAX_SHOW_REF_SYMBOLIC_DEPTH = 32;
const MAX_SHOW_REF_OUTPUT_BYTES = 1_000_000;
const MAX_LS_TREE_DEPTH = 128;
const MAX_LS_TREE_ENTRIES = 100_000;
const MAX_LS_TREE_OBJECTS = 4_096;
const MAX_LS_TREE_OBJECT_BYTES = 8 * 1024 * 1024;
const MAX_LS_TREE_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_LS_TREE_PEEL_OBJECT_BYTES = 1_000_000;
const MAX_LS_TREE_TOTAL_PEEL_BYTES = 4_000_000;
const MAX_LS_TREE_PATH_BYTES = 1_000_000;
const MAX_LS_TREE_OUTPUT_BYTES = 1_000_000;
const MAX_GREP_CANDIDATES = 100_000;
const MAX_GREP_DEPTH = 128;
const MAX_GREP_FILE_BYTES = 8 * 1024 * 1024;
const MAX_GREP_TOTAL_FILE_BYTES = 64 * 1024 * 1024;
const MAX_GREP_TREE_BYTES = 16 * 1024 * 1024;
const MAX_GREP_OBJECTS = 200_000;
const MAX_GREP_PATTERN_BYTES = 64 * 1024;
const MAX_GREP_PATHSPECS = 100;
const MAX_GREP_PATH_BYTES = 4_096;
const MAX_GREP_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_GREP_MATCHES = 100_000;
const MAX_GREP_OUTPUT_BYTES = 1_000_000;
const MAX_GREP_REGEX_STATES = 65_536;
const MAX_GREP_MATCH_STEPS = 100_000_000;
const MAX_GREP_PATHSPEC_STEPS = 100_000_000;
const MAX_LS_FILES_PATHS = 100;
const MAX_LS_FILES_PATH_BYTES = 4_096;
const MAX_LS_FILES_ENTRIES = 100_000;
const MAX_LS_FILES_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;
const MAX_CONFIG_ENTRIES = 100_000;
const MAX_CONFIG_KEY_BYTES = 4_096;
const MAX_RESET_PATHS = 100;
const MAX_RESET_PATH_BYTES = 4_096;
const MAX_RESET_TOTAL_PATH_BYTES = 65_536;
const MAX_RESET_INDEX_ENTRIES = 100_000;
const MAX_RESET_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_RESTORE_PATHS = 100;
const MAX_RESTORE_PATH_BYTES = 4_096;
const MAX_RESTORE_TOTAL_PATH_BYTES = 65_536;
const MAX_RESTORE_DEPTH = 128;
const MAX_RESTORE_ENTRIES = 100_000;
const MAX_RESTORE_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_RESTORE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RESTORE_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_RM_PATHS = 100;
const MAX_RM_PATH_BYTES = 4_096;
const MAX_RM_TOTAL_PATH_BYTES = 65_536;
const MAX_RM_INDEX_ENTRIES = 100_000;
const MAX_RM_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_RM_WORKTREE_FILE_BYTES = 16 * 1024 * 1024;
const MAX_RM_TOTAL_WORKTREE_BYTES = 64 * 1024 * 1024;
const MAX_RM_DEPTH = 128;
const MAX_RM_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_MV_PATH_BYTES = 4_096;
const MAX_MV_TOTAL_PATH_BYTES = 8_192;
const MAX_MV_DEPTH = 128;
const MAX_MV_INDEX_ENTRIES = 100_000;
const MAX_MV_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_MV_SCANNED_ENTRIES = 100_000;
const MAX_CLEAN_SELECTORS = 100;
const MAX_CLEAN_PATH_BYTES = 4_096;
const MAX_CLEAN_TOTAL_SELECTOR_BYTES = 65_536;
const MAX_CLEAN_DEPTH = 128;
const MAX_CLEAN_SCANNED_ENTRIES = 100_000;
const MAX_CLEAN_CANDIDATES = 100_000;
const MAX_CLEAN_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_TAG_DELETE_NAMES = 100;
const MAX_TAG_DELETE_NAME_BYTES = 4_096;
const MAX_TAG_DELETE_REF_NAME_BYTES = MAX_TAG_DELETE_NAME_BYTES + 10;
const MAX_TAG_DELETE_TOTAL_NAME_BYTES = 65_536;
const MAX_TAG_DELETE_DEPTH = 128;
const MAX_TAG_DELETE_REF_ENTRIES = 100_000;
const MAX_TAG_DELETE_PACKED_BYTES = 16 * 1024 * 1024;
const MAX_TAG_DELETE_LOOSE_BYTES = 4_096;
const MAX_TAG_DELETE_OUTPUT_BYTES = 1024 * 1024;

const HELP = `usage: git <command> [options]

Local repositories use canonical .git objects, refs, index, and config.

  init, clone, status, add, rm, mv, commit, diff, apply, log, show, grep, ls-files, ls-tree, check-ignore, show-ref, merge-base
  branch, switch, checkout, merge, restore, reset
  remote, fetch, pull, push, ls-remote
  tag, stash, blame, rev-list, rev-parse, cat-file
  cherry-pick, clean, fsck, gc, config

Run git help <command> for the supported subset. Global -C is supported; -c is
limited to user.name, user.email, and http.corsProxy.

Smart HTTP requires CORS or a trusted --cors-proxy. Direct GitHub uses a
bounded snapshot: run git snapshot info for its upstream identity and limits.
`;

const MERGE_BASE_USAGE = "usage: git merge-base [--is-ancestor] <revision> <revision>\n";

const COMMAND_HELP: Record<string, string> = {
  init: "usage: git init [-b|--initial-branch branch] [directory]  # --bare is unavailable\n",
  clone: "usage: git clone [-b|--branch branch] [--depth n] [--single-branch] [--cors-proxy URL] <repository> [directory]\n",
  status: "usage: git status [-s|--short] [-b|--branch] [-sbz] [--porcelain[=v1]] [-z] [-uno|-unormal|-uall|--untracked-files=no|normal|all] [--] [paths...]\n       unsupported options before -- fail with status 2 before repository inspection\n",
  add: "usage: git add [-A|--all] [-u|--update] [--] [paths...]\n       git add (-N|--intent-to-add) [--] <paths...>\n       intent paths are literal cwd-relative exact-file or directory-prefix selectors; ignored and missing-only selectors fail atomically\n       intent mode records canonical empty-blob stage-0 entries with the real Git intent flag; HEAD/worktree stay unchanged\n       intent status: 0 updated/no-op, 1 repository/index/worktree/selector/publication failure, 2 grammar/path/bounds failure\n       intent limits: 100 paths, 4096 bytes/path, 65536 path bytes, depth 128, 100000 candidates/resulting index entries, 16 MiB index\n       force, dry-run, patch/interactive UI, pathspec magic, submodules, conflicts, and special files are unavailable in intent mode\n",
  rm: "usage: git rm [-r] [--] <paths...> | git rm --cached [-r] [--] <paths...>\n       literal cwd-relative tracked paths; -r selects descendants; every selector must match\n       non-cached mode requires index=HEAD and worktree=index, then coordinates bounded worktree/index removal with rollback\n       --cached removes only safe stage-0 index entries; HEAD and worktree are unchanged; no -f or pathspec magic\n       limits: 100 paths, 4096 bytes/path, 65536 path bytes, depth 128, 100000 index/removal entries, 16 MiB index, 16 MiB/file, 64 MiB compared/rollback bytes, 8 MiB output\n       status: 0 removed, 1 repository/index/content-safety/runtime failure, 2 invocation/path/bounds failure\n",
  mv: "usage: git mv [--] <source> <destination>\n       literal cwd-relative tracked file, symlink, or directory rename; destination must not exist\n       preserves existing index OIDs/modes while moving current worktree bytes; HEAD is unchanged\n       intermediate symlink ancestry, unmerged indexes, submodules, force, multiple sources, destination-directory shorthand, and pathspec magic are unavailable\n       limits: 2 paths, 4096 bytes/path, 8192 path bytes, depth 128, 100000 scanned/index entries, 16 MiB index\n       status: 0 renamed, 1 repository/index/collision/runtime failure, 2 invocation/path/bounds failure\n",
  commit: "usage: git commit [-a|--all] [--amend] [-q|--quiet] [--allow-empty] [--no-verify] [--no-gpg-sign] (-m MESSAGE... | -F - | --no-edit)\n       -mTEXT, --message[=]MESSAGE, and compact -am are accepted; multiple -m values form paragraphs\n       --no-edit requires --amend; paths, editor message files, hooks, and signing are unavailable\n",
  diff: "usage: git diff [--cached|--staged] [-U N|-UN|--unified=N] [--check|--quiet|--exit-code] [--no-color|--color=never] [-z] [--name-only|--name-status|--stat|--numstat] [A...B|revisions...] [-- paths...]\n       context N is a decimal integer from 0 through 1000; --unified N is also accepted\n       status: 0 successful comparison, 1 requested predicate/check found differences, 2 invocation/repository/revision/diff error\n       machine projections verify racy worktree content; name limits: 100000 records, 4096 UTF-8 bytes/path, 8 MiB output\n       --numstat emits added<TAB>deleted<TAB>path; -z uses raw NUL-terminated paths; binary is -<TAB>-\n       numstat reports exact moves as separate delete/add records (no rename detection)\n",
  apply: "usage: git apply [--cached] [-R|--reverse] [--check] [--] [PATCH|-]  # one bounded UTF-8 unified Git patch; stdin when omitted\n       --cached applies against and writes only the index; reverse/cached may each appear once\n       status: 0 applied/applicable, 1 valid but inapplicable, 2 invalid/bounded request\n       limits: 8 MiB patch, 100 files, 10000 hunks, 100000 lines, 4096 bytes/path, 16 MiB/file, 64 MiB staged bytes, 100000 index entries, 16 MiB index\n",
  log: "usage: git log [--oneline|--format=FMT|--pretty=FMT] [-n count] [--all] [--graph] [--stat|--name-only|--name-status|--numstat] [-z] [--no-color|--color=never] [revision] [-- paths...]\n       FMT atoms: %H %h %s %n %% and ASCII %xNN; --pretty=oneline and --pretty=format:FMT\n       path projections use first-parent A/M/D records, explicit commit-block terminators, and limits of 1000 commits, 100000 records, and 8 MiB output\n       projected custom formats must be single-line and contain %H or %h; -z emits raw NUL-terminated path fields\n",
  show: "usage: git show [-U N|-UN|--unified=N] [--stat|--numstat [-z]|--name-only|--name-status [-z]] [--oneline|--format=FMT|--pretty=FMT] [--no-patch] [--no-color|--color=never] [revision] [-- paths...]\n       context N is a decimal integer from 0 through 1000; --unified N is also accepted\n       FMT atoms: %H %h %s %n %% and ASCII %xNN; one commit, first parent\n       numstat reports exact moves as separate delete/add records (no rename detection)\n",
  branch: "usage: git branch --show-current | git branch [-a|--all|-r|--remotes] [-v|-vv|--verbose] [--list] | git branch <name> [start-point] | git branch [-m|--move] [old] <new> | git branch [-d|--delete|-D] <name>\n       compact -av/-rv/-avv clusters are accepted; -v adds subjects and -vv adds configured upstream divergence\n       divergence is bounded to 100000 commits per pair and 1000 upstream-bearing rows\n",
  switch: "usage: git switch [-c|--create branch [start-point]] | [--detach] <branch-or-commit>\n",
  checkout: "usage: git checkout [-b branch] [start-point] | git checkout [ref] -- <paths...>\n",
  merge: "usage: git merge [--no-commit] <branch> | git merge --abort | git merge --continue\n       tracked changes are rejected; unrelated untracked/ignored leaves are preserved\n       exact and file/directory ancestor collisions reject before mutation\n",
  restore: "usage: git restore [-s|--source ref] [-S|--staged] [-W|--worktree] [--] <paths...>\n       paths are literal cwd-relative exact tracked files or directory prefixes; -- protects leading-dash names\n       worktree-only source defaults to the index; --staged defaults to HEAD; one resolved source supplies both selected layers\n       complete source/index/worktree validation precedes a private scratch index and rollback-backed worktree publication\n       HEAD, refs, and unselected layers never change; success is silent\n       status: 0 restored/no-op, 1 repository/ref/object/index/worktree/no-match/runtime failure, 2 grammar/path/bounds failure\n       limits: 100 paths, 4096 bytes/path, 65536 path bytes, depth 128, 100000 candidates/resulting index entries, 16 MiB index, 16 MiB/file, 64 MiB rollback bytes\n       pathspec magic, interactive conflict selection, submodules, special files, and replacing nonempty untracked directories are unavailable\n",
  reset: "usage: git reset [--mixed|--soft|--hard] [commit] | git reset [--mixed] [commit] -- <paths...>\n       commit accepts refs, object IDs, and ancestry expressions such as HEAD^ or HEAD~2 (4096 UTF-8 bytes)\n       path selectors are literal exact files or directory prefixes; no match is success; worktree is unchanged\n       limits: 100 paths, 4096 UTF-8 bytes/path, 65536 selector bytes, 100000 index entries, 16 MiB index\n       status: 0 success, 1 repository/object/index I/O failure, 2 invalid invocation/revision/path/bounds\n",
  snapshot: "usage: git snapshot [info] | git snapshot checkout <branch>\n",
  pull: "usage: git pull [--cors-proxy URL] [remote] [branch]\n",
  push: "usage: git push [--cors-proxy URL] [remote] [refspec]\n",
  fetch: "usage: git fetch [--cors-proxy URL] [remote] [branch]\n",
  "ls-remote": "usage: git ls-remote [--cors-proxy URL] [repository] [patterns...]\n",
  clean: "usage: git clean [-n|--dry-run] [-f|--force] [-d] [-z|--null] [-X|--ignored-only] [-- paths...]\n       -z emits raw candidate paths terminated by NUL; compact -nfdz/-nXdz forms are accepted; -n takes precedence over -f\n       -X selects only ignored untracked entries; -d also selects wholly ignored and empty ignored directories; -x is unavailable\n       paths are literal cwd-relative selectors; tracked, staged, ordinary-untracked, re-included, git-dir, and out-of-scope entries are protected\n       limits: 100 selectors, 4096 bytes/path, 65536 selector bytes, depth 128, 100000 scanned/candidate entries, 8 MiB output\n",
  config: "usage: git config [--global|--local] [-l|--list] | git config [--global|--local] [--get] <name> | git config [--global|--local] --unset <name> | git config [--global|--local] <name> <value>\n       options precede operands; -- ends option parsing; --unset targets local storage by default\n       --global uses $HOME/.gitconfig; HOME must be absolute and remain inside /home/web\n       --unset status: 0 one value removed, 5 no value or multiple values, 2 invalid invocation/bounds\n       mutation limits: 4096-byte key, 1 MiB selected config file, 100000 parsed entries\n",
  remote: "usage: git remote [-v|--verbose] | git remote get-url <name> | git remote add <name> <url> | git remote remove|rm <name>\n",
  stash: "usage: git stash [push] | git stash list | git stash apply | git stash pop | git stash drop\n       tracked changes only; apply/pop restore as unstaged changes; operations target the top entry\n       custom messages, selectors, --index, and include-untracked modes are unavailable\n",
  tag: "usage: git tag | git tag [-a] <name> [-m message] [commit]\n       git tag (-d|--delete) [--] NAME...\n       delete resolves only literal local tag names and commits the complete validated request with rollback\n       output: Deleted tag NAME (was 7-HEX); status: 0 deleted, 1 repository/ref/runtime failure, 2 invocation/name/bounds failure\n       limits: 100 names, 4096 bytes/name, 65536 name bytes, depth 128, 100000 ref entries, 16 MiB packed refs, 1 MiB staged output\n       remote deletion, patterns, reflog policy, force, and broader upstream tag modes are unavailable\n",
  blame: "usage: git blame [revision] -- <path>\n",
  "rev-list": "usage: git rev-list [--count] [--max-count n] <revision>\n       traverses at most 100000 commits; --count emits one decimal total\n",
  "rev-parse": "usage: git rev-parse [--verify] [--quiet] [--short[=n]] <revision> | git rev-parse --abbrev-ref HEAD | git rev-parse --show-toplevel|--show-prefix|--git-dir|--git-common-dir|--is-inside-work-tree\n",
  "merge-base": `${MERGE_BASE_USAGE}       --is-ancestor status: 0 ancestor, 1 not ancestor, 2 invocation/repository/revision/traversal error\n       ancestry traversal is limited to 100000 unique commits and 1000000 parent edges\n`,
  "cat-file": "usage: git cat-file -t|-s|-e|-p <object>\n       -e status: 0 object exists, 1 expression does not resolve, 2 invocation/repository/object validation error; predicate is silent\n",
  "cherry-pick": "usage: git cherry-pick <commit>\n       tracked changes are rejected; unrelated untracked/ignored leaves are preserved\n       exact and file/directory ancestor collisions reject before mutation\n       after a clean-tree conflict, use git reset --hard HEAD to abandon the result\n",
  fsck: "usage: git fsck\n",
  gc: "usage: git gc\n",
  "ls-files": "usage: git ls-files [-z] [--stage|--cached|--modified|--deleted|--others [--exclude-standard]] [-- [PATH...]]\n       terminal paths are literal cwd-relative exact/directory-prefix selectors; no matches is success\n       limits: 100 paths, 4096 bytes/path, 100000 candidate entries, 16 MiB staged output\n",
  "check-ignore": "usage: git check-ignore [-q|--quiet] [--] PATH...\n       git check-ignore --stdin -z\n       --stdin -z reads literal cwd-relative NUL records; tabs, newlines, and leading dashes are preserved\n       complete input, ignore inspection, and output are staged before publication\n       status: 0 any path ignored, 1 none ignored, 2 usage, 128 repository/input/path/inspection error\n       limits: 100 operands; NUL stdin 1000000 bytes/4096 records; path 4096 bytes/128 components; output 1 MiB\n",
  "show-ref": "usage: git show-ref [--head] | git show-ref --verify [--quiet] [--] REF\n",
  "ls-tree": "usage: git ls-tree [-r] [-t] [-z] [--name-only] [--max-count=N] [--] <tree-ish>\n",
  grep: "usage: git grep [-n|--line-number] [-i|--ignore-case] [-F|--fixed-strings|-E|--extended-regexp] [-l|--files-with-matches|-q|--quiet] [-z] [--max-results=N] [-e] PATTERN [REVISION] [-- [PATHSPEC...]]\n       tracked worktree bytes or one historical tree; stdin is ignored\n       limits: 100000 candidates/matches, depth 128, file 8 MiB, files 64 MiB, trees 16 MiB/200000 objects, pattern 64 KiB, index 16 MiB, path 4096 bytes, output 1000000 bytes\n",
};

type GitCommandContext = HostCommandContext & { gitConfigOverrides?: Record<string, string> };

class GitUsageError extends Error {}
class GitApplyConflictError extends Error {}

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

function globalConfigPath(context: HostCommandContext): string {
  const home = context.env?.HOME || "/home/web";
  if (!home.startsWith("/")) throw new Error("HOME must be an absolute workspace path");
  return `${workspacePath("/home/web", home)}/.gitconfig`;
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
    .replace(/^Fetching ([^\r\n]+) for repo 0x[0-9a-f]+$/gim, "Fetching $1")
    .replace(/^(net\s+.*\/\s+chk\s+0%\s+\([^\r\n)]*\))\(null\)$/gm, "$1")
    .replace(/(^|[\s"'(])\/workspace(?=\/|[\s"'):]|$)/gm, "$1/home/web");
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

function gitFs(
  context: HostCommandContext,
  options: { hideIntentToAdd?: boolean } = {},
) {
  return createIsomorphicGitFs(context.py, options);
}

interface ConfigEntry {
  key: string;
  value: string;
}

interface ConfigEntrySpan extends ConfigEntry {
  start: number;
  end: number;
}

function parseConfigSpans(text: string): ConfigEntrySpan[] {
  const entries: ConfigEntrySpan[] = [];
  let section = "";
  let subsection = "";
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    let end = newline < 0 ? text.length : newline + 1;
    const source = text.slice(start, newline < 0 ? text.length : newline);
    const line = source.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      start = end; continue;
    }
    const header = /^\[([^\s\]"]+)(?:\s+"([^"]+)")?\]$/.exec(line);
    if (header) {
      section = header[1].toLowerCase();
      subsection = header[2] || "";
      start = end; continue;
    }
    const setting = /^([^=\s]+)\s*(?:=\s*)?(.*)$/.exec(line);
    if (section && setting) {
      let continuation = source.endsWith("\r") ? source.slice(0, -1) : source;
      while (end < text.length && /(^|[^\\])(?:\\\\)*\\$/.test(continuation)) {
        const nextNewline = text.indexOf("\n", end);
        const nextEnd = nextNewline < 0 ? text.length : nextNewline + 1;
        continuation = text.slice(end, nextNewline < 0 ? text.length : nextNewline);
        if (continuation.endsWith("\r")) continuation = continuation.slice(0, -1);
        end = nextEnd;
      }
      const prefix = subsection ? `${section}.${subsection}` : section;
      entries.push({
        key: `${prefix}.${setting[1]}`,
        value: setting[2].trim(),
        start,
        end,
      });
    }
    start = end;
  }
  return entries;
}

function parseConfig(text: string): ConfigEntry[] {
  return parseConfigSpans(text).map(({ key, value }) => ({ key, value }));
}

function configEntries(py: Pyodide, root?: string, globalPath = "/home/web/.gitconfig"): ConfigEntry[] {
  const paths = [globalPath, ...(root ? [`${root}/.git/config`] : [])];
  return paths.flatMap((path) => fsExists(py, path) ? parseConfig(fsReadText(py, path)) : []);
}

function configValue(
  py: Pyodide,
  root: string,
  key: string,
  globalPath = "/home/web/.gitconfig",
): string | undefined {
  const normalized = key.toLowerCase();
  return configEntries(py, root, globalPath).filter(
    (entry) => entry.key.toLowerCase() === normalized,
  ).at(-1)?.value;
}

function remoteUrl(
  py: Pyodide,
  root: string,
  remote = "origin",
  globalPath = "/home/web/.gitconfig",
): string | undefined {
  return configValue(py, root, `remote.${remote}.url`, globalPath);
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

function configuredCorsProxy(py: Pyodide, root?: string, globalPath = "/home/web/.gitconfig"): string | undefined {
  const value = root ? configValue(py, root, "http.corsProxy", globalPath) : configEntries(py, undefined, globalPath).filter(
    (entry) => entry.key.toLowerCase() === "http.corsproxy",
  ).at(-1)?.value;
  return value?.trim() || undefined;
}

function contextCorsProxy(context: HostCommandContext, root?: string): string | undefined {
  return configOverrides(context)["http.corsproxy"] ||
    configuredCorsProxy(context.py, root, globalConfigPath(context));
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

const CHECK_IGNORE_USAGE =
  "usage: git check-ignore [-q|--quiet] [--] PATH...\n" +
  "       git check-ignore --stdin -z\n";

type CheckIgnoreFailureKind = "input" | "path" | "repository";

class CheckIgnoreFailure extends Error {
  kind: CheckIgnoreFailureKind;

  constructor(kind: CheckIgnoreFailureKind) {
    super(kind);
    this.kind = kind;
  }
}

interface CheckIgnoreRequest {
  quiet: boolean;
  stdin: boolean;
  paths: string[];
}

interface CheckIgnorePath {
  original: string;
  relative: string;
}

function parseCheckIgnoreArgs(args: string[]): CheckIgnoreRequest | null {
  if (
    args.length === 2 &&
    ((args[0] === "--stdin" && args[1] === "-z") ||
      (args[0] === "-z" && args[1] === "--stdin"))
  ) {
    return { quiet: false, stdin: true, paths: [] };
  }
  if (args.includes("--stdin") || args.includes("-z")) return null;

  let quiet = false;
  let options = true;
  const paths: string[] = [];
  for (const arg of args) {
    if (options && arg === "--") {
      options = false;
    } else if (options && (arg === "-q" || arg === "--quiet")) {
      if (quiet) return null;
      quiet = true;
    } else if (options && arg.startsWith("-")) {
      return null;
    } else {
      paths.push(arg);
    }
  }
  if (!paths.length || paths.length > MAX_CHECK_IGNORE_OPERANDS || (quiet && paths.length !== 1)) {
    return null;
  }
  return { quiet, stdin: false, paths };
}

function decodeCheckIgnoreStdin(bytes: Uint8Array): string[] {
  if (bytes.byteLength > MAX_CHECK_IGNORE_STDIN_BYTES) throw new CheckIgnoreFailure("input");
  const paths: string[] = [];
  let start = 0;
  for (let index = 0; index <= bytes.byteLength; index++) {
    if (index < bytes.byteLength && bytes[index] !== 0) continue;
    if (index === bytes.byteLength && start === index) break;
    if (start === index) throw new CheckIgnoreFailure("path");
    const record = bytes.subarray(start, index);
    if (record.byteLength > MAX_CHECK_IGNORE_PATH_BYTES) throw new CheckIgnoreFailure("input");
    let path: string;
    try {
      path = new TextDecoder("utf-8", { fatal: true }).decode(record);
    } catch {
      throw new CheckIgnoreFailure("path");
    }
    paths.push(path);
    if (paths.length > MAX_CHECK_IGNORE_RECORDS) throw new CheckIgnoreFailure("input");
    start = index + 1;
  }
  return paths;
}

function checkIgnoreMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const errno = (error as { errno?: unknown }).errno;
  const code = (error as { code?: unknown }).code;
  return errno === 44 || code === "ENOENT" || code === "ENOTDIR";
}

function checkIgnoreLstat(context: HostCommandContext, path: string) {
  try {
    return context.py.FS.lstat(path);
  } catch (error) {
    if (checkIgnoreMissingError(error)) return undefined;
    throw new CheckIgnoreFailure("repository");
  }
}

function normalizeCheckIgnorePath(
  context: HostCommandContext,
  root: string,
  original: string,
  allowNewline = false,
): CheckIgnorePath {
  if (!original || original.includes("\0") || (!allowNewline && original.includes("\n"))) {
    throw new CheckIgnoreFailure("path");
  }
  const bytes = encoder.encode(original);
  if (bytes.byteLength > MAX_CHECK_IGNORE_PATH_BYTES) throw new CheckIgnoreFailure("input");
  try {
    if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== original) {
      throw new CheckIgnoreFailure("path");
    }
  } catch (error) {
    if (error instanceof CheckIgnoreFailure) throw error;
    throw new CheckIgnoreFailure("path");
  }

  let relative: string;
  try {
    relative = pathFromRepository(root, context.cwd, original);
  } catch {
    throw new CheckIgnoreFailure("path");
  }
  const components = relative === "." ? [] : relative.split("/");
  if (
    components.length > MAX_CHECK_IGNORE_PATH_COMPONENTS ||
    components[0] === ".git"
  ) {
    throw new CheckIgnoreFailure("path");
  }

  let current = root;
  for (let index = 0; index + 1 < components.length; index++) {
    current += `/${components[index]}`;
    const stat = checkIgnoreLstat(context, current);
    if (!stat) break;
    if (context.py.FS.isLink?.(stat.mode) || !context.py.FS.isDir(stat.mode)) {
      throw new CheckIgnoreFailure("path");
    }
  }
  return { original, relative };
}

function checkIgnorePatternCount(text: string): number {
  return text.split("\n").filter((line) => line && !line.startsWith("#")).length;
}

function maskedCheckIgnoreFs(
  context: HostCommandContext,
  maskedPaths: Set<string>,
): ReturnType<typeof gitFs> {
  const base = gitFs(context);
  if (!maskedPaths.size) return base;
  type PromiseFs = {
    readFile: (path: string, options?: unknown) => Promise<unknown>;
    stat: (path: string) => Promise<unknown>;
    lstat: (path: string) => Promise<unknown>;
  };
  const basePromises = (base as unknown as { promises: PromiseFs }).promises;
  const promises = Object.create(basePromises) as PromiseFs;
  const missing = (): Promise<never> => {
    const error = Object.assign(new Error("No such file"), { code: "ENOENT", errno: 44 });
    return Promise.reject(error);
  };
  const masked = (path: string) => typeof path === "string" && maskedPaths.has(normalizePath(path));
  promises.readFile = (path, options) => masked(path)
    ? missing()
    : basePromises.readFile(path, options);
  promises.stat = (path) => masked(path) ? missing() : basePromises.stat(path);
  promises.lstat = (path) => masked(path) ? missing() : basePromises.lstat(path);
  return { promises } as unknown as ReturnType<typeof gitFs>;
}

async function prepareCheckIgnoreRepository(
  context: HostCommandContext,
  root: string,
  paths: CheckIgnorePath[],
): Promise<{ fs: ReturnType<typeof gitFs>; tracked: Set<string> }> {
  const indexPath = `${root}/.git/index`;
  const indexStat = checkIgnoreLstat(context, indexPath);
  if (indexStat && indexStat.size > MAX_CHECK_IGNORE_INDEX_BYTES) {
    throw new CheckIgnoreFailure("input");
  }

  const baseFs = gitFs(context);
  let trackedPaths: string[];
  try {
    trackedPaths = await isomorphicGit.listFiles({ fs: baseFs, dir: root });
  } catch {
    throw new CheckIgnoreFailure("repository");
  }
  if (trackedPaths.length > MAX_CHECK_IGNORE_INDEX_ENTRIES) {
    throw new CheckIgnoreFailure("input");
  }

  const candidates = new Set<string>([`${root}/.git/info/exclude`, `${root}/.gitignore`]);
  for (const { relative } of paths) {
    const components = relative === "." ? [] : relative.split("/");
    for (let index = 1; index < components.length; index++) {
      candidates.add(`${root}/${components.slice(0, index).join("/")}/.gitignore`);
    }
  }

  const maskedPaths = new Set<string>();
  let files = 0;
  let totalBytes = 0;
  let patterns = 0;
  for (const path of candidates) {
    const stat = checkIgnoreLstat(context, path);
    if (!stat) continue;
    if (context.py.FS.isLink?.(stat.mode)) {
      maskedPaths.add(normalizePath(path));
      continue;
    }
    if (context.py.FS.isDir(stat.mode)) throw new CheckIgnoreFailure("repository");
    files++;
    totalBytes += stat.size;
    if (
      files > MAX_CHECK_IGNORE_FILES ||
      stat.size > MAX_CHECK_IGNORE_FILE_BYTES ||
      totalBytes > MAX_CHECK_IGNORE_TOTAL_BYTES
    ) {
      throw new CheckIgnoreFailure("input");
    }
    let text: string;
    try {
      const bytes = context.py.FS.readFile(path) as Uint8Array;
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new CheckIgnoreFailure("repository");
    }
    patterns += checkIgnorePatternCount(text);
    if (patterns > MAX_CHECK_IGNORE_PATTERNS) throw new CheckIgnoreFailure("input");
  }
  return {
    fs: maskedCheckIgnoreFs(context, maskedPaths),
    tracked: new Set(trackedPaths),
  };
}

function checkIgnoreFailure(error: unknown): HostCommandResult {
  const kind = error instanceof CheckIgnoreFailure ? error.kind : "repository";
  const message = kind === "input"
    ? "input limit exceeded"
    : kind === "path" ? "invalid pathname" : "cannot inspect repository";
  return errorResult(128, `git check-ignore: ${message}\n`);
}

async function runCheckIgnore(
  context: HostCommandContext,
  args: string[],
): Promise<HostCommandResult> {
  const request = parseCheckIgnoreArgs(args);
  if (!request) return errorResult(2, CHECK_IGNORE_USAGE);

  let root: string;
  try {
    root = repositoryRoot(context.py, context.cwd);
    if (!fsIsDir(context.py, `${root}/.git`)) throw new Error("bare repository");
  } catch {
    return errorResult(128, "git check-ignore: not a git worktree\n");
  }

  try {
    const originals = request.stdin
      ? decodeCheckIgnoreStdin(context.stdin ?? new Uint8Array())
      : request.paths;
    const paths = originals.map((path) =>
      normalizeCheckIgnorePath(context, root, path, request.stdin)
    );
    const { fs, tracked } = await prepareCheckIgnoreRepository(context, root, paths);
    const matches = await Promise.all(paths.map(async ({ relative }) =>
      !tracked.has(relative) && await isomorphicGit.isIgnored({ fs, dir: root, filepath: relative })
    ));
    const ignored = paths.filter((_, index) => matches[index]);
    if (!ignored.length) return result(1, "");
    if (request.quiet) return result(0, "");
    const terminator = request.stdin ? "\0" : "\n";
    const output = ignored.map(({ original }) => `${original}${terminator}`).join("");
    if (encoder.encode(output).byteLength > MAX_CHECK_IGNORE_OUTPUT_BYTES) {
      throw new CheckIgnoreFailure("input");
    }
    return result(0, output);
  } catch (error) {
    return checkIgnoreFailure(error);
  }
}

const SHOW_REF_USAGE =
  "usage: git show-ref [--head] | git show-ref --verify [--quiet] [--] REF\n";

interface ShowRefRequest {
  head: boolean;
  verify: boolean;
  quiet: boolean;
  ref?: string;
}

type ShowRefValue =
  | { kind: "direct"; oid: string }
  | { kind: "symbolic"; target: string };

class ShowRefFailure extends Error {
  kind: "limit" | "repository" | "not-repository";

  constructor(kind: "limit" | "repository" | "not-repository") {
    super(kind);
    this.kind = kind;
  }
}

function parseShowRefArgs(args: string[]): ShowRefRequest | null {
  let head = false;
  let verify = false;
  let quiet = false;
  let options = true;
  let separator = false;
  const operands: string[] = [];
  for (const arg of args) {
    if (options && arg === "--") {
      if (separator || operands.length) return null;
      separator = true;
      options = false;
    } else if (options && arg === "--head") {
      if (head) return null;
      head = true;
    } else if (options && arg === "--verify") {
      if (verify) return null;
      verify = true;
    } else if (options && arg === "--quiet") {
      if (quiet) return null;
      quiet = true;
    } else if (options && arg.startsWith("-")) {
      return null;
    } else {
      operands.push(arg);
    }
  }
  if (head && verify) return null;
  if (quiet && !verify) return null;
  if (!verify && operands.length) return null;
  if (verify && operands.length !== 1) return null;
  if (!verify && separator) return null;
  return { head, verify, quiet, ...(operands.length ? { ref: operands[0] } : {}) };
}

function showRefByteCompare(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.byteLength, b.byteLength);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.byteLength - b.byteLength;
}

function showRefUtf8Bytes(value: string): Uint8Array | undefined {
  const bytes = encoder.encode(value);
  try {
    if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value) return undefined;
  } catch {
    return undefined;
  }
  return bytes;
}

function validShowRefName(ref: string): boolean {
  if (!ref.startsWith("refs/") || ref.length === 5 || ref.endsWith("/") || ref.endsWith(".")) {
    return false;
  }
  if (
    ref.includes("//") || ref.includes("..") || ref.includes("@{") ||
    /[\x00-\x20\x7f~^:?*[\\]/.test(ref)
  ) return false;
  return ref.split("/").every((part) =>
    Boolean(part) && !part.startsWith(".") && !part.endsWith(".lock")
  );
}

function validateShowRefName(ref: string, limitKind: "invalid" | "limit"): boolean {
  const bytes = showRefUtf8Bytes(ref);
  if (!bytes) return false;
  if (bytes.byteLength > MAX_SHOW_REF_NAME_BYTES) {
    if (limitKind === "limit") throw new ShowRefFailure("limit");
    return false;
  }
  return validShowRefName(ref);
}

function showRefLstat(context: HostCommandContext, path: string) {
  try {
    return context.py.FS.lstat(path);
  } catch (error) {
    if (checkIgnoreMissingError(error)) return undefined;
    throw new ShowRefFailure("repository");
  }
}

function showRefIsBareRepository(context: HostCommandContext, directory: string): boolean {
  const required = ["HEAD", "config", "objects", "refs"];
  const stats = required.map((name) => showRefLstat(context, `${directory}/${name}`));
  if (stats.some((stat) => !stat)) return false;
  if (
    context.py.FS.isDir(stats[0]!.mode) || context.py.FS.isLink?.(stats[0]!.mode) ||
    context.py.FS.isDir(stats[1]!.mode) || context.py.FS.isLink?.(stats[1]!.mode) ||
    !context.py.FS.isDir(stats[2]!.mode) || context.py.FS.isLink?.(stats[2]!.mode) ||
    !context.py.FS.isDir(stats[3]!.mode) || context.py.FS.isLink?.(stats[3]!.mode)
  ) return false;
  let entries: ConfigEntry[];
  try {
    entries = parseConfig(fsReadText(context.py, `${directory}/config`));
  } catch {
    return false;
  }
  return entries.some((entry) =>
    entry.key.toLowerCase() === "core.bare" && entry.value.toLowerCase() === "true"
  );
}

function showRefGitDirectory(context: HostCommandContext): string {
  let directory = context.cwd;
  while (directory === "/home/web" || directory.startsWith("/home/web/")) {
    const dotGit = `${directory}/.git`;
    const stat = showRefLstat(context, dotGit);
    if (stat) {
      if (context.py.FS.isLink?.(stat.mode) || !context.py.FS.isDir(stat.mode)) {
        throw new ShowRefFailure("repository");
      }
      return dotGit;
    }
    if (showRefIsBareRepository(context, directory)) return directory;
    if (directory === "/home/web") break;
    directory = directory.slice(0, directory.lastIndexOf("/")) || "/";
  }
  throw new ShowRefFailure("not-repository");
}

function readShowRefText(context: HostCommandContext, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      context.py.FS.readFile(path) as Uint8Array,
    );
  } catch {
    throw new ShowRefFailure("repository");
  }
}

function parseShowRefPayload(text: string): ShowRefValue {
  const direct = /^([0-9a-fA-F]{40})(?:\n|\r\n)?$/.exec(text);
  if (direct) return { kind: "direct", oid: direct[1].toLowerCase() };
  const symbolic = /^ref: (refs\/[^\r\n]+)(?:\n|\r\n)?$/.exec(text);
  if (!symbolic || !validateShowRefName(symbolic[1], "limit")) {
    throw new ShowRefFailure("repository");
  }
  return { kind: "symbolic", target: symbolic[1] };
}

interface ShowRefLoadBudget {
  entries: number;
  looseBytes: number;
}

function readShowRefLooseValue(
  context: HostCommandContext,
  path: string,
  budget: ShowRefLoadBudget,
): ShowRefValue {
  const stat = showRefLstat(context, path);
  if (!stat || context.py.FS.isDir(stat.mode) || context.py.FS.isLink?.(stat.mode)) {
    throw new ShowRefFailure("repository");
  }
  if (stat.size > MAX_SHOW_REF_LOOSE_BYTES) throw new ShowRefFailure("limit");
  budget.looseBytes += stat.size;
  if (budget.looseBytes > MAX_SHOW_REF_TOTAL_LOOSE_BYTES) throw new ShowRefFailure("limit");
  return parseShowRefPayload(readShowRefText(context, path));
}

function readShowRefPacked(
  context: HostCommandContext,
  gitDirectory: string,
): Map<string, ShowRefValue> {
  const refs = new Map<string, ShowRefValue>();
  const path = `${gitDirectory}/packed-refs`;
  const stat = showRefLstat(context, path);
  if (!stat) return refs;
  if (context.py.FS.isDir(stat.mode) || context.py.FS.isLink?.(stat.mode)) {
    throw new ShowRefFailure("repository");
  }
  if (stat.size > MAX_SHOW_REF_PACKED_BYTES) throw new ShowRefFailure("limit");
  let precedingRef = false;
  let peeled = false;
  for (const rawLine of readShowRefText(context, path).split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith("#")) {
      precedingRef = false;
      peeled = false;
      continue;
    }
    if (line.startsWith("^")) {
      if (!precedingRef || peeled || !/^\^[0-9a-fA-F]{40}$/.test(line)) {
        throw new ShowRefFailure("repository");
      }
      peeled = true;
      continue;
    }
    const match = /^([0-9a-fA-F]{40}) (.+)$/.exec(line);
    if (!match || !validateShowRefName(match[2], "limit") || refs.has(match[2])) {
      throw new ShowRefFailure("repository");
    }
    refs.set(match[2], { kind: "direct", oid: match[1].toLowerCase() });
    if (refs.size > MAX_SHOW_REF_REFS) throw new ShowRefFailure("limit");
    precedingRef = true;
    peeled = false;
  }
  return refs;
}

function readShowRefLoose(
  context: HostCommandContext,
  gitDirectory: string,
  refs: Map<string, ShowRefValue>,
  budget: ShowRefLoadBudget,
): void {
  const root = `${gitDirectory}/refs`;
  const rootStat = showRefLstat(context, root);
  if (!rootStat) return;
  if (context.py.FS.isLink?.(rootStat.mode) || !context.py.FS.isDir(rootStat.mode)) {
    throw new ShowRefFailure("repository");
  }
  const visit = (directory: string, prefix: string): void => {
    let names: string[];
    try {
      names = context.py.FS.readdir(directory)
        .filter((name) => name !== "." && name !== "..")
        .sort(showRefByteCompare);
    } catch {
      throw new ShowRefFailure("repository");
    }
    for (const name of names) {
      budget.entries++;
      if (budget.entries > MAX_SHOW_REF_FS_ENTRIES) throw new ShowRefFailure("limit");
      const path = `${directory}/${name}`;
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = showRefLstat(context, path);
      if (!stat || context.py.FS.isLink?.(stat.mode)) throw new ShowRefFailure("repository");
      if (context.py.FS.isDir(stat.mode)) {
        visit(path, relative);
        continue;
      }
      const ref = `refs/${relative}`;
      if (!validateShowRefName(ref, "limit")) throw new ShowRefFailure("repository");
      refs.set(ref, readShowRefLooseValue(context, path, budget));
      if (refs.size > MAX_SHOW_REF_REFS) throw new ShowRefFailure("limit");
    }
  };
  visit(root, "");
}

function assertShowRefNamespace(refs: Map<string, ShowRefValue>): void {
  const names = [...refs.keys()].sort(showRefByteCompare);
  for (let index = 1; index < names.length; index++) {
    if (names[index].startsWith(`${names[index - 1]}/`)) {
      throw new ShowRefFailure("repository");
    }
  }
}

function resolveShowRef(
  name: string,
  value: ShowRefValue | undefined,
  refs: Map<string, ShowRefValue>,
  depth = 0,
  seen = new Set<string>(),
): string | undefined {
  if (!value) return undefined;
  if (value.kind === "direct") return value.oid;
  if (depth >= MAX_SHOW_REF_SYMBOLIC_DEPTH || seen.has(name)) {
    throw new ShowRefFailure("repository");
  }
  const nextSeen = new Set(seen);
  nextSeen.add(name);
  return resolveShowRef(value.target, refs.get(value.target), refs, depth + 1, nextSeen);
}

function showRefFailure(context: HostCommandContext, error: unknown): HostCommandResult {
  if (error instanceof ShowRefFailure && error.kind === "not-repository") {
    return errorResult(128, `git: not a Git repository: ${context.cwd}\n`);
  }
  if (error instanceof ShowRefFailure && error.kind === "limit") {
    return errorResult(2, "git show-ref: limit exceeded\n");
  }
  return errorResult(128, "git show-ref: repository inspection failed\n");
}

function runShowRef(context: HostCommandContext, args: string[]): HostCommandResult {
  const request = parseShowRefArgs(args);
  if (!request) return errorResult(2, SHOW_REF_USAGE);
  if (
    request.verify &&
    request.ref !== "HEAD" &&
    (!request.ref || !validateShowRefName(request.ref, "invalid"))
  ) return errorResult(2, "git show-ref: invalid ref\n");

  try {
    const gitDirectory = showRefGitDirectory(context);
    const refs = readShowRefPacked(context, gitDirectory);
    const budget: ShowRefLoadBudget = { entries: 0, looseBytes: 0 };
    readShowRefLoose(context, gitDirectory, refs, budget);
    assertShowRefNamespace(refs);

    const resolved = new Map<string, string>();
    for (const [name, value] of refs) {
      const oid = resolveShowRef(name, value, refs);
      if (oid) resolved.set(name, oid);
    }

    let head: ShowRefValue | undefined;
    if (request.head || request.ref === "HEAD") {
      const path = `${gitDirectory}/HEAD`;
      if (showRefLstat(context, path)) head = readShowRefLooseValue(context, path, budget);
    }

    if (request.verify) {
      const name = request.ref!;
      const oid = name === "HEAD"
        ? resolveShowRef("HEAD", head, refs)
        : resolved.get(name);
      if (!oid) {
        return request.quiet
          ? result(1, "")
          : errorResult(1, "git show-ref: ref not found\n");
      }
      const output = request.quiet ? "" : `${oid} ${name}\n`;
      if (encoder.encode(output).byteLength > MAX_SHOW_REF_OUTPUT_BYTES) {
        throw new ShowRefFailure("limit");
      }
      return result(0, output);
    }

    const rows: string[] = [];
    if (request.head) {
      const oid = resolveShowRef("HEAD", head, refs);
      if (oid) rows.push(`${oid} HEAD\n`);
    }
    for (const name of [...resolved.keys()].sort(showRefByteCompare)) {
      rows.push(`${resolved.get(name)} ${name}\n`);
    }
    if (!rows.length) return result(1, "");
    const output = rows.join("");
    if (encoder.encode(output).byteLength > MAX_SHOW_REF_OUTPUT_BYTES) {
      throw new ShowRefFailure("limit");
    }
    return result(0, output);
  } catch (error) {
    return showRefFailure(context, error);
  }
}

const TAG_DELETE_USAGE = "usage: git tag (-d|--delete) [--] NAME...\n";

class TagDeleteFailure extends Error {
  readonly kind: "missing" | "repository" | "runtime";

  constructor(
    kind: "missing" | "repository" | "runtime",
    message: string,
  ) {
    super(message);
    this.kind = kind;
  }
}

interface TagDeleteRequest {
  names: string[];
  refs: string[];
}

interface TagLooseSnapshot {
  name: string;
  ref: string;
  path: string;
  bytes?: Uint8Array;
  oid?: string;
}

interface TagPackedSnapshot {
  bytes?: Uint8Array;
  staged?: Uint8Array;
  changed: boolean;
  oids: Map<string, string>;
  refs: Set<string>;
  entries: number;
}

interface TagDeletePlan {
  gitDirectory: string;
  packed: TagPackedSnapshot;
  loose: TagLooseSnapshot[];
  output: string;
}

function parseTagDeleteRequest(args: string[]): TagDeleteRequest {
  if (args[0] !== "-d" && args[0] !== "--delete") {
    throw new GitUsageError(TAG_DELETE_USAGE.trimEnd());
  }
  const names: string[] = [];
  let options = true;
  let separator = false;
  for (const arg of args.slice(1)) {
    if (options && arg === "--") {
      if (separator || names.length) throw new GitUsageError(TAG_DELETE_USAGE.trimEnd());
      separator = true;
      options = false;
      continue;
    }
    if (options && arg.startsWith("-")) {
      throw new GitUsageError(`unsupported tag delete option: ${arg}`);
    }
    names.push(arg);
  }
  if (!names.length) throw new GitUsageError(TAG_DELETE_USAGE.trimEnd());
  if (names.length > MAX_TAG_DELETE_NAMES) {
    throw new GitUsageError(`tag delete accepts at most ${MAX_TAG_DELETE_NAMES} names`);
  }

  const seen = new Set<string>();
  const refs: string[] = [];
  let totalBytes = 0;
  for (const name of names) {
    const bytes = showRefUtf8Bytes(name);
    if (!bytes || !name || name === "@" || name.startsWith("refs/tags/")) {
      throw new GitUsageError(`invalid tag name: ${quoteRmOutputPath(name)}`);
    }
    if (bytes.byteLength > MAX_TAG_DELETE_NAME_BYTES) {
      throw new GitUsageError(`tag name exceeds ${MAX_TAG_DELETE_NAME_BYTES} UTF-8 bytes`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TAG_DELETE_TOTAL_NAME_BYTES) {
      throw new GitUsageError(
        `tag names exceed ${MAX_TAG_DELETE_TOTAL_NAME_BYTES} aggregate UTF-8 bytes`,
      );
    }
    if (name.split("/").length > MAX_TAG_DELETE_DEPTH) {
      throw new GitUsageError(`tag name has more than ${MAX_TAG_DELETE_DEPTH} components`);
    }
    const ref = `refs/tags/${name}`;
    if (!validShowRefName(ref)) {
      throw new GitUsageError(`invalid tag name: ${quoteRmOutputPath(name)}`);
    }
    if (seen.has(name)) {
      throw new GitUsageError(`duplicate tag name: ${quoteRmOutputPath(name)}`);
    }
    seen.add(name);
    refs.push(ref);
  }
  return { names, refs };
}

function tagDeleteLstat(context: HostCommandContext, path: string) {
  try {
    return context.py.FS.lstat(path);
  } catch (error) {
    if (checkIgnoreMissingError(error)) return undefined;
    throw new TagDeleteFailure("repository", `cannot inspect ${path}`);
  }
}

function inspectTagPackedRefs(
  context: HostCommandContext,
  gitDirectory: string,
  targets: Set<string>,
): TagPackedSnapshot {
  const path = `${gitDirectory}/packed-refs`;
  const stat = tagDeleteLstat(context, path);
  if (!stat) return { changed: false, oids: new Map(), refs: new Set(), entries: 0 };
  if (context.py.FS.isDir(stat.mode) || context.py.FS.isLink?.(stat.mode)) {
    throw new TagDeleteFailure("repository", "packed-refs is not a regular file");
  }
  if (stat.size > MAX_TAG_DELETE_PACKED_BYTES) {
    throw new GitUsageError(`tag packed refs exceed ${MAX_TAG_DELETE_PACKED_BYTES} bytes`);
  }
  let bytes: Uint8Array;
  let text: string;
  try {
    bytes = new Uint8Array(context.py.FS.readFile(path) as Uint8Array).slice();
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TagDeleteFailure("repository", "cannot read packed-refs");
  }

  const chunks = text.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const kept: string[] = [];
  const oids = new Map<string, string>();
  const refs = new Set<string>();
  let entries = 0;
  let precedingRef = false;
  let precedingTarget = false;
  let peeled = false;
  let changed = false;
  for (const chunk of chunks) {
    let line = chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line || line.startsWith("#")) {
      precedingRef = false;
      precedingTarget = false;
      peeled = false;
      kept.push(chunk);
      continue;
    }
    if (line.startsWith("^")) {
      if (!precedingRef || peeled || !/^\^[0-9a-fA-F]{40}$/.test(line)) {
        throw new TagDeleteFailure("repository", "packed-refs is malformed");
      }
      peeled = true;
      if (precedingTarget) changed = true;
      else kept.push(chunk);
      continue;
    }
    const match = /^([0-9a-fA-F]{40}) (.+)$/.exec(line);
    if (!match || !validShowRefName(match[2])) {
      throw new TagDeleteFailure("repository", "packed-refs is malformed");
    }
    if (encoder.encode(match[2]).byteLength > MAX_TAG_DELETE_REF_NAME_BYTES) {
      throw new TagDeleteFailure("repository", "packed ref name exceeds the tag inspection limit");
    }
    if (++entries > MAX_TAG_DELETE_REF_ENTRIES) {
      throw new GitUsageError(`tag ref entry limit exceeded (${MAX_TAG_DELETE_REF_ENTRIES})`);
    }
    if (refs.has(match[2])) {
      throw new TagDeleteFailure("repository", "packed-refs contains a duplicate ref");
    }
    refs.add(match[2]);
    oids.set(match[2], match[1].toLowerCase());
    precedingRef = true;
    precedingTarget = targets.has(match[2]);
    peeled = false;
    if (precedingTarget) changed = true;
    else kept.push(chunk);
  }
  return {
    bytes,
    staged: changed ? encoder.encode(kept.join("")) : bytes.slice(),
    changed,
    oids,
    refs,
    entries,
  };
}

function inspectTagLooseRefs(
  context: HostCommandContext,
  gitDirectory: string,
  request: TagDeleteRequest,
): { snapshots: TagLooseSnapshot[]; refs: Set<string>; entries: number } {
  const targetNames = new Map(request.refs.map((ref, index) => [ref, request.names[index]!]));
  const snapshots = new Map<string, TagLooseSnapshot>(request.refs.map((ref, index) => [ref, {
    name: request.names[index]!,
    ref,
    path: `${gitDirectory}/${ref}`,
  }]));
  const refs = new Set<string>();
  const root = `${gitDirectory}/refs/tags`;
  const rootStat = tagDeleteLstat(context, root);
  if (!rootStat) return { snapshots: [...snapshots.values()], refs, entries: 0 };
  if (!context.py.FS.isDir(rootStat.mode) || context.py.FS.isLink?.(rootStat.mode)) {
    throw new TagDeleteFailure("repository", "refs/tags is not a directory");
  }

  let entries = 0;
  const visit = (directory: string, prefix: string): void => {
    let names: string[];
    try {
      names = context.py.FS.readdir(directory)
        .filter((name: string) => name !== "." && name !== "..")
        .sort(showRefByteCompare);
    } catch {
      throw new TagDeleteFailure("repository", "cannot inspect loose tags");
    }
    for (const name of names) {
      if (++entries > MAX_TAG_DELETE_REF_ENTRIES) {
        throw new GitUsageError(`tag ref entry limit exceeded (${MAX_TAG_DELETE_REF_ENTRIES})`);
      }
      const short = prefix ? `${prefix}/${name}` : name;
      if (short.split("/").length > MAX_TAG_DELETE_DEPTH) {
        throw new TagDeleteFailure("repository", "loose tag depth exceeds the inspection limit");
      }
      const ref = `refs/tags/${short}`;
      if (
        !validShowRefName(ref) ||
        encoder.encode(short).byteLength > MAX_TAG_DELETE_NAME_BYTES
      ) {
        throw new TagDeleteFailure("repository", "loose tag name is invalid or over limit");
      }
      const path = `${directory}/${name}`;
      const stat = tagDeleteLstat(context, path);
      if (!stat || context.py.FS.isLink?.(stat.mode)) {
        throw new TagDeleteFailure("repository", "loose tag ancestry is invalid");
      }
      if (context.py.FS.isDir(stat.mode)) {
        visit(path, short);
        continue;
      }
      refs.add(ref);
      if (!targetNames.has(ref)) continue;
      if (stat.size > MAX_TAG_DELETE_LOOSE_BYTES) {
        throw new TagDeleteFailure("repository", "loose tag exceeds the inspection limit");
      }
      let bytes: Uint8Array;
      let value: string;
      try {
        bytes = new Uint8Array(context.py.FS.readFile(path) as Uint8Array).slice();
        value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new TagDeleteFailure("repository", "cannot read loose tag");
      }
      const match = /^([0-9a-fA-F]{40})(?:\n|\r\n)?$/.exec(value);
      if (!match) throw new TagDeleteFailure("repository", "loose tag is not a direct ref");
      snapshots.set(ref, {
        name: targetNames.get(ref)!, ref, path, bytes, oid: match[1].toLowerCase(),
      });
    }
  };
  visit(root, "");
  return { snapshots: request.refs.map((ref) => snapshots.get(ref)!), refs, entries };
}

function assertTagRefNamespace(refs: Set<string>): void {
  const names = [...refs].sort(showRefByteCompare);
  for (let index = 1; index < names.length; index++) {
    if (names[index]!.startsWith(`${names[index - 1]!}/`)) {
      throw new TagDeleteFailure("repository", "ref namespace contains a file/directory collision");
    }
  }
}

function readTagLooseBytes(
  context: HostCommandContext,
  snapshot: TagLooseSnapshot,
): Uint8Array | undefined {
  const stat = tagDeleteLstat(context, snapshot.path);
  if (!stat) return undefined;
  if (context.py.FS.isDir(stat.mode) || context.py.FS.isLink?.(stat.mode)) {
    throw new TagDeleteFailure("runtime", "tag ref changed type during the operation");
  }
  if (stat.size > MAX_TAG_DELETE_LOOSE_BYTES) {
    throw new TagDeleteFailure("runtime", "tag ref changed during the operation");
  }
  try {
    return new Uint8Array(context.py.FS.readFile(snapshot.path) as Uint8Array).slice();
  } catch {
    throw new TagDeleteFailure("runtime", "cannot re-read tag ref");
  }
}

function readTagPackedBytes(
  context: HostCommandContext,
  gitDirectory: string,
): Uint8Array | undefined {
  const path = `${gitDirectory}/packed-refs`;
  const stat = tagDeleteLstat(context, path);
  if (!stat) return undefined;
  if (context.py.FS.isDir(stat.mode) || context.py.FS.isLink?.(stat.mode)) {
    throw new TagDeleteFailure("runtime", "packed-refs changed type during the operation");
  }
  if (stat.size > MAX_TAG_DELETE_PACKED_BYTES) {
    throw new TagDeleteFailure("runtime", "packed-refs changed during the operation");
  }
  try {
    return new Uint8Array(context.py.FS.readFile(path) as Uint8Array).slice();
  } catch {
    throw new TagDeleteFailure("runtime", "cannot re-read packed-refs");
  }
}

function prepareTagDeletePlan(
  context: HostCommandContext,
  root: string,
  request: TagDeleteRequest,
): TagDeletePlan {
  const gitDirectory = `${root}/.git`;
  for (const ref of request.refs) {
    if (tagDeleteLstat(context, `${gitDirectory}/${ref}.lock`)) {
      throw new TagDeleteFailure("runtime", `cannot acquire tag lock for ${ref.slice(10)}`);
    }
  }
  const targets = new Set(request.refs);
  const packed = inspectTagPackedRefs(context, gitDirectory, targets);
  const loose = inspectTagLooseRefs(context, gitDirectory, request);
  if (packed.entries + loose.entries > MAX_TAG_DELETE_REF_ENTRIES) {
    throw new GitUsageError(`tag ref entry limit exceeded (${MAX_TAG_DELETE_REF_ENTRIES})`);
  }
  const namespace = new Set([...packed.refs, ...loose.refs]);
  if (namespace.size > MAX_TAG_DELETE_REF_ENTRIES) {
    throw new GitUsageError(`tag ref entry limit exceeded (${MAX_TAG_DELETE_REF_ENTRIES})`);
  }
  assertTagRefNamespace(namespace);

  const output: string[] = [];
  for (const snapshot of loose.snapshots) {
    const oid = snapshot.oid ?? packed.oids.get(snapshot.ref);
    if (!oid) throw new TagDeleteFailure("missing", snapshot.name);
    output.push(`Deleted tag ${quoteRmOutputPath(snapshot.name)} (was ${oid.slice(0, 7)})\n`);
  }
  const rendered = output.join("");
  if (encoder.encode(rendered).byteLength > MAX_TAG_DELETE_OUTPUT_BYTES) {
    throw new GitUsageError(`tag delete output exceeds ${MAX_TAG_DELETE_OUTPUT_BYTES} bytes`);
  }
  return { gitDirectory, packed, loose: loose.snapshots, output: rendered };
}

function assertTagDeletePlanCurrent(context: HostCommandContext, plan: TagDeletePlan): void {
  if (plan.packed.changed && fsExists(context.py, `${plan.gitDirectory}/packed-refs.lock`)) {
    throw new TagDeleteFailure("runtime", "cannot acquire packed-refs lock");
  }
  const packed = readTagPackedBytes(context, plan.gitDirectory);
  if (!equalOptionalBytes(packed, plan.packed.bytes)) {
    throw new TagDeleteFailure("runtime", "packed-refs changed during the operation");
  }
  for (const snapshot of plan.loose) {
    if (snapshot.bytes && fsExists(context.py, `${snapshot.path}.lock`)) {
      throw new TagDeleteFailure("runtime", `cannot acquire tag lock for ${snapshot.name}`);
    }
    if (!equalOptionalBytes(readTagLooseBytes(context, snapshot), snapshot.bytes)) {
      throw new TagDeleteFailure("runtime", `tag changed during the operation: ${snapshot.name}`);
    }
  }
}

function equalOptionalBytes(
  left: Uint8Array | undefined,
  right: Uint8Array | undefined,
): boolean {
  if (!left || !right) return left === right;
  return equalBytes(left, right);
}

function writePackedRefsAtomically(
  context: HostCommandContext,
  gitDirectory: string,
  bytes: Uint8Array,
): void {
  const path = `${gitDirectory}/packed-refs`;
  const lock = `${path}.lock`;
  if (fsExists(context.py, lock)) {
    throw new TagDeleteFailure("runtime", "cannot acquire packed-refs lock");
  }
  try {
    context.py.FS.writeFile(lock, bytes);
    context.py.FS.rename(lock, path);
  } catch (error) {
    try { if (fsExists(context.py, lock)) context.py.FS.unlink(lock); } catch { /* best effort */ }
    throw error;
  }
}

function rollbackTagDeletePlan(context: HostCommandContext, plan: TagDeletePlan): string[] {
  const failures: string[] = [];
  const packedPath = `${plan.gitDirectory}/packed-refs`;
  const packedLock = `${packedPath}.lock`;
  try { if (fsExists(context.py, packedLock)) context.py.FS.unlink(packedLock); }
  catch (error) { failures.push(`packed lock: ${conciseObjectError(error)}`); }
  let packedChanged = false;
  if (plan.packed.changed) {
    try {
      packedChanged = !equalOptionalBytes(
        readTagPackedBytes(context, plan.gitDirectory),
        plan.packed.bytes,
      );
    } catch {
      packedChanged = true;
    }
  }
  if (packedChanged) {
    try {
      if (plan.packed.bytes) writePackedRefsAtomically(context, plan.gitDirectory, plan.packed.bytes);
      else if (fsExists(context.py, packedPath)) context.py.FS.unlink(packedPath);
    } catch (error) {
      failures.push(`packed refs: ${conciseObjectError(error)}`);
    }
  }
  for (const snapshot of plan.loose) {
    if (!snapshot.bytes) continue;
    try {
      if (equalOptionalBytes(readTagLooseBytes(context, snapshot), snapshot.bytes)) continue;
    } catch {
      // Attempt restoration below and report it if the target cannot be replaced.
    }
    try {
      const slash = snapshot.path.lastIndexOf("/");
      context.py.FS.mkdirTree(snapshot.path.slice(0, slash));
      const stat = tagDeleteLstat(context, snapshot.path);
      if (stat && (context.py.FS.isDir(stat.mode) || context.py.FS.isLink?.(stat.mode))) {
        throw new Error("rollback target changed type");
      }
      context.py.FS.writeFile(snapshot.path, snapshot.bytes);
    } catch (error) {
      failures.push(`${snapshot.name}: ${conciseObjectError(error)}`);
    }
  }
  return failures;
}

function applyTagDeletePlan(context: HostCommandContext, plan: TagDeletePlan): void {
  assertTagDeletePlanCurrent(context, plan);
  try {
    if (plan.packed.changed) {
      writePackedRefsAtomically(context, plan.gitDirectory, plan.packed.staged!);
    }
    for (const snapshot of plan.loose) {
      if (!snapshot.bytes) continue;
      if (!equalOptionalBytes(readTagLooseBytes(context, snapshot), snapshot.bytes)) {
        throw new TagDeleteFailure("runtime", `tag changed during the operation: ${snapshot.name}`);
      }
      context.py.FS.unlink(snapshot.path);
    }
  } catch (error) {
    const failures = rollbackTagDeletePlan(context, plan);
    if (failures.length) {
      throw new TagDeleteFailure(
        "runtime",
        `${conciseObjectError(error)}; tag rollback failed for ${failures.join(", ")}`,
      );
    }
    throw error;
  }
}

function runTagDelete(context: HostCommandContext, args: string[]): HostCommandResult {
  try {
    const request = parseTagDeleteRequest(args);
    const root = repositoryRoot(context.py, context.cwd);
    const plan = prepareTagDeletePlan(context, root, request);
    applyTagDeletePlan(context, plan);
    return result(0, plan.output);
  } catch (error) {
    if (error instanceof GitUsageError) throw error;
    if (error instanceof TagDeleteFailure && error.kind === "missing") {
      return errorResult(1, `git tag: tag not found: ${quoteRmOutputPath(error.message)}\n`);
    }
    return errorResult(1, `git tag: ${conciseObjectError(error)}\n`);
  }
}

const LS_TREE_USAGE =
  "usage: git ls-tree [-r] [-t] [-z] [--name-only] [--max-count=N] [--] <tree-ish>\n";

interface LsTreeRequest {
  recursive: boolean;
  includeTrees: boolean;
  nul: boolean;
  nameOnly: boolean;
  maxCount?: number;
  treeish: string;
}

type LsTreeFailureKind =
  | "invalid-treeish"
  | "invalid-tree"
  | "traversal"
  | "output";

class LsTreeFailure extends Error {
  kind: LsTreeFailureKind;

  constructor(kind: LsTreeFailureKind) {
    super(kind);
    this.kind = kind;
  }
}

function parseLsTreeArgs(args: string[]): LsTreeRequest | undefined {
  let recursive = false;
  let includeTrees = false;
  let nul = false;
  let nameOnly = false;
  let maxCount: number | undefined;
  let options = true;
  let operandSeen = false;
  const operands: string[] = [];
  for (const arg of args) {
    if (operandSeen) {
      operands.push(arg);
    } else if (options && arg === "--") {
      if (operandSeen) return undefined;
      options = false;
    } else if (options && arg === "-r") {
      recursive = true;
    } else if (options && arg === "-t") {
      includeTrees = true;
    } else if (options && arg === "-z") {
      nul = true;
    } else if (options && arg === "--name-only") {
      nameOnly = true;
    } else if (options && arg.startsWith("--max-count=")) {
      if (maxCount !== undefined) return undefined;
      const value = arg.slice("--max-count=".length);
      if (!/^\d+$/.test(value)) return undefined;
      maxCount = Number(value);
      if (!Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > MAX_LS_TREE_ENTRIES) {
        return undefined;
      }
    } else if (options && arg.startsWith("-")) {
      return undefined;
    } else {
      operandSeen = true;
      operands.push(arg);
    }
  }
  if (
    operands.length !== 1 || !operands[0] ||
    !showRefUtf8Bytes(operands[0]) ||
    encoder.encode(operands[0]).byteLength > MAX_GIT_REVISION_BYTES
  ) return undefined;
  return {
    recursive,
    includeTrees,
    nul,
    nameOnly,
    ...(maxCount === undefined ? {} : { maxCount }),
    treeish: operands[0],
  };
}

interface RawTreeEntry {
  mode: "040000" | "100644" | "100755" | "120000" | "160000";
  type: "blob" | "tree" | "commit";
  oid: string;
  name: Uint8Array;
}

interface RawTreeCursor {
  bytes: Uint8Array;
  offset: number;
  names: Map<number, Uint8Array[]>;
}

function equalTreeName(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function rememberTreeName(cursor: RawTreeCursor, name: Uint8Array): void {
  let hash = 0x811c9dc5;
  for (const byte of name) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  const bucket = cursor.names.get(hash) ?? [];
  if (bucket.some((candidate) => equalTreeName(candidate, name))) {
    throw new LsTreeFailure("invalid-tree");
  }
  bucket.push(name);
  cursor.names.set(hash, bucket);
}

function nextRawTreeEntry(cursor: RawTreeCursor): RawTreeEntry | undefined {
  const { bytes } = cursor;
  if (cursor.offset === bytes.byteLength) return undefined;
  const modeStart = cursor.offset;
  let space = modeStart;
  while (space < bytes.byteLength && bytes[space] !== 0x20 && space - modeStart <= 6) space++;
  if (space === bytes.byteLength || bytes[space] !== 0x20) {
    throw new LsTreeFailure("invalid-tree");
  }
  let storedMode = "";
  for (let index = modeStart; index < space; index++) {
    const byte = bytes[index];
    if (byte < 0x30 || byte > 0x37) throw new LsTreeFailure("invalid-tree");
    storedMode += String.fromCharCode(byte);
  }
  const mode = storedMode === "40000" || storedMode === "040000"
    ? "040000"
    : storedMode === "100644" || storedMode === "100755" ||
        storedMode === "120000" || storedMode === "160000"
      ? storedMode
      : undefined;
  if (!mode) throw new LsTreeFailure("invalid-tree");

  const nameStart = space + 1;
  let nul = nameStart;
  while (nul < bytes.byteLength && bytes[nul] !== 0) nul++;
  if (nul === nameStart || nul === bytes.byteLength || nul + 21 > bytes.byteLength) {
    throw new LsTreeFailure("invalid-tree");
  }
  const name = bytes.subarray(nameStart, nul);
  if (
    name.some((byte) => byte === 0x2f) ||
    (name.byteLength === 1 && name[0] === 0x2e) ||
    (name.byteLength === 2 && name[0] === 0x2e && name[1] === 0x2e)
  ) throw new LsTreeFailure("invalid-tree");
  rememberTreeName(cursor, name);

  const oid = objectId(bytes, nul + 1);
  cursor.offset = nul + 21;
  return {
    mode,
    type: mode === "040000" ? "tree" : mode === "160000" ? "commit" : "blob",
    oid,
    name,
  };
}

function joinTreePath(parent: Uint8Array, name: Uint8Array): Uint8Array {
  const length = parent.byteLength + (parent.byteLength ? 1 : 0) + name.byteLength;
  if (length > MAX_LS_TREE_PATH_BYTES) throw new LsTreeFailure("traversal");
  const path = new Uint8Array(length);
  path.set(parent);
  let offset = parent.byteLength;
  if (offset) path[offset++] = 0x2f;
  path.set(name, offset);
  return path;
}

function quoteLsTreePath(path: Uint8Array): Uint8Array {
  const safe = path.every((byte) =>
    byte >= 0x20 && byte <= 0x7e && byte !== 0x22 && byte !== 0x5c
  );
  if (safe) return path;
  let output = '"';
  for (const byte of path) {
    if (byte === 0x09) output += "\\t";
    else if (byte === 0x0a) output += "\\n";
    else if (byte === 0x22) output += '\\"';
    else if (byte === 0x5c) output += "\\\\";
    else if (byte >= 0x20 && byte <= 0x7e) output += String.fromCharCode(byte);
    else output += `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return encoder.encode(`${output}"`);
}

function concatTreeBytes(parts: Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

interface LsTreeWalkState {
  request: LsTreeRequest;
  root: string;
  context: HostCommandContext;
  examinedEntries: number;
  decodedObjects: number;
  decodedBytes: number;
  records: number;
  outputBytes: number;
  output: Uint8Array[];
  stopped: boolean;
}

function appendLsTreeRecord(
  state: LsTreeWalkState,
  entry: RawTreeEntry,
  path: Uint8Array,
): void {
  const shownPath = state.request.nul ? path : quoteLsTreePath(path);
  const prefix = state.request.nameOnly
    ? new Uint8Array()
    : encoder.encode(`${entry.mode} ${entry.type} ${entry.oid}\t`);
  const terminator = new Uint8Array([state.request.nul ? 0 : 0x0a]);
  const length = prefix.byteLength + shownPath.byteLength + 1;
  if (state.outputBytes + length > MAX_LS_TREE_OUTPUT_BYTES) {
    throw new LsTreeFailure("output");
  }
  state.output.push(concatTreeBytes([prefix, shownPath, terminator], length));
  state.outputBytes += length;
  state.records++;
  if (state.request.maxCount !== undefined && state.records >= state.request.maxCount) {
    state.stopped = true;
  }
}

async function walkLsTree(
  state: LsTreeWalkState,
  oid: string,
  parent: Uint8Array,
  depth: number,
): Promise<void> {
  if (state.stopped) return;
  if (depth > MAX_LS_TREE_DEPTH) throw new LsTreeFailure("traversal");
  state.decodedObjects++;
  if (state.decodedObjects > MAX_LS_TREE_OBJECTS) throw new LsTreeFailure("traversal");

  let object: { type: string; object: Uint8Array };
  try {
    object = await isomorphicGit.readObject({
      fs: gitFs(state.context),
      dir: state.root,
      oid,
      format: "content",
    }) as { type: string; object: Uint8Array };
  } catch {
    throw new LsTreeFailure("invalid-tree");
  }
  if (object.type !== "tree" || !(object.object instanceof Uint8Array)) {
    throw new LsTreeFailure("invalid-tree");
  }
  if (object.object.byteLength > MAX_LS_TREE_OBJECT_BYTES) {
    throw new LsTreeFailure("traversal");
  }
  state.decodedBytes += object.object.byteLength;
  if (state.decodedBytes > MAX_LS_TREE_TOTAL_BYTES) throw new LsTreeFailure("traversal");

  const cursor: RawTreeCursor = { bytes: object.object, offset: 0, names: new Map() };
  while (!state.stopped) {
    const entry = nextRawTreeEntry(cursor);
    if (!entry) break;
    state.examinedEntries++;
    if (state.examinedEntries > MAX_LS_TREE_ENTRIES) {
      throw new LsTreeFailure("traversal");
    }
    const path = joinTreePath(parent, entry.name);
    if (!state.request.recursive) {
      appendLsTreeRecord(state, entry, path);
    } else if (entry.type === "tree") {
      if (state.request.includeTrees) appendLsTreeRecord(state, entry, path);
      if (!state.stopped) await walkLsTree(state, entry.oid, path, depth + 1);
    } else {
      appendLsTreeRecord(state, entry, path);
    }
  }
}

function lsTreeFailure(error: unknown): HostCommandResult {
  const kind = error instanceof LsTreeFailure ? error.kind : "invalid-tree";
  const message = kind === "invalid-treeish"
    ? "invalid tree-ish"
    : kind === "invalid-tree" ? "invalid tree object"
    : kind === "output" ? "output limit exceeded"
    : "traversal limit exceeded";
  return errorResult(2, `git ls-tree: ${message}\n`);
}

function lsTreeMissingObject(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error &&
    (error as { code?: unknown }).code === "NotFoundError"
  );
}

function lsTreeHeaderOid(bytes: Uint8Array, header: "tree" | "object"): string | undefined {
  const prefix = encoder.encode(`${header} `);
  if (bytes.byteLength < prefix.byteLength + 41) return undefined;
  for (let index = 0; index < prefix.byteLength; index++) {
    if (bytes[index] !== prefix[index]) return undefined;
  }
  let oid = "";
  for (let index = prefix.byteLength; index < prefix.byteLength + 40; index++) {
    const byte = bytes[index];
    const hex = byte >= 0x30 && byte <= 0x39 || byte >= 0x61 && byte <= 0x66;
    if (!hex) return undefined;
    oid += String.fromCharCode(byte);
  }
  return bytes[prefix.byteLength + 40] === 0x0a ? oid : undefined;
}

async function resolveLsTreeOid(
  context: HostCommandContext,
  root: string,
  treeish: string,
): Promise<string> {
  let oid: string;
  let peelBytes = 0;
  try {
    oid = await resolveDiffRevision(context, root, treeish);
  } catch {
    if (/^[0-9a-fA-F]{40}$/.test(treeish)) {
      oid = treeish.toLowerCase();
    } else {
      try {
        oid = await isomorphicGit.resolveRef({ fs: gitFs(context), dir: root, ref: treeish });
      } catch {
        throw new LsTreeFailure("invalid-treeish");
      }
    }
  }
  for (let depth = 0; depth <= 32; depth++) {
    let object: { type: string; object: Uint8Array };
    try {
      object = await isomorphicGit.readObject({
        fs: gitFs(context), dir: root, oid, format: "content",
      }) as { type: string; object: Uint8Array };
    } catch (error) {
      throw new LsTreeFailure(lsTreeMissingObject(error) ? "invalid-treeish" : "invalid-tree");
    }
    if (!(object.object instanceof Uint8Array)) throw new LsTreeFailure("invalid-treeish");
    if (object.type === "tree") return oid;
    if (object.type === "blob") throw new LsTreeFailure("invalid-treeish");
    if (object.object.byteLength > MAX_LS_TREE_PEEL_OBJECT_BYTES) {
      throw new LsTreeFailure("traversal");
    }
    peelBytes += object.object.byteLength;
    if (peelBytes > MAX_LS_TREE_TOTAL_PEEL_BYTES) throw new LsTreeFailure("traversal");
    const next = object.type === "commit"
      ? lsTreeHeaderOid(object.object, "tree")
      : object.type === "tag" ? lsTreeHeaderOid(object.object, "object") : undefined;
    if (!next || depth === 32) throw new LsTreeFailure("invalid-treeish");
    oid = next;
  }
  throw new LsTreeFailure("invalid-treeish");
}

async function runLsTree(
  context: HostCommandContext,
  args: string[],
): Promise<HostCommandResult> {
  const request = parseLsTreeArgs(args);
  if (!request) return errorResult(2, LS_TREE_USAGE);
  let root: string;
  try {
    root = repositoryRoot(context.py, context.cwd);
  } catch {
    return errorResult(2, `git: not a Git repository: ${context.cwd}\n`);
  }

  let treeOid: string;
  try {
    treeOid = await resolveLsTreeOid(context, root, request.treeish);
  } catch (error) {
    return lsTreeFailure(error);
  }

  const state: LsTreeWalkState = {
    request,
    root,
    context,
    examinedEntries: 0,
    decodedObjects: 0,
    decodedBytes: 0,
    records: 0,
    outputBytes: 0,
    output: [],
    stopped: false,
  };
  try {
    await walkLsTree(state, treeOid, new Uint8Array(), 1);
    const stdout = concatTreeBytes(state.output, state.outputBytes);
    return { exitCode: 0, stdout };
  } catch (error) {
    return lsTreeFailure(error);
  }
}

type GitGrepPatternMode = "basic" | "extended" | "fixed";

interface GitGrepRequest {
  lineNumber: boolean;
  ignoreCase: boolean;
  patternMode: GitGrepPatternMode;
  filesWithMatches: boolean;
  quiet: boolean;
  nul: boolean;
  maxResults?: number;
  pattern: Uint8Array;
  revision?: string;
  pathspecs: string[];
}

class GitGrepFailure extends Error {}

function gitGrepFailure(message: string): never {
  throw new GitGrepFailure(message);
}

function parseGitGrepArgs(args: string[]): GitGrepRequest {
  let lineNumber = false;
  let ignoreCase = false;
  let fixed = false;
  let extended = false;
  let filesWithMatches = false;
  let quiet = false;
  let nul = false;
  let maxResults: number | undefined;
  let patternText: string | undefined;
  let index = 0;
  while (index < args.length && patternText === undefined) {
    const arg = args[index];
    if (arg === "-n" || arg === "--line-number") lineNumber = true;
    else if (arg === "-i" || arg === "--ignore-case") ignoreCase = true;
    else if (arg === "-F" || arg === "--fixed-strings") fixed = true;
    else if (arg === "-E" || arg === "--extended-regexp") extended = true;
    else if (arg === "-l" || arg === "--files-with-matches") filesWithMatches = true;
    else if (arg === "-q" || arg === "--quiet") quiet = true;
    else if (arg === "-z") nul = true;
    else if (arg.startsWith("--max-results=")) {
      if (maxResults !== undefined) gitGrepFailure("--max-results may be specified only once");
      const value = arg.slice("--max-results=".length);
      if (!/^[1-9]\d*$/.test(value)) gitGrepFailure("--max-results must be a decimal integer from 1 through 100000");
      maxResults = Number(value);
      if (!Number.isSafeInteger(maxResults) || maxResults > MAX_GREP_MATCHES) {
        gitGrepFailure("--max-results must be a decimal integer from 1 through 100000");
      }
    } else if (arg === "-e") {
      if (index + 1 >= args.length) gitGrepFailure("-e requires a pattern");
      patternText = args[++index];
    } else if (arg === "--") {
      gitGrepFailure("pattern is required before --");
    } else if (arg.startsWith("-")) {
      gitGrepFailure(`unsupported option: ${gitGrepQuote(arg)}`);
    } else {
      patternText = arg;
    }
    index++;
  }
  if (patternText === undefined) gitGrepFailure("pattern is required");
  if (fixed && extended) gitGrepFailure("-F and -E are mutually exclusive");
  if (filesWithMatches && quiet) gitGrepFailure("-l and -q are mutually exclusive");

  let revision: string | undefined;
  if (index < args.length && args[index] !== "--") {
    if (args[index].startsWith("-")) gitGrepFailure("options must precede the pattern");
    revision = args[index++];
  }
  if (index < args.length && args[index] !== "--") gitGrepFailure("at most one revision is supported");
  const pathspecs = index < args.length ? args.slice(index + 1) : [];
  if (pathspecs.length > MAX_GREP_PATHSPECS) gitGrepFailure("more than 100 pathspecs");

  const pattern = encoder.encode(patternText);
  if (patternText.includes("\0") || pattern.byteLength > MAX_GREP_PATTERN_BYTES) {
    gitGrepFailure("pattern exceeds 65536 bytes or contains NUL");
  }
  if (revision !== undefined && (
    !revision || revision.includes("\0") || encoder.encode(revision).byteLength > MAX_GIT_REVISION_BYTES
  )) gitGrepFailure("invalid revision operand");
  for (const pathspec of pathspecs) {
    if (
      !pathspec || pathspec.includes("\0") || pathspec.startsWith("/") ||
      pathspec.startsWith(":") || encoder.encode(pathspec).byteLength > MAX_GREP_PATH_BYTES
    ) gitGrepFailure("invalid pathspec");
  }
  return {
    lineNumber,
    ignoreCase,
    patternMode: fixed ? "fixed" : extended ? "extended" : "basic",
    filesWithMatches,
    quiet,
    nul,
    ...(maxResults === undefined ? {} : { maxResults }),
    pattern,
    ...(revision === undefined ? {} : { revision }),
    pathspecs,
  };
}

function gitGrepQuote(value: string): string {
  let output = "";
  for (const byte of encoder.encode(value)) {
    const shown = byte >= 0x20 && byte <= 0x7e
      ? String.fromCharCode(byte)
      : `\\x${byte.toString(16).padStart(2, "0")}`;
    if (output.length + shown.length > 1_024) return `${output}...`;
    output += shown;
  }
  return output;
}

type GitGrepRegexToken =
  | { kind: "literal"; byte: number }
  | { kind: "class"; bytes: Uint8Array }
  | { kind: "any" | "start" | "end" | "open" | "close" | "alt" | "star" | "plus" | "question" };

function addGitGrepClassByte(set: Uint8Array, byte: number, ignoreCase: boolean): void {
  set[byte] = 1;
  if (!ignoreCase) return;
  if (byte >= 0x41 && byte <= 0x5a) set[byte + 0x20] = 1;
  else if (byte >= 0x61 && byte <= 0x7a) set[byte - 0x20] = 1;
}

function readGitGrepClassByte(pattern: Uint8Array, index: number): [number, number] {
  if (index >= pattern.byteLength) gitGrepFailure("invalid regular expression");
  if (pattern[index] !== 0x5c) return [pattern[index], index + 1];
  if (index + 1 >= pattern.byteLength) gitGrepFailure("invalid regular expression");
  return [pattern[index + 1], index + 2];
}

function parseGitGrepClass(
  pattern: Uint8Array,
  start: number,
  ignoreCase: boolean,
): [{ kind: "class"; bytes: Uint8Array }, number] {
  let index = start + 1;
  let negate = false;
  if (index < pattern.byteLength && pattern[index] === 0x5e) {
    negate = true; index++;
  }
  const set = new Uint8Array(256);
  let have = false;
  while (index < pattern.byteLength) {
    if (pattern[index] === 0x5d && have) {
      if (negate) for (let byte = 0; byte < 256; byte++) set[byte] = set[byte] ? 0 : 1;
      return [{ kind: "class", bytes: set }, index + 1];
    }
    if (
      pattern[index] === 0x5b && index + 1 < pattern.byteLength &&
      [0x2e, 0x3a, 0x3d].includes(pattern[index + 1])
    ) gitGrepFailure("POSIX named, collating, and equivalence classes are unavailable");
    let first: number;
    [first, index] = readGitGrepClassByte(pattern, index);
    if (
      index < pattern.byteLength && pattern[index] === 0x2d &&
      index + 1 < pattern.byteLength && pattern[index + 1] !== 0x5d
    ) {
      let last: number;
      [last, index] = readGitGrepClassByte(pattern, index + 1);
      if (last < first) gitGrepFailure("invalid regular expression range");
      for (let byte = first; byte <= last; byte++) addGitGrepClassByte(set, byte, ignoreCase);
    } else {
      addGitGrepClassByte(set, first, ignoreCase);
    }
    have = true;
  }
  gitGrepFailure("unterminated regular expression class");
}

function gitGrepLiteralToken(byte: number, ignoreCase: boolean): GitGrepRegexToken {
  const asciiLetter = byte >= 0x41 && byte <= 0x5a || byte >= 0x61 && byte <= 0x7a;
  if (!ignoreCase || !asciiLetter) {
    return { kind: "literal", byte };
  }
  const bytes = new Uint8Array(256);
  addGitGrepClassByte(bytes, byte, true);
  return { kind: "class", bytes };
}

function tokenizeGitGrepRegex(
  pattern: Uint8Array,
  mode: "basic" | "extended",
  ignoreCase: boolean,
): GitGrepRegexToken[] {
  const tokens: GitGrepRegexToken[] = [];
  const extendedMeta = new Map<number, GitGrepRegexToken["kind"]>([
    [0x2e, "any"], [0x5e, "start"], [0x24, "end"], [0x28, "open"],
    [0x29, "close"], [0x7c, "alt"], [0x2a, "star"], [0x2b, "plus"],
    [0x3f, "question"],
  ]);
  const basicEscaped = new Map<number, GitGrepRegexToken["kind"]>([
    [0x28, "open"], [0x29, "close"], [0x7c, "alt"], [0x2b, "plus"], [0x3f, "question"],
  ]);
  for (let index = 0; index < pattern.byteLength;) {
    const byte = pattern[index];
    if (byte === 0x5b) {
      let token: { kind: "class"; bytes: Uint8Array };
      [token, index] = parseGitGrepClass(pattern, index, ignoreCase);
      tokens.push(token); continue;
    }
    if (byte === 0x5c) {
      if (index + 1 >= pattern.byteLength) gitGrepFailure("invalid regular expression");
      const escaped = pattern[index + 1];
      if (escaped >= 0x31 && escaped <= 0x39) gitGrepFailure("regular expression backreferences are unavailable");
      if (mode === "basic" && escaped === 0x7b) gitGrepFailure("counted regular expression repeats are unavailable");
      const kind = mode === "basic" ? basicEscaped.get(escaped) : undefined;
      tokens.push(kind ? { kind } as GitGrepRegexToken : gitGrepLiteralToken(escaped, ignoreCase));
      index += 2; continue;
    }
    if (mode === "extended" && (byte === 0x7b || byte === 0x7d)) {
      gitGrepFailure("counted regular expression repeats are unavailable");
    }
    const kind = mode === "extended"
      ? extendedMeta.get(byte)
      : byte === 0x2e ? "any"
      : byte === 0x5e ? "start"
      : byte === 0x24 ? "end"
      : byte === 0x2a ? "star"
      : undefined;
    tokens.push(kind ? { kind } as GitGrepRegexToken : gitGrepLiteralToken(byte, ignoreCase));
    index++;
  }
  return tokens;
}

type GitGrepRegexNode =
  | { kind: "empty" | "any" | "start" | "end" }
  | { kind: "class"; bytes: Uint8Array }
  | { kind: "concat" | "alt"; children: GitGrepRegexNode[] }
  | { kind: "star" | "plus" | "question"; child: GitGrepRegexNode };

class GitGrepRegexParser {
  private index = 0;
  private depth = 0;
  private readonly tokens: GitGrepRegexToken[];

  constructor(tokens: GitGrepRegexToken[]) { this.tokens = tokens; }

  parse(): GitGrepRegexNode {
    const node = this.parseAlternation(false);
    if (this.index !== this.tokens.length) gitGrepFailure("invalid regular expression");
    return node;
  }

  private parseAlternation(inGroup: boolean): GitGrepRegexNode {
    const children = [this.parseConcatenation(inGroup)];
    while (this.tokens[this.index]?.kind === "alt") {
      this.index++;
      children.push(this.parseConcatenation(inGroup));
    }
    return children.length === 1 ? children[0] : { kind: "alt", children };
  }

  private parseConcatenation(inGroup: boolean): GitGrepRegexNode {
    const children: GitGrepRegexNode[] = [];
    while (this.index < this.tokens.length) {
      const kind = this.tokens[this.index].kind;
      if (kind === "alt" || kind === "close") break;
      children.push(this.parseRepeated(inGroup));
    }
    return children.length === 0
      ? { kind: "empty" }
      : children.length === 1 ? children[0] : { kind: "concat", children };
  }

  private parseRepeated(inGroup: boolean): GitGrepRegexNode {
    const token = this.tokens[this.index++];
    let node: GitGrepRegexNode;
    if (token.kind === "open") {
      if (++this.depth > MAX_GREP_DEPTH) gitGrepFailure("regular expression nesting exceeds 128");
      node = this.parseAlternation(true);
      if (this.tokens[this.index]?.kind !== "close") gitGrepFailure("unterminated regular expression group");
      this.index++; this.depth--;
    } else if (token.kind === "class") node = token;
    else if (token.kind === "literal") {
      const bytes = new Uint8Array(256); bytes[token.byte] = 1; node = { kind: "class", bytes };
    } else if (["any", "start", "end"].includes(token.kind)) {
      node = { kind: token.kind as "any" | "start" | "end" };
    } else {
      gitGrepFailure(inGroup ? "invalid regular expression group" : "invalid regular expression");
    }
    const repeat = this.tokens[this.index]?.kind;
    if (repeat === "star" || repeat === "plus" || repeat === "question") {
      if (node.kind === "start" || node.kind === "end") gitGrepFailure("regular expression anchor cannot be repeated");
      this.index++;
      node = { kind: repeat, child: node };
      const duplicate = this.tokens[this.index]?.kind;
      if (duplicate === "star" || duplicate === "plus" || duplicate === "question") {
        gitGrepFailure("repeated regular expression quantifier");
      }
    }
    return node;
  }
}

type GitGrepRegexState =
  | { op: "byte"; bytes: Uint8Array; out: number }
  | { op: "any" | "start" | "end" | "jump"; out: number }
  | { op: "split"; out: number; out1: number }
  | { op: "match" };

interface GitGrepRegexPatch { state: number; branch: "out" | "out1" }
interface GitGrepRegexFragment { start: number; exits: GitGrepRegexPatch[] }

class GitGrepRegexCompiler {
  readonly states: GitGrepRegexState[] = [];

  compile(node: GitGrepRegexNode): { states: GitGrepRegexState[]; start: number } {
    const fragment = this.node(node);
    const match = this.add({ op: "match" });
    this.patch(fragment.exits, match);
    return { states: this.states, start: fragment.start };
  }

  private add(state: GitGrepRegexState): number {
    if (this.states.length >= MAX_GREP_REGEX_STATES) gitGrepFailure("regular expression program exceeds 65536 states");
    this.states.push(state); return this.states.length - 1;
  }

  private patch(exits: GitGrepRegexPatch[], target: number): void {
    for (const exit of exits) {
      const state = this.states[exit.state] as Exclude<GitGrepRegexState, { op: "match" }>;
      if (exit.branch === "out") state.out = target;
      else if (state.op === "split") state.out1 = target;
    }
  }

  private node(node: GitGrepRegexNode): GitGrepRegexFragment {
    if (node.kind === "empty") {
      const start = this.add({ op: "jump", out: -1 });
      return { start, exits: [{ state: start, branch: "out" }] };
    }
    if (node.kind === "class") {
      const start = this.add({ op: "byte", bytes: node.bytes, out: -1 });
      return { start, exits: [{ state: start, branch: "out" }] };
    }
    if (node.kind === "any" || node.kind === "start" || node.kind === "end") {
      const start = this.add({ op: node.kind, out: -1 });
      return { start, exits: [{ state: start, branch: "out" }] };
    }
    if (node.kind === "concat") {
      let fragment = this.node(node.children[0]);
      for (const child of node.children.slice(1)) {
        const next = this.node(child);
        this.patch(fragment.exits, next.start);
        fragment = { start: fragment.start, exits: next.exits };
      }
      return fragment;
    }
    if (node.kind === "alt") {
      let fragment = this.node(node.children[0]);
      for (const child of node.children.slice(1)) {
        const right = this.node(child);
        const split = this.add({ op: "split", out: fragment.start, out1: right.start });
        fragment = { start: split, exits: [...fragment.exits, ...right.exits] };
      }
      return fragment;
    }
    if (node.kind !== "star" && node.kind !== "plus" && node.kind !== "question") {
      gitGrepFailure("invalid regular expression node");
    }
    const child = this.node(node.child);
    if (node.kind === "star") {
      const split = this.add({ op: "split", out: child.start, out1: -1 });
      this.patch(child.exits, split);
      return { start: split, exits: [{ state: split, branch: "out1" }] };
    }
    if (node.kind === "plus") {
      const split = this.add({ op: "split", out: child.start, out1: -1 });
      this.patch(child.exits, split);
      return { start: child.start, exits: [{ state: split, branch: "out1" }] };
    }
    const split = this.add({ op: "split", out: child.start, out1: -1 });
    return { start: split, exits: [...child.exits, { state: split, branch: "out1" }] };
  }
}

interface GitGrepMatcher {
  fixed?: Uint8Array;
  states?: GitGrepRegexState[];
  start?: number;
  ignoreCase: boolean;
  marks?: Uint32Array;
  generation: number;
}

interface GitGrepStepBudget { match: number; pathspec: number }

function gitGrepLiteralNode(node: GitGrepRegexNode, output: number[]): boolean {
  if (node.kind === "empty") return true;
  if (node.kind === "class") {
    let selected = -1;
    for (let byte = 0; byte < 256; byte++) {
      if (!node.bytes[byte]) continue;
      if (selected >= 0) return false;
      selected = byte;
    }
    if (selected < 0) return false;
    output.push(selected); return true;
  }
  if (node.kind !== "concat") return false;
  return node.children.every((child) => gitGrepLiteralNode(child, output));
}

function compileGitGrepMatcher(request: GitGrepRequest): GitGrepMatcher {
  if (request.patternMode === "fixed") {
    return { fixed: request.pattern, ignoreCase: request.ignoreCase, generation: 0 };
  }
  const tokens = tokenizeGitGrepRegex(request.pattern, request.patternMode, request.ignoreCase);
  const node = new GitGrepRegexParser(tokens).parse();
  const literal: number[] = [];
  if (gitGrepLiteralNode(node, literal)) {
    return { fixed: new Uint8Array(literal), ignoreCase: false, generation: 0 };
  }
  const { states, start } = new GitGrepRegexCompiler().compile(node);
  return {
    states,
    start,
    ignoreCase: false,
    marks: new Uint32Array(states.length),
    generation: 0,
  };
}

function gitGrepFold(byte: number): number {
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
}

function gitGrepFixedMatches(
  matcher: GitGrepMatcher,
  line: Uint8Array,
  budget: GitGrepStepBudget,
): boolean {
  const pattern = matcher.fixed!;
  if (!pattern.byteLength) return true;
  if (pattern.byteLength > line.byteLength) return false;
  const skip = new Uint32Array(256); skip.fill(pattern.byteLength);
  for (let index = 0; index + 1 < pattern.byteLength; index++) {
    const byte = matcher.ignoreCase ? gitGrepFold(pattern[index]) : pattern[index];
    skip[byte] = pattern.byteLength - index - 1;
  }
  let end = pattern.byteLength - 1;
  while (end < line.byteLength) {
    let offset = 0;
    while (offset < pattern.byteLength) {
      if (++budget.match > MAX_GREP_MATCH_STEPS) gitGrepFailure("matching step limit exceeded");
      const left = line[end - offset];
      const right = pattern[pattern.byteLength - 1 - offset];
      if ((matcher.ignoreCase ? gitGrepFold(left) : left) !==
          (matcher.ignoreCase ? gitGrepFold(right) : right)) break;
      offset++;
    }
    if (offset === pattern.byteLength) return true;
    const last = matcher.ignoreCase ? gitGrepFold(line[end]) : line[end];
    end += Math.max(1, skip[last]);
  }
  return false;
}

function gitGrepClosure(
  matcher: GitGrepMatcher,
  seeds: number[],
  position: number,
  length: number,
  budget: GitGrepStepBudget,
): number[] {
  const states = matcher.states!;
  const marks = matcher.marks!;
  matcher.generation++;
  if (matcher.generation === 0xffffffff) {
    marks.fill(0); matcher.generation = 1;
  }
  const generation = matcher.generation;
  const stack = seeds.slice();
  const output: number[] = [];
  while (stack.length) {
    const index = stack.pop()!;
    if (index < 0 || marks[index] === generation) continue;
    marks[index] = generation;
    if (++budget.match > MAX_GREP_MATCH_STEPS) gitGrepFailure("matching step limit exceeded");
    const state = states[index];
    if (state.op === "jump") stack.push(state.out);
    else if (state.op === "split") stack.push(state.out1, state.out);
    else if (state.op === "start") { if (position === 0) stack.push(state.out); }
    else if (state.op === "end") { if (position === length) stack.push(state.out); }
    else output.push(index);
  }
  return output;
}

function gitGrepRegexMatches(
  matcher: GitGrepMatcher,
  line: Uint8Array,
  budget: GitGrepStepBudget,
): boolean {
  let seeds = [matcher.start!];
  for (let position = 0; position <= line.byteLength; position++) {
    const current = gitGrepClosure(matcher, seeds, position, line.byteLength, budget);
    if (current.some((index) => matcher.states![index].op === "match")) return true;
    if (position === line.byteLength) return false;
    const next: number[] = [matcher.start!];
    for (const index of current) {
      const state = matcher.states![index];
      if (++budget.match > MAX_GREP_MATCH_STEPS) gitGrepFailure("matching step limit exceeded");
      if (state.op === "any" || state.op === "byte" && state.bytes[line[position]]) {
        next.push(state.out);
      }
    }
    seeds = next;
  }
  return false;
}

function gitGrepLineMatches(
  matcher: GitGrepMatcher,
  line: Uint8Array,
  budget: GitGrepStepBudget,
): boolean {
  return matcher.fixed
    ? gitGrepFixedMatches(matcher, line, budget)
    : gitGrepRegexMatches(matcher, line, budget);
}

type GitGrepGlobToken =
  | { kind: "literal"; byte: number }
  | { kind: "class"; bytes: Uint8Array }
  | { kind: "any" | "star" };

interface GitGrepPathspec {
  literal?: Uint8Array;
  tokens?: GitGrepGlobToken[];
}

function compileGitGrepPathspec(bytes: Uint8Array): GitGrepPathspec {
  const tokens: GitGrepGlobToken[] = [];
  let wildcard = false;
  for (let index = 0; index < bytes.byteLength;) {
    const byte = bytes[index];
    if (byte === 0x5c) {
      if (index + 1 >= bytes.byteLength) gitGrepFailure("invalid pathspec");
      tokens.push({ kind: "literal", byte: bytes[index + 1] }); index += 2;
    } else if (byte === 0x2a) {
      wildcard = true;
      if (tokens.at(-1)?.kind !== "star") tokens.push({ kind: "star" });
      index++;
    } else if (byte === 0x3f) {
      wildcard = true; tokens.push({ kind: "any" }); index++;
    } else if (byte === 0x5b) {
      wildcard = true;
      let token: { kind: "class"; bytes: Uint8Array };
      [token, index] = parseGitGrepClass(bytes, index, false);
      tokens.push(token);
    } else {
      tokens.push({ kind: "literal", byte }); index++;
    }
  }
  return wildcard ? { tokens } : { literal: new Uint8Array(tokens.map((token) =>
    token.kind === "literal" ? token.byte : 0
  )) };
}

function gitGrepBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function gitGrepLiteralPathSelected(path: Uint8Array, literal: Uint8Array): boolean {
  if (!literal.byteLength) return true;
  if (path.byteLength < literal.byteLength) return false;
  for (let index = 0; index < literal.byteLength; index++) if (path[index] !== literal[index]) return false;
  return path.byteLength === literal.byteLength || path[literal.byteLength] === 0x2f;
}

function gitGrepGlobSelected(
  path: Uint8Array,
  tokens: GitGrepGlobToken[],
  budget: GitGrepStepBudget,
): boolean {
  const close = (seeds: number[]): number[] => {
    const selected = new Uint8Array(tokens.length + 1);
    const stack = seeds.slice();
    const output: number[] = [];
    while (stack.length) {
      const index = stack.pop()!;
      if (selected[index]) continue;
      selected[index] = 1;
      output.push(index);
      if (++budget.pathspec > MAX_GREP_PATHSPEC_STEPS) gitGrepFailure("pathspec step limit exceeded");
      if (tokens[index]?.kind === "star") stack.push(index + 1);
    }
    return output;
  };
  let states = close([0]);
  for (const byte of path) {
    const next: number[] = [];
    for (const index of states) {
      const token = tokens[index];
      if (!token) continue;
      if (++budget.pathspec > MAX_GREP_PATHSPEC_STEPS) gitGrepFailure("pathspec step limit exceeded");
      if (token.kind === "star") next.push(index);
      else if (token.kind === "any" || token.kind === "literal" && token.byte === byte ||
               token.kind === "class" && token.bytes[byte]) next.push(index + 1);
    }
    states = close(next);
    if (!states.length) return false;
  }
  return close(states).includes(tokens.length);
}

function gitGrepPathSelected(
  path: Uint8Array,
  pathspecs: GitGrepPathspec[],
  budget: GitGrepStepBudget,
): boolean {
  return !pathspecs.length || pathspecs.some((pathspec) => pathspec.literal
    ? gitGrepLiteralPathSelected(path, pathspec.literal)
    : gitGrepGlobSelected(path, pathspec.tokens!, budget)
  );
}

interface GitGrepCandidate {
  repositoryPath: Uint8Array;
  displayPath: Uint8Array;
  worktreePath?: string;
  oid?: string;
}

interface GitGrepHistoricalBudget {
  entries: number;
  objects: number;
  treeBytes: number;
}

interface GitGrepSearchState {
  request: GitGrepRequest;
  matcher?: GitGrepMatcher;
  context: HostCommandContext;
  root: string;
  output: Uint8Array[];
  outputBytes: number;
  outputRecords: number;
  matches: number;
  totalFileBytes: number;
  found: boolean;
  stopped: boolean;
  budget: GitGrepStepBudget;
}

function gitGrepRepositoryRoot(context: HostCommandContext): string {
  let directory = normalizePath(context.cwd);
  let depth = 0;
  while (directory === "/home/web" || directory.startsWith("/home/web/")) {
    if (depth > MAX_GREP_DEPTH) gitGrepFailure("repository discovery depth exceeds 128");
    if (fsExists(context.py, `${directory}/.git`) && fsIsDir(context.py, `${directory}/.git`)) {
      return directory;
    }
    if (directory === "/home/web") break;
    directory = directory.slice(0, directory.lastIndexOf("/")) || "/";
    depth++;
  }
  gitGrepFailure("not a git worktree");
}

function gitGrepCwdPrefix(root: string, cwd: string): string {
  const normalized = normalizePath(cwd);
  if (normalized !== root && !normalized.startsWith(`${root}/`)) {
    gitGrepFailure("working directory is outside the worktree");
  }
  return normalized === root ? "" : normalized.slice(root.length + 1);
}

function splitGitGrepPath(path: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let start = 0;
  for (let index = 0; index <= path.byteLength; index++) {
    if (index < path.byteLength && path[index] !== 0x2f) continue;
    parts.push(path.slice(start, index)); start = index + 1;
  }
  return path.byteLength ? parts : [];
}

function relativeGitGrepPath(path: Uint8Array, cwdPrefix: Uint8Array): Uint8Array {
  const target = splitGitGrepPath(path);
  const baseParts = splitGitGrepPath(cwdPrefix);
  let common = 0;
  while (
    common < target.length && common < baseParts.length &&
    gitGrepBytesEqual(target[common], baseParts[common])
  ) common++;
  const parts: Uint8Array[] = [];
  for (let index = common; index < baseParts.length; index++) parts.push(encoder.encode(".."));
  parts.push(...target.slice(common));
  if (!parts.length) return encoder.encode(".");
  const length = parts.reduce((total, part) => total + part.byteLength, 0) + parts.length - 1;
  if (length > MAX_GREP_PATH_BYTES) gitGrepFailure("pathname exceeds 4096 bytes");
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    if (offset) output[offset++] = 0x2f;
    output.set(part, offset); offset += part.byteLength;
  }
  return output;
}

function normalizeGitGrepPathspecs(
  context: HostCommandContext,
  root: string,
  values: string[],
): GitGrepPathspec[] {
  return values.map((value) => {
    let absolute: string;
    try {
      absolute = workspacePath(context.cwd, value);
    } catch {
      gitGrepFailure("pathspec escapes the worktree");
    }
    if (absolute !== root && !absolute.startsWith(`${root}/`)) {
      gitGrepFailure("pathspec escapes the worktree");
    }
    const relative = absolute === root ? "" : absolute.slice(root.length + 1);
    if (relative === ".git" || relative.startsWith(".git/")) gitGrepFailure(".git pathspec is unavailable");
    const bytes = encoder.encode(relative);
    if (bytes.byteLength > MAX_GREP_PATH_BYTES) gitGrepFailure("pathspec exceeds 4096 bytes");
    try {
      return compileGitGrepPathspec(bytes);
    } catch {
      gitGrepFailure("invalid pathspec");
    }
  });
}

function gitGrepPathInDefaultScope(path: Uint8Array, cwdPrefix: Uint8Array): boolean {
  if (!cwdPrefix.byteLength) return true;
  if (path.byteLength <= cwdPrefix.byteLength) return false;
  for (let index = 0; index < cwdPrefix.byteLength; index++) {
    if (path[index] !== cwdPrefix[index]) return false;
  }
  return path[cwdPrefix.byteLength] === 0x2f;
}

function compareGitGrepCandidates(left: GitGrepCandidate, right: GitGrepCandidate): number {
  const a = left.repositoryPath, b = right.repositoryPath;
  const length = Math.min(a.byteLength, b.byteLength);
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.byteLength - b.byteLength;
}

function gitGrepIndexStat(context: HostCommandContext, path: string) {
  try {
    return context.py.FS.lstat(path);
  } catch (error) {
    if (checkIgnoreMissingError(error)) return undefined;
    gitGrepFailure("cannot inspect index");
  }
}

function gitGrepStageZeroModes(bytes: Uint8Array): Map<string, number> {
  if (bytes.byteLength < 32) gitGrepFailure("invalid index");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4);
  if (view.getUint32(0) !== 0x44495243 || (version !== 2 && version !== 3)) {
    gitGrepFailure("unsupported index format");
  }
  const count = view.getUint32(8);
  if (count > MAX_GREP_CANDIDATES) gitGrepFailure("more than 100000 candidate entries");
  const modes = new Map<string, number>();
  let offset = 12;
  const bodyEnd = bytes.byteLength - 20;
  const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
  for (let entry = 0; entry < count; entry++) {
    const start = offset;
    if (start + 63 > bodyEnd) gitGrepFailure("invalid index");
    const mode = view.getUint32(start + 24);
    const flags = view.getUint16(start + 60);
    const extended = Boolean(flags & 0x4000);
    if (extended && version !== 3) gitGrepFailure("invalid extended index entry");
    let nul = start + 62 + (extended ? 2 : 0);
    const pathStart = nul;
    while (nul < bodyEnd && bytes[nul] !== 0) nul++;
    if (nul === pathStart || nul >= bodyEnd) gitGrepFailure("invalid index pathname");
    const pathBytes = bytes.subarray(pathStart, nul);
    if (pathBytes.byteLength > MAX_GREP_PATH_BYTES) gitGrepFailure("pathname exceeds 4096 bytes");
    let path: string;
    try {
      path = fatalDecoder.decode(pathBytes);
    } catch {
      gitGrepFailure("index pathname is not valid UTF-8");
    }
    if (
      !path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")
    ) gitGrepFailure("invalid index pathname");
    if (((flags >>> 12) & 3) === 0) {
      if (modes.has(path)) gitGrepFailure("duplicate stage-0 index pathname");
      modes.set(path, mode);
    }
    const length = nul - start + 1;
    offset = start + Math.ceil(length / 8) * 8;
  }
  if (offset > bodyEnd) gitGrepFailure("invalid index");
  return modes;
}

async function collectGitGrepWorktreeCandidates(
  state: GitGrepSearchState,
  cwdPrefix: Uint8Array,
  pathspecs: GitGrepPathspec[],
): Promise<GitGrepCandidate[]> {
  const indexPath = `${state.root}/.git/index`;
  const indexStat = gitGrepIndexStat(state.context, indexPath);
  if (!indexStat) return [];
  if (indexStat.size > MAX_GREP_INDEX_BYTES) gitGrepFailure("index exceeds 16777216 bytes");
  let indexBytes: Uint8Array;
  try {
    indexBytes = state.context.py.FS.readFile(indexPath) as Uint8Array;
  } catch {
    gitGrepFailure("cannot read index");
  }
  const stageZeroModes = gitGrepStageZeroModes(indexBytes);
  let rows: Array<{ filepath: string; mode: number } | undefined>;
  try {
    rows = await isomorphicGit.walk({
      fs: gitFs(state.context),
      dir: state.root,
      trees: [isomorphicGit.STAGE()],
      map: async (filepath, [entry]) => {
        if (filepath === "." || !entry) return undefined;
        const mode = stageZeroModes.get(filepath);
        if (mode === undefined) return undefined;
        if (filepath.split("/").length > MAX_GREP_DEPTH) gitGrepFailure("candidate depth exceeds 128");
        const bytes = encoder.encode(filepath);
        if (bytes.byteLength > MAX_GREP_PATH_BYTES) gitGrepFailure("pathname exceeds 4096 bytes");
        if (await entry.type() !== "blob") return undefined;
        return mode === 0o100644 || mode === 0o100755 ? { filepath, mode } : undefined;
      },
    }) as Array<{ filepath: string; mode: number } | undefined>;
  } catch (error) {
    if (error instanceof GitGrepFailure) throw error;
    gitGrepFailure("cannot inspect index");
  }
  return rows.filter((row): row is { filepath: string; mode: number } => Boolean(row)).flatMap((row) => {
    const repositoryPath = encoder.encode(row.filepath);
    if (
      pathspecs.length
        ? !gitGrepPathSelected(repositoryPath, pathspecs, state.budget)
        : !gitGrepPathInDefaultScope(repositoryPath, cwdPrefix)
    ) return [];
    return [{
      repositoryPath,
      displayPath: relativeGitGrepPath(repositoryPath, cwdPrefix),
      worktreePath: `${state.root}/${row.filepath}`,
    }];
  }).sort(compareGitGrepCandidates);
}

async function readGitGrepHistoricalObject(
  state: GitGrepSearchState,
  oid: string,
  budget: GitGrepHistoricalBudget,
): Promise<{ type: string; object: Uint8Array }> {
  budget.objects++;
  if (budget.objects > MAX_GREP_OBJECTS) gitGrepFailure("historical object count exceeds 200000");
  let object: { type: string; object: Uint8Array };
  try {
    object = await isomorphicGit.readObject({
      fs: gitFs(state.context), dir: state.root, oid, format: "content",
    }) as { type: string; object: Uint8Array };
  } catch {
    gitGrepFailure("cannot read historical object");
  }
  if (!(object.object instanceof Uint8Array)) gitGrepFailure("invalid historical object");
  if (object.type !== "blob") {
    budget.treeBytes += object.object.byteLength;
    if (budget.treeBytes > MAX_GREP_TREE_BYTES) gitGrepFailure("historical tree decoding exceeds 16777216 bytes");
  }
  return object;
}

async function resolveGitGrepTree(
  state: GitGrepSearchState,
  revision: string,
  budget: GitGrepHistoricalBudget,
): Promise<{ oid: string; object: Uint8Array }> {
  let oid: string;
  try {
    oid = await resolveDiffRevision(state.context, state.root, revision);
  } catch {
    if (/^[0-9a-fA-F]{40}$/.test(revision)) oid = revision.toLowerCase();
    else {
      try {
        oid = await isomorphicGit.resolveRef({ fs: gitFs(state.context), dir: state.root, ref: revision });
      } catch {
        gitGrepFailure("invalid revision");
      }
    }
  }
  for (let depth = 0; depth <= 32; depth++) {
    const object = await readGitGrepHistoricalObject(state, oid, budget);
    if (object.type === "tree") return { oid, object: object.object };
    if (object.type === "blob") gitGrepFailure("revision does not resolve to a commit or tree");
    const next = object.type === "commit"
      ? lsTreeHeaderOid(object.object, "tree")
      : object.type === "tag" ? lsTreeHeaderOid(object.object, "object") : undefined;
    if (!next || depth === 32) gitGrepFailure("invalid revision object");
    oid = next;
  }
  gitGrepFailure("invalid revision");
}

function joinGitGrepTreePath(parent: Uint8Array, name: Uint8Array): Uint8Array {
  const length = parent.byteLength + (parent.byteLength ? 1 : 0) + name.byteLength;
  if (length > MAX_GREP_PATH_BYTES) gitGrepFailure("pathname exceeds 4096 bytes");
  const path = new Uint8Array(length);
  path.set(parent);
  let offset = parent.byteLength;
  if (offset) path[offset++] = 0x2f;
  path.set(name, offset);
  return path;
}

async function walkGitGrepTree(
  state: GitGrepSearchState,
  oid: string,
  parent: Uint8Array,
  depth: number,
  budget: GitGrepHistoricalBudget,
  output: Array<{ repositoryPath: Uint8Array; oid: string }>,
  decodedTree?: Uint8Array,
): Promise<void> {
  if (depth > MAX_GREP_DEPTH) gitGrepFailure("historical tree depth exceeds 128");
  let tree = decodedTree;
  if (!tree) {
    const object = await readGitGrepHistoricalObject(state, oid, budget);
    if (object.type !== "tree") gitGrepFailure("invalid historical tree");
    tree = object.object;
  }
  const cursor: RawTreeCursor = { bytes: tree, offset: 0, names: new Map() };
  try {
    for (;;) {
      const entry = nextRawTreeEntry(cursor);
      if (!entry) break;
      budget.entries++;
      if (budget.entries > MAX_GREP_CANDIDATES) gitGrepFailure("more than 100000 candidate entries");
      const path = joinGitGrepTreePath(parent, entry.name);
      if (entry.type === "tree") {
        await walkGitGrepTree(state, entry.oid, path, depth + 1, budget, output);
      } else if (entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755")) {
        output.push({ repositoryPath: path, oid: entry.oid });
      }
    }
  } catch (error) {
    if (error instanceof GitGrepFailure) throw error;
    gitGrepFailure("invalid historical tree");
  }
}

async function collectGitGrepHistoricalCandidates(
  state: GitGrepSearchState,
  cwdPrefix: Uint8Array,
  pathspecs: GitGrepPathspec[],
): Promise<GitGrepCandidate[]> {
  const budget: GitGrepHistoricalBudget = { entries: 0, objects: 0, treeBytes: 0 };
  const tree = await resolveGitGrepTree(state, state.request.revision!, budget);
  const raw: Array<{ repositoryPath: Uint8Array; oid: string }> = [];
  await walkGitGrepTree(state, tree.oid, new Uint8Array(), 1, budget, raw, tree.object);
  return raw.flatMap((entry) => {
    if (
      pathspecs.length
        ? !gitGrepPathSelected(entry.repositoryPath, pathspecs, state.budget)
        : !gitGrepPathInDefaultScope(entry.repositoryPath, cwdPrefix)
    ) return [];
    return [{
      ...entry,
      displayPath: relativeGitGrepPath(entry.repositoryPath, cwdPrefix),
    }];
  }).sort(compareGitGrepCandidates);
}

function readGitGrepWorktreeFile(
  state: GitGrepSearchState,
  path: string,
): Uint8Array | undefined {
  let stat;
  try {
    stat = state.context.py.FS.lstat(path);
  } catch (error) {
    if (checkIgnoreMissingError(error)) return undefined;
    gitGrepFailure("cannot inspect worktree file");
  }
  if ((stat.mode & 0xf000) !== 0x8000 || state.context.py.FS.isLink?.(stat.mode)) return undefined;
  if (stat.size > MAX_GREP_FILE_BYTES) gitGrepFailure("file exceeds 8388608 bytes");
  let bytes: Uint8Array;
  try {
    bytes = state.context.py.FS.readFile(path) as Uint8Array;
  } catch {
    gitGrepFailure("cannot read worktree file");
  }
  if (bytes.byteLength > MAX_GREP_FILE_BYTES) gitGrepFailure("file exceeds 8388608 bytes");
  return bytes;
}

async function readGitGrepCandidate(
  state: GitGrepSearchState,
  candidate: GitGrepCandidate,
): Promise<Uint8Array | undefined> {
  let bytes: Uint8Array | undefined;
  if (candidate.worktreePath) bytes = readGitGrepWorktreeFile(state, candidate.worktreePath);
  else {
    let object: { type: string; object: Uint8Array };
    try {
      object = await isomorphicGit.readObject({
        fs: gitFs(state.context), dir: state.root, oid: candidate.oid!, format: "content",
      }) as { type: string; object: Uint8Array };
    } catch {
      gitGrepFailure("cannot read historical blob");
    }
    if (object.type !== "blob" || !(object.object instanceof Uint8Array)) {
      gitGrepFailure("invalid historical blob");
    }
    bytes = object.object;
    if (bytes.byteLength > MAX_GREP_FILE_BYTES) gitGrepFailure("file exceeds 8388608 bytes");
  }
  if (!bytes) return undefined;
  state.totalFileBytes += bytes.byteLength;
  if (state.totalFileBytes > MAX_GREP_TOTAL_FILE_BYTES) {
    gitGrepFailure("cumulative file bytes exceed 67108864");
  }
  return bytes;
}

function gitGrepIdentifier(state: GitGrepSearchState, candidate: GitGrepCandidate): Uint8Array {
  if (!state.request.revision) return candidate.displayPath;
  const prefix = encoder.encode(`${state.request.revision}:`);
  return concatTreeBytes([prefix, candidate.displayPath], prefix.byteLength + candidate.displayPath.byteLength);
}

function appendGitGrepOutput(state: GitGrepSearchState, parts: Uint8Array[]): void {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  if (length > MAX_GREP_OUTPUT_BYTES - state.outputBytes) gitGrepFailure("output exceeds 1000000 bytes");
  state.output.push(concatTreeBytes(parts, length));
  state.outputBytes += length;
  state.outputRecords++;
  if (state.request.maxResults !== undefined && state.outputRecords >= state.request.maxResults) {
    state.stopped = true;
  }
}

function recordGitGrepMatch(state: GitGrepSearchState): void {
  state.matches++;
  if (state.matches > MAX_GREP_MATCHES) gitGrepFailure("more than 100000 matches");
  state.found = true;
}

function emitGitGrepName(state: GitGrepSearchState, identifier: Uint8Array): void {
  appendGitGrepOutput(state, [identifier, new Uint8Array([state.request.nul ? 0 : 0x0a])]);
}

function emitGitGrepBinary(state: GitGrepSearchState, identifier: Uint8Array): void {
  if (state.request.nul) {
    appendGitGrepOutput(state, [identifier, new Uint8Array([0]), encoder.encode("binary\0")]);
  } else {
    appendGitGrepOutput(state, [encoder.encode("Binary file "), identifier, encoder.encode(" matches\n")]);
  }
}

function emitGitGrepLine(
  state: GitGrepSearchState,
  identifier: Uint8Array,
  line: Uint8Array,
  lineNumber: number,
): void {
  if (state.request.nul) {
    const parts = [identifier, new Uint8Array([0])];
    if (state.request.lineNumber) parts.push(encoder.encode(`${lineNumber}\0`));
    parts.push(line, new Uint8Array([0]));
    appendGitGrepOutput(state, parts);
  } else {
    const prefix = state.request.lineNumber ? `:${lineNumber}:` : ":";
    appendGitGrepOutput(state, [identifier, encoder.encode(prefix), line, new Uint8Array([0x0a])]);
  }
}

function searchGitGrepCandidate(
  state: GitGrepSearchState,
  candidate: GitGrepCandidate,
  bytes: Uint8Array,
): void {
  const identifier = gitGrepIdentifier(state, candidate);
  const binary = bytes.includes(0);
  let start = 0;
  let lineNumber = 1;
  const searchLine = (line: Uint8Array): boolean => {
    if (!gitGrepLineMatches(state.matcher!, line, state.budget)) return false;
    recordGitGrepMatch(state);
    if (state.request.quiet) {
      state.stopped = true; return true;
    }
    if (state.request.filesWithMatches) emitGitGrepName(state, identifier);
    else if (binary) emitGitGrepBinary(state, identifier);
    else emitGitGrepLine(state, identifier, line, lineNumber);
    return state.request.filesWithMatches || binary || state.stopped;
  };
  for (let offset = 0; offset < bytes.byteLength; offset++) {
    if (bytes[offset] !== 0x0a) continue;
    if (searchLine(bytes.subarray(start, offset))) return;
    start = offset + 1; lineNumber++;
  }
  if (!state.stopped && start < bytes.byteLength) searchLine(bytes.subarray(start));
}

async function runGitGrep(
  context: HostCommandContext,
  args: string[],
): Promise<HostCommandResult> {
  try {
    if (context.args.length > 127) gitGrepFailure("more than 127 argv entries");
    const request = parseGitGrepArgs(args);
    const root = gitGrepRepositoryRoot(context);
    const cwdPrefix = encoder.encode(gitGrepCwdPrefix(root, context.cwd));
    const state: GitGrepSearchState = {
      request,
      context,
      root,
      output: [],
      outputBytes: 0,
      outputRecords: 0,
      matches: 0,
      totalFileBytes: 0,
      found: false,
      stopped: false,
      budget: { match: 0, pathspec: 0 },
    };
    const pathspecs = normalizeGitGrepPathspecs(context, root, request.pathspecs);
    const candidates = request.revision
      ? await collectGitGrepHistoricalCandidates(state, cwdPrefix, pathspecs)
      : await collectGitGrepWorktreeCandidates(state, cwdPrefix, pathspecs);
    state.matcher = compileGitGrepMatcher(request);
    for (const candidate of candidates) {
      if (state.stopped) break;
      const bytes = await readGitGrepCandidate(state, candidate);
      if (bytes) searchGitGrepCandidate(state, candidate, bytes);
    }
    if (!state.found) return result(1, "");
    if (request.quiet) return result(0, "");
    return {
      exitCode: 0,
      stdout: concatTreeBytes(state.output, state.outputBytes),
    };
  } catch (error) {
    const message = error instanceof GitGrepFailure ? error.message : "repository inspection failed";
    return errorResult(2, `git grep: ${message}\n`);
  }
}

async function headId(context: HostCommandContext, cwd: string): Promise<string> {
  const resolved = await invoke(context, ["rev-parse", "HEAD"], cwd);
  if (resolved.exitCode !== 0) throw new Error(`${resolved.stdout}${resolved.stderr}`.trim());
  return resolved.stdout.trim();
}

type ExactStatusRow = [string, number, number, number];

async function statusMatrix(
  context: HostCommandContext,
  cwd: string,
  options: { filepaths?: string[]; ignored?: boolean; hideIntentToAdd?: boolean } = {},
): Promise<ExactStatusRow[]> {
  const fs = gitFs(context, { hideIntentToAdd: options.hideIntentToAdd });
  let hasHead = true;
  try {
    await isomorphicGit.resolveRef({ fs, dir: cwd, ref: "HEAD" });
  } catch {
    hasHead = false;
  }
  const trees: ReturnType<typeof isomorphicGit.TREE>[] = hasHead
    ? [
      isomorphicGit.TREE({ ref: "HEAD" }),
      isomorphicGit.WORKDIR() as ReturnType<typeof isomorphicGit.TREE>,
      isomorphicGit.STAGE() as ReturnType<typeof isomorphicGit.TREE>,
    ]
    : [
      isomorphicGit.WORKDIR() as ReturnType<typeof isomorphicGit.TREE>,
      isomorphicGit.STAGE() as ReturnType<typeof isomorphicGit.TREE>,
    ];
  const selectors = options.filepaths ?? ["."];
  const rows = await isomorphicGit.walk({
    fs,
    dir: cwd,
    trees,
    map: async (filepath, entries) => {
      if (
        filepath === "." || filepath === ".git" || filepath.startsWith(".git/") ||
        !diffPathSelected(filepath, selectors)
      ) return undefined;
      const head = hasHead ? entries[0] : undefined;
      const worktree = entries[hasHead ? 1 : 0];
      const stage = entries[hasHead ? 2 : 1];
      if (!head && !stage && worktree && !options.ignored && await isomorphicGit.isIgnored({
        fs, dir: cwd, filepath,
      })) return undefined;
      const [headType, worktreeType, stageType] = await Promise.all([
        head?.type(), worktree?.type(), stage?.type(),
      ]);
      const isBlob = [headType, worktreeType, stageType].includes("blob");
      if ((headType === "tree" || headType === "special") && !isBlob) return undefined;
      if (headType === "commit") return undefined;
      if ((worktreeType === "tree" || worktreeType === "special") && !isBlob) return undefined;
      if (stageType === "commit") return undefined;
      if ((stageType === "tree" || stageType === "special") && !isBlob) return undefined;

      const headIdentity = head && headType === "blob"
        ? `${await head.mode()}:${await head.oid()}`
        : undefined;
      const stageIdentity = stage && stageType === "blob"
        ? `${await stage.mode()}:${await stage.oid()}`
        : undefined;
      let worktreeIdentity: string | undefined;
      if (worktree && worktreeType === "blob") {
        const content = await worktree.content();
        if (content) {
          const { oid } = await isomorphicGit.hashBlob({ object: content });
          worktreeIdentity = `${await worktree.mode()}:${oid}`;
        }
      }
      const identities = [undefined, headIdentity, worktreeIdentity, stageIdentity];
      return [
        filepath,
        identities.indexOf(headIdentity),
        identities.indexOf(worktreeIdentity),
        identities.indexOf(stageIdentity),
      ] as ExactStatusRow;
    },
  }) as Array<ExactStatusRow | undefined>;
  return rows.filter((row): row is ExactStatusRow => Boolean(row));
}

async function isClean(context: HostCommandContext, cwd: string): Promise<boolean> {
  return (await statusMatrix(context, cwd)).every(([, head, workdir, stage]) =>
    head === workdir && workdir === stage
  );
}

async function hasStagedChanges(context: HostCommandContext, cwd: string): Promise<boolean> {
  return (await statusMatrix(context, cwd, { hideIntentToAdd: true }))
    .some(([, head, , stage]) => head !== stage);
}

interface AddIntentCandidate {
  path: string;
  mode: number;
  identity: string;
}

let addIntentScratchSequence = 0;

function preflightAddIntentAncestry(
  context: HostCommandContext,
  root: string,
  path: string,
): void {
  let parent = root;
  for (const part of path.split("/").slice(0, -1)) {
    parent += `/${part}`;
    const stat = worktreeStat(context, parent);
    if (!stat) throw new Error(`add -N parent disappeared: ${quoteDiffPath(path)}`);
    if (context.py.FS.isLink?.(stat.mode)) {
      throw new GitUsageError(`add -N refuses symlink ancestry at ${quoteDiffPath(path)}`);
    }
    if (!context.py.FS.isDir(stat.mode)) {
      throw new GitUsageError(`add -N ancestry is not a directory at ${quoteDiffPath(path)}`);
    }
  }
}

function addIntentCandidate(
  context: HostCommandContext,
  root: string,
  path: string,
): AddIntentCandidate {
  preflightAddIntentAncestry(context, root, path);
  const stat = worktreeStat(context, `${root}/${path}`);
  if (!stat || context.py.FS.isDir(stat.mode)) {
    throw new Error(`add -N candidate disappeared: ${quoteDiffPath(path)}`);
  }
  const link = Boolean(context.py.FS.isLink?.(stat.mode));
  const regular = (stat.mode & 0xf000) === 0x8000;
  if (!link && !regular) {
    throw new GitUsageError(`add -N does not support this file type: ${quoteDiffPath(path)}`);
  }
  return {
    path,
    mode: link ? 0o120000 : (stat.mode & 0o111) !== 0 ? 0o100755 : 0o100644,
    identity: cleanLeafIdentity(stat),
  };
}

function commitAddIntentIndex(
  context: HostCommandContext,
  root: string,
  snapshot: Uint8Array,
  hadIndex: boolean,
  staged: Uint8Array,
): void {
  const indexPath = `${root}/.git/index`;
  if (fsExists(context.py, `${indexPath}.lock`)) {
    throw new Error("add -N cannot acquire the index lock");
  }
  const current = fsExists(context.py, indexPath)
    ? new Uint8Array(context.py.FS.readFile(indexPath) as Uint8Array)
    : new Uint8Array();
  if (!equalBytes(current, snapshot)) throw new Error("add -N index changed during the operation");
  try {
    context.py.FS.writeFile(indexPath, staged);
  } catch (error) {
    try {
      if (hadIndex) context.py.FS.writeFile(indexPath, snapshot);
      else if (fsExists(context.py, indexPath)) context.py.FS.unlink(indexPath);
    } catch { /* preserve the original publication error */ }
    throw error;
  }
}

async function runAddIntent(
  context: HostCommandContext,
  root: string,
  operands: string[],
): Promise<HostCommandResult> {
  if (!operands.length) throw new GitUsageError("add -N requires at least one path");
  if (operands.length > MAX_ADD_INTENT_PATHS) {
    throw new GitUsageError(`add -N accepts at most ${MAX_ADD_INTENT_PATHS} paths`);
  }
  let totalBytes = 0;
  const selectors = new Set<string>();
  for (const operand of operands) {
    const bytes = showRefUtf8Bytes(operand);
    if (!operand || operand.includes("\0") || !bytes) {
      throw new GitUsageError("add -N paths must be nonempty UTF-8 without NUL");
    }
    if (bytes.byteLength > MAX_ADD_INTENT_PATH_BYTES) {
      throw new GitUsageError(`add -N path exceeds ${MAX_ADD_INTENT_PATH_BYTES} bytes`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_ADD_INTENT_TOTAL_PATH_BYTES) {
      throw new GitUsageError(
        `add -N paths exceed ${MAX_ADD_INTENT_TOTAL_PATH_BYTES} aggregate bytes`,
      );
    }
    let path: string;
    try {
      path = pathFromRepository(root, context.cwd, operand);
    } catch {
      throw new GitUsageError("add -N path escapes the worktree");
    }
    if (path === "." || path.split("/").length > MAX_ADD_INTENT_DEPTH) {
      if (path !== ".") {
        throw new GitUsageError(`add -N path has more than ${MAX_ADD_INTENT_DEPTH} components`);
      }
    }
    if (path === ".git" || path.startsWith(".git/")) {
      throw new GitUsageError("add -N cannot select the Git directory");
    }
    selectors.add(path);
  }

  const indexPath = `${root}/.git/index`;
  if (fsExists(context.py, `${indexPath}.lock`)) {
    throw new Error("add -N cannot acquire the index lock");
  }
  const metadata = readRmIndexMetadata(context, root, "add -N");
  if (metadata.snapshot.byteLength > MAX_ADD_INTENT_INDEX_BYTES) {
    throw new GitUsageError(`add -N index exceeds ${MAX_ADD_INTENT_INDEX_BYTES} bytes`);
  }
  if (metadata.entries > MAX_ADD_INTENT_INDEX_ENTRIES) {
    throw new GitUsageError(
      `add -N index entry limit exceeded (${MAX_ADD_INTENT_INDEX_ENTRIES})`,
    );
  }
  if (metadata.unmerged) throw new Error("add -N refuses an unmerged index");

  const rows = await statusMatrix(context, root, { ignored: true });
  if (rows.length > MAX_ADD_INTENT_CANDIDATES) {
    throw new GitUsageError(
      `add -N candidate entry limit exceeded (${MAX_ADD_INTENT_CANDIDATES})`,
    );
  }
  const selected = (path: string, selector: string) =>
    selector === "." || path === selector || path.startsWith(`${selector}/`);
  const ignored = new Map<string, boolean>();
  const isIgnored = async (path: string): Promise<boolean> => {
    const known = ignored.get(path);
    if (known !== undefined) return known;
    const value = await isomorphicGit.isIgnored({ fs: gitFs(context), dir: root, filepath: path });
    ignored.set(path, value);
    return value;
  };
  const candidatePaths = new Set<string>();
  for (const selector of selectors) {
    const matches = rows.filter(([path]) => selected(path, selector));
    if (!matches.length) throw new Error(`pathspec '${selector}' did not match any files`);
    let nonignored = false;
    for (const [path, head, workdir, stage] of matches) {
      if (head !== 0 || stage !== 0) {
        nonignored = true;
        continue;
      }
      if (workdir === 0) continue;
      if (await isIgnored(path)) continue;
      nonignored = true;
      candidatePaths.add(path);
    }
    if (!nonignored) throw new Error(`path is ignored: ${selector}`);
  }
  if (metadata.entries + candidatePaths.size > MAX_ADD_INTENT_INDEX_ENTRIES) {
    throw new GitUsageError(
      `add -N resulting index entry limit exceeded (${MAX_ADD_INTENT_INDEX_ENTRIES})`,
    );
  }
  const candidates = [...candidatePaths].sort(compareRmPaths)
    .map((path) => addIntentCandidate(context, root, path));
  if (!candidates.length) return result(0, "");

  let scratch: string;
  do {
    scratch = `${root}/.git/piodide-add-intent-index-${++addIntentScratchSequence}`;
  } while (fsExists(context.py, scratch));
  context.py.FS.mkdir(scratch);
  const hadIndex = fsExists(context.py, indexPath);
  try {
    if (hadIndex) context.py.FS.writeFile(`${scratch}/index`, metadata.snapshot);
    const fs = gitFs(context);
    const oid = await isomorphicGit.writeBlob({ fs, dir: root, blob: new Uint8Array() });
    if (oid !== EMPTY_BLOB_OID) throw new Error("add -N could not create the canonical empty blob");
    const cache = {};
    for (const candidate of candidates) {
      await isomorphicGit.updateIndex({
        fs,
        dir: root,
        gitdir: scratch,
        cache,
        filepath: candidate.path,
        oid: EMPTY_BLOB_OID,
        mode: candidate.mode,
        add: true,
      });
    }
    let staged = new Uint8Array(context.py.FS.readFile(`${scratch}/index`) as Uint8Array);
    staged = new Uint8Array(
      await markGitIndexIntentToAdd(staged, new Set(candidates.map(({ path }) => path))),
    );
    if (staged.byteLength > MAX_ADD_INTENT_INDEX_BYTES) {
      throw new GitUsageError(`add -N resulting index exceeds ${MAX_ADD_INTENT_INDEX_BYTES} bytes`);
    }
    for (const candidate of candidates) {
      const current = addIntentCandidate(context, root, candidate.path);
      if (current.mode !== candidate.mode || current.identity !== candidate.identity) {
        throw new Error(`add -N worktree changed during the operation: ${quoteDiffPath(candidate.path)}`);
      }
    }
    commitAddIntentIndex(context, root, metadata.snapshot, hadIndex, staged);
  } finally {
    removeRmIndexScratch(context, scratch);
  }
  return result(0, "");
}

async function runAdd(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  const paths: string[] = [];
  const operands: string[] = [];
  let all = false;
  let update = false;
  let intentToAdd = false;
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
    if (options && (arg === "-u" || arg === "--update")) {
      update = true;
      continue;
    }
    if (options && (arg === "-N" || arg === "--intent-to-add")) {
      intentToAdd = true;
      continue;
    }
    if (options && arg.startsWith("-")) throw new GitUsageError(`unsupported add option: ${arg}`);
    operands.push(arg);
  }
  if (intentToAdd) {
    if (all || update) throw new GitUsageError("add -N is incompatible with -A and -u");
    return runAddIntent(context, root, operands);
  }
  for (const operand of operands) paths.push(pathFromRepository(root, context.cwd, operand));
  if (!all && !update && !paths.length) {
    throw new GitUsageError("add requires at least one path (use -A, -u, or .)");
  }
  if (all && update) throw new GitUsageError("add -A and -u are mutually exclusive");
  const requested = paths.length ? paths : ["."];
  const selected = (filepath: string, path: string) =>
    path === "." || filepath === path || filepath.startsWith(`${path}/`);
  const matrix = await statusMatrix(context, root);
  for (const path of requested) {
    if (path === "." || matrix.some(([filepath]) => selected(filepath, path))) continue;
    const ignored = await isomorphicGit.isIgnored({ fs: gitFs(context), dir: root, filepath: path });
    if (ignored) throw new Error(`path is ignored: ${path}`);
    throw new Error(`pathspec '${path}' did not match any files`);
  }
  const fs = gitFs(context);
  for (const [filepath, head, workdir, stage] of matrix) {
    if (!requested.some((path) => selected(filepath, path))) continue;
    if (update && head === 0 && stage === 0) continue;
    if (workdir === stage) continue;
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

interface BranchListingRow {
  branch: string;
  oid: string;
  remote: boolean;
}

interface BranchUpstream {
  label: string;
  ref: string;
}

interface BranchUpstreamDisplay extends BranchUpstream {
  ahead?: number;
  behind?: number;
  gone?: boolean;
}

class BranchListingLimitError extends Error {}

function effectiveConfig(
  py: Pyodide,
  root: string,
  globalPath = "/home/web/.gitconfig",
): Map<string, string> {
  const values = new Map<string, string>();
  for (const { key, value } of configEntries(py, root, globalPath)) values.set(key.toLowerCase(), value);
  return values;
}

function configuredBranchUpstream(
  config: Map<string, string>,
  branch: string,
): BranchUpstream | undefined {
  const remote = config.get(`branch.${branch}.remote`.toLowerCase());
  const merge = config.get(`branch.${branch}.merge`.toLowerCase());
  const prefix = "refs/heads/";
  if (!remote || !merge?.startsWith(prefix)) return undefined;
  const name = merge.slice(prefix.length);
  try {
    assertBranchName(name);
  } catch {
    return undefined;
  }
  return remote === "."
    ? { label: name, ref: `refs/heads/${name}` }
    : { label: `${remote}/${name}`, ref: `refs/remotes/${remote}/${name}` };
}

async function branchReachableCommits(
  context: HostCommandContext,
  root: string,
  start: string,
  union: Set<string>,
): Promise<Set<string>> {
  const reachable = new Set<string>();
  const pending = [start];
  while (pending.length) {
    const oid = pending.pop()!;
    if (reachable.has(oid)) continue;
    reachable.add(oid);
    if (!union.has(oid)) {
      if (union.size >= MAX_BRANCH_DIVERGENCE_COMMITS) {
        throw new BranchListingLimitError(
          `upstream divergence exceeds ${MAX_BRANCH_DIVERGENCE_COMMITS} commits`,
        );
      }
      union.add(oid);
    }
    const entry = await isomorphicGit.readCommit({ fs: gitFs(context), dir: root, oid })
      .catch(() => undefined);
    if (entry) pending.push(...entry.commit.parent);
  }
  return reachable;
}

async function branchDivergence(
  context: HostCommandContext,
  root: string,
  localOid: string,
  upstreamOid: string,
): Promise<{ ahead: number; behind: number }> {
  const union = new Set<string>();
  const local = await branchReachableCommits(context, root, localOid, union);
  const upstream = await branchReachableCommits(context, root, upstreamOid, union);
  let ahead = 0;
  let behind = 0;
  for (const oid of local) if (!upstream.has(oid)) ahead++;
  for (const oid of upstream) if (!local.has(oid)) behind++;
  return { ahead, behind };
}

function formatBranchUpstream(upstream: BranchUpstreamDisplay): string {
  if (upstream.gone) return `[${upstream.label}: gone]`;
  const divergence = [
    ...(upstream.ahead ? [`ahead ${upstream.ahead}`] : []),
    ...(upstream.behind ? [`behind ${upstream.behind}`] : []),
  ].join(", ");
  return `[${upstream.label}${divergence ? `: ${divergence}` : ""}]`;
}

async function renderBranchListing(
  context: HostCommandContext,
  root: string,
  current: string | null,
  rows: BranchListingRow[],
  verbosity: number,
): Promise<HostCommandResult> {
  if (!verbosity) {
    return result(0, rows.map(({ branch, remote }) =>
      `${!remote && branch === current ? "*" : " "} ${branch}\n`
    ).join(""));
  }
  const config = effectiveConfig(context.py, root, globalConfigPath(context));
  const upstreams = verbosity === 2
    ? rows.flatMap((row) => {
      if (row.remote) return [];
      const upstream = configuredBranchUpstream(config, row.branch);
      return upstream ? [{ row, upstream }] : [];
    })
    : [];
  if (upstreams.length > MAX_BRANCH_UPSTREAMS) {
    return errorResult(2, `git branch: refusing to inspect more than ${MAX_BRANCH_UPSTREAMS} upstreams\n`);
  }
  const upstreamDisplay = new Map<string, BranchUpstreamDisplay>();
  const divergenceCache = new Map<string, { ahead: number; behind: number }>();
  try {
    for (const { row, upstream } of upstreams) {
      let upstreamOid: string;
      try {
        upstreamOid = await isomorphicGit.resolveRef({
          fs: gitFs(context), dir: root, ref: upstream.ref,
        });
      } catch {
        upstreamDisplay.set(row.branch, { ...upstream, gone: true });
        continue;
      }
      const key = `${row.oid}\0${upstreamOid}`;
      let divergence = divergenceCache.get(key);
      if (!divergence) {
        divergence = await branchDivergence(context, root, row.oid, upstreamOid);
        divergenceCache.set(key, divergence);
      }
      upstreamDisplay.set(row.branch, { ...upstream, ...divergence });
    }
  } catch (error) {
    if (error instanceof BranchListingLimitError) {
      return errorResult(2, `git branch: ${error.message}\n`);
    }
    throw error;
  }

  const width = rows.reduce((maximum, row) => Math.max(maximum, row.branch.length), 0);
  const output: string[] = [];
  for (const row of rows) {
    const { commit } = await isomorphicGit.readCommit({
      fs: gitFs(context), dir: root, oid: row.oid,
    });
    const subject = commit.message.split(/\r?\n/, 1)[0];
    const upstream = upstreamDisplay.get(row.branch);
    output.push(
      `${!row.remote && row.branch === current ? "*" : " "} ${row.branch.padEnd(width)} ` +
        `${row.oid.slice(0, 7)}${upstream ? ` ${formatBranchUpstream(upstream)}` : ""} ${subject}\n`,
    );
  }
  return result(0, output.join(""));
}

async function runBranch(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const cwd = repositoryRoot(context.py, context.cwd);
  currentBranch(context.py, cwd);
  let deletion = false;
  let forceDelete = false;
  let rename = false;
  let all = false;
  let remotesOnly = false;
  let verbosity = 0;
  let showCurrent = false;
  let list = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "-d" || arg === "--delete") deletion = true;
    else if (arg === "-D") {
      deletion = true;
      forceDelete = true;
    } else if (arg === "-m" || arg === "--move") rename = true;
    else if (arg === "--all") all = true;
    else if (arg === "--remotes") remotesOnly = true;
    else if (arg === "--verbose") verbosity++;
    else if (/^-[arv]+$/.test(arg)) {
      for (const option of arg.slice(1)) {
        if (option === "a") all = true;
        else if (option === "r") remotesOnly = true;
        else verbosity++;
      }
    }
    else if (arg === "--show-current") showCurrent = true;
    else if (arg === "--list") list = true;
    else if (arg.startsWith("-")) throw new GitUsageError(`unsupported branch option: ${arg}`);
    else positional.push(arg);
  }
  if (verbosity > 2) throw new GitUsageError("branch verbosity may be specified at most twice");
  const listing = all || remotesOnly || verbosity > 0 || list;
  const actions = Number(deletion) + Number(rename) + Number(showCurrent);
  if (actions > 1) throw new GitUsageError("branch action options are mutually exclusive");
  if (showCurrent) {
    if (listing || positional.length) {
      throw new GitUsageError("branch --show-current accepts no other options or operands");
    }
    const branch = currentBranch(context.py, cwd);
    return result(0, branch ? `${branch}\n` : "");
  }
  if (rename) {
    if (listing) throw new GitUsageError("branch -m/--move cannot be combined with listing options");
    if (positional.length < 1 || positional.length > 2) {
      throw new GitUsageError("branch -m/--move accepts [old-name] new-name");
    }
    const oldName = positional.length === 2 ? positional[0] : currentBranch(context.py, cwd);
    const newName = positional.at(-1)!;
    if (!oldName) throw new Error("cannot rename a detached HEAD");
    assertBranchName(oldName);
    assertBranchName(newName);
    await isomorphicGit.renameBranch({ fs: gitFs(context), dir: cwd, oldref: oldName, ref: newName });
    return result(0, "");
  }
  if (deletion) {
    if (listing) throw new GitUsageError("branch -d/--delete cannot be combined with listing options");
    if (positional.length !== 1) {
      throw new GitUsageError("branch -d/-D/--delete requires exactly one branch name");
    }
  } else if (listing && positional.length) {
    throw new GitUsageError("bounded branch listing does not accept patterns");
  } else if (positional.length > 2) {
    throw new GitUsageError("branch accepts a branch name and optional start-point");
  }
  const name = positional[0];
  if (!name) {
    const current = currentBranch(context.py, cwd);
    const branches = packedBranches(context.py, cwd);
    for (const [branch, oid] of looseBranches(context.py, cwd)) branches.set(branch, oid);
    const local = remotesOnly && !all
      ? []
      : [...branches].map(([branch, oid]) => ({ branch, oid, remote: false }));
    const remoteBranches: Array<{ remote: string; branch: string }> = [];
    if ((all || remotesOnly) && !isGitHubRemoteRepository(context.py, cwd)) {
      for (const { remote } of await isomorphicGit.listRemotes({ fs: gitFs(context), dir: cwd })) {
        const names = await isomorphicGit.listBranches({ fs: gitFs(context), dir: cwd, remote }).catch(() => []);
        remoteBranches.push(...names.map((branch) => ({ remote, branch })));
      }
    }
    const remote: BranchListingRow[] = [];
    for (const { remote: remoteName, branch } of remoteBranches) {
      const ref = `refs/remotes/${remoteName}/${branch}`;
      const oid = await isomorphicGit.resolveRef({ fs: gitFs(context), dir: cwd, ref });
      remote.push({ branch: `remotes/${remoteName}/${branch}`, oid, remote: true });
    }
    const rows = [...local, ...remote].sort((a, b) => a.branch.localeCompare(b.branch));
    return renderBranchListing(context, cwd, current, rows, verbosity);
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
  const checkoutRef = detach ? await resolveDiffRevision(context, root, ref) : ref;
  await isomorphicGit.checkout({
    fs: gitFs(context),
    dir: root,
    ref: checkoutRef,
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
  const url = remoteUrl(context.py, cwd, remote, globalConfigPath(context));
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
    const url = remoteUrl(context.py, cwd, remote, globalConfigPath(context));
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
    const url = remoteUrl(context.py, cwd, remote, globalConfigPath(context));
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
  const url = root && !isHttpRemote(target)
    ? remoteUrl(context.py, root, target, globalConfigPath(context))
    : target;
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
  let scope: "global" | "local" | undefined;
  let operation: "list" | "get" | "unset" | undefined;
  const operands: string[] = [];
  let options = true;
  for (const arg of args) {
    if (options && arg === "--") { options = false; continue; }
    if (options && (arg === "--global" || arg === "--local")) {
      const selected = arg.slice(2) as "global" | "local";
      if (scope === selected) throw new GitUsageError(`config scope option repeated: ${arg}`);
      if (scope) throw new GitUsageError("config --global and --local are mutually exclusive");
      scope = selected; continue;
    }
    if (options && (arg === "--list" || arg === "-l" || arg === "--get" || arg === "--unset")) {
      const selected = arg === "--list" || arg === "-l" ? "list" : arg.slice(2) as "get" | "unset";
      if (operation) throw new GitUsageError("config operation options are mutually exclusive");
      operation = selected; continue;
    }
    if (options && arg.startsWith("-")) {
      throw new GitUsageError(`unsupported config option: ${arg}`);
    }
    options = false;
    operands.push(arg);
  }
  if (operation === "list" && operands.length) {
    throw new GitUsageError("config --list accepts no operands");
  }
  if ((operation === "get" || operation === "unset") && operands.length !== 1) {
    throw new GitUsageError(`config --${operation} requires exactly one name`);
  }
  if (!operation && operands.length > 2) throw new GitUsageError(COMMAND_HELP.config.trim());
  const key = operation === "get" || operation === "unset"
    ? operands[0]
    : operands.length ? operands[0] : undefined;
  if (key !== undefined) assertConfigKey(key);

  const needsGlobalConfig = scope === "global" || (
    scope === undefined && operation !== "unset" && !(!operation && operands.length === 2)
  );
  const globalPath = needsGlobalConfig ? globalConfigPath(context) : "/home/web/.gitconfig";
  let root: string | undefined;
  try { root = repositoryRoot(context.py, context.cwd); } catch { /* global config only */ }
  if (scope === "local" && !root) throw new Error("not a Git repository");
  if (operation === "unset") {
    const path = scope === "global"
      ? globalPath
      : root ? `${root}/.git/config` : undefined;
    if (!path) throw new Error("not a Git repository (use --global outside one)");
    return unsetConfigFile(context.py, path, key!);
  }

  const storedEntries = scope === "global"
    ? (fsExists(context.py, globalPath) ? parseConfig(fsReadText(context.py, globalPath)) : [])
    : scope === "local"
      ? parseConfig(fsReadText(context.py, `${root}/.git/config`))
      : configEntries(context.py, root, globalPath);
  const entries = [
    ...storedEntries,
    ...Object.entries(configOverrides(context)).map(([key, value]) => ({ key, value })),
  ];
  if (operation === "list" || (!operation && operands.length === 0)) {
    return result(0, entries.map(({ key, value }) => `${key}=${value}\n`).join(""));
  }
  if (operation === "get" || (!operation && operands.length === 1)) {
    const normalized = key!.toLowerCase();
    const values = entries.filter((entry) => entry.key.toLowerCase() === normalized);
    return values.length ? result(0, `${values.at(-1)!.value}\n`) : result(1, "");
  }
  if (!operation && operands.length === 2) {
    if (scope === "global") appendConfig(context.py, globalPath, operands[0], operands[1]);
    else {
      if (!root) throw new Error("not a Git repository (use --global outside one)");
      await isomorphicGit.setConfig({ fs: gitFs(context), dir: root, path: operands[0], value: operands[1] });
    }
    return result(0, "");
  }
  throw new GitUsageError(COMMAND_HELP.config.trim());
}

function assertConfigKey(key: string): void {
  if (encoder.encode(key).byteLength > MAX_CONFIG_KEY_BYTES) {
    throw new GitUsageError(`config key exceeds ${MAX_CONFIG_KEY_BYTES} bytes`);
  }
  const parts = key.split(".");
  if (parts.length < 2 || parts.some((part) => !part || /[\0\r\n\[\]]/.test(part))) {
    throw new GitUsageError(`invalid config key: ${key}`);
  }
}

function unsetConfigFile(py: Pyodide, path: string, key: string): HostCommandResult {
  if (!fsExists(py, path)) return result(5, "");
  const stat = py.FS.stat(path);
  if (stat.size > MAX_CONFIG_FILE_BYTES) {
    throw new GitUsageError(`selected config file exceeds ${MAX_CONFIG_FILE_BYTES} bytes`);
  }
  const text = fsReadText(py, path);
  const entries = parseConfigSpans(text);
  if (entries.length > MAX_CONFIG_ENTRIES) {
    throw new GitUsageError(`selected config has more than ${MAX_CONFIG_ENTRIES} entries`);
  }
  const normalized = key.toLowerCase();
  const matches = entries.filter((entry) => entry.key.toLowerCase() === normalized);
  if (!matches.length) return result(5, "");
  if (matches.length > 1) return errorResult(5, `warning: ${key} has multiple values\n`);
  const match = matches[0];
  fsWriteText(py, path, text.slice(0, match.start) + text.slice(match.end));
  return result(0, "");
}

function appendConfig(py: Pyodide, path: string, key: string, value: string): void {
  assertConfigKey(key);
  const parts = key.split(".");
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
    const url = remoteUrl(context.py, root, args[1], globalConfigPath(context));
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
  throw new GitUsageError(COMMAND_HELP.remote.trim());
}

interface RestoreRequest {
  source?: string;
  staged: boolean;
  worktree: boolean;
  paths: string[];
}

function parseRestoreRequest(
  context: HostCommandContext,
  root: string,
  args: string[],
): RestoreRequest {
  let source: string | undefined;
  let staged = false;
  let worktree = false;
  let stagedSeen = false;
  let worktreeSeen = false;
  const operands: string[] = [];
  let options = true;
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (options && value === "--") options = false;
    else if (options && (value === "--staged" || value === "-S")) {
      if (stagedSeen) throw new GitUsageError("restore --staged may be specified only once");
      stagedSeen = true;
      staged = true;
    }
    else if (options && (value === "--worktree" || value === "-W")) {
      if (worktreeSeen) throw new GitUsageError("restore --worktree may be specified only once");
      worktreeSeen = true;
      worktree = true;
    }
    else if (options && (value === "--source" || value === "-s")) {
      if (source !== undefined) throw new GitUsageError("restore accepts one source");
      source = args[++index];
      if (!source) throw new GitUsageError(`${value} requires a ref`);
    } else if (options && value.startsWith("--source=")) {
      if (source !== undefined) throw new GitUsageError("restore accepts one source");
      source = value.slice(9);
      if (!source) throw new GitUsageError("--source requires a ref");
    } else if (options && value.startsWith("-")) {
      throw new GitUsageError(`unsupported restore option: ${value}`);
    }
    else operands.push(value);
  }
  if (!operands.length) throw new GitUsageError("restore requires at least one path");
  if (operands.length > MAX_RESTORE_PATHS) {
    throw new GitUsageError(`restore accepts at most ${MAX_RESTORE_PATHS} paths`);
  }
  if (source !== undefined) {
    const bytes = showRefUtf8Bytes(source);
    if (!source || source.includes("\0") || !bytes || bytes.byteLength > MAX_GIT_REVISION_BYTES) {
      throw new GitUsageError(`restore source must be at most ${MAX_GIT_REVISION_BYTES} UTF-8 bytes`);
    }
  }
  let totalBytes = 0;
  const paths = new Set<string>();
  for (const operand of operands) {
    const bytes = showRefUtf8Bytes(operand);
    if (!operand || operand.includes("\0") || !bytes) {
      throw new GitUsageError("restore paths must be nonempty UTF-8 without NUL");
    }
    if (bytes.byteLength > MAX_RESTORE_PATH_BYTES) {
      throw new GitUsageError(`restore path exceeds ${MAX_RESTORE_PATH_BYTES} bytes`);
    }
    if (operand.startsWith("/")) {
      throw new GitUsageError("restore paths must be relative to the worktree");
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_RESTORE_TOTAL_PATH_BYTES) {
      throw new GitUsageError(
        `restore paths exceed ${MAX_RESTORE_TOTAL_PATH_BYTES} aggregate bytes`,
      );
    }
    let path: string;
    try {
      path = pathFromRepository(root, context.cwd, operand);
    } catch {
      throw new GitUsageError("restore path escapes the worktree");
    }
    if (path !== "." && path.split("/").length > MAX_RESTORE_DEPTH) {
      throw new GitUsageError(
        `restore path has more than ${MAX_RESTORE_DEPTH} components`,
      );
    }
    paths.add(path);
  }
  if (!staged && !worktree) worktree = true;
  return { source, staged, worktree, paths: [...paths] };
}

async function runRestore(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  const request = parseRestoreRequest(context, root, args);
  const indexPath = `${root}/.git/index`;
  if (fsExists(context.py, `${indexPath}.lock`)) {
    throw new Error("restore cannot acquire the index lock");
  }
  const metadata = readRmIndexMetadata(context, root, "restore");
  if (metadata.snapshot.byteLength > MAX_RESTORE_INDEX_BYTES) {
    throw new GitUsageError(`restore index exceeds ${MAX_RESTORE_INDEX_BYTES} bytes`);
  }
  if (metadata.unmerged) throw new Error("restore refuses an unmerged index");
  // Git uses the index as the default worktree source, but HEAD when the index
  // is also being restored. An explicit source applies to every selected layer.
  const effectiveSource = request.source ?? (request.staged ? "HEAD" : null);
  const plan = await prepareRecoveryPlan(
    context,
    root,
    effectiveSource,
    request.paths,
    {
      command: "restore",
      entries: MAX_RESTORE_ENTRIES,
      pathBytes: MAX_RESTORE_PATH_BYTES,
      depth: MAX_RESTORE_DEPTH,
      fileBytes: MAX_RESTORE_FILE_BYTES,
      totalBytes: MAX_RESTORE_TOTAL_BYTES,
    },
  );
  if (plan.currentIndexEntries !== metadata.entries) {
    throw new Error("restore index contains duplicate or unsupported entries");
  }
  const worktreePlan = request.worktree
    ? prepareRestoreWorktreePlan(context, root, plan)
    : undefined;
  const stagedIndex = request.staged
    ? await stageRestoreIndex(context, root, plan, metadata.snapshot)
    : undefined;
  if (worktreePlan) {
    applyRestoreTransaction(
      context,
      root,
      worktreePlan,
      metadata.snapshot,
      fsExists(context.py, indexPath),
      stagedIndex,
    );
  } else if (stagedIndex) {
    publishRestoreIndex(
      context,
      root,
      metadata.snapshot,
      fsExists(context.py, indexPath),
      stagedIndex,
    );
  }
  return result(0, "");
}

interface RecoveryEntry {
  filepath: string;
  oid: string;
  mode: number;
  type: "blob" | "commit";
}

interface RecoveryPlan {
  desired: RecoveryEntry[];
  currentIndex: RecoveryEntry[];
  currentTracked: RecoveryEntry[];
  blobs: Map<string, Uint8Array>;
  currentIndexEntries: number;
}

interface RecoveryLimits {
  command: string;
  entries: number;
  pathBytes: number;
  depth: number;
  fileBytes: number;
  totalBytes: number;
}

function recoveryPathSelected(filepath: string, selected: string[]): boolean {
  return selected.some((path) =>
    path === "." || filepath === path || filepath.startsWith(`${path}/`)
  );
}

async function recoveryEntries(
  context: HostCommandContext,
  root: string,
  source: string | null,
  limits?: Pick<RecoveryLimits, "command" | "entries">,
): Promise<RecoveryEntry[]> {
  let count = 0;
  const entries = await isomorphicGit.walk({
    fs: gitFs(context),
    dir: root,
    trees: [source === null ? isomorphicGit.STAGE() : isomorphicGit.TREE({ ref: source })],
    map: async (filepath, [entry]) => {
      if (filepath === "." || !entry) return undefined;
      const type = await entry.type();
      if (type !== "blob" && type !== "commit") return undefined;
      count++;
      if (limits && count > limits.entries) {
        throw new GitUsageError(
          `${limits.command} entry limit exceeded (${limits.entries})`,
        );
      }
      return {
        filepath,
        oid: await entry.oid(),
        mode: await entry.mode(),
        type,
      };
    },
  }) as Array<RecoveryEntry | undefined>;
  return entries.filter((entry): entry is RecoveryEntry => Boolean(entry));
}

async function resolveRecoverySource(
  context: HostCommandContext,
  root: string,
  source: string | null,
): Promise<string | null> {
  if (source === null) return null;
  try {
    return await isomorphicGit.resolveRef({ fs: gitFs(context), dir: root, ref: source });
  } catch {
    throw new Error(`unknown revision: ${source}`);
  }
}

async function prepareRecoveryPlan(
  context: HostCommandContext,
  root: string,
  source: string | null,
  selected: string[],
  limits?: RecoveryLimits,
): Promise<RecoveryPlan> {
  const resolved = await resolveRecoverySource(context, root, source);
  const entryLimits = limits ? { command: limits.command, entries: limits.entries } : undefined;
  const desiredAll = await recoveryEntries(context, root, resolved, entryLimits);
  const currentIndexAll = await recoveryEntries(context, root, null, entryLimits);
  let headAll: RecoveryEntry[] = [];
  try {
    headAll = await recoveryEntries(context, root, "HEAD", entryLimits);
  } catch (error) {
    if (error instanceof GitUsageError) throw error;
    // An unborn repository has an index but no HEAD tree.
  }
  const known = [...desiredAll, ...currentIndexAll, ...headAll];
  if (limits) {
    for (const entry of known) {
      const bytes = showRefUtf8Bytes(entry.filepath);
      if (!entry.filepath || entry.filepath.includes("\0") || !bytes ||
          bytes.byteLength > limits.pathBytes) {
        throw new GitUsageError(
          `${limits.command} entry path exceeds ${limits.pathBytes} UTF-8 bytes`,
        );
      }
      if (entry.filepath.split("/").length > limits.depth) {
        throw new GitUsageError(
          `${limits.command} entry path has more than ${limits.depth} components`,
        );
      }
    }
  }
  for (const path of selected) {
    if (path === "." || known.some((entry) => recoveryPathSelected(entry.filepath, [path]))) continue;
    throw new Error(`pathspec '${path}' did not match any files`);
  }
  const desired = desiredAll.filter((entry) => recoveryPathSelected(entry.filepath, selected));
  const unsupported = desired.find((entry) => entry.type === "commit");
  if (unsupported) throw new GitUsageError(`submodule recovery is unavailable: ${unsupported.filepath}`);
  for (const entry of desired) {
    if (![0o100644, 0o100755, 0o120000].includes(entry.mode)) {
      throw new GitUsageError(`unsupported recovery mode for ${entry.filepath}`);
    }
  }
  const blobs = new Map<string, Uint8Array>();
  let blobBytes = 0;
  for (const entry of desired) {
    const { blob } = await isomorphicGit.readBlob({
      fs: gitFs(context), dir: root, oid: entry.oid,
    });
    const bytes = new Uint8Array(blob);
    if (limits && bytes.byteLength > limits.fileBytes) {
      throw new GitUsageError(
        `${limits.command} source file exceeds ${limits.fileBytes} bytes: ${quoteDiffPath(entry.filepath)}`,
      );
    }
    blobBytes += bytes.byteLength;
    if (limits && blobBytes > limits.totalBytes) {
      throw new GitUsageError(
        `${limits.command} source bytes exceed ${limits.totalBytes} aggregate bytes`,
      );
    }
    blobs.set(entry.filepath, bytes);
  }
  const uniqueTracked = new Map<string, RecoveryEntry>();
  for (const entry of [...headAll, ...currentIndexAll]) uniqueTracked.set(entry.filepath, entry);
  if (limits) {
    const expanded = new Set([
      ...desired.map((entry) => entry.filepath),
      ...currentIndexAll.filter((entry) => recoveryPathSelected(entry.filepath, selected))
        .map((entry) => entry.filepath),
      ...[...uniqueTracked.values()].filter(
        (entry) => recoveryPathSelected(entry.filepath, selected),
      ).map((entry) => entry.filepath),
    ]);
    if (expanded.size > limits.entries) {
      throw new GitUsageError(
        `${limits.command} candidate limit exceeded (${limits.entries})`,
      );
    }
    const resulting = new Map(currentIndexAll.map((entry) => [entry.filepath, entry]));
    for (const entry of currentIndexAll.filter(
      (entry) => recoveryPathSelected(entry.filepath, selected),
    )) resulting.delete(entry.filepath);
    for (const entry of desired) resulting.set(entry.filepath, entry);
    if (resulting.size > limits.entries) {
      throw new GitUsageError(
        `${limits.command} resulting index entry limit exceeded (${limits.entries})`,
      );
    }
  }
  return {
    desired,
    currentIndex: currentIndexAll.filter((entry) => recoveryPathSelected(entry.filepath, selected)),
    currentTracked: [...uniqueTracked.values()].filter(
      (entry) => recoveryPathSelected(entry.filepath, selected),
    ),
    blobs,
    currentIndexEntries: currentIndexAll.length,
  };
}

async function applyRecoveryIndex(
  context: HostCommandContext,
  root: string,
  plan: RecoveryPlan,
): Promise<void> {
  const indexPath = `${root}/.git/index`;
  const existed = fsExists(context.py, indexPath);
  const snapshot = existed
    ? new Uint8Array(context.py.FS.readFile(indexPath) as Uint8Array)
    : null;
  const desired = new Map(plan.desired.map((entry) => [entry.filepath, entry]));
  try {
    for (const entry of plan.currentIndex) {
      if (!desired.has(entry.filepath)) {
        await isomorphicGit.updateIndex({
          fs: gitFs(context), dir: root, filepath: entry.filepath, remove: true, force: true,
        });
      }
    }
    for (const entry of plan.desired) {
      await isomorphicGit.updateIndex({
        fs: gitFs(context),
        dir: root,
        filepath: entry.filepath,
        oid: entry.oid,
        mode: entry.mode,
        add: true,
      });
    }
  } catch (error) {
    if (snapshot) context.py.FS.writeFile(indexPath, snapshot);
    else if (fsExists(context.py, indexPath)) context.py.FS.unlink(indexPath);
    throw error;
  }
}

function worktreeStat(context: HostCommandContext, path: string) {
  try {
    return context.py.FS.lstat(path);
  } catch {
    return null;
  }
}

function removeWorktreeLeaf(context: HostCommandContext, path: string): void {
  const stat = worktreeStat(context, path);
  if (!stat) return;
  if (context.py.FS.isDir(stat.mode)) throw new Error(`cannot replace directory: ${path}`);
  forgetEmscriptenSymlinkTarget(context.py.FS, path);
  context.py.FS.unlink(path);
}

function preflightRecoveryWorktree(
  context: HostCommandContext,
  root: string,
  desired: RecoveryEntry[],
  removals: string[],
): void {
  for (const filepath of removals) {
    const path = `${root}/${filepath}`;
    const stat = worktreeStat(context, path);
    if (stat && context.py.FS.isDir(stat.mode)) {
      throw new Error(`cannot replace directory: ${filepath}`);
    }
  }
  for (const entry of desired) {
    const parts = entry.filepath.split("/");
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent += `/${part}`;
      const stat = worktreeStat(context, parent);
      if (stat && !context.py.FS.isDir(stat.mode)) {
        throw new Error(`cannot restore through non-directory path: ${entry.filepath}`);
      }
    }
    const target = worktreeStat(context, `${root}/${entry.filepath}`);
    if (target && context.py.FS.isDir(target.mode)) {
      throw new Error(`cannot replace directory: ${entry.filepath}`);
    }
  }
}

function recoveryRemovals(plan: RecoveryPlan): string[] {
  const desiredPaths = new Set(plan.desired.map((entry) => entry.filepath));
  return plan.currentTracked
    .map((entry) => entry.filepath)
    .filter((filepath) => !desiredPaths.has(filepath))
    .sort((left, right) => right.split("/").length - left.split("/").length);
}

async function applyRecoveryWorktree(
  context: HostCommandContext,
  root: string,
  plan: RecoveryPlan,
): Promise<void> {
  const removals = recoveryRemovals(plan);
  preflightRecoveryWorktree(context, root, plan.desired, removals);
  for (const filepath of removals) removeWorktreeLeaf(context, `${root}/${filepath}`);
  for (const entry of plan.desired) {
    const path = `${root}/${entry.filepath}`;
    const slash = path.lastIndexOf("/");
    if (slash > root.length) context.py.FS.mkdirTree(path.slice(0, slash));
    removeWorktreeLeaf(context, path);
    const blob = plan.blobs.get(entry.filepath)!;
    if (entry.mode === 0o120000) {
      const target = decoder.decode(blob);
      context.py.FS.symlink(target, path);
      preserveEmscriptenSymlinkTarget(context.py.FS, path, target);
    } else {
      context.py.FS.writeFile(path, blob);
      context.py.FS.chmod(path, entry.mode === 0o100755 ? 0o755 : 0o644);
    }
  }
  const parents = new Set(removals.flatMap((filepath) => {
    const values: string[] = [];
    let parent = filepath;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      if (parent) values.push(parent);
    }
    return values;
  }));
  for (const parent of [...parents].sort((left, right) =>
    right.split("/").length - left.split("/").length
  )) {
    try { context.py.FS.rmdir(`${root}/${parent}`); } catch { /* keep nonempty directories */ }
  }
}

interface RestoreLeafSnapshot {
  filepath: string;
  kind: "absent" | "file" | "symlink";
  bytes: Uint8Array;
  mode: number;
  linkTarget?: string;
}

interface RestoreDirectorySnapshot {
  filepath: string;
  existed: boolean;
  identity?: string;
}

interface RestoreWorktreePlan {
  recovery: RecoveryPlan;
  removals: string[];
  leaves: RestoreLeafSnapshot[];
  directories: RestoreDirectorySnapshot[];
}

let restoreIndexScratchSequence = 0;

function readRestoreLeafSnapshot(
  context: HostCommandContext,
  root: string,
  filepath: string,
): RestoreLeafSnapshot {
  const absolute = `${root}/${filepath}`;
  const stat = worktreeStat(context, absolute);
  if (!stat) {
    return { filepath, kind: "absent", bytes: new Uint8Array(), mode: 0 };
  }
  if (context.py.FS.isDir(stat.mode)) {
    throw new Error(`cannot replace directory: ${filepath}`);
  }
  if (context.py.FS.isLink?.(stat.mode)) {
    const linkTarget = preservedEmscriptenSymlinkTarget(context.py.FS, absolute) ??
      gitSymlinkTarget(absolute, context.py.FS.readlink(absolute));
    const bytes = encoder.encode(linkTarget);
    if (bytes.byteLength > MAX_RESTORE_FILE_BYTES) {
      throw new GitUsageError(
        `restore worktree file exceeds ${MAX_RESTORE_FILE_BYTES} bytes: ${quoteDiffPath(filepath)}`,
      );
    }
    return { filepath, kind: "symlink", bytes, mode: 0o120000, linkTarget };
  }
  if ((stat.mode & 0xf000) !== 0x8000) {
    throw new GitUsageError(`restore does not support this worktree type: ${quoteDiffPath(filepath)}`);
  }
  if (stat.size > MAX_RESTORE_FILE_BYTES) {
    throw new GitUsageError(
      `restore worktree file exceeds ${MAX_RESTORE_FILE_BYTES} bytes: ${quoteDiffPath(filepath)}`,
    );
  }
  const bytes = new Uint8Array(context.py.FS.readFile(absolute) as Uint8Array).slice();
  if (bytes.byteLength > MAX_RESTORE_FILE_BYTES) {
    throw new GitUsageError(
      `restore worktree file exceeds ${MAX_RESTORE_FILE_BYTES} bytes: ${quoteDiffPath(filepath)}`,
    );
  }
  return {
    filepath,
    kind: "file",
    bytes,
    mode: (stat.mode & 0o111) !== 0 ? 0o100755 : 0o100644,
  };
}

function sameRestoreLeaf(left: RestoreLeafSnapshot, right: RestoreLeafSnapshot): boolean {
  return left.filepath === right.filepath && left.kind === right.kind &&
    left.mode === right.mode && left.linkTarget === right.linkTarget &&
    equalBytes(left.bytes, right.bytes);
}

function restoreDirectoryPaths(paths: string[]): string[] {
  const directories = new Set<string>();
  for (const filepath of paths) {
    let parent = filepath;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      if (parent) directories.add(parent);
    }
  }
  return [...directories].sort((left, right) =>
    left.split("/").length - right.split("/").length || compareRmPaths(left, right)
  );
}

function prepareRestoreWorktreePlan(
  context: HostCommandContext,
  root: string,
  recovery: RecoveryPlan,
): RestoreWorktreePlan {
  const removals = recoveryRemovals(recovery);
  preflightRecoveryWorktree(context, root, recovery.desired, removals);
  const affected = new Set([
    ...removals,
    ...recovery.desired.map((entry) => entry.filepath),
  ]);
  if (affected.size > MAX_RESTORE_ENTRIES) {
    throw new GitUsageError(
      `restore worktree candidate limit exceeded (${MAX_RESTORE_ENTRIES})`,
    );
  }
  const leaves = [...affected].sort(compareRmPaths).map((filepath) =>
    readRestoreLeafSnapshot(context, root, filepath)
  );
  let bytes = 0;
  for (const snapshot of leaves) {
    bytes += snapshot.bytes.byteLength;
    if (bytes > MAX_RESTORE_TOTAL_BYTES) {
      throw new GitUsageError(
        `restore rollback bytes exceed ${MAX_RESTORE_TOTAL_BYTES} aggregate bytes`,
      );
    }
  }
  const directories = restoreDirectoryPaths([...affected]).map((filepath) => {
    const stat = worktreeStat(context, `${root}/${filepath}`);
    if (!stat) return { filepath, existed: false };
    if (!context.py.FS.isDir(stat.mode) || context.py.FS.isLink?.(stat.mode)) {
      throw new Error(`cannot restore through non-directory path: ${filepath}`);
    }
    return { filepath, existed: true, identity: cleanNodeIdentity(stat) };
  });
  return { recovery, removals, leaves, directories };
}

function recoveryIndexChanges(plan: RecoveryPlan): boolean {
  if (plan.currentIndex.length !== plan.desired.length) return true;
  const desired = new Map(plan.desired.map((entry) => [entry.filepath, entry]));
  return plan.currentIndex.some((entry) => {
    const replacement = desired.get(entry.filepath);
    return !replacement || replacement.oid !== entry.oid || replacement.mode !== entry.mode;
  });
}

async function stageRestoreIndex(
  context: HostCommandContext,
  root: string,
  plan: RecoveryPlan,
  snapshot: Uint8Array,
): Promise<Uint8Array> {
  if (!recoveryIndexChanges(plan)) return snapshot;
  let scratch: string;
  do {
    scratch = `${root}/.git/piodide-restore-index-${++restoreIndexScratchSequence}`;
  } while (fsExists(context.py, scratch));
  context.py.FS.mkdir(scratch);
  try {
    if (snapshot.byteLength) context.py.FS.writeFile(`${scratch}/index`, snapshot);
    const fs = gitFs(context);
    const cache = {};
    const desired = new Map(plan.desired.map((entry) => [entry.filepath, entry]));
    for (const entry of plan.currentIndex) {
      if (!desired.has(entry.filepath)) {
        await isomorphicGit.updateIndex({
          fs, dir: root, gitdir: scratch, cache,
          filepath: entry.filepath, remove: true, force: true,
        });
      }
    }
    for (const entry of plan.desired) {
      await isomorphicGit.updateIndex({
        fs, dir: root, gitdir: scratch, cache,
        filepath: entry.filepath, oid: entry.oid, mode: entry.mode, add: true,
      });
    }
    const staged = new Uint8Array(context.py.FS.readFile(`${scratch}/index`) as Uint8Array);
    if (staged.byteLength > MAX_RESTORE_INDEX_BYTES) {
      throw new GitUsageError(
        `restore resulting index exceeds ${MAX_RESTORE_INDEX_BYTES} bytes`,
      );
    }
    return staged;
  } finally {
    removeRmIndexScratch(context, scratch);
  }
}

function assertRestoreIndexUnchanged(
  context: HostCommandContext,
  root: string,
  snapshot: Uint8Array,
  hadIndex: boolean,
): void {
  const indexPath = `${root}/.git/index`;
  if (fsExists(context.py, `${indexPath}.lock`)) {
    throw new Error("restore cannot acquire the index lock");
  }
  const exists = fsExists(context.py, indexPath);
  const current = exists
    ? new Uint8Array(context.py.FS.readFile(indexPath) as Uint8Array)
    : new Uint8Array();
  if (exists !== hadIndex || !equalBytes(current, snapshot)) {
    throw new Error("restore index changed during the operation");
  }
}

function publishRestoreIndex(
  context: HostCommandContext,
  root: string,
  snapshot: Uint8Array,
  hadIndex: boolean,
  staged: Uint8Array,
): void {
  assertRestoreIndexUnchanged(context, root, snapshot, hadIndex);
  if (equalBytes(snapshot, staged)) return;
  const indexPath = `${root}/.git/index`;
  try {
    context.py.FS.writeFile(indexPath, staged);
  } catch (error) {
    try {
      if (hadIndex) context.py.FS.writeFile(indexPath, snapshot);
      else if (fsExists(context.py, indexPath)) context.py.FS.unlink(indexPath);
    } catch (rollback) {
      throw new Error(
        `${conciseObjectError(error)}; restore index rollback failed: ${conciseObjectError(rollback)}`,
      );
    }
    throw error;
  }
}

function verifyRestoreWorktreePlan(
  context: HostCommandContext,
  root: string,
  plan: RestoreWorktreePlan,
): void {
  for (const directory of plan.directories) {
    const stat = worktreeStat(context, `${root}/${directory.filepath}`);
    if (!directory.existed) {
      if (stat) throw new Error(`restore worktree changed during the operation: ${quoteDiffPath(directory.filepath)}`);
      continue;
    }
    if (!stat || !context.py.FS.isDir(stat.mode) || context.py.FS.isLink?.(stat.mode) ||
        cleanNodeIdentity(stat) !== directory.identity) {
      throw new Error(`restore worktree changed during the operation: ${quoteDiffPath(directory.filepath)}`);
    }
  }
  for (const snapshot of plan.leaves) {
    const current = readRestoreLeafSnapshot(context, root, snapshot.filepath);
    if (!sameRestoreLeaf(current, snapshot)) {
      throw new Error(
        `restore worktree changed during the operation: ${quoteDiffPath(snapshot.filepath)}`,
      );
    }
  }
}

function unlinkRestoreLeaf(context: HostCommandContext, absolute: string): void {
  const stat = worktreeStat(context, absolute);
  if (!stat) return;
  if (context.py.FS.isDir(stat.mode)) throw new Error(`cannot replace directory: ${absolute}`);
  forgetEmscriptenSymlinkTarget(context.py.FS, absolute);
  context.py.FS.unlink(absolute);
}

function writeRestoreEntry(
  context: HostCommandContext,
  root: string,
  entry: RecoveryEntry,
  bytes: Uint8Array,
): void {
  const absolute = `${root}/${entry.filepath}`;
  const slash = absolute.lastIndexOf("/");
  if (slash > root.length) context.py.FS.mkdirTree(absolute.slice(0, slash));
  unlinkRestoreLeaf(context, absolute);
  if (entry.mode === 0o120000) {
    const target = decoder.decode(bytes);
    context.py.FS.symlink(target, absolute);
    preserveEmscriptenSymlinkTarget(context.py.FS, absolute, target);
  } else {
    context.py.FS.writeFile(absolute, bytes);
    context.py.FS.chmod(absolute, entry.mode === 0o100755 ? 0o755 : 0o644);
  }
}

function restoreWorktreeRollback(
  context: HostCommandContext,
  root: string,
  plan: RestoreWorktreePlan,
): string[] {
  const failures: string[] = [];
  const deepestLeaves = [...plan.leaves].sort((left, right) =>
    right.filepath.split("/").length - left.filepath.split("/").length ||
      compareRmPaths(right.filepath, left.filepath)
  );
  for (const snapshot of deepestLeaves) {
    const absolute = `${root}/${snapshot.filepath}`;
    try {
      const stat = worktreeStat(context, absolute);
      if (!stat) continue;
      if (context.py.FS.isDir(stat.mode)) context.py.FS.rmdir(absolute);
      else {
        forgetEmscriptenSymlinkTarget(context.py.FS, absolute);
        context.py.FS.unlink(absolute);
      }
    } catch (error) {
      failures.push(`${quoteDiffPath(snapshot.filepath)}: ${conciseObjectError(error)}`);
    }
  }
  for (const directory of [...plan.directories].reverse()) {
    if (directory.existed) continue;
    const absolute = `${root}/${directory.filepath}`;
    try {
      const stat = worktreeStat(context, absolute);
      if (!stat) continue;
      if (!context.py.FS.isDir(stat.mode) || context.py.FS.isLink?.(stat.mode)) {
        throw new Error("rollback directory became a non-directory");
      }
      context.py.FS.rmdir(absolute);
    } catch (error) {
      failures.push(`${quoteDiffPath(directory.filepath)}: ${conciseObjectError(error)}`);
    }
  }
  for (const directory of plan.directories) {
    if (!directory.existed) continue;
    const absolute = `${root}/${directory.filepath}`;
    try {
      const stat = worktreeStat(context, absolute);
      if (!stat) context.py.FS.mkdirTree(absolute);
      else if (!context.py.FS.isDir(stat.mode) || context.py.FS.isLink?.(stat.mode)) {
        throw new Error("rollback directory became a non-directory");
      }
    } catch (error) {
      failures.push(`${quoteDiffPath(directory.filepath)}: ${conciseObjectError(error)}`);
    }
  }
  for (const snapshot of plan.leaves) {
    if (snapshot.kind === "absent") continue;
    const absolute = `${root}/${snapshot.filepath}`;
    try {
      const slash = absolute.lastIndexOf("/");
      if (slash > root.length) context.py.FS.mkdirTree(absolute.slice(0, slash));
      unlinkRestoreLeaf(context, absolute);
      if (snapshot.kind === "symlink") {
        const target = snapshot.linkTarget ?? decoder.decode(snapshot.bytes);
        context.py.FS.symlink(target, absolute);
        preserveEmscriptenSymlinkTarget(context.py.FS, absolute, target);
      } else {
        context.py.FS.writeFile(absolute, snapshot.bytes);
        context.py.FS.chmod(absolute, snapshot.mode === 0o100755 ? 0o755 : 0o644);
      }
    } catch (error) {
      failures.push(`${quoteDiffPath(snapshot.filepath)}: ${conciseObjectError(error)}`);
    }
  }
  return failures;
}

function applyRestoreTransaction(
  context: HostCommandContext,
  root: string,
  plan: RestoreWorktreePlan,
  indexSnapshot: Uint8Array,
  hadIndex: boolean,
  stagedIndex?: Uint8Array,
): void {
  let mutationStarted = false;
  try {
    assertRestoreIndexUnchanged(context, root, indexSnapshot, hadIndex);
    verifyRestoreWorktreePlan(context, root, plan);
    mutationStarted = true;
    for (const filepath of plan.removals) {
      unlinkRestoreLeaf(context, `${root}/${filepath}`);
    }
    for (const entry of plan.recovery.desired) {
      writeRestoreEntry(context, root, entry, plan.recovery.blobs.get(entry.filepath)!);
    }
    for (const directory of [...plan.directories].reverse()) {
      const absolute = `${root}/${directory.filepath}`;
      const stat = worktreeStat(context, absolute);
      if (!stat || !context.py.FS.isDir(stat.mode) || context.py.FS.isLink?.(stat.mode)) continue;
      try { context.py.FS.rmdir(absolute); } catch { /* preserve nonempty directories */ }
    }
    if (stagedIndex) {
      publishRestoreIndex(context, root, indexSnapshot, hadIndex, stagedIndex);
    }
  } catch (error) {
    if (!mutationStarted) throw error;
    const failures = restoreWorktreeRollback(context, root, plan);
    if (failures.length) {
      throw new Error(
        `${conciseObjectError(error)}; restore worktree rollback failed for ${failures.join(", ")}`,
      );
    }
    throw error;
  }
}

async function runCheckout(
  context: HostCommandContext,
  args: string[],
): Promise<HostCommandResult> {
  const separator = args.indexOf("--");
  if (separator < 0) throw new GitUsageError(COMMAND_HELP.checkout.trim());
  const beforePaths = args.slice(0, separator);
  if (beforePaths.length > 1 || beforePaths.some((value) => value.startsWith("-"))) {
    throw new GitUsageError(COMMAND_HELP.checkout.trim());
  }
  if (separator + 1 >= args.length) throw new GitUsageError("checkout requires at least one path");
  const root = repositoryRoot(context.py, context.cwd);
  const filepaths = args.slice(separator + 1).map((path) =>
    pathFromRepository(root, context.cwd, path)
  );
  const source = beforePaths[0] ?? null;
  const plan = await prepareRecoveryPlan(context, root, source, filepaths);
  preflightRecoveryWorktree(context, root, plan.desired, recoveryRemovals(plan));
  if (source !== null) await applyRecoveryIndex(context, root, plan);
  await applyRecoveryWorktree(context, root, plan);
  return result(0, "");
}

type ResetMode = "mixed" | "soft" | "hard";

interface ResetIndexPlan {
  desired: RecoveryEntry[];
  current: RecoveryEntry[];
}

let resetIndexScratchSequence = 0;

function resetPathSelectors(
  context: HostCommandContext,
  root: string,
  operands: string[],
): string[] {
  if (!operands.length) throw new GitUsageError("path-form reset requires at least one path");
  if (operands.length > MAX_RESET_PATHS) {
    throw new GitUsageError(`path-form reset accepts at most ${MAX_RESET_PATHS} paths`);
  }
  let totalBytes = 0;
  const selected = new Set<string>();
  for (const operand of operands) {
    const bytes = showRefUtf8Bytes(operand);
    if (!operand || operand.includes("\0") || !bytes) {
      throw new GitUsageError("reset path operands must be nonempty UTF-8 without NUL");
    }
    if (bytes.byteLength > MAX_RESET_PATH_BYTES) {
      throw new GitUsageError(`reset path operand exceeds ${MAX_RESET_PATH_BYTES} bytes`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_RESET_TOTAL_PATH_BYTES) {
      throw new GitUsageError(
        `reset path operands exceed ${MAX_RESET_TOTAL_PATH_BYTES} aggregate bytes`,
      );
    }
    try {
      selected.add(pathFromRepository(root, context.cwd, operand));
    } catch {
      throw new GitUsageError("reset path escapes the worktree");
    }
  }
  return [...selected];
}

async function prepareResetIndexPlan(
  context: HostCommandContext,
  root: string,
  ref: string,
  selected: string[],
): Promise<ResetIndexPlan> {
  const indexPath = `${root}/.git/index`;
  if (fsExists(context.py, indexPath)) {
    const stat = context.py.FS.stat(indexPath);
    if (stat.size > MAX_RESET_INDEX_BYTES) {
      throw new GitUsageError(`reset index exceeds ${MAX_RESET_INDEX_BYTES} bytes`);
    }
  }
  const [desiredAll, currentAll] = await Promise.all([
    recoveryEntries(context, root, ref),
    recoveryEntries(context, root, null),
  ]);
  if (desiredAll.length > MAX_RESET_INDEX_ENTRIES || currentAll.length > MAX_RESET_INDEX_ENTRIES) {
    throw new GitUsageError(
      `reset index entry limit exceeded (${MAX_RESET_INDEX_ENTRIES})`,
    );
  }
  const desired = desiredAll.filter((entry) => recoveryPathSelected(entry.filepath, selected));
  const current = currentAll.filter((entry) => recoveryPathSelected(entry.filepath, selected));
  for (const entry of desired) {
    if (entry.type === "commit") {
      throw new GitUsageError(`submodule reset is unavailable: ${entry.filepath}`);
    }
    if (![0o100644, 0o100755, 0o120000].includes(entry.mode)) {
      throw new GitUsageError(`unsupported reset mode for ${entry.filepath}`);
    }
    // A reset must not install a missing or corrupt source object into an
    // otherwise valid index. Read sequentially so validation retains at most
    // one selected blob payload at a time.
    await isomorphicGit.readBlob({ fs: gitFs(context), dir: root, oid: entry.oid });
  }
  const resulting = new Map(currentAll.map((entry) => [entry.filepath, entry]));
  for (const entry of current) resulting.delete(entry.filepath);
  for (const entry of desired) resulting.set(entry.filepath, entry);
  if (resulting.size > MAX_RESET_INDEX_ENTRIES) {
    throw new GitUsageError(
      `reset resulting index entry limit exceeded (${MAX_RESET_INDEX_ENTRIES})`,
    );
  }
  return { desired, current };
}

function resetIndexPlanChanges(plan: ResetIndexPlan): boolean {
  if (plan.current.length !== plan.desired.length) return true;
  const desired = new Map(plan.desired.map((entry) => [entry.filepath, entry]));
  return plan.current.some((entry) => {
    const replacement = desired.get(entry.filepath);
    return !replacement || replacement.oid !== entry.oid || replacement.mode !== entry.mode;
  });
}

function removeResetIndexScratch(context: HostCommandContext, path: string): void {
  try {
    const index = `${path}/index`;
    if (fsExists(context.py, index)) context.py.FS.unlink(index);
    if (fsExists(context.py, path)) context.py.FS.rmdir(path);
  } catch {
    // Scratch cleanup must not hide the original result. The directory is
    // private under .git and contains only the disposable index copy.
  }
}

async function applyResetIndexPlan(
  context: HostCommandContext,
  root: string,
  plan: ResetIndexPlan,
): Promise<void> {
  if (!resetIndexPlanChanges(plan)) return;
  const indexPath = `${root}/.git/index`;
  const existed = fsExists(context.py, indexPath);
  const snapshot = existed
    ? new Uint8Array(context.py.FS.readFile(indexPath) as Uint8Array)
    : undefined;
  if ((snapshot?.byteLength ?? 0) > MAX_RESET_INDEX_BYTES) {
    throw new GitUsageError(`reset index exceeds ${MAX_RESET_INDEX_BYTES} bytes`);
  }
  let scratch: string;
  do {
    scratch = `${root}/.git/piodide-reset-index-${++resetIndexScratchSequence}`;
  } while (fsExists(context.py, scratch));
  context.py.FS.mkdir(scratch);
  try {
    if (snapshot) context.py.FS.writeFile(`${scratch}/index`, snapshot);
    const fs = gitFs(context);
    const cache = {};
    const desired = new Map(plan.desired.map((entry) => [entry.filepath, entry]));
    for (const entry of plan.current) {
      if (!desired.has(entry.filepath)) {
        await isomorphicGit.updateIndex({
          fs, dir: root, gitdir: scratch, cache,
          filepath: entry.filepath, remove: true, force: true,
        });
      }
    }
    for (const entry of plan.desired) {
      await isomorphicGit.updateIndex({
        fs, dir: root, gitdir: scratch, cache,
        filepath: entry.filepath, oid: entry.oid, mode: entry.mode, add: true,
      });
    }
    const staged = new Uint8Array(context.py.FS.readFile(`${scratch}/index`) as Uint8Array);
    if (staged.byteLength > MAX_RESET_INDEX_BYTES) {
      throw new GitUsageError(`reset resulting index exceeds ${MAX_RESET_INDEX_BYTES} bytes`);
    }
    try {
      context.py.FS.writeFile(indexPath, staged);
    } catch (error) {
      try {
        if (snapshot) context.py.FS.writeFile(indexPath, snapshot);
        else if (fsExists(context.py, indexPath)) context.py.FS.unlink(indexPath);
      } catch { /* preserve the original write error */ }
      throw error;
    }
  } finally {
    removeResetIndexScratch(context, scratch);
  }
}

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

async function resolveResetCommit(
  context: HostCommandContext,
  root: string,
  revision: string,
): Promise<string> {
  const bytes = showRefUtf8Bytes(revision);
  if (
    !revision || revision.includes("\0") || !bytes ||
    bytes.byteLength > MAX_GIT_REVISION_BYTES
  ) {
    throw new GitUsageError("invalid reset revision");
  }
  // The native resolver provides the bounded expression surface already used
  // by rev-parse, diff, and other inspection commands. Peeling to a commit
  // rejects blob/tree expressions before any index, worktree, or ref mutation.
  const resolved = await invoke(context, ["rev-parse", `${revision}^{commit}`], root);
  const oid = resolved.stdout.trim();
  if (resolved.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(oid)) {
    throw new GitUsageError(`unknown revision: ${revision}`);
  }
  try {
    await isomorphicGit.readCommit({ fs: gitFs(context), dir: root, oid });
  } catch {
    throw new GitUsageError(`revision is not a commit: ${revision}`);
  }
  return oid;
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
  let explicitMode: ResetMode | undefined;
  let pathForm = false;
  const revisions: string[] = [];
  const pathOperands: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (pathForm) {
      pathOperands.push(value);
      continue;
    }
    if (value === "--") {
      pathForm = true;
      continue;
    }
    if (value === "--mixed" || value === "--soft" || value === "--hard") {
      const requested = value.slice(2) as ResetMode;
      if (explicitMode !== undefined) {
        throw new GitUsageError("reset accepts at most one of --mixed, --soft, and --hard");
      }
      explicitMode = requested;
      mode = requested;
    } else if (value.startsWith("-")) {
      throw new GitUsageError(`unsupported reset option: ${value}`);
    } else revisions.push(value);
  }
  if (revisions.length > 1) {
    throw new GitUsageError(
      pathForm ? "reset accepts at most one revision before --" : "reset accepts at most one revision",
    );
  }
  if (pathForm && !pathOperands.length) {
    throw new GitUsageError("path-form reset requires at least one path");
  }
  if (pathForm && mode !== "mixed") {
    throw new GitUsageError(`reset --${mode} does not accept paths`);
  }
  const ref = revisions[0] || "HEAD";
  const selected = pathForm ? resetPathSelectors(context, root, pathOperands) : [];

  const oid = await resolveResetCommit(context, root, ref);
  if (pathForm) {
    const plan = await prepareResetIndexPlan(context, root, oid, selected);
    await applyResetIndexPlan(context, root, plan);
    return result(0, "");
  }

  if (mode === "hard") {
    const plan = await prepareRecoveryPlan(context, root, oid, ["."]);
    preflightRecoveryWorktree(context, root, plan.desired, recoveryRemovals(plan));
    await applyRecoveryIndex(context, root, plan);
    await applyRecoveryWorktree(context, root, plan);
  } else if (mode === "mixed") {
    await resetIndexPaths(context, root, oid);
  }
  await moveHead(context, root, oid);
  clearMergeState(context.py, root);
  return result(0, mode === "hard" ? `HEAD is now at ${oid.slice(0, 7)}\n` : "");
}

interface RmRequest {
  cached: boolean;
  recursive: boolean;
  paths: string[];
}

interface RmIndexMetadata {
  snapshot: Uint8Array;
  entries: number;
  unmerged: boolean;
}

interface RmWorktreeSnapshot {
  entry: RecoveryEntry;
  bytes: Uint8Array;
  linkTarget?: string;
}

interface RmPlan {
  snapshot: Uint8Array;
  removals: RecoveryEntry[];
  worktree: RmWorktreeSnapshot[];
  directories: string[];
}

function parseRmRequest(
  context: HostCommandContext,
  root: string,
  args: string[],
): RmRequest {
  let cached = false;
  let recursive = false;
  let options = true;
  const operands: string[] = [];
  for (const arg of args) {
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (options && arg === "--cached") {
      if (cached) throw new GitUsageError("rm --cached may be specified only once");
      cached = true;
      continue;
    }
    if (options && arg === "-r") {
      if (recursive) throw new GitUsageError("rm -r may be specified only once");
      recursive = true;
      continue;
    }
    if (options && arg.startsWith("-")) {
      throw new GitUsageError(`unsupported rm option: ${arg}`);
    }
    operands.push(arg);
  }
  const command = cached ? "rm --cached" : "rm";
  if (!operands.length) throw new GitUsageError(`${command} requires at least one path`);
  if (operands.length > MAX_RM_PATHS) {
    throw new GitUsageError(`${command} accepts at most ${MAX_RM_PATHS} paths`);
  }
  let totalBytes = 0;
  const normalized = new Set<string>();
  for (const operand of operands) {
    const bytes = showRefUtf8Bytes(operand);
    if (!operand || operand.includes("\0") || !bytes) {
      throw new GitUsageError("rm paths must be nonempty UTF-8 without NUL");
    }
    if (bytes.byteLength > MAX_RM_PATH_BYTES) {
      throw new GitUsageError(`rm path exceeds ${MAX_RM_PATH_BYTES} bytes`);
    }
    if (operand.startsWith("/")) {
      throw new GitUsageError("rm paths must be relative to the worktree");
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_RM_TOTAL_PATH_BYTES) {
      throw new GitUsageError(`rm paths exceed ${MAX_RM_TOTAL_PATH_BYTES} aggregate bytes`);
    }
    let path: string;
    try {
      path = pathFromRepository(root, context.cwd, operand);
    } catch {
      throw new GitUsageError("rm path escapes the worktree");
    }
    if (path !== "." && path.split("/").length > MAX_RM_DEPTH) {
      throw new GitUsageError(`rm path has more than ${MAX_RM_DEPTH} components`);
    }
    normalized.add(path);
  }
  return { cached, recursive, paths: [...normalized] };
}

function readRmIndexMetadata(
  context: HostCommandContext,
  root: string,
  command = "rm",
): RmIndexMetadata {
  const indexPath = `${root}/.git/index`;
  if (!fsExists(context.py, indexPath)) {
    return { snapshot: new Uint8Array(), entries: 0, unmerged: false };
  }
  const stat = context.py.FS.stat(indexPath);
  if (stat.size > MAX_RM_INDEX_BYTES) {
    throw new GitUsageError(`${command} index exceeds ${MAX_RM_INDEX_BYTES} bytes`);
  }
  const snapshot = new Uint8Array(context.py.FS.readFile(indexPath) as Uint8Array);
  const invalid = (): never => { throw new Error(`${command} cannot read the Git index`); };
  if (
    snapshot.byteLength < 32 || decoder.decode(snapshot.subarray(0, 4)) !== "DIRC"
  ) invalid();
  const view = new DataView(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength);
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) invalid();
  const entries = view.getUint32(8);
  if (entries > MAX_RM_INDEX_ENTRIES) {
    throw new GitUsageError(
      `${command} index entry limit exceeded (${MAX_RM_INDEX_ENTRIES})`,
    );
  }
  const dataEnd = snapshot.byteLength - 20;
  let offset = 12;
  let unmerged = false;
  for (let index = 0; index < entries; index++) {
    if (offset + 62 > dataEnd) invalid();
    const flags = view.getUint16(offset + 60);
    if ((flags & 0x3000) !== 0) unmerged = true;
    const extended = Boolean(flags & 0x4000);
    if (extended && version !== 3) invalid();
    const pathStart = offset + 62 + (extended ? 2 : 0);
    const pathEnd = snapshot.indexOf(0, pathStart);
    if (pathEnd < pathStart || pathEnd >= dataEnd) invalid();
    const entryBytes = (pathStart - offset + (pathEnd - pathStart) + 1 + 7) & ~7;
    offset += entryBytes;
    if (offset > dataEnd) invalid();
  }
  return { snapshot, entries, unmerged };
}

function compareRmPaths(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index++) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index]! - rightBytes[index]!;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

function preflightRmWorktreeAncestry(
  context: HostCommandContext,
  root: string,
  filepath: string,
): void {
  const parts = filepath.split("/");
  if (parts.length > MAX_RM_DEPTH) {
    throw new GitUsageError(`rm path has more than ${MAX_RM_DEPTH} components`);
  }
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent += `/${part}`;
    let stat;
    try {
      stat = context.py.FS.lstat(parent);
    } catch (error) {
      throw new Error(
        `rm cannot inspect ancestry for ${quoteDiffPath(filepath)}: ${conciseObjectError(error)}`,
      );
    }
    if (context.py.FS.isLink?.(stat.mode)) {
      throw new Error(`rm refuses symlink ancestry at ${quoteDiffPath(filepath)}`);
    }
    if (!context.py.FS.isDir(stat.mode)) {
      throw new Error(`rm worktree ancestry is not a directory at ${quoteDiffPath(filepath)}`);
    }
  }
}

async function readRmWorktreeSnapshot(
  context: HostCommandContext,
  root: string,
  entry: RecoveryEntry,
  compared: { bytes: number },
): Promise<{ matches: boolean; snapshot?: RmWorktreeSnapshot }> {
  preflightRmWorktreeAncestry(context, root, entry.filepath);
  const absolute = `${root}/${entry.filepath}`;
  let stat;
  try {
    stat = context.py.FS.lstat(absolute);
  } catch (error) {
    if (!fsExists(context.py, absolute)) return { matches: false };
    throw new Error(`cannot inspect ${quoteDiffPath(entry.filepath)}: ${conciseObjectError(error)}`);
  }
  if (context.py.FS.isDir(stat.mode)) return { matches: false };
  let bytes: Uint8Array;
  let mode: number;
  let linkTarget: string | undefined;
  try {
    if (context.py.FS.isLink?.(stat.mode)) {
      linkTarget = preservedEmscriptenSymlinkTarget(context.py.FS, absolute) ??
        gitSymlinkTarget(absolute, context.py.FS.readlink(absolute));
      bytes = encoder.encode(linkTarget);
      mode = 0o120000;
    } else {
      if (stat.size > MAX_RM_WORKTREE_FILE_BYTES) {
        throw new GitUsageError(
          `rm worktree file exceeds ${MAX_RM_WORKTREE_FILE_BYTES} bytes: ${quoteDiffPath(entry.filepath)}`,
        );
      }
      bytes = new Uint8Array(context.py.FS.readFile(absolute) as Uint8Array).slice();
      mode = (stat.mode & 0o111) !== 0 ? 0o100755 : 0o100644;
    }
  } catch (error) {
    if (error instanceof GitUsageError) throw error;
    throw new Error(`cannot read ${quoteDiffPath(entry.filepath)}: ${conciseObjectError(error)}`);
  }
  if (bytes.byteLength > MAX_RM_WORKTREE_FILE_BYTES) {
    throw new GitUsageError(
      `rm worktree file exceeds ${MAX_RM_WORKTREE_FILE_BYTES} bytes: ${quoteDiffPath(entry.filepath)}`,
    );
  }
  compared.bytes += bytes.byteLength;
  if (compared.bytes > MAX_RM_TOTAL_WORKTREE_BYTES) {
    throw new GitUsageError(`rm compared worktree bytes exceed ${MAX_RM_TOTAL_WORKTREE_BYTES}`);
  }
  const { oid } = await isomorphicGit.hashBlob({ object: bytes });
  const matches = entry.mode === mode && entry.oid === oid;
  return {
    matches,
    snapshot: matches ? { entry, bytes, linkTarget } : undefined,
  };
}

async function rmWorktreeMatchesIndex(
  context: HostCommandContext,
  root: string,
  entry: RecoveryEntry,
  compared: { bytes: number },
): Promise<boolean> {
  return (await readRmWorktreeSnapshot(context, root, entry, compared)).matches;
}

async function prepareRmPlan(
  context: HostCommandContext,
  root: string,
  request: RmRequest,
): Promise<RmPlan> {
  const indexPath = `${root}/.git/index`;
  if (fsExists(context.py, `${indexPath}.lock`)) throw new Error("rm cannot acquire the index lock");
  const metadata = readRmIndexMetadata(context, root);
  if (metadata.unmerged) {
    throw new Error(`${request.cached ? "rm --cached" : "rm"} refuses an unmerged index`);
  }
  const intentToAdd = metadata.snapshot.byteLength
    ? gitIndexIntentToAddPaths(metadata.snapshot)
    : new Set<string>();
  const current = await recoveryEntries(context, root, null);
  if (current.length !== metadata.entries) {
    throw new Error("rm index contains duplicate or unsupported entries");
  }
  for (const entry of current) {
    const bytes = showRefUtf8Bytes(entry.filepath);
    if (
      !entry.filepath || entry.filepath.includes("\0") || !bytes ||
      bytes.byteLength > MAX_RM_PATH_BYTES
    ) {
      throw new GitUsageError(`rm index path exceeds ${MAX_RM_PATH_BYTES} UTF-8 bytes`);
    }
    if (entry.filepath.split("/").length > MAX_RM_DEPTH) {
      throw new GitUsageError(`rm index path has more than ${MAX_RM_DEPTH} components`);
    }
  }

  const removals = new Map<string, RecoveryEntry>();
  const directorySelectors = new Set<string>();
  for (const selector of request.paths) {
    const exact = current.find((entry) => entry.filepath === selector);
    const descendants = current.filter((entry) =>
      selector === "." || entry.filepath.startsWith(`${selector}/`)
    );
    if (!exact && descendants.length && !request.recursive) {
      throw new GitUsageError(`rm directory ${quoteDiffPath(selector)} requires -r`);
    }
    if (!exact && descendants.length) directorySelectors.add(selector);
    const matched = exact ? [exact, ...(request.recursive ? descendants : [])]
      : request.recursive ? descendants : [];
    if (!matched.length) {
      throw new GitUsageError(
        `rm pathspec ${quoteDiffPath(selector)} did not match any stage-0 index entries`,
      );
    }
    for (const entry of matched) removals.set(entry.filepath, entry);
  }

  let head: RecoveryEntry[] = [];
  let headOid: string | undefined;
  try {
    headOid = await isomorphicGit.resolveRef({ fs: gitFs(context), dir: root, ref: "HEAD" });
  } catch {
    // An unborn repository has no HEAD tree. Cached removal can still retain
    // a matching worktree copy; non-cached removal refuses staged-only data.
  }
  if (headOid) head = await recoveryEntries(context, root, headOid);
  if (head.length > MAX_RM_INDEX_ENTRIES) {
    throw new GitUsageError(`rm HEAD entry limit exceeded (${MAX_RM_INDEX_ENTRIES})`);
  }
  const headEntries = new Map(head.map((entry) => [entry.filepath, entry]));
  const compared = { bytes: 0 };
  const orderedRemovals = [...removals.values()].sort((left, right) =>
    compareRmPaths(left.filepath, right.filepath)
  );
  const worktree: RmWorktreeSnapshot[] = [];
  for (const entry of orderedRemovals) {
    const command = request.cached ? "rm --cached" : "rm";
    if (entry.type === "commit") {
      throw new Error(`${command} does not support submodules: ${quoteDiffPath(entry.filepath)}`);
    }
    if (![0o100644, 0o100755, 0o120000].includes(entry.mode)) {
      throw new Error(`${command} found an unsupported index mode: ${quoteDiffPath(entry.filepath)}`);
    }
    const headEntry = headEntries.get(entry.filepath);
    if (request.cached) {
      if (intentToAdd.has(entry.filepath)) continue;
      if (headEntry && headEntry.oid === entry.oid && headEntry.mode === entry.mode) continue;
      if (await rmWorktreeMatchesIndex(context, root, entry, compared)) continue;
      throw new Error(
        `rm --cached refuses unique staged content at ${quoteDiffPath(entry.filepath)}; ` +
        "the index matches neither HEAD nor the worktree",
      );
    }
    if (!headEntry || headEntry.oid !== entry.oid || headEntry.mode !== entry.mode) {
      throw new Error(
        `rm refuses staged changes at ${quoteDiffPath(entry.filepath)}; the index differs from HEAD`,
      );
    }
    const inspected = await readRmWorktreeSnapshot(context, root, entry, compared);
    if (!inspected.matches || !inspected.snapshot) {
      throw new Error(
        `rm refuses worktree changes at ${quoteDiffPath(entry.filepath)}; ` +
        "the worktree differs from the index",
      );
    }
    worktree.push(inspected.snapshot);
  }

  const directories = new Set<string>();
  for (const selector of directorySelectors) {
    for (const entry of orderedRemovals) {
      if (!recoveryPathSelected(entry.filepath, [selector])) continue;
      let parent = entry.filepath;
      while (parent.includes("/")) {
        parent = parent.slice(0, parent.lastIndexOf("/"));
        if (selector !== "." && parent !== selector && !parent.startsWith(`${selector}/`)) break;
        if (parent) directories.add(parent);
        if (parent === selector) break;
      }
    }
  }
  return {
    snapshot: metadata.snapshot,
    removals: orderedRemovals,
    worktree,
    directories: [...directories].sort((left, right) => {
      const depth = right.split("/").length - left.split("/").length;
      return depth || compareRmPaths(left, right);
    }),
  };
}

let rmIndexScratchSequence = 0;

function removeRmIndexScratch(context: HostCommandContext, path: string): void {
  try {
    for (const name of ["index", "index.lock"]) {
      const entry = `${path}/${name}`;
      if (fsExists(context.py, entry)) context.py.FS.unlink(entry);
    }
    if (fsExists(context.py, path)) context.py.FS.rmdir(path);
  } catch {
    // The private scratch index is disposable and must not hide the result.
  }
}

async function stageRmIndex(
  context: HostCommandContext,
  root: string,
  plan: RmPlan,
): Promise<Uint8Array> {
  let scratch: string;
  do {
    scratch = `${root}/.git/piodide-rm-index-${++rmIndexScratchSequence}`;
  } while (fsExists(context.py, scratch));
  context.py.FS.mkdir(scratch);
  try {
    context.py.FS.writeFile(`${scratch}/index`, plan.snapshot);
    const fs = gitFs(context);
    const cache = {};
    for (const entry of plan.removals) {
      await isomorphicGit.updateIndex({
        fs, dir: root, gitdir: scratch, cache,
        filepath: entry.filepath, remove: true, force: true,
      });
    }
    const staged = new Uint8Array(context.py.FS.readFile(`${scratch}/index`) as Uint8Array);
    if (staged.byteLength > MAX_RM_INDEX_BYTES) {
      throw new GitUsageError(`rm resulting index exceeds ${MAX_RM_INDEX_BYTES} bytes`);
    }
    return staged.slice();
  } finally {
    removeRmIndexScratch(context, scratch);
  }
}

function commitRmIndex(
  context: HostCommandContext,
  root: string,
  snapshot: Uint8Array,
  staged: Uint8Array,
  command = "rm",
): void {
  const indexPath = `${root}/.git/index`;
  if (fsExists(context.py, `${indexPath}.lock`)) {
    throw new Error(`${command} cannot acquire the index lock`);
  }
  const current = fsExists(context.py, indexPath)
    ? new Uint8Array(context.py.FS.readFile(indexPath) as Uint8Array)
    : new Uint8Array();
  if (!equalBytes(current, snapshot)) {
    throw new Error(`${command} index changed during the operation`);
  }
  try {
    context.py.FS.writeFile(indexPath, staged);
  } catch (error) {
    try { context.py.FS.writeFile(indexPath, snapshot); } catch { /* preserve original error */ }
    throw error;
  }
}

function rmPathFromCwd(root: string, cwd: string, filepath: string): string {
  const prefix = pathFromRepository(root, cwd, ".");
  if (prefix === ".") return filepath;
  const from = prefix.split("/");
  const to = filepath.split("/");
  let shared = 0;
  while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared++;
  return [...Array(from.length - shared).fill(".."), ...to.slice(shared)].join("/") || ".";
}

function quoteRmOutputPath(path: string): string {
  const bytes = encoder.encode(path);
  if ([...bytes].every((byte) => byte >= 0x20 && byte < 0x7f && ![0x22, 0x27, 0x5c].includes(byte))) {
    return `'${path}'`;
  }
  let quoted = '"';
  for (const byte of bytes) {
    if (byte === 0x22 || byte === 0x5c) quoted += `\\${String.fromCharCode(byte)}`;
    else if (byte >= 0x20 && byte < 0x7f) quoted += String.fromCharCode(byte);
    else quoted += `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return `${quoted}"`;
}

function restoreRmWorktree(
  context: HostCommandContext,
  root: string,
  removed: RmWorktreeSnapshot[],
  removedDirectories: string[],
): string[] {
  const failures: string[] = [];
  for (const directory of [...removedDirectories].reverse()) {
    const absolute = `${root}/${directory}`;
    try {
      if (!fsExists(context.py, absolute)) context.py.FS.mkdir(absolute);
    } catch (error) {
      failures.push(`${quoteDiffPath(directory)}: ${conciseObjectError(error)}`);
    }
  }
  for (const snapshot of removed) {
    const { entry, bytes, linkTarget } = snapshot;
    const absolute = `${root}/${entry.filepath}`;
    try {
      const slash = absolute.lastIndexOf("/");
      if (slash > root.length) context.py.FS.mkdirTree(absolute.slice(0, slash));
      if (fsExists(context.py, absolute)) {
        const stat = context.py.FS.lstat(absolute);
        if (context.py.FS.isDir(stat.mode)) throw new Error("rollback target became a directory");
        forgetEmscriptenSymlinkTarget(context.py.FS, absolute);
        context.py.FS.unlink(absolute);
      }
      if (entry.mode === 0o120000) {
        const target = linkTarget ?? decoder.decode(bytes);
        context.py.FS.symlink(target, absolute);
        preserveEmscriptenSymlinkTarget(context.py.FS, absolute, target);
      } else {
        context.py.FS.writeFile(absolute, bytes);
        context.py.FS.chmod(absolute, entry.mode === 0o100755 ? 0o755 : 0o644);
      }
    } catch (error) {
      failures.push(`${quoteDiffPath(entry.filepath)}: ${conciseObjectError(error)}`);
    }
  }
  return failures;
}

async function applyRmWorktreePlan(
  context: HostCommandContext,
  root: string,
  plan: RmPlan,
  staged: Uint8Array,
): Promise<void> {
  const removed: RmWorktreeSnapshot[] = [];
  const removedDirectories: string[] = [];
  try {
    const compared = { bytes: 0 };
    for (const snapshot of plan.worktree) {
      const current = await readRmWorktreeSnapshot(
        context, root, snapshot.entry, compared,
      );
      if (
        !current.matches || !current.snapshot ||
        !equalBytes(current.snapshot.bytes, snapshot.bytes) ||
        current.snapshot.linkTarget !== snapshot.linkTarget
      ) {
        throw new Error(
          `rm worktree changed during the operation: ${quoteDiffPath(snapshot.entry.filepath)}`,
        );
      }
      const absolute = `${root}/${snapshot.entry.filepath}`;
      forgetEmscriptenSymlinkTarget(context.py.FS, absolute);
      context.py.FS.unlink(absolute);
      removed.push(snapshot);
    }
    for (const directory of plan.directories) {
      const absolute = `${root}/${directory}`;
      if (!fsExists(context.py, absolute)) continue;
      const stat = context.py.FS.lstat(absolute);
      if (!context.py.FS.isDir(stat.mode) || context.py.FS.isLink?.(stat.mode)) {
        throw new Error(`rm cleanup path is not a directory: ${quoteDiffPath(directory)}`);
      }
      const entries = context.py.FS.readdir(absolute).filter(
        (name: string) => name !== "." && name !== "..",
      );
      if (entries.length) continue;
      context.py.FS.rmdir(absolute);
      removedDirectories.push(directory);
    }
    commitRmIndex(context, root, plan.snapshot, staged);
  } catch (error) {
    const failures = restoreRmWorktree(context, root, removed, removedDirectories);
    if (failures.length) {
      throw new Error(
        `${conciseObjectError(error)}; rm rollback failed for ${failures.join(", ")}`,
      );
    }
    throw error;
  }
}

async function runRm(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  const request = parseRmRequest(context, root, args);
  const plan = await prepareRmPlan(context, root, request);
  const staged = await stageRmIndex(context, root, plan);
  if (request.cached) {
    commitRmIndex(context, root, plan.snapshot, staged);
    return result(0, "");
  }
  const output = plan.removals.map((entry) =>
    `rm ${quoteRmOutputPath(rmPathFromCwd(root, context.cwd, entry.filepath))}\n`
  ).join("");
  if (encoder.encode(output).byteLength > MAX_RM_OUTPUT_BYTES) {
    throw new GitUsageError(`rm output exceeds ${MAX_RM_OUTPUT_BYTES} bytes`);
  }
  await applyRmWorktreePlan(context, root, plan, staged);
  return result(0, output);
}

interface MvRequest {
  source: string;
  destination: string;
}

interface MvMapping {
  source: RecoveryEntry;
  destination: RecoveryEntry;
}

interface MvPlan {
  snapshot: Uint8Array;
  source: string;
  destination: string;
  sourceIdentity: string;
  mappings: MvMapping[];
}

function parseMvRequest(
  context: HostCommandContext,
  root: string,
  args: string[],
): MvRequest {
  let options = true;
  const operands: string[] = [];
  for (const arg of args) {
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (options && arg.startsWith("-")) {
      throw new GitUsageError(`unsupported mv option: ${arg}`);
    }
    operands.push(arg);
  }
  if (operands.length !== 2) {
    throw new GitUsageError("mv requires exactly one source and one destination");
  }
  let totalBytes = 0;
  const normalized: string[] = [];
  for (const operand of operands) {
    const bytes = showRefUtf8Bytes(operand);
    if (!operand || operand.includes("\0") || !bytes) {
      throw new GitUsageError("mv paths must be nonempty UTF-8 without NUL");
    }
    if (bytes.byteLength > MAX_MV_PATH_BYTES) {
      throw new GitUsageError(`mv path exceeds ${MAX_MV_PATH_BYTES} bytes`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_MV_TOTAL_PATH_BYTES) {
      throw new GitUsageError(`mv paths exceed ${MAX_MV_TOTAL_PATH_BYTES} aggregate bytes`);
    }
    if (operand.startsWith("/")) {
      throw new GitUsageError("mv paths must be relative to the worktree");
    }
    let path: string;
    try {
      path = pathFromRepository(root, context.cwd, operand);
    } catch {
      throw new GitUsageError("mv path escapes the worktree");
    }
    if (path === ".") throw new GitUsageError("mv paths must name entries below the worktree");
    if (path === ".git" || path.startsWith(".git/")) {
      throw new GitUsageError("mv cannot operate on repository metadata");
    }
    if (path.split("/").length > MAX_MV_DEPTH) {
      throw new GitUsageError(`mv path has more than ${MAX_MV_DEPTH} components`);
    }
    normalized.push(path);
  }
  const [source, destination] = normalized as [string, string];
  if (source === destination) throw new Error("mv source and destination are the same path");
  if (destination.startsWith(`${source}/`)) {
    throw new Error("mv destination is inside the source");
  }
  return { source, destination };
}

function validateMvRepositoryPath(path: string): void {
  const bytes = showRefUtf8Bytes(path);
  if (!path || !bytes || bytes.byteLength > MAX_MV_PATH_BYTES) {
    throw new GitUsageError(`mv path exceeds ${MAX_MV_PATH_BYTES} UTF-8 bytes`);
  }
  if (path.split("/").length > MAX_MV_DEPTH) {
    throw new GitUsageError(`mv path has more than ${MAX_MV_DEPTH} components`);
  }
}

function preflightMvAncestry(
  context: HostCommandContext,
  root: string,
  filepath: string,
): void {
  let parent = root;
  for (const part of filepath.split("/").slice(0, -1)) {
    parent += `/${part}`;
    const stat = worktreeStat(context, parent);
    if (!stat) throw new Error(`mv parent does not exist: ${quoteDiffPath(filepath)}`);
    if (context.py.FS.isLink?.(stat.mode)) {
      throw new Error(`mv refuses symlink ancestry at ${quoteDiffPath(filepath)}`);
    }
    if (!context.py.FS.isDir(stat.mode)) {
      throw new Error(`mv ancestry is not a directory: ${quoteDiffPath(filepath)}`);
    }
  }
}

function scanMvSource(
  context: HostCommandContext,
  root: string,
  source: string,
  destination: string,
): void {
  const stack: Array<{ repositoryPath: string; relative: string }> = [
    { repositoryPath: source, relative: "" },
  ];
  let scanned = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (++scanned > MAX_MV_SCANNED_ENTRIES) {
      throw new GitUsageError(
        `mv source scan exceeds ${MAX_MV_SCANNED_ENTRIES} entries`,
      );
    }
    validateMvRepositoryPath(current.repositoryPath);
    const mapped = current.relative
      ? `${destination}/${current.relative}`
      : destination;
    validateMvRepositoryPath(mapped);
    const absolute = `${root}/${current.repositoryPath}`;
    const stat = worktreeStat(context, absolute);
    if (!stat) throw new Error(`mv source changed during preflight: ${quoteDiffPath(source)}`);
    if (!context.py.FS.isDir(stat.mode) || context.py.FS.isLink?.(stat.mode)) continue;
    const children = context.py.FS.readdir(absolute)
      .filter((name: string) => name !== "." && name !== "..")
      .sort(compareRmPaths);
    for (let index = children.length - 1; index >= 0; index--) {
      const name = children[index]!;
      stack.push({
        repositoryPath: `${current.repositoryPath}/${name}`,
        relative: current.relative ? `${current.relative}/${name}` : name,
      });
    }
  }
}

async function prepareMvPlan(
  context: HostCommandContext,
  root: string,
  request: MvRequest,
): Promise<MvPlan> {
  const indexPath = `${root}/.git/index`;
  if (fsExists(context.py, `${indexPath}.lock`)) throw new Error("mv cannot acquire the index lock");
  const metadata = readRmIndexMetadata(context, root, "mv");
  if (metadata.snapshot.byteLength > MAX_MV_INDEX_BYTES) {
    throw new GitUsageError(`mv index exceeds ${MAX_MV_INDEX_BYTES} bytes`);
  }
  if (metadata.entries > MAX_MV_INDEX_ENTRIES) {
    throw new GitUsageError(`mv index entry limit exceeded (${MAX_MV_INDEX_ENTRIES})`);
  }
  if (metadata.unmerged) throw new Error("mv refuses an unmerged index");
  const current = await recoveryEntries(context, root, null);
  if (current.length !== metadata.entries) {
    throw new Error("mv index contains duplicate or unsupported entries");
  }
  for (const entry of current) validateMvRepositoryPath(entry.filepath);

  preflightMvAncestry(context, root, request.source);
  preflightMvAncestry(context, root, request.destination);
  const sourceAbsolute = `${root}/${request.source}`;
  const destinationAbsolute = `${root}/${request.destination}`;
  const sourceStat = worktreeStat(context, sourceAbsolute);
  if (!sourceStat) throw new Error(`mv source does not exist: ${quoteDiffPath(request.source)}`);
  if (worktreeStat(context, destinationAbsolute)) {
    throw new Error(`mv destination already exists: ${quoteDiffPath(request.destination)}`);
  }

  const exact = current.find((entry) => entry.filepath === request.source);
  const descendants = current.filter((entry) =>
    entry.filepath.startsWith(`${request.source}/`)
  );
  if (exact && descendants.length) throw new Error("mv index contains a file/directory collision");
  let selected: RecoveryEntry[];
  if (exact) {
    if (exact.type !== "commit" && context.py.FS.isDir(sourceStat.mode)) {
      throw new Error(`mv tracked file is a worktree directory: ${quoteDiffPath(request.source)}`);
    }
    selected = [exact];
  } else if (descendants.length) {
    if (!context.py.FS.isDir(sourceStat.mode) || context.py.FS.isLink?.(sourceStat.mode)) {
      throw new Error(`mv tracked directory is not a worktree directory: ${quoteDiffPath(request.source)}`);
    }
    selected = descendants;
  } else {
    throw new Error(`mv source is not tracked: ${quoteDiffPath(request.source)}`);
  }
  for (const entry of selected) {
    if (entry.type === "commit") {
      throw new Error(`mv does not support submodules: ${quoteDiffPath(entry.filepath)}`);
    }
    if (![0o100644, 0o100755, 0o120000].includes(entry.mode)) {
      throw new Error(`mv found an unsupported index mode: ${quoteDiffPath(entry.filepath)}`);
    }
  }

  scanMvSource(context, root, request.source, request.destination);
  const mappings = selected.map((entry): MvMapping => {
    const suffix = exact ? "" : entry.filepath.slice(request.source.length + 1);
    const filepath = suffix ? `${request.destination}/${suffix}` : request.destination;
    validateMvRepositoryPath(filepath);
    return { source: entry, destination: { ...entry, filepath } };
  }).sort((left, right) => compareRmPaths(left.source.filepath, right.source.filepath));

  const selectedPaths = new Set(selected.map((entry) => entry.filepath));
  const resulting = new Map(
    current.filter((entry) => !selectedPaths.has(entry.filepath))
      .map((entry) => [entry.filepath, entry]),
  );
  for (const mapping of mappings) {
    if (resulting.has(mapping.destination.filepath)) {
      throw new Error(
        `mv destination collides with the index: ${quoteDiffPath(mapping.destination.filepath)}`,
      );
    }
    resulting.set(mapping.destination.filepath, mapping.destination);
  }
  const paths = [...resulting.keys()].sort(compareRmPaths);
  for (let index = 1; index < paths.length; index++) {
    const parent = paths[index - 1]!;
    const child = paths[index]!;
    if (child.startsWith(`${parent}/`)) {
      throw new Error(`mv destination creates an index collision: ${quoteDiffPath(child)}`);
    }
  }
  if (resulting.size > MAX_MV_INDEX_ENTRIES) {
    throw new GitUsageError(`mv resulting index entry limit exceeded (${MAX_MV_INDEX_ENTRIES})`);
  }
  return {
    snapshot: metadata.snapshot,
    source: request.source,
    destination: request.destination,
    sourceIdentity: `${sourceStat.dev}:${sourceStat.ino}`,
    mappings,
  };
}

let mvIndexScratchSequence = 0;

async function stageMvIndex(
  context: HostCommandContext,
  root: string,
  plan: MvPlan,
): Promise<Uint8Array> {
  let scratch: string;
  do {
    scratch = `${root}/.git/piodide-mv-index-${++mvIndexScratchSequence}`;
  } while (fsExists(context.py, scratch));
  context.py.FS.mkdir(scratch);
  try {
    context.py.FS.writeFile(`${scratch}/index`, plan.snapshot);
    const fs = gitFs(context);
    const cache = {};
    for (const mapping of plan.mappings) {
      await isomorphicGit.updateIndex({
        fs, dir: root, gitdir: scratch, cache,
        filepath: mapping.source.filepath, remove: true, force: true,
      });
    }
    for (const mapping of plan.mappings) {
      await isomorphicGit.updateIndex({
        fs, dir: root, gitdir: scratch, cache,
        filepath: mapping.destination.filepath,
        oid: mapping.destination.oid,
        mode: mapping.destination.mode,
        add: true,
      });
    }
    let staged = new Uint8Array(context.py.FS.readFile(`${scratch}/index`) as Uint8Array);
    const sourceIntents = plan.snapshot.byteLength
      ? gitIndexIntentToAddPaths(plan.snapshot)
      : new Set<string>();
    const destinationIntents = new Set(plan.mappings.filter(
      (mapping) => sourceIntents.has(mapping.source.filepath),
    ).map((mapping) => mapping.destination.filepath));
    if (destinationIntents.size) {
      staged = new Uint8Array(await markGitIndexIntentToAdd(staged, destinationIntents));
    }
    if (staged.byteLength > MAX_MV_INDEX_BYTES) {
      throw new GitUsageError(`mv resulting index exceeds ${MAX_MV_INDEX_BYTES} bytes`);
    }
    return staged.slice();
  } finally {
    removeRmIndexScratch(context, scratch);
  }
}

function applyMvPlan(
  context: HostCommandContext,
  root: string,
  plan: MvPlan,
  staged: Uint8Array,
): void {
  preflightMvAncestry(context, root, plan.source);
  preflightMvAncestry(context, root, plan.destination);
  const sourceAbsolute = `${root}/${plan.source}`;
  const destinationAbsolute = `${root}/${plan.destination}`;
  const sourceStat = worktreeStat(context, sourceAbsolute);
  if (!sourceStat || `${sourceStat.dev}:${sourceStat.ino}` !== plan.sourceIdentity) {
    throw new Error(`mv source changed during the operation: ${quoteDiffPath(plan.source)}`);
  }
  if (worktreeStat(context, destinationAbsolute)) {
    throw new Error(`mv destination appeared during the operation: ${quoteDiffPath(plan.destination)}`);
  }
  context.py.FS.rename(sourceAbsolute, destinationAbsolute);
  try {
    commitRmIndex(context, root, plan.snapshot, staged, "mv");
  } catch (error) {
    try {
      if (worktreeStat(context, sourceAbsolute)) throw new Error("source path became occupied");
      if (!worktreeStat(context, destinationAbsolute)) throw new Error("destination disappeared");
      context.py.FS.rename(destinationAbsolute, sourceAbsolute);
    } catch (rollbackError) {
      throw new Error(
        `${conciseObjectError(error)}; mv rollback failed: ${conciseObjectError(rollbackError)}`,
      );
    }
    throw error;
  }
}

async function runMv(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  const request = parseMvRequest(context, root, args);
  const plan = await prepareMvPlan(context, root, request);
  const staged = await stageMvIndex(context, root, plan);
  applyMvPlan(context, root, plan, staged);
  return result(0, "");
}

interface CleanStatShape {
  dev?: number;
  ino?: number;
  mode: number;
  size?: number;
  mtime?: unknown;
  ctime?: unknown;
}

function cleanStatTime(value: unknown): string {
  if (value instanceof Date) return String(value.getTime());
  if (typeof value === "number" || typeof value === "string") return String(value);
  return "";
}

function cleanNodeIdentity(stat: CleanStatShape): string {
  return `${stat.dev ?? ""}:${stat.ino ?? ""}:${stat.mode}`;
}

function cleanLeafIdentity(stat: CleanStatShape): string {
  return `${cleanNodeIdentity(stat)}:${stat.size ?? ""}:` +
    `${cleanStatTime(stat.mtime)}:${cleanStatTime(stat.ctime)}`;
}

function preflightCleanSelectorAncestry(
  context: HostCommandContext,
  root: string,
  filepath: string,
): void {
  if (filepath === ".") return;
  let parent = root;
  for (const part of filepath.split("/").slice(0, -1)) {
    parent += `/${part}`;
    const stat = worktreeStat(context, parent);
    if (!stat) return;
    if (context.py.FS.isLink?.(stat.mode)) {
      throw new Error(`clean refuses symlink ancestry at ${quoteDiffPath(filepath)}`);
    }
    if (!context.py.FS.isDir(stat.mode)) {
      throw new Error(`clean ancestry is not a directory at ${quoteDiffPath(filepath)}`);
    }
  }
}

interface IgnoredCleanRequest {
  root: string;
  dryRun: boolean;
  directories: boolean;
  nul: boolean;
  operands: string[];
  selected: string[];
  cwdScope: string;
  validateSelectorPath: (path: string) => void;
}

async function runIgnoredClean(
  context: HostCommandContext,
  request: IgnoredCleanRequest,
): Promise<HostCommandResult> {
  const {
    root, dryRun, directories, nul, operands, selected, cwdScope, validateSelectorPath,
  } = request;
  if (!fsIsDir(context.py, `${root}/.git`)) throw new Error("clean requires a Git worktree");

  for (const path of selected) preflightCleanSelectorAncestry(context, root, path);

  const inspected = new Set<string>();
  const leaves = new Map<string, string>();
  const directoryIdentities = new Map<string, string>();
  const childrenByDirectory = new Map<string, string[]>();
  const validateScannedPath = (path: string): void => {
    try {
      validateSelectorPath(path);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : String(error));
    }
    inspected.add(path);
    if (inspected.size > MAX_CLEAN_SCANNED_ENTRIES) {
      throw new Error(`clean scan exceeds ${MAX_CLEAN_SCANNED_ENTRIES} entries`);
    }
  };
  const scan = (relative: string): void => {
    if (relative === ".git" || relative.startsWith(".git/")) return;
    if (relative !== "." && inspected.has(relative)) return;
    const absolute = relative === "." ? root : `${root}/${relative}`;
    const stat = worktreeStat(context, absolute);
    if (!stat) return;
    if (relative !== ".") validateScannedPath(relative);
    if (!context.py.FS.isDir(stat.mode) || context.py.FS.isLink?.(stat.mode)) {
      if (relative !== ".") leaves.set(relative, cleanLeafIdentity(stat));
      return;
    }
    if (relative !== ".") directoryIdentities.set(relative, cleanNodeIdentity(stat));
    const children = context.py.FS.readdir(absolute)
      .filter((name: string) => name !== "." && name !== "..")
      .map((name: string) => relative === "." ? name : `${relative}/${name}`)
      .filter((path: string) => path !== ".git")
      .sort(compareRmPaths);
    if (relative !== ".") childrenByDirectory.set(relative, children);
    for (const child of children) scan(child);
  };
  for (const path of selected) scan(path);

  const paths = [...leaves.keys(), ...directoryIdentities.keys()].sort(compareRmPaths);
  let ignoreFs: ReturnType<typeof gitFs>;
  let tracked: Set<string>;
  try {
    ({ fs: ignoreFs, tracked } = await prepareCheckIgnoreRepository(
      context,
      root,
      paths.map((relative) => ({ original: relative, relative })),
    ));
  } catch (error) {
    const detail = error instanceof CheckIgnoreFailure && error.kind === "input"
      ? "ignore or index inspection limit exceeded"
      : "cannot inspect repository ignore rules or index";
    throw new Error(`clean ${detail}`);
  }

  const ignored = new Set<string>();
  const classify = async (path: string): Promise<void> => {
    if (tracked.has(path)) return;
    const directory = directoryIdentities.has(path);
    if (await isomorphicGit.isIgnored({
      fs: ignoreFs,
      dir: root,
      filepath: directory ? `${path}/` : path,
    })) ignored.add(path);
  };
  for (let start = 0; start < paths.length; start += 256) {
    await Promise.all(paths.slice(start, start + 256).map(classify));
  }

  const removableFiles = [...leaves.keys()].filter((path) => ignored.has(path))
    .sort(compareRmPaths);
  const removableFileSet = new Set(removableFiles);
  const defaultProtectedDirectory = operands.length === 0 && cwdScope !== "." ? cwdScope : null;
  const cleanableMemo = new Map<string, boolean>();
  const cleanableDirectory = (path: string): boolean => {
    const memoized = cleanableMemo.get(path);
    if (memoized !== undefined) return memoized;
    const cleanable = ignored.has(path) && (childrenByDirectory.get(path) ?? []).every((child) =>
      directoryIdentities.has(child)
        ? cleanableDirectory(child)
        : removableFileSet.has(child)
    );
    cleanableMemo.set(path, cleanable);
    return cleanable;
  };
  const removableDirectories = directories
    ? [...directoryIdentities.keys()].filter((path) =>
        path !== defaultProtectedDirectory && cleanableDirectory(path)
      ).sort((left, right) => {
        const depth = right.split("/").length - left.split("/").length;
        return depth || compareRmPaths(left, right);
      })
    : [];
  const removed = [
    ...removableFiles,
    ...removableDirectories.map((path) => `${path}/`),
  ];
  if (removed.length > MAX_CLEAN_CANDIDATES) {
    throw new Error(`clean candidate count exceeds ${MAX_CLEAN_CANDIDATES}`);
  }
  const renderRecord = (path: string, preview: boolean): string => nul
    ? `${path}\0`
    : `${preview ? "Would remove" : "Removing"} ${path}\n`;
  const output = removed.map((path) => renderRecord(path, dryRun)).join("");
  if (encoder.encode(output).byteLength > MAX_CLEAN_OUTPUT_BYTES) {
    throw new Error(`clean output exceeds ${MAX_CLEAN_OUTPUT_BYTES} bytes`);
  }
  if (dryRun) return result(0, output);

  const indexPath = `${root}/.git/index`;
  const indexStat = worktreeStat(context, indexPath);
  const indexIdentity = indexStat ? cleanLeafIdentity(indexStat) : null;
  const assertIndexUnchanged = (): void => {
    const current = worktreeStat(context, indexPath);
    if ((current ? cleanLeafIdentity(current) : null) !== indexIdentity) {
      throw new Error("clean index changed during the operation");
    }
  };
  const assertLeafUnchanged = (path: string): void => {
    preflightCleanSelectorAncestry(context, root, path);
    const stat = worktreeStat(context, `${root}/${path}`);
    if (
      !stat || context.py.FS.isDir(stat.mode) ||
      cleanLeafIdentity(stat) !== leaves.get(path)
    ) {
      throw new Error(`clean candidate changed during the operation: ${quoteDiffPath(path)}`);
    }
  };
  const assertDirectoryUnchanged = (path: string, requireEmpty = false): void => {
    preflightCleanSelectorAncestry(context, root, path);
    const absolute = `${root}/${path}`;
    const stat = worktreeStat(context, absolute);
    if (
      !stat || !context.py.FS.isDir(stat.mode) || context.py.FS.isLink?.(stat.mode) ||
      cleanNodeIdentity(stat) !== directoryIdentities.get(path)
    ) {
      throw new Error(`clean directory changed during the operation: ${quoteDiffPath(`${path}/`)}`);
    }
    const children = context.py.FS.readdir(absolute)
      .filter((name: string) => name !== "." && name !== "..")
      .map((name: string) => `${path}/${name}`)
      .sort(compareRmPaths);
    if (requireEmpty ? children.length !== 0 :
      children.length !== (childrenByDirectory.get(path) ?? []).length ||
      children.some((child: string, index: number) => child !== childrenByDirectory.get(path)![index])) {
      throw new Error(`clean directory contents changed during the operation: ${quoteDiffPath(`${path}/`)}`);
    }
  };

  assertIndexUnchanged();
  for (const path of removableFiles) assertLeafUnchanged(path);
  for (const path of removableDirectories) assertDirectoryUnchanged(path);
  const stillIgnored = await Promise.all([
    ...removableFiles.map((path) => isomorphicGit.isIgnored({ fs: ignoreFs, dir: root, filepath: path })),
    ...removableDirectories.map((path) =>
      isomorphicGit.isIgnored({ fs: ignoreFs, dir: root, filepath: `${path}/` })
    ),
  ]);
  if (stillIgnored.some((value) => !value)) {
    throw new Error("clean ignore rules changed during the operation");
  }
  assertIndexUnchanged();

  let completed = "";
  const runtimeFailure = (path: string, error: unknown): HostCommandResult => {
    const response: HostCommandResult = {
      exitCode: 1,
      stderr: encoder.encode(
        `git: clean failed to remove ${quoteDiffPath(path)}: ${conciseObjectError(error)}\n`,
      ),
    };
    if (completed) response.stdout = encoder.encode(completed);
    return response;
  };
  for (const path of removableFiles) {
    try {
      assertIndexUnchanged();
      assertLeafUnchanged(path);
      forgetEmscriptenSymlinkTarget(context.py.FS, `${root}/${path}`);
      context.py.FS.unlink(`${root}/${path}`);
      completed += renderRecord(path, false);
    } catch (error) {
      return runtimeFailure(path, error);
    }
  }
  for (const path of removableDirectories) {
    const display = `${path}/`;
    try {
      assertIndexUnchanged();
      assertDirectoryUnchanged(path, true);
      context.py.FS.rmdir(`${root}/${path}`);
      completed += renderRecord(display, false);
    } catch (error) {
      return runtimeFailure(display, error);
    }
  }
  return result(0, completed);
}

async function runClean(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  let force = false;
  let dryRun = false;
  let directories = false;
  let nul = false;
  let ignoredOnly = false;
  let options = true;
  const operands: string[] = [];
  for (const arg of args) {
    if (options && arg === "--") {
      options = false;
      continue;
    }
    if (!options) {
      operands.push(arg);
      continue;
    }
    if (arg === "-f" || arg === "--force") force = true;
    else if (arg === "-n" || arg === "--dry-run") dryRun = true;
    else if (arg === "-d") directories = true;
    else if (arg === "-z" || arg === "--null") nul = true;
    else if (arg === "-X" || arg === "--ignored-only") ignoredOnly = true;
    else if (/^-[nfdzX]{2,}$/.test(arg)) {
      force ||= arg.includes("f");
      dryRun ||= arg.includes("n");
      directories ||= arg.includes("d");
      nul ||= arg.includes("z");
      ignoredOnly ||= arg.includes("X");
    } else if (arg.startsWith("-")) {
      throw new GitUsageError(`unsupported clean option: ${arg}`);
    } else {
      throw new GitUsageError("clean path selectors must follow --");
    }
  }
  if (!force && !dryRun) throw new GitUsageError("clean requires -n (preview) or -f");
  if (operands.length > MAX_CLEAN_SELECTORS) {
    throw new GitUsageError(`clean accepts at most ${MAX_CLEAN_SELECTORS} path selectors`);
  }
  let selectorBytes = 0;
  for (const operand of operands) {
    const bytes = showRefUtf8Bytes(operand);
    if (!operand || operand.includes("\0") || !bytes) {
      throw new GitUsageError("clean path selectors must be nonempty UTF-8 without NUL");
    }
    if (bytes.byteLength > MAX_CLEAN_PATH_BYTES) {
      throw new GitUsageError(`clean path selector exceeds ${MAX_CLEAN_PATH_BYTES} bytes`);
    }
    selectorBytes += bytes.byteLength;
    if (selectorBytes > MAX_CLEAN_TOTAL_SELECTOR_BYTES) {
      throw new GitUsageError(
        `clean path selectors exceed ${MAX_CLEAN_TOTAL_SELECTOR_BYTES} aggregate bytes`,
      );
    }
  }
  const cwdScope = pathFromRepository(root, context.cwd, ".");
  const selected = operands.length
    ? operands.map((path) => pathFromRepository(root, context.cwd, path))
    : [cwdScope];
  const validatePath = (path: string): void => {
    const bytes = showRefUtf8Bytes(path);
    if (!path || path.includes("\0") || !bytes || bytes.byteLength > MAX_CLEAN_PATH_BYTES) {
      throw new GitUsageError(`clean candidate path exceeds ${MAX_CLEAN_PATH_BYTES} UTF-8 bytes`);
    }
    if (path.split("/").length > MAX_CLEAN_DEPTH) {
      throw new GitUsageError(`clean traversal exceeds depth ${MAX_CLEAN_DEPTH}`);
    }
  };
  for (const path of selected) validatePath(path);
  if (ignoredOnly) {
    return runIgnoredClean(context, {
      root,
      dryRun,
      directories,
      nul,
      operands,
      selected,
      cwdScope,
      validateSelectorPath: validatePath,
    });
  }
  const defaultProtectedDirectory = operands.length === 0 && cwdScope !== "." ? cwdScope : null;
  const selectedPath = (filepath: string) => recoveryPathSelected(filepath, selected);
  const explicitlySelectedFile = (filepath: string) => operands.length > 0 && selected.includes(filepath);
  const matrix = await isomorphicGit.statusMatrix({ fs: gitFs(context), dir: root });
  if (matrix.length > MAX_CLEAN_SCANNED_ENTRIES) {
    throw new GitUsageError(`clean scan exceeds ${MAX_CLEAN_SCANNED_ENTRIES} entries`);
  }
  const inspected = new Set<string>();
  for (const [filepath] of matrix) {
    validatePath(filepath);
    inspected.add(filepath);
  }
  const untracked = matrix.filter(([, head, workdir, stage]) => head === 0 && workdir === 2 && stage === 0)
    .map(([filepath]) => filepath).filter(selectedPath).sort();
  const tracked = matrix.filter(([, head, , stage]) => head !== 0 || stage !== 0)
    .map(([filepath]) => filepath);
  const removableFiles = new Set<string>();
  const directoryCandidates = new Set<string>();
  for (const filepath of untracked) {
    const absolute = `${root}/${filepath}`;
    const stat = context.py.FS.lstat(absolute);
    if (context.py.FS.isDir(stat.mode) && selectedPath(filepath)) directoryCandidates.add(filepath);
    else removableFiles.add(filepath);
    let parent = filepath;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      if (parent && selectedPath(parent)) directoryCandidates.add(parent);
    }
  }

  const cleanableMemo = new Map<string, boolean>();
  const cleanableDirectory = (relative: string): boolean => {
    const memoized = cleanableMemo.get(relative);
    if (memoized !== undefined) return memoized;
    const absolute = `${root}/${relative}`;
    let cleanable = true;
    for (const name of context.py.FS.readdir(absolute)) {
      if (name === "." || name === "..") continue;
      const child = `${relative}/${name}`;
      validatePath(child);
      inspected.add(child);
      if (inspected.size > MAX_CLEAN_SCANNED_ENTRIES) {
        throw new GitUsageError(`clean scan exceeds ${MAX_CLEAN_SCANNED_ENTRIES} entries`);
      }
      const stat = context.py.FS.lstat(`${root}/${child}`);
      if (context.py.FS.isDir(stat.mode)) {
        if (!directoryCandidates.has(child) || !cleanableDirectory(child)) {
          cleanable = false;
          break;
        }
      } else if (!removableFiles.has(child)) {
        cleanable = false;
        break;
      }
    }
    cleanableMemo.set(relative, cleanable);
    return cleanable;
  };
  const removableDirectories = directories
    ? [...directoryCandidates].filter((path) =>
        path !== defaultProtectedDirectory && cleanableDirectory(path)
      ).sort((left, right) => {
        const depth = right.split("/").length - left.split("/").length;
        return depth || left.localeCompare(right);
      })
    : [];

  const insideUntrackedDirectory = (filepath: string): boolean => {
    const parts = filepath.split("/");
    for (let length = 1; length < parts.length; length++) {
      const directory = parts.slice(0, length).join("/");
      if (!tracked.some((path) => path === directory || path.startsWith(`${directory}/`))) return true;
    }
    return false;
  };
  const removableFileList = untracked.filter((path) =>
    removableFiles.has(path) &&
    (directories || explicitlySelectedFile(path) || !insideUntrackedDirectory(path))
  );
  const removed = [
    ...removableFileList,
    ...removableDirectories.map((path) => `${path}/`),
  ];
  if (removed.length > MAX_CLEAN_CANDIDATES) {
    throw new GitUsageError(`clean candidate count exceeds ${MAX_CLEAN_CANDIDATES}`);
  }
  const output = nul
    ? removed.map((path) => `${path}\0`).join("")
    : removed.map((path) => `${dryRun ? "Would remove" : "Removing"} ${path}\n`).join("");
  if (encoder.encode(output).byteLength > MAX_CLEAN_OUTPUT_BYTES) {
    throw new GitUsageError(`clean output exceeds ${MAX_CLEAN_OUTPUT_BYTES} bytes`);
  }
  if (!dryRun) {
    for (const filepath of removableFileList) {
      try {
        context.py.FS.unlink(`${root}/${filepath}`);
      } catch (error) {
        throw new Error(`clean failed to remove ${quoteDiffPath(filepath)}: ${conciseObjectError(error)}`);
      }
    }
    for (const directory of removableDirectories) {
      try {
        context.py.FS.rmdir(`${root}/${directory}`);
      } catch (error) {
        throw new Error(`clean failed to remove ${quoteDiffPath(`${directory}/`)}: ${conciseObjectError(error)}`);
      }
    }
  }
  return result(0, output);
}

function stashReflogLines(py: Pyodide, root: string): string[] {
  const path = `${root}/.git/logs/refs/stash`;
  return fsExists(py, path)
    ? fsReadText(py, path).split(/\r?\n/).filter(Boolean)
    : [];
}

function stashOidFromReflog(line: string): string | undefined {
  const oid = line.split(/\s+/, 3)[1];
  return /^[0-9a-f]{40}$/.test(oid || "") ? oid : undefined;
}

async function repairStashRef(context: HostCommandContext, root: string): Promise<void> {
  const lines = stashReflogLines(context.py, root);
  const refPath = `${root}/.git/refs/stash`;
  const logPath = `${root}/.git/logs/refs/stash`;
  if (!lines.length) {
    if (fsExists(context.py, refPath)) context.py.FS.unlink(refPath);
    if (fsExists(context.py, logPath)) context.py.FS.unlink(logPath);
    return;
  }
  const oid = stashOidFromReflog(lines.at(-1)!);
  if (!oid) throw new Error("stash reflog contains an invalid object id");
  await isomorphicGit.writeRef({
    fs: gitFs(context), dir: root, ref: "refs/stash", value: oid, force: true,
  });
}

function renderStashList(py: Pyodide, root: string): string {
  return stashReflogLines(py, root).reverse().map((line, index) => {
    const tab = line.indexOf("\t");
    const message = tab >= 0 ? line.slice(tab + 1) : "stash entry";
    return `stash@{${index}}: ${message}\n`;
  }).join("");
}

interface StashableState {
  changed: boolean;
  regularChanges: StashRegularChange[];
}

interface StashRegularChange {
  filepath: string;
  rawContent: Uint8Array;
  rawMode: number;
  blobContent: Uint8Array;
  gitMode: number;
}

async function stashableState(
  context: HostCommandContext,
  root: string,
): Promise<StashableState> {
  const rows = await isomorphicGit.walk({
    fs: gitFs(context),
    dir: root,
    trees: [isomorphicGit.TREE({ ref: "HEAD" }), isomorphicGit.WORKDIR(), isomorphicGit.STAGE()],
    map: async (filepath, [head, worktree, stage]) => {
      if (filepath === "." || (!head && !stage)) return undefined;
      const [headType, worktreeType, stageType] = await Promise.all([
        head?.type(), worktree?.type(), stage?.type(),
      ]);
      if (![headType, worktreeType, stageType].some((type) => type === "blob" || type === "commit")) {
        return undefined;
      }
      const headIdentity = head && headType !== "tree"
        ? `${await head.mode()}:${await head.oid()}`
        : null;
      const stageIdentity = stage && stageType !== "tree"
        ? `${await stage.mode()}:${await stage.oid()}`
        : null;
      let worktreeIdentity: string | null = null;
      let worktreeContent: Uint8Array | undefined;
      if (worktree && worktreeType === "blob") {
        // WorkdirEntry.oid() intentionally trusts Git's index stat cache. Hash
        // the bytes directly so a rapid same-size edit cannot disappear from
        // an agent's stash request.
        const content = await worktree.content();
        if (content) {
          worktreeContent = new Uint8Array(content);
          const { oid } = await isomorphicGit.hashBlob({ object: content });
          worktreeIdentity = `${await worktree.mode()}:${oid}`;
        }
      } else if (worktree && worktreeType === "commit") {
        worktreeIdentity = `${await worktree.mode()}:${await worktree.oid()}`;
      }
      const worktreeDiffers = stageIdentity !== worktreeIdentity;
      let regularChange: StashRegularChange | undefined;
      if (worktreeDiffers && worktree && worktreeType === "blob" && worktreeContent) {
        const worktreeMode = await worktree.mode();
        const path = `${root}/${filepath}`;
        const stat = context.py.FS.lstat(path);
        if (
          (worktreeMode & 0o170000) === 0o100000 &&
          !context.py.FS.isLink?.(stat.mode)
        ) {
          regularChange = {
            filepath,
            rawContent: new Uint8Array(context.py.FS.readFile(path) as Uint8Array),
            rawMode: stat.mode & 0o777,
            blobContent: worktreeContent,
            gitMode: worktreeMode,
          };
        }
      }
      return {
        changed: headIdentity !== stageIdentity || worktreeDiffers,
        regularChange,
      };
    },
  }) as Array<{
    changed: boolean;
    regularChange?: StashRegularChange;
  } | undefined>;
  return {
    changed: rows.some((row) => row?.changed),
    regularChanges: rows.flatMap((row) => row?.regularChange ? [row.regularChange] : []),
  };
}

function forceNativeStashDetection(
  context: HostCommandContext,
  root: string,
  entries: StashRegularChange[],
): void {
  for (const entry of entries) {
    const padded = new Uint8Array(entry.rawContent.byteLength + 1);
    padded.set(entry.rawContent);
    padded[padded.byteLength - 1] = 0;
    context.py.FS.writeFile(`${root}/${entry.filepath}`, padded);
    context.py.FS.chmod(`${root}/${entry.filepath}`, entry.rawMode);
  }
}

function restoreForcedStashChanges(
  context: HostCommandContext,
  root: string,
  entries: StashRegularChange[],
): void {
  for (const entry of entries) {
    context.py.FS.writeFile(`${root}/${entry.filepath}`, entry.rawContent);
    context.py.FS.chmod(`${root}/${entry.filepath}`, entry.rawMode);
  }
}

interface StashTreeEdit {
  files: Map<string, { oid: string; mode: string }>;
  directories: Map<string, StashTreeEdit>;
}

function stashTreeEdits(
  replacements: Map<string, { oid: string; mode: string }>,
): StashTreeEdit {
  const root: StashTreeEdit = { files: new Map(), directories: new Map() };
  for (const [filepath, replacement] of replacements) {
    const parts = filepath.split("/");
    const name = parts.pop()!;
    let node = root;
    for (const part of parts) {
      let child = node.directories.get(part);
      if (!child) {
        child = { files: new Map(), directories: new Map() };
        node.directories.set(part, child);
      }
      node = child;
    }
    node.files.set(name, replacement);
  }
  return root;
}

async function rewriteStashTree(
  context: HostCommandContext,
  root: string,
  oid: string,
  edits: StashTreeEdit,
): Promise<string> {
  const fs = gitFs(context);
  const { tree } = await isomorphicGit.readTree({ fs, dir: root, oid });
  const entries = new Map(tree.map((entry) => [entry.path, entry]));
  for (const [name, replacement] of edits.files) {
    const existing = entries.get(name);
    if (!existing || existing.type === "tree") {
      throw new Error(`stash tree does not contain regular path ${name}`);
    }
    entries.set(name, { path: name, type: "blob", ...replacement });
  }
  for (const [name, childEdits] of edits.directories) {
    const existing = entries.get(name);
    if (!existing || existing.type !== "tree") {
      throw new Error(`stash tree does not contain directory ${name}`);
    }
    entries.set(name, {
      ...existing,
      oid: await rewriteStashTree(context, root, existing.oid, childEdits),
    });
  }
  return isomorphicGit.writeTree({ fs, dir: root, tree: [...entries.values()] });
}

async function patchTopStash(
  context: HostCommandContext,
  root: string,
  entries: StashRegularChange[],
): Promise<void> {
  if (!entries.length) return;
  const fs = gitFs(context);
  const lines = stashReflogLines(context.py, root);
  const oldOid = lines.length ? stashOidFromReflog(lines.at(-1)!) : undefined;
  if (!oldOid) throw new Error("new stash entry is missing from the reflog");
  const replacements = new Map<string, { oid: string; mode: string }>();
  for (const entry of entries) {
    replacements.set(entry.filepath, {
      oid: await isomorphicGit.writeBlob({ fs, dir: root, blob: entry.blobContent }),
      mode: entry.gitMode.toString(8),
    });
  }
  const { commit } = await isomorphicGit.readCommit({ fs, dir: root, oid: oldOid });
  const tree = await rewriteStashTree(context, root, commit.tree, stashTreeEdits(replacements));
  const newOid = await isomorphicGit.writeCommit({ fs, dir: root, commit: { ...commit, tree } });
  const line = lines.at(-1)!;
  const match = /^([0-9a-f]{40}) ([0-9a-f]{40})(.*)$/.exec(line);
  if (!match || match[2] !== oldOid) throw new Error("new stash reflog entry is malformed");
  lines[lines.length - 1] = `${match[1]} ${newOid}${match[3]}`;
  fsWriteText(context.py, `${root}/.git/logs/refs/stash`, `${lines.join("\n")}\n`);
  await isomorphicGit.writeRef({ fs, dir: root, ref: "refs/stash", value: newOid, force: true });
}

function stashFailureDetail(response: Libgit2Result): string {
  return normalizeLibgitOutput(response.stderr || response.stdout).trim().replace(/\s+/g, " ");
}

async function stashChangedPaths(
  context: HostCommandContext,
  root: string,
  oid: string,
): Promise<string[]> {
  const { commit } = await isomorphicGit.readCommit({ fs: gitFs(context), dir: root, oid });
  const base = commit.parent[0];
  if (!base) return [];
  const records = await structuralDiffNames(context, root, [base, oid], false, false);
  return [...new Set(records.flatMap((record) => record.paths))];
}

function stashConflictMarker(bytes: Uint8Array): boolean {
  if (bytes.byteLength > MAX_APPLY_BYTES) return false;
  const text = decoder.decode(bytes);
  return /(^|\n)<<<<<<< Updated upstream\r?\n[\s\S]*\r?\n=======\r?\n[\s\S]*\r?\n>>>>>>> Stashed changes(?:\r?\n|$)/.test(text);
}

function stashPathBytes(context: HostCommandContext, root: string, filepath: string): Uint8Array | null {
  const path = `${root}/${filepath}`;
  try {
    const stat = context.py.FS.lstat(path);
    if (context.py.FS.isDir(stat.mode) || context.py.FS.isLink?.(stat.mode)) return null;
    return new Uint8Array(context.py.FS.readFile(path) as Uint8Array);
  } catch {
    return null;
  }
}

function equalBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

async function applyTopStash(
  context: HostCommandContext,
  root: string,
): Promise<HostCommandResult> {
  const lines = stashReflogLines(context.py, root);
  const oid = lines.length ? stashOidFromReflog(lines.at(-1)!) : undefined;
  if (!oid) return errorResult(1, "git: no stash entries found\n");
  const paths = await stashChangedPaths(context, root, oid);
  const before = new Map(paths.map((path) => [path, stashPathBytes(context, root, path)]));
  const applied = await invoke(context, ["stash", "apply"], root);
  await repairStashRef(context, root);
  if (applied.exitCode !== 0) {
    const detail = stashFailureDetail(applied);
    return errorResult(1, `git: unable to apply stash; stash retained${detail ? `: ${detail}` : ""}\n`);
  }
  const nativeStatus = await invoke(context, ["status", "--porcelain"], root);
  const conflicts = new Set(conflictPathsFromStatus(`${nativeStatus.stdout}\n${nativeStatus.stderr}`));
  for (const path of paths) {
    const after = stashPathBytes(context, root, path);
    if (!equalBytes(before.get(path) ?? null, after) && after && stashConflictMarker(after)) {
      conflicts.add(path);
    }
  }
  if (conflicts.size) {
    return errorResult(
      1,
      `git: stash apply produced conflicts in ${[...conflicts].sort().map(quoteStatusPath).join(", ")}; ` +
        "stash retained\n",
    );
  }
  return result(0, "");
}

async function dropTopStash(
  context: HostCommandContext,
  root: string,
): Promise<HostCommandResult> {
  const lines = stashReflogLines(context.py, root);
  if (!lines.length) {
    await repairStashRef(context, root);
    return errorResult(1, "git: no stash entries found\n");
  }
  const remaining = lines.slice(0, -1);
  const logPath = `${root}/.git/logs/refs/stash`;
  if (remaining.length) fsWriteText(context.py, logPath, `${remaining.join("\n")}\n`);
  else if (fsExists(context.py, logPath)) context.py.FS.unlink(logPath);
  await repairStashRef(context, root);
  return result(0, "Dropped refs/stash@{0}\n");
}

async function runStash(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  const operation = args[0] ?? "push";
  const operands = args.slice(1);
  if (!["push", "list", "apply", "pop", "drop"].includes(operation)) {
    throw new GitUsageError(`unsupported stash operation: ${operation}`);
  }
  if (operands.length) {
    const unavailable = operation === "push" && operands.some((value) =>
      value === "-m" || value === "--message" || value.startsWith("--message=")
    ) ? "custom stash messages are unavailable" :
      `stash ${operation} targets the top entry and accepts no options or operands`;
    throw new GitUsageError(unavailable);
  }
  await repairStashRef(context, root);
  if (operation === "list") return result(0, renderStashList(context.py, root));
  if (operation === "apply") return applyTopStash(context, root);
  if (operation === "drop") return dropTopStash(context, root);
  if (operation === "pop") {
    const applied = await applyTopStash(context, root);
    if (applied.exitCode !== 0) return applied;
    return dropTopStash(context, root);
  }
  if (fsExists(context.py, `${root}/.git/MERGE_HEAD`)) {
    return errorResult(1, "git: cannot stash during a merge\n");
  }
  try {
    await isomorphicGit.resolveRef({ fs: gitFs(context), dir: root, ref: "HEAD" });
  } catch {
    return errorResult(1, "git: cannot stash before the initial commit\n");
  }
  const state = await stashableState(context, root);
  if (!state.changed) {
    return result(0, "No local changes to save\n");
  }
  let pushed: Libgit2Result;
  try {
    // wasm-git's libgit2 can miss a same-size edit made in the same timestamp
    // tick. A one-byte temporary size change forces native detection; the
    // newly-created stash tree is then rewritten with the exact original blob.
    forceNativeStashDetection(context, root, state.regularChanges);
    pushed = await invoke(context, ["stash", "push"], root);
  } catch (error) {
    restoreForcedStashChanges(context, root, state.regularChanges);
    throw error;
  }
  await repairStashRef(context, root);
  if (pushed.exitCode !== 0) {
    restoreForcedStashChanges(context, root, state.regularChanges);
    const detail = stashFailureDetail(pushed);
    return errorResult(1, `git: unable to save stash${detail ? `: ${detail}` : ""}\n`);
  }
  try {
    await patchTopStash(context, root, state.regularChanges);
  } catch (error) {
    const restored = await invoke(context, ["stash", "apply"], root);
    restoreForcedStashChanges(context, root, state.regularChanges);
    if (restored.exitCode === 0) {
      await invoke(context, ["stash", "drop"], root);
    }
    await repairStashRef(context, root);
    const detail = error instanceof Error ? error.message : String(error);
    return errorResult(
      1,
      `git: unable to finalize stash; original changes restored${
        restored.exitCode === 0 ? "" : "; recovery stash retained"
      }: ${detail}\n`,
    );
  }
  return result(0, normalizeLibgitOutput(pushed.stdout));
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
    const { commit } = await isomorphicGit.readCommit({ fs: gitFs(context), dir: root, oid });
    // Preserve isomorphic-git's established diagnostics for unsupported root
    // and merge commits. It validates those forms before touching repository
    // state, so the bounded preflight is only needed for a pick it can execute.
    if (commit.parent.length === 1) {
      const preflight = await preflightCherryPick(context, root, oid, commit.parent[0]);
      if (preflight) return preflight;
    }
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
  let indexedObjects = 0;
  for (const name of py.FS.readdir(directory)) {
    if (!name.endsWith(".idx")) continue;
    const bytes = py.FS.readFile(`${directory}/${name}`) as Uint8Array;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version2 = bytes.length >= 8 && view.getUint32(0) === 0xff744f63;
    const fanout = version2 ? 8 : 0;
    if (version2 && view.getUint32(4) !== 2) throw new Error(`unsupported pack index version in ${name}`);
    if (bytes.length < fanout + 1024) throw new Error(`truncated pack index: ${name}`);
    const count = view.getUint32(fanout + 255 * 4);
    indexedObjects += count;
    if (indexedObjects > MAX_FSCK_OBJECTS) {
      throw new Error(`fsck object limit exceeded (${MAX_FSCK_OBJECTS})`);
    }
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
        if (!/^[0-9a-f]{38}$/.test(suffix)) continue;
        objects.add(`${prefix}${suffix}`);
        if (objects.size > MAX_FSCK_OBJECTS) {
          throw new Error(`fsck object limit exceeded (${MAX_FSCK_OBJECTS})`);
        }
      }
    }
  }
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
    if (seen.size >= MAX_FSCK_OBJECTS) {
      throw new Error(`fsck object limit exceeded (${MAX_FSCK_OBJECTS})`);
    }
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

interface LsFilesRequest {
  stage: boolean;
  nul: boolean;
  cached: boolean;
  modified: boolean;
  deleted: boolean;
  others: boolean;
  excludeStandard: boolean;
  paths: string[];
}

function parseLsFilesArgs(args: string[]): LsFilesRequest {
  let stage = false;
  let nul = false;
  let cached = false;
  let modified = false;
  let deleted = false;
  let others = false;
  let excludeStandard = false;
  let pathOperands = false;
  const paths: string[] = [];
  for (const arg of args) {
    if (pathOperands) { paths.push(arg); continue; }
    if (arg === "--") { pathOperands = true; continue; }
    if (arg === "--stage" || arg === "-s") stage = true;
    else if (arg === "-z") nul = true;
    else if (arg === "--cached" || arg === "-c") cached = true;
    else if (arg === "--modified" || arg === "-m") modified = true;
    else if (arg === "--deleted" || arg === "-d") deleted = true;
    else if (arg === "--others" || arg === "-o") others = true;
    else if (arg === "--exclude-standard") excludeStandard = true;
    else throw new GitUsageError(`unsupported ls-files option: ${arg}`);
  }
  if (excludeStandard && !others) {
    throw new GitUsageError("ls-files --exclude-standard requires --others");
  }
  if (stage && (modified || deleted || others)) {
    throw new GitUsageError("ls-files --stage only supports the cached index");
  }
  if (paths.length > MAX_LS_FILES_PATHS) {
    throw new GitUsageError(`ls-files accepts at most ${MAX_LS_FILES_PATHS} paths`);
  }
  for (const path of paths) {
    const bytes = showRefUtf8Bytes(path);
    if (!path || path.includes("\0") || !bytes) {
      throw new GitUsageError("ls-files path operands must be nonempty UTF-8 without NUL");
    }
    if (bytes.byteLength > MAX_LS_FILES_PATH_BYTES) {
      throw new GitUsageError(`ls-files path operand exceeds ${MAX_LS_FILES_PATH_BYTES} bytes`);
    }
  }
  return { stage, nul, cached, modified, deleted, others, excludeStandard, paths };
}

function normalizeLsFilesPaths(
  context: HostCommandContext,
  root: string,
  paths: string[],
): string[] {
  const normalized = new Set<string>();
  for (const path of paths) {
    try {
      normalized.add(pathFromRepository(root, context.cwd, path));
    } catch {
      throw new GitUsageError("ls-files path escapes the worktree");
    }
  }
  return [...normalized];
}

function lsFilesPathSelected(path: string, selectors: string[]): boolean {
  return !selectors.length || selectors.some(
    (selector) => selector === "." || path === selector || path.startsWith(`${selector}/`),
  );
}

function appendLsFilesRecord(output: string[], state: { bytes: number }, record: string): void {
  const length = encoder.encode(record).byteLength;
  if (length > MAX_LS_FILES_OUTPUT_BYTES - state.bytes) {
    throw new GitUsageError(`ls-files output exceeds ${MAX_LS_FILES_OUTPUT_BYTES} bytes`);
  }
  output.push(record);
  state.bytes += length;
}

async function runLsFiles(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const request = parseLsFilesArgs(args);
  try {
    const root = repositoryRoot(context.py, context.cwd);
    const selectors = normalizeLsFilesPaths(context, root, request.paths);
    const fs = gitFs(context);
    const terminator = request.nul ? "\0" : "\n";
    const output: string[] = [];
    const outputState = { bytes: 0 };
    if (request.stage) {
      let candidates = 0;
      await isomorphicGit.walk({
        fs,
        dir: root,
        trees: [isomorphicGit.STAGE()],
        map: async (filepath, [entry]) => {
          if (filepath === "." || !entry || await entry.type() === "tree") return undefined;
          if (++candidates > MAX_LS_FILES_ENTRIES) {
            throw new GitUsageError(`ls-files candidate entry limit exceeded (${MAX_LS_FILES_ENTRIES})`);
          }
          if (!lsFilesPathSelected(filepath, selectors)) return undefined;
          appendLsFilesRecord(
            output,
            outputState,
            `${(await entry.mode()).toString(8).padStart(6, "0")} ${await entry.oid()} 0\t${filepath}${terminator}`,
          );
          return undefined;
        },
      });
      return result(0, output.join(""));
    }

    const filtersRequested = request.cached || request.modified || request.deleted || request.others;
    if (!filtersRequested) request.cached = true;
    const rows = await isomorphicGit.statusMatrix({ fs, dir: root, ignored: request.others });
    if (rows.length > MAX_LS_FILES_ENTRIES) {
      throw new GitUsageError(`ls-files candidate entry limit exceeded (${MAX_LS_FILES_ENTRIES})`);
    }
    const selected = new Set<string>();
    for (const [path, , worktree, index] of rows) {
      if (path === ".git" || path.startsWith(".git/") || !lsFilesPathSelected(path, selectors)) continue;
      if (request.cached && index !== 0) selected.add(path);
      if (request.modified && index !== 0 && worktree !== index) selected.add(path);
      if (request.deleted && index !== 0 && worktree === 0) selected.add(path);
      if (request.others && index === 0 && worktree !== 0) {
        if (!request.excludeStandard || !(await isomorphicGit.isIgnored({ fs, dir: root, filepath: path }))) {
          selected.add(path);
        }
      }
    }
    for (const path of [...selected].sort()) {
      appendLsFilesRecord(output, outputState, `${path}${terminator}`);
    }
    return result(0, output.join(""));
  } catch (error) {
    if (error instanceof GitUsageError) throw error;
    throw new GitUsageError(error instanceof Error ? error.message : String(error));
  }
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

function quoteStatusPath(path: string): string {
  const bytes = encoder.encode(path);
  if ([...bytes].every((byte) => byte > 0x20 && byte < 0x7f && byte !== 0x22 && byte !== 0x5c)) {
    return path;
  }
  const namedEscapes: Record<number, string> = {
    0x07: "a", 0x08: "b", 0x09: "t", 0x0a: "n", 0x0b: "v", 0x0c: "f", 0x0d: "r",
  };
  let quoted = '"';
  for (const byte of bytes) {
    if (byte === 0x22 || byte === 0x5c) quoted += `\\${String.fromCharCode(byte)}`;
    else if (namedEscapes[byte]) quoted += `\\${namedEscapes[byte]}`;
    else if (byte >= 0x20 && byte < 0x7f) quoted += String.fromCharCode(byte);
    else quoted += `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return `${quoted}"`;
}

function decodeGitQuotedPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const bytes: number[] = [];
  const escapes: Record<string, number> = {
    a: 0x07, b: 0x08, t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d,
    '"': 0x22, "\\": 0x5c,
  };
  for (let index = 1; index < value.length - 1; index++) {
    const character = value[index];
    if (character !== "\\") {
      bytes.push(...encoder.encode(character));
      continue;
    }
    const escaped = value[++index];
    if (escaped === undefined) break;
    if (escapes[escaped] !== undefined) {
      bytes.push(escapes[escaped]);
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      while (octal.length < 3 && /[0-7]/.test(value[index + 1] ?? "")) octal += value[++index];
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    bytes.push(...encoder.encode(escaped));
  }
  return decoder.decode(new Uint8Array(bytes));
}

function diffPathSelected(path: string, paths: string[]): boolean {
  return !paths.length || paths.some((selected) =>
    selected === "." || path === selected || path.startsWith(`${selected}/`)
  );
}

function diffSectionPaths(section: string): string[] {
  const paths: string[] = [];
  for (const marker of section.matchAll(/^(?:---|\+\+\+) (.+)$/gm)) {
    const decoded = decodeGitQuotedPath(marker[1]);
    if (decoded === "/dev/null") continue;
    paths.push(decoded.replace(/^[ab]\//, ""));
  }
  if (paths.length) return [...new Set(paths)];
  const header = section.slice(0, section.indexOf("\n") < 0 ? section.length : section.indexOf("\n"));
  const body = header.replace(/^diff --git /, "");
  const quoted = /^("(?:\\.|[^"])*") ("(?:\\.|[^"])*")$/.exec(body);
  if (quoted) {
    return [...new Set(quoted.slice(1).map((value) => decodeGitQuotedPath(value).replace(/^[ab]\//, "")))];
  }
  if (body.startsWith("a/")) {
    for (let split = body.indexOf(" b/"); split >= 0; split = body.indexOf(" b/", split + 1)) {
      const left = body.slice(2, split);
      const right = body.slice(split + 3);
      if (left === right) return [left];
    }
  }
  return [];
}

function changedPathsFromPatch(output: string): Set<string> {
  const changed = new Set<string>();
  const starts = [...output.matchAll(/^diff --git /gm)].map((match) => match.index!);
  starts.push(output.length);
  for (let index = 0; index + 1 < starts.length; index++) {
    for (const path of diffSectionPaths(output.slice(starts[index], starts[index + 1]))) {
      changed.add(path);
    }
  }
  return changed;
}

function filterDiffPaths(output: string, paths: string[], records: DiffNameRecord[] = []): string {
  if (!paths.length || !output) return output;
  const starts = [...output.matchAll(/^diff --git /gm)].map((match) => match.index!);
  if (!starts.length) return output;
  starts.push(output.length);
  const selected: string[] = [];
  for (let index = 0; index + 1 < starts.length; index++) {
    const section = output.slice(starts[index], starts[index + 1]);
    const sectionPaths = records.length === starts.length - 1 && records[index]
      ? records[index].paths
      : diffSectionPaths(section);
    if (sectionPaths.some((path) => diffPathSelected(path, paths))) selected.push(section);
  }
  return selected.join("");
}

function filterDiffExcludedPaths(output: string, excluded: Set<string>): string {
  if (!excluded.size || !output) return output;
  const starts = [...output.matchAll(/^diff --git /gm)].map((match) => match.index!);
  if (!starts.length) return output;
  starts.push(output.length);
  const selected: string[] = [];
  for (let index = 0; index + 1 < starts.length; index++) {
    const section = output.slice(starts[index], starts[index + 1]);
    if (!diffSectionPaths(section).some((path) => excluded.has(path))) selected.push(section);
  }
  return selected.join("");
}

interface DiffNameRecord {
  raw: string;
  status?: string;
  paths: string[];
  oldOid?: string;
  newOid?: string;
}

async function resolveDiffRevision(context: HostCommandContext, root: string, revision: string): Promise<string> {
  const resolved = await invoke(context, ["rev-parse", revision], root);
  const oid = resolved.stdout.trim();
  if (resolved.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(oid)) {
    throw new Error(`unknown revision: ${revision}`);
  }
  return oid;
}

async function findMergeBase(
  context: HostCommandContext,
  root: string,
  left: string,
  right: string,
): Promise<string | undefined> {
  const fs = gitFs(context);
  const oids = await Promise.all([
    resolveDiffRevision(context, root, left),
    resolveDiffRevision(context, root, right),
  ]);
  const bases = await isomorphicGit.findMergeBase({ fs, dir: root, oids });
  return bases[0];
}

async function resolveMergeBaseCommit(
  context: HostCommandContext,
  root: string,
  revision: string,
): Promise<Awaited<ReturnType<typeof isomorphicGit.readCommit>>> {
  const oid = await resolveDiffRevision(context, root, revision);
  return isomorphicGit.readCommit({ fs: gitFs(context), dir: root, oid });
}

async function mergeBaseIsAncestor(
  context: HostCommandContext,
  root: string,
  ancestorRevision: string,
  descendantRevision: string,
): Promise<boolean> {
  // Resolve and validate both operands before traversal so false is reserved
  // for a fully evaluated graph predicate, never a bad revision or object.
  const ancestor = await resolveMergeBaseCommit(context, root, ancestorRevision);
  const descendant = await resolveMergeBaseCommit(context, root, descendantRevision);
  if (ancestor.oid === descendant.oid) return true;

  const pending = [descendant.oid];
  const visited = new Set<string>();
  const cached = new Map([[descendant.oid, descendant]]);
  let edges = 0;
  while (pending.length) {
    const oid = pending.pop()!;
    if (visited.has(oid)) continue;
    if (visited.size >= MAX_MERGE_BASE_ANCESTOR_COMMITS) {
      throw new Error("merge-base --is-ancestor traversal limit exceeded");
    }
    const entry = cached.get(oid) ?? await isomorphicGit.readCommit({
      fs: gitFs(context), dir: root, oid,
    });
    visited.add(entry.oid);
    if (entry.oid === ancestor.oid) return true;
    for (let index = entry.commit.parent.length - 1; index >= 0; index--) {
      edges++;
      if (edges > MAX_MERGE_BASE_ANCESTOR_EDGES) {
        throw new Error("merge-base --is-ancestor traversal limit exceeded");
      }
      const parent = entry.commit.parent[index];
      if (!visited.has(parent)) pending.push(parent);
    }
  }
  return false;
}

async function runMergeBase(
  context: HostCommandContext,
  args: string[],
): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  if (args[0] === "--is-ancestor") {
    if (
      args.length !== 3 ||
      args.slice(1).some((arg) => !arg || encoder.encode(arg).byteLength > MAX_GIT_REVISION_BYTES)
    ) {
      return errorResult(2, MERGE_BASE_USAGE);
    }
    return result(
      await mergeBaseIsAncestor(context, root, args[1], args[2]) ? 0 : 1,
      "",
    );
  }
  if (args.includes("--is-ancestor") || args.some((arg) => arg.startsWith("-"))) {
    return errorResult(2, MERGE_BASE_USAGE);
  }
  if (args.length !== 2 || args.some((arg) => arg.startsWith("-"))) {
    throw new GitUsageError("git merge-base requires exactly two revisions");
  }
  const base = await findMergeBase(context, root, args[0], args[1]);
  return base ? result(0, `${base}\n`) : result(1, "");
}

async function runCatFile(
  context: HostCommandContext,
  args: string[],
): Promise<HostCommandResult> {
  if (!catFilePredicateRequested(args)) {
    return runLibgitCommand(context, context.cwd, ["cat-file", ...args]);
  }
  if (
    args.length !== 2 ||
    args[0] !== "-e" ||
    args[1].startsWith("-") ||
    encoder.encode(args[1]).byteLength > MAX_GIT_REVISION_BYTES
  ) {
    return result(2, "");
  }

  const root = repositoryRoot(context.py, context.cwd);
  const expression = args[1];
  if (!expression) return result(1, "");

  const exists = await invoke(context, ["cat-file", "-e", expression], root);
  if (exists.exitCode === 0) return result(0, "");

  // Native rev-parse preserves the full object-expression surface already
  // supported by cat-file (including ancestry, peeling, and REV:path). Once
  // resolved, readObject distinguishes a missing/dangling object from bytes
  // that exist but cannot be validated.
  const resolved = await invoke(context, ["rev-parse", expression], root);
  let oid = resolved.stdout.trim();
  if (resolved.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(oid)) {
    if (/^[0-9a-f]{40}$/.test(expression)) {
      oid = expression;
    } else {
      try {
        oid = await isomorphicGit.resolveRef({ fs: gitFs(context), dir: root, ref: expression });
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: unknown }).code === "NotFoundError"
        ) {
          return result(1, "");
        }
        throw error;
      }
    }
  }
  try {
    await isomorphicGit.readObject({ fs: gitFs(context), dir: root, oid, format: "content" });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "NotFoundError"
    ) {
      return result(1, "");
    }
    throw error;
  }
  throw new Error(`cat-file could not validate object expression: ${expression}`);
}

async function structuralDiffNames(
  context: HostCommandContext,
  root: string,
  revisions: string[],
  cached: boolean,
  unborn: boolean,
  verifiedWorktreeChanges?: Set<string>,
): Promise<DiffNameRecord[]> {
  const fs = gitFs(context, { hideIntentToAdd: cached });
  let trees: ReturnType<typeof isomorphicGit.TREE>[];
  let workdir = false;
  let stageGuard = false;
  if (revisions.length >= 2) {
    trees = [
      isomorphicGit.TREE({ ref: await resolveDiffRevision(context, root, revisions[0]) }),
      isomorphicGit.TREE({ ref: await resolveDiffRevision(context, root, revisions[1]) }),
    ];
  } else if (cached) {
    const left = revisions[0]
      ? await resolveDiffRevision(context, root, revisions[0])
      : unborn ? EMPTY_TREE_OID : await resolveDiffRevision(context, root, "HEAD");
    trees = [isomorphicGit.TREE({ ref: left }), isomorphicGit.STAGE() as ReturnType<typeof isomorphicGit.TREE>];
  } else if (revisions.length === 1) {
    trees = [
      isomorphicGit.TREE({ ref: await resolveDiffRevision(context, root, revisions[0]) }),
      isomorphicGit.WORKDIR() as ReturnType<typeof isomorphicGit.TREE>,
      isomorphicGit.STAGE() as ReturnType<typeof isomorphicGit.TREE>,
    ];
    workdir = stageGuard = true;
  } else {
    trees = [
      isomorphicGit.STAGE() as ReturnType<typeof isomorphicGit.TREE>,
      isomorphicGit.WORKDIR() as ReturnType<typeof isomorphicGit.TREE>,
    ];
    workdir = true;
  }
  const records = await isomorphicGit.walk({
    fs,
    dir: root,
    trees,
    map: async (filepath, entries) => {
      if (filepath === ".") return undefined;
      const left = entries[0];
      const right = entries[1];
      const guard = entries[2];
      if ((left && await left.type() === "tree") || (right && await right.type() === "tree")) return undefined;
      if (stageGuard && !left && right && !guard) return undefined;
      if (workdir && !left && right && revisions.length === 0) return undefined;
      const oldOid = left ? await left.oid() : undefined;
      const newOid = right ? await right.oid() : undefined;
      const oldMode = left ? await left.mode() : undefined;
      const newMode = right ? await right.mode() : undefined;
      // isomorphic-git's WORKDIR walker may reuse an index OID when every
      // cached stat field is unchanged. Browser MEMFS can produce that state
      // after an immediate equal-length rewrite. The native full patch has
      // already compared the bytes, so its path set is authoritative for this
      // projection and must override a racy-clean OID equality.
      if (
        oldOid === newOid && oldMode === newMode &&
        !(workdir && verifiedWorktreeChanges?.has(filepath))
      ) return undefined;
      const status = !left ? "A" : !right ? "D" : "M";
      return { raw: `${status}\t${quoteDiffPath(filepath)}`, status, paths: [filepath], oldOid, newOid };
    },
  }) as Array<DiffNameRecord | undefined>;
  return records.filter((record): record is DiffNameRecord => Boolean(record));
}

function coalesceExactRenames(records: DiffNameRecord[]): DiffNameRecord[] {
  const deleted = new Map<string, DiffNameRecord[]>();
  const added = new Map<string, DiffNameRecord[]>();
  for (const record of records) {
    if (record.status === "D" && record.oldOid) {
      deleted.set(record.oldOid, [...(deleted.get(record.oldOid) ?? []), record]);
    } else if (record.status === "A" && record.newOid) {
      added.set(record.newOid, [...(added.get(record.newOid) ?? []), record]);
    }
  }
  const replacements = new Map<DiffNameRecord, DiffNameRecord>();
  const consumed = new Set<DiffNameRecord>();
  for (const [oid, oldRecords] of deleted) {
    const newRecords = added.get(oid);
    if (oldRecords.length !== 1 || newRecords?.length !== 1) continue;
    replacements.set(oldRecords[0], {
      raw: `R100\t${quoteDiffPath(oldRecords[0].paths[0])}\t${quoteDiffPath(newRecords[0].paths[0])}`,
      status: "R100",
      paths: [oldRecords[0].paths[0], newRecords[0].paths[0]],
      oldOid: oid,
      newOid: oid,
    });
    consumed.add(newRecords[0]);
  }
  return records.flatMap((record) => {
    const replacement = replacements.get(record);
    if (replacement) return [replacement];
    return consumed.has(record) ? [] : [record];
  });
}

function renderDiffNames(records: DiffNameRecord[], nameStatus: boolean, paths: string[], nul: boolean): string {
  if (records.length > MAX_DIFF_PROJECTION_RECORDS) {
    throw new GitUsageError(
      `git diff name projection record limit exceeded (${MAX_DIFF_PROJECTION_RECORDS})`,
    );
  }
  for (const record of records) {
    for (const path of record.paths) {
      if (encoder.encode(path).byteLength > MAX_DIFF_PROJECTION_PATH_BYTES) {
        throw new GitUsageError(
          `git diff name projection pathname limit exceeded (${MAX_DIFF_PROJECTION_PATH_BYTES} bytes)`,
        );
      }
    }
  }
  const selected = records.filter((record) =>
    record.paths.some((path) => diffPathSelected(path, paths))
  );
  let output: string;
  if (!nameStatus) {
    const names = selected.map((record) => record.paths.at(-1)!);
    output = names.map((path) => `${nul ? path : quoteDiffPath(path)}${nul ? "\0" : "\n"}`).join("");
  } else if (!nul) {
    output = selected.length ? `${selected.map((record) => record.raw).join("\n")}\n` : "";
  } else {
    output = selected.map((record) => `${record.status}\0${record.paths.join("\0")}\0`).join("");
  }
  if (encoder.encode(output).byteLength > MAX_DIFF_PROJECTION_OUTPUT_BYTES) {
    throw new GitUsageError(
      `git diff name projection output limit exceeded (${MAX_DIFF_PROJECTION_OUTPUT_BYTES} bytes)`,
    );
  }
  return output;
}

function renderDiffStat(patch: string, records: DiffNameRecord[] = []): string {
  if (!patch) return "";
  const starts = [...patch.matchAll(/^diff --git /gm)].map((match) => match.index!);
  if (!starts.length) return "";
  starts.push(patch.length);
  const lines: string[] = [];
  let insertions = 0;
  let deletions = 0;
  for (let index = 0; index + 1 < starts.length; index++) {
    const section = patch.slice(starts[index], starts[index + 1]);
    const path = records[index]?.paths.at(-1) ?? diffSectionPaths(section).at(-1) ?? "unknown";
    let added = 0;
    let removed = 0;
    for (const line of section.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    insertions += added;
    deletions += removed;
    const total = added + removed;
    const graph = `${"+".repeat(Math.min(added, 40))}${"-".repeat(Math.min(removed, 40))}` ||
      (/^Binary files /m.test(section) ? "Bin" : "0");
    lines.push(` ${quoteDiffPath(path)} | ${total} ${graph}\n`);
  }
  const files = starts.length - 1;
  const summary = [`${files} file${files === 1 ? "" : "s"} changed`];
  if (insertions) summary.push(`${insertions} insertion${insertions === 1 ? "" : "s"}(+)`);
  if (deletions) summary.push(`${deletions} deletion${deletions === 1 ? "" : "s"}(-)`);
  return `${lines.join("")} ${summary.join(", ")}\n`;
}

function numstatLimit(kind: string, maximum: number): never {
  throw new GitUsageError(`--numstat limit exceeded: ${kind} (maximum ${maximum})`);
}

function worktreeDiffBytes(
  context: HostCommandContext,
  root: string,
  path: string,
): Uint8Array | undefined {
  const absolute = `${root}/${path}`;
  if (!fsExists(context.py, absolute)) return undefined;
  const stat = context.py.FS.lstat(absolute);
  if (context.py.FS.isDir(stat.mode)) return undefined;
  if (context.py.FS.isLink?.(stat.mode)) {
    const target = preservedEmscriptenSymlinkTarget(context.py.FS, absolute) ??
      context.py.FS.readlink(absolute);
    return encoder.encode(target);
  }
  if (stat.size > MAX_NUMSTAT_BLOB_BYTES) {
    numstatLimit("input blob bytes", MAX_NUMSTAT_BLOB_BYTES);
  }
  return new Uint8Array(context.py.FS.readFile(absolute) as Uint8Array);
}

interface NumstatPreflightState {
  objectBlobs: Map<string, Uint8Array>;
  worktreeBlobs: Map<string, Uint8Array | undefined>;
  examinedBytes: number;
}

function numstatPreflightState(): NumstatPreflightState {
  return {
    objectBlobs: new Map(),
    worktreeBlobs: new Map(),
    examinedBytes: 0,
  };
}

async function preflightNumstat(
  context: HostCommandContext,
  root: string,
  records: DiffNameRecord[],
  newFromWorktree: boolean,
  state = numstatPreflightState(),
): Promise<Map<DiffNameRecord, boolean>> {
  if (records.length > MAX_NUMSTAT_RECORDS) numstatLimit("records", MAX_NUMSTAT_RECORDS);
  for (const record of records) {
    for (const path of record.paths) {
      if (encoder.encode(path).byteLength > MAX_NUMSTAT_PATH_BYTES) {
        numstatLimit("pathname bytes", MAX_NUMSTAT_PATH_BYTES);
      }
    }
  }

  const fs = gitFs(context);
  const examine = (bytes: Uint8Array | undefined): boolean => {
    if (!bytes) return false;
    if (bytes.byteLength > MAX_NUMSTAT_BLOB_BYTES) {
      numstatLimit("input blob bytes", MAX_NUMSTAT_BLOB_BYTES);
    }
    state.examinedBytes += bytes.byteLength;
    if (state.examinedBytes > MAX_NUMSTAT_TOTAL_BLOB_BYTES) {
      numstatLimit("total input blob bytes", MAX_NUMSTAT_TOTAL_BLOB_BYTES);
    }
    return bytes.subarray(0, NUMSTAT_BINARY_PROBE_BYTES).includes(0);
  };
  const objectBlob = async (oid: string | undefined): Promise<Uint8Array | undefined> => {
    if (!oid) return undefined;
    let bytes = state.objectBlobs.get(oid);
    if (!bytes) {
      const value = await isomorphicGit.readBlob({ fs, dir: root, oid });
      bytes = new Uint8Array(value.blob);
      state.objectBlobs.set(oid, bytes);
    }
    return bytes;
  };
  const worktreeBlob = (path: string): Uint8Array | undefined => {
    if (!state.worktreeBlobs.has(path)) {
      state.worktreeBlobs.set(path, worktreeDiffBytes(context, root, path));
    }
    return state.worktreeBlobs.get(path);
  };

  const binary = new Map<DiffNameRecord, boolean>();
  for (const record of records) {
    const oldBinary = examine(await objectBlob(record.oldOid));
    const newBytes = newFromWorktree
      ? worktreeBlob(record.paths.at(-1)!)
      : await objectBlob(record.newOid);
    binary.set(record, oldBinary || examine(newBytes));
  }
  return binary;
}

function renderDiffNumstat(
  patch: string,
  records: DiffNameRecord[],
  binary: Map<DiffNameRecord, boolean>,
  nul: boolean,
): string {
  if (!records.length) return "";
  const starts = [...patch.matchAll(/^diff --git /gm)].map((match) => match.index!);
  if (starts.length !== records.length) {
    throw new GitUsageError("git diff --numstat could not align patch records");
  }
  starts.push(patch.length);
  let output = "";
  let outputBytes = 0;
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    let added: number | "-" = 0;
    let deleted: number | "-" = 0;
    if (binary.get(record)) {
      added = deleted = "-";
    } else {
      let inHunk = false;
      const section = patch.slice(starts[index], starts[index + 1]);
      for (const line of section.split("\n")) {
        if (line.startsWith("@@ ")) { inHunk = true; continue; }
        if (!inHunk) continue;
        if (line.startsWith("+")) added++;
        else if (line.startsWith("-")) deleted++;
      }
      if (added > MAX_NUMSTAT_LINE_COUNT) {
        numstatLimit("additions per record", MAX_NUMSTAT_LINE_COUNT);
      }
      if (deleted > MAX_NUMSTAT_LINE_COUNT) {
        numstatLimit("deletions per record", MAX_NUMSTAT_LINE_COUNT);
      }
    }
    const path = record.paths.at(-1)!;
    const row = `${added}\t${deleted}\t${nul ? path : quoteDiffPath(path)}${nul ? "\0" : "\n"}`;
    outputBytes += encoder.encode(row).byteLength;
    if (outputBytes > MAX_NUMSTAT_OUTPUT_BYTES) {
      numstatLimit("stdout bytes", MAX_NUMSTAT_OUTPUT_BYTES);
    }
    output += row;
  }
  return output;
}

function checkDiffWhitespace(output: string): string {
  const failures: string[] = [];
  let path = "unknown";
  let newLine = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("+++ ")) {
      const decoded = decodeGitQuotedPath(line.slice(4));
      path = decoded.startsWith("b/") ? decoded.slice(2) : decoded;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1);
      const indentation = content.match(/^[ \t]*/)?.[0] ?? "";
      if (/[ \t]+$/.test(content) || indentation.includes(" \t")) {
        failures.push(`${path}:${newLine}: trailing whitespace.\n${line}\n`);
      }
      newLine++;
    } else if (!line.startsWith("-") && !line.startsWith("\\ No newline")) {
      newLine++;
    }
  }
  return failures.join("");
}

interface PatchLine {
  text: string;
  newline: boolean;
}

interface PatchHunkLine extends PatchLine {
  operation: " " | "+" | "-";
}

interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: PatchHunkLine[];
}

interface PatchFile {
  source: string | null;
  destination: string | null;
  hunks: PatchHunk[];
  rename: boolean;
}

interface PatchPlan extends PatchFile {
  sourcePath: string | null;
  destinationPath: string | null;
  bytes: Uint8Array;
}

interface CachedPatchPlan extends PatchFile {
  sourceEntry: RecoveryEntry | null;
  bytes: Uint8Array;
  mode: number;
}

function splitTextLines(value: string): PatchLine[] {
  const lines: PatchLine[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== "\n") continue;
    lines.push({ text: value.slice(start, index), newline: true });
    start = index + 1;
  }
  if (start < value.length) lines.push({ text: value.slice(start), newline: false });
  return lines;
}

function decodePatchText(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GitUsageError(`${label} is not valid UTF-8; binary patches are unsupported`);
  }
}

function patchRelativePath(value: string, side: "a" | "b"): string | null {
  if (value === "/dev/null") return null;
  const decoded = decodeGitQuotedPath(value);
  const prefix = `${side}/`;
  const path = decoded.startsWith(prefix) ? decoded.slice(prefix.length) : decoded;
  if (
    !path || path.startsWith("/") || path.includes("\0") ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    path === ".git" || path.startsWith(".git/")
  ) {
    throw new GitUsageError(`unsafe patch path: ${JSON.stringify(path)}`);
  }
  if (encoder.encode(path).byteLength > MAX_APPLY_PATH_BYTES) {
    throw new GitUsageError(`patch path exceeds ${MAX_APPLY_PATH_BYTES} bytes`);
  }
  return path;
}

function parsePatchCount(value: string | undefined): number {
  const parsed = value === undefined ? 1 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new GitUsageError("invalid patch hunk count");
  return parsed;
}

function parsePatchSection(lines: string[], sectionNumber: number): PatchFile {
  let source: string | null | undefined;
  let destination: string | null | undefined;
  let renameSource: string | undefined;
  let renameDestination: string | undefined;
  let modeChange = false;
  let unsupportedNewMode = false;
  let symlinkMode = false;
  const hunks: PatchHunk[] = [];
  let totalLines = 0;

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === "GIT binary patch" || line.startsWith("Binary files ")) {
      throw new GitUsageError(`patch section ${sectionNumber}: binary patches are unsupported`);
    }
    if (line.startsWith("old mode ") || line.startsWith("new mode ")) modeChange = true;
    if (line.startsWith("new file mode ") && line.slice(14) !== "100644") unsupportedNewMode = true;
    if (/^(?:new file mode|deleted file mode|old mode|new mode) 120000$/.test(line) ||
        /^index [0-9a-f]+\.\.[0-9a-f]+ 120000$/.test(line)) symlinkMode = true;
    if (line.startsWith("rename from ")) renameSource = patchRelativePath(line.slice(12), "a")!;
    if (line.startsWith("rename to ")) renameDestination = patchRelativePath(line.slice(10), "b")!;
    if (line.startsWith("--- ")) source = patchRelativePath(line.slice(4), "a");
    if (line.startsWith("+++ ")) destination = patchRelativePath(line.slice(4), "b");
    if (!line.startsWith("@@ ")) continue;

    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/.exec(line);
    if (!header) throw new GitUsageError(`patch section ${sectionNumber}: invalid hunk header`);
    const oldStart = Number(header[1]);
    const oldCount = parsePatchCount(header[2]);
    const newStart = Number(header[3]);
    const newCount = parsePatchCount(header[4]);
    if (!Number.isSafeInteger(oldStart) || oldStart < 0 ||
        !Number.isSafeInteger(newStart) || newStart < 0) {
      throw new GitUsageError(`patch section ${sectionNumber}: invalid hunk start`);
    }
    const hunkLines: PatchHunkLine[] = [];
    let oldSeen = 0;
    let newSeen = 0;
    while (oldSeen < oldCount || newSeen < newCount) {
      const body = lines[++index];
      if (body === undefined) throw new GitUsageError(`patch section ${sectionNumber}: truncated hunk`);
      const operation = body[0];
      if (operation !== " " && operation !== "+" && operation !== "-") {
        throw new GitUsageError(`patch section ${sectionNumber}: invalid hunk line`);
      }
      const entry: PatchHunkLine = { operation, text: body.slice(1), newline: true };
      hunkLines.push(entry);
      if (operation !== "+") oldSeen++;
      if (operation !== "-") newSeen++;
      if (oldSeen > oldCount || newSeen > newCount) {
        throw new GitUsageError(`patch section ${sectionNumber}: hunk count mismatch`);
      }
      totalLines++;
      if (totalLines > MAX_APPLY_LINES) {
        throw new GitUsageError(`patch line limit exceeded (${MAX_APPLY_LINES})`);
      }
      if (lines[index + 1] === "\\ No newline at end of file") {
        entry.newline = false;
        index++;
      }
    }
    hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines });
    if (hunks.length > MAX_APPLY_HUNKS) {
      throw new GitUsageError(`patch hunk limit exceeded (${MAX_APPLY_HUNKS})`);
    }
  }

  source = renameSource ?? source;
  destination = renameDestination ?? destination;
  const rename = renameSource !== undefined || renameDestination !== undefined;
  if (source === undefined || destination === undefined) {
    if (!(rename && renameSource && renameDestination)) {
      throw new GitUsageError(`patch section ${sectionNumber}: missing ---/+++ file markers`);
    }
  }
  if (symlinkMode) throw new GitUsageError(`patch section ${sectionNumber}: symlink patches are unsupported`);
  if (modeChange) throw new GitUsageError(`patch section ${sectionNumber}: file mode changes are unsupported`);
  if (unsupportedNewMode) {
    throw new GitUsageError(`patch section ${sectionNumber}: new files must use regular mode 100644`);
  }
  if (source === null && destination === null) {
    throw new GitUsageError(`patch section ${sectionNumber}: both paths are /dev/null`);
  }
  if (!hunks.length && !rename && source !== null && destination !== null) {
    throw new GitUsageError(`patch section ${sectionNumber}: contains no hunks`);
  }
  return {
    source: source as string | null,
    destination: destination as string | null,
    hunks,
    rename,
  };
}

function parseGitPatch(text: string): PatchFile[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > MAX_APPLY_LINES) {
    throw new GitUsageError(`patch line limit exceeded (${MAX_APPLY_LINES})`);
  }
  const starts: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].startsWith("diff --git ")) starts.push(index);
  }
  if (!starts.length) throw new GitUsageError("patch contains no 'diff --git' sections");
  if (starts.length > MAX_APPLY_FILES) {
    throw new GitUsageError(`patch file limit exceeded (${MAX_APPLY_FILES})`);
  }
  starts.push(lines.length);
  const files = starts.slice(0, -1).map((start, index) =>
    parsePatchSection(lines.slice(start, starts[index + 1]), index + 1)
  );
  const hunks = files.reduce((count, file) => count + file.hunks.length, 0);
  const changedLines = files.reduce(
    (count, file) => count + file.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0),
    0,
  );
  if (hunks > MAX_APPLY_HUNKS) throw new GitUsageError(`patch hunk limit exceeded (${MAX_APPLY_HUNKS})`);
  if (changedLines > MAX_APPLY_LINES) {
    throw new GitUsageError(`patch line limit exceeded (${MAX_APPLY_LINES})`);
  }
  return files;
}

function reversePatchFiles(files: PatchFile[]): PatchFile[] {
  return files.map((file) => ({
    source: file.destination,
    destination: file.source,
    rename: file.rename,
    hunks: file.hunks.map((hunk) => ({
      oldStart: hunk.newStart,
      oldCount: hunk.newCount,
      newStart: hunk.oldStart,
      newCount: hunk.oldCount,
      lines: hunk.lines.map((line) => ({
        text: line.text,
        newline: line.newline,
        operation: line.operation === "+" ? "-" : line.operation === "-" ? "+" : " ",
      })),
    })),
  }));
}

function patchLinesEqual(left: PatchLine | undefined, right: PatchLine): boolean {
  return Boolean(left && left.text === right.text && left.newline === right.newline);
}

function applyPatchHunks(source: PatchLine[], file: PatchFile): PatchLine[] {
  const output: PatchLine[] = [];
  let cursor = 0;
  for (const hunk of file.hunks) {
    const offset = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (offset < cursor || offset > source.length) {
      throw new GitApplyConflictError(`patch failed: ${file.source ?? file.destination}: invalid hunk position`);
    }
    output.push(...source.slice(cursor, offset));
    cursor = offset;
    for (const line of hunk.lines) {
      if (line.operation === "+") {
        output.push({ text: line.text, newline: line.newline });
        continue;
      }
      if (!patchLinesEqual(source[cursor], line)) {
        throw new GitApplyConflictError(`patch failed: ${file.source ?? file.destination}:${cursor + 1}`);
      }
      if (line.operation === " ") output.push(source[cursor]);
      cursor++;
    }
  }
  output.push(...source.slice(cursor));
  return output;
}

function encodePatchLines(lines: PatchLine[]): Uint8Array {
  return encoder.encode(lines.map((line) => `${line.text}${line.newline ? "\n" : ""}`).join(""));
}

function regularFileBytes(
  context: HostCommandContext,
  path: string,
  inapplicable = false,
): Uint8Array {
  const fail = (message: string): never => {
    throw inapplicable ? new GitApplyConflictError(message) : new GitUsageError(message);
  };
  if (!fsExists(context.py, path)) return fail(`patch source does not exist: ${path}`);
  let stat;
  try {
    stat = context.py.FS.lstat(path);
  } catch (error) {
    throw new GitUsageError(`cannot inspect patch file ${path}: ${conciseObjectError(error)}`);
  }
  if (context.py.FS.isDir(stat.mode) || context.py.FS.isLink?.(stat.mode)) {
    return fail(`patch source is not a regular file: ${path}`);
  }
  try {
    return context.py.FS.readFile(path) as Uint8Array;
  } catch (error) {
    throw new GitUsageError(`cannot read patch file ${path}: ${conciseObjectError(error)}`);
  }
}

function patchAbsolutePath(root: string, relative: string | null): string | null {
  return relative === null ? null : `${root}/${relative}`;
}

function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

function preparePatchPlans(
  context: HostCommandContext,
  root: string,
  files: PatchFile[],
): PatchPlan[] {
  const touched = new Set<string>();
  let sourceBytesTotal = 0;
  let resultBytesTotal = 0;
  return files.map((file) => {
    const sourcePath = patchAbsolutePath(root, file.source);
    const destinationPath = patchAbsolutePath(root, file.destination);
    for (const path of new Set([sourcePath, destinationPath].filter((value): value is string => Boolean(value)))) {
      if (touched.has(path)) throw new GitUsageError(`patch touches a path more than once: ${path}`);
      touched.add(path);
    }
    if (sourcePath === null && destinationPath && fsExists(context.py, destinationPath)) {
      throw new GitApplyConflictError(`patch destination already exists: ${destinationPath}`);
    }
    if (sourcePath && destinationPath && sourcePath !== destinationPath && fsExists(context.py, destinationPath)) {
      throw new GitApplyConflictError(`patch destination already exists: ${destinationPath}`);
    }
    const sourceBytes = sourcePath ? regularFileBytes(context, sourcePath, true) : new Uint8Array();
    if (sourceBytes.byteLength > MAX_APPLY_FILE_BYTES) {
      throw new GitUsageError(`patch source exceeds ${MAX_APPLY_FILE_BYTES} bytes: ${file.source}`);
    }
    sourceBytesTotal += sourceBytes.byteLength;
    if (sourceBytesTotal > MAX_APPLY_TOTAL_BYTES) {
      throw new GitUsageError(`patch source bytes exceed ${MAX_APPLY_TOTAL_BYTES}`);
    }
    const sourceText = decodePatchText(sourceBytes, sourcePath ?? "new file");
    const bytes = encodePatchLines(applyPatchHunks(splitTextLines(sourceText), file));
    if (bytes.byteLength > MAX_APPLY_FILE_BYTES) {
      throw new GitUsageError(`patched file exceeds ${MAX_APPLY_FILE_BYTES} bytes: ${file.destination}`);
    }
    resultBytesTotal += bytes.byteLength;
    if (resultBytesTotal > MAX_APPLY_TOTAL_BYTES) {
      throw new GitUsageError(`patched bytes exceed ${MAX_APPLY_TOTAL_BYTES}`);
    }
    if (destinationPath === null && bytes.byteLength !== 0) {
      throw new GitApplyConflictError(`deletion patch leaves content in ${sourcePath}`);
    }
    let parent = destinationPath ? parentPath(destinationPath) : root;
    while (parent !== root) {
      if (fsExists(context.py, parent) && !context.py.FS.isDir(context.py.FS.lstat(parent).mode)) {
        throw new GitApplyConflictError(`patch destination parent is not a directory: ${parent}`);
      }
      parent = parentPath(parent);
    }
    return { ...file, sourcePath, destinationPath, bytes };
  });
}

function applyPatchPlans(context: HostCommandContext, root: string, plans: PatchPlan[]): void {
  const snapshots = new Map<string, Uint8Array | null>();
  for (const plan of plans) {
    for (const path of new Set([plan.sourcePath, plan.destinationPath].filter((value): value is string => Boolean(value)))) {
      snapshots.set(path, fsExists(context.py, path) ? regularFileBytes(context, path).slice() : null);
    }
  }
  const createdDirectories: string[] = [];
  try {
    for (const plan of plans) {
      if (plan.destinationPath) {
        const missing: string[] = [];
        for (let parent = parentPath(plan.destinationPath); parent !== root; parent = parentPath(parent)) {
          if (!fsExists(context.py, parent)) missing.push(parent);
        }
        for (const directory of missing.reverse()) {
          context.py.FS.mkdir(directory);
          createdDirectories.push(directory);
        }
      }
      if (plan.sourcePath && plan.sourcePath !== plan.destinationPath && fsExists(context.py, plan.sourcePath)) {
        context.py.FS.unlink(plan.sourcePath);
      }
      if (plan.destinationPath) context.py.FS.writeFile(plan.destinationPath, plan.bytes);
      else if (plan.sourcePath && fsExists(context.py, plan.sourcePath)) context.py.FS.unlink(plan.sourcePath);
    }
  } catch (error) {
    for (const [path, bytes] of snapshots) {
      if (fsExists(context.py, path) && !context.py.FS.isDir(context.py.FS.lstat(path).mode)) {
        context.py.FS.unlink(path);
      }
      if (bytes) context.py.FS.writeFile(path, bytes);
    }
    for (const directory of createdDirectories.reverse()) {
      try { context.py.FS.rmdir(directory); } catch {}
    }
    throw new GitUsageError(`patch write failed: ${conciseObjectError(error)}`);
  }
}

async function prepareCachedPatchPlans(
  context: HostCommandContext,
  root: string,
  files: PatchFile[],
): Promise<CachedPatchPlan[]> {
  const indexPath = `${root}/.git/index`;
  if (fsExists(context.py, indexPath) && context.py.FS.stat(indexPath).size > MAX_RESET_INDEX_BYTES) {
    throw new GitUsageError(`apply index exceeds ${MAX_RESET_INDEX_BYTES} bytes`);
  }
  const current = await recoveryEntries(context, root, null);
  if (current.length > MAX_RESET_INDEX_ENTRIES) {
    throw new GitUsageError(`apply index entry limit exceeded (${MAX_RESET_INDEX_ENTRIES})`);
  }
  const entries = new Map(current.map((entry) => [entry.filepath, entry]));
  const touched = new Set<string>();
  let sourceBytesTotal = 0;
  let resultBytesTotal = 0;

  const destinationBlocked = (path: string, source: string | null): boolean => {
    if (path !== source && entries.has(path)) return true;
    let parent = path;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      if (entries.has(parent)) return true;
    }
    for (const existing of entries.keys()) {
      if (existing.startsWith(`${path}/`)) return true;
    }
    return false;
  };

  const plans: CachedPatchPlan[] = [];
  for (const file of files) {
    for (const path of new Set(
      [file.source, file.destination].filter((value): value is string => value !== null),
    )) {
      if (touched.has(path)) throw new GitUsageError(`patch touches a path more than once: ${path}`);
      touched.add(path);
    }
    const sourceEntry = file.source === null ? null : entries.get(file.source) ?? null;
    if (file.source !== null && !sourceEntry) {
      throw new GitApplyConflictError(`patch source does not exist in index: ${file.source}`);
    }
    if (sourceEntry && (sourceEntry.type !== "blob" || ![0o100644, 0o100755].includes(sourceEntry.mode))) {
      throw new GitUsageError(`patch source is not a regular index entry: ${file.source}`);
    }
    if (file.destination !== null && destinationBlocked(file.destination, file.source)) {
      throw new GitApplyConflictError(`patch destination already exists in index: ${file.destination}`);
    }

    let sourceBytes = new Uint8Array();
    if (sourceEntry) {
      const { blob } = await isomorphicGit.readBlob({
        fs: gitFs(context), dir: root, oid: sourceEntry.oid,
      });
      sourceBytes = new Uint8Array(blob);
    }
    if (sourceBytes.byteLength > MAX_APPLY_FILE_BYTES) {
      throw new GitUsageError(`patch source exceeds ${MAX_APPLY_FILE_BYTES} bytes: ${file.source}`);
    }
    sourceBytesTotal += sourceBytes.byteLength;
    if (sourceBytesTotal > MAX_APPLY_TOTAL_BYTES) {
      throw new GitUsageError(`patch source bytes exceed ${MAX_APPLY_TOTAL_BYTES}`);
    }
    const sourceText = decodePatchText(sourceBytes, file.source ?? "new index file");
    const patched = encodePatchLines(applyPatchHunks(splitTextLines(sourceText), file));
    if (patched.byteLength > MAX_APPLY_FILE_BYTES) {
      throw new GitUsageError(`patched file exceeds ${MAX_APPLY_FILE_BYTES} bytes: ${file.destination}`);
    }
    resultBytesTotal += patched.byteLength;
    if (resultBytesTotal > MAX_APPLY_TOTAL_BYTES) {
      throw new GitUsageError(`patched bytes exceed ${MAX_APPLY_TOTAL_BYTES}`);
    }
    if (file.destination === null && patched.byteLength !== 0) {
      throw new GitApplyConflictError(`deletion patch leaves content in ${file.source}`);
    }
    plans.push({
      ...file,
      sourceEntry,
      bytes: patched,
      mode: sourceEntry?.mode ?? 0o100644,
    });
  }

  const resulting = new Set(entries.keys());
  for (const plan of plans) {
    if (plan.source !== null) resulting.delete(plan.source);
    if (plan.destination !== null) resulting.add(plan.destination);
  }
  if (resulting.size > MAX_RESET_INDEX_ENTRIES) {
    throw new GitUsageError(`apply resulting index entry limit exceeded (${MAX_RESET_INDEX_ENTRIES})`);
  }
  return plans;
}

let cachedApplyScratchSequence = 0;

function removeCachedApplyScratch(context: HostCommandContext, path: string): void {
  try {
    for (const name of ["index", "index.lock"]) {
      const entry = `${path}/${name}`;
      if (fsExists(context.py, entry)) context.py.FS.unlink(entry);
    }
    if (fsExists(context.py, path)) context.py.FS.rmdir(path);
  } catch {
    // The private scratch index is disposable and must not hide the result.
  }
}

async function applyCachedPatchPlans(
  context: HostCommandContext,
  root: string,
  plans: CachedPatchPlan[],
): Promise<void> {
  const indexPath = `${root}/.git/index`;
  const snapshot = fsExists(context.py, indexPath)
    ? new Uint8Array(context.py.FS.readFile(indexPath) as Uint8Array)
    : undefined;
  if ((snapshot?.byteLength ?? 0) > MAX_RESET_INDEX_BYTES) {
    throw new GitUsageError(`apply index exceeds ${MAX_RESET_INDEX_BYTES} bytes`);
  }
  let scratch: string;
  do {
    scratch = `${root}/.git/piodide-apply-index-${++cachedApplyScratchSequence}`;
  } while (fsExists(context.py, scratch));
  context.py.FS.mkdir(scratch);
  try {
    if (snapshot) context.py.FS.writeFile(`${scratch}/index`, snapshot);
    const fs = gitFs(context);
    const cache = {};
    for (const plan of plans) {
      if (plan.source !== null && plan.source !== plan.destination) {
        await isomorphicGit.updateIndex({
          fs, dir: root, gitdir: scratch, cache,
          filepath: plan.source, remove: true, force: true,
        });
      }
    }
    for (const plan of plans) {
      if (plan.destination === null) continue;
      const oid = await isomorphicGit.writeBlob({ fs, dir: root, blob: plan.bytes });
      await isomorphicGit.updateIndex({
        fs, dir: root, gitdir: scratch, cache,
        filepath: plan.destination, oid, mode: plan.mode, add: true,
      });
    }
    const staged = new Uint8Array(context.py.FS.readFile(`${scratch}/index`) as Uint8Array);
    if (staged.byteLength > MAX_RESET_INDEX_BYTES) {
      throw new GitUsageError(`apply resulting index exceeds ${MAX_RESET_INDEX_BYTES} bytes`);
    }
    try {
      context.py.FS.writeFile(indexPath, staged);
    } catch (error) {
      try {
        if (snapshot) context.py.FS.writeFile(indexPath, snapshot);
        else if (fsExists(context.py, indexPath)) context.py.FS.unlink(indexPath);
      } catch { /* preserve the original write error */ }
      throw error;
    }
  } finally {
    removeCachedApplyScratch(context, scratch);
  }
}

async function runApplyRequest(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  let check = false;
  let reverse = false;
  let cached = false;
  let options = true;
  const operands: string[] = [];
  for (const arg of args) {
    if (options && arg === "--") { options = false; continue; }
    if (options && arg === "--check") { check = true; continue; }
    if (options && arg === "--cached") {
      if (cached) throw new GitUsageError("git apply cached option may be specified only once");
      cached = true;
      continue;
    }
    if (options && (arg === "-R" || arg === "--reverse")) {
      if (reverse) throw new GitUsageError("git apply reverse option may be specified only once");
      reverse = true;
      continue;
    }
    if (options && arg.startsWith("-") && arg !== "-") {
      throw new GitUsageError(`unsupported apply option: ${arg}`);
    }
    operands.push(arg);
  }
  if (operands.length > 1) throw new GitUsageError("git apply accepts at most one patch file");
  const operand = operands[0] ?? "-";
  if (encoder.encode(operand).byteLength > MAX_APPLY_PATH_BYTES) {
    throw new GitUsageError(`patch operand exceeds ${MAX_APPLY_PATH_BYTES} bytes`);
  }
  let bytes: Uint8Array;
  if (operand === "-") {
    if (context.stdin === undefined) throw new GitUsageError("git apply requires a patch file or piped stdin");
    bytes = context.stdin;
  } else {
    const path = workspacePath(context.cwd, operand);
    bytes = regularFileBytes(context, path);
  }
  if (bytes.byteLength > MAX_APPLY_BYTES) {
    throw new GitUsageError(`patch exceeds ${MAX_APPLY_BYTES} bytes`);
  }
  const root = repositoryRoot(context.py, context.cwd);
  let files = parseGitPatch(decodePatchText(bytes, operand));
  if (reverse) files = reversePatchFiles(files);
  if (cached) {
    const plans = await prepareCachedPatchPlans(context, root, files);
    if (!check) await applyCachedPatchPlans(context, root, plans);
  } else {
    const plans = preparePatchPlans(context, root, files);
    if (!check) applyPatchPlans(context, root, plans);
  }
  return result(0, "");
}

async function runApply(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  try {
    return await runApplyRequest(context, args);
  } catch (error) {
    if (error instanceof GitUsageError || error instanceof GitApplyConflictError) throw error;
    throw new GitUsageError(error instanceof Error ? error.message : String(error));
  }
}

function extractDiffContext(
  args: string[],
  command: "diff" | "show",
): { args: string[]; contextLines?: number } {
  const remaining: string[] = [];
  let contextLines: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    let matched = false;
    let value: string | undefined;
    if (arg === "-U" || arg === "--unified") {
      matched = true;
      value = args[++index];
    } else if (arg.startsWith("-U")) {
      matched = true;
      value = arg.slice(2);
    } else if (arg.startsWith("--unified=")) {
      matched = true;
      value = arg.slice(10);
    }
    if (!matched) {
      remaining.push(arg);
      continue;
    }
    if (value === undefined || !/^[0-9]+$/.test(value)) {
      throw new GitUsageError(
        `git ${command} context must be a decimal integer from 0 through ${MAX_DIFF_CONTEXT}`,
      );
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed > MAX_DIFF_CONTEXT) {
      throw new GitUsageError(
        `git ${command} context must be a decimal integer from 0 through ${MAX_DIFF_CONTEXT}`,
      );
    }
    contextLines = parsed;
  }
  return { args: remaining, contextLines };
}

async function runDiff(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const separator = args.indexOf("--");
  const parsedContext = extractDiffContext(separator < 0 ? args : args.slice(0, separator), "diff");
  const optionArgs = parsedContext.args;
  const supportedOptions = new Set([
    "--cached", "--staged", "--check", "--quiet", "--exit-code", "--no-color", "--color=never",
    "-z", "--name-only", "--name-status", "--stat", "--numstat",
  ]);
  for (const arg of optionArgs) {
    if (arg.startsWith("-") && !supportedOptions.has(arg)) {
      throw new GitUsageError(`unsupported diff option: ${arg}`);
    }
  }
  const check = optionArgs.includes("--check");
  const quiet = optionArgs.includes("--quiet");
  const exitCode = optionArgs.includes("--exit-code");
  const nul = optionArgs.includes("-z");
  const nameOnly = optionArgs.includes("--name-only");
  const nameStatus = optionArgs.includes("--name-status");
  const cached = optionArgs.some((arg) => arg === "--cached" || arg === "--staged");
  const stat = optionArgs.includes("--stat");
  const numstat = optionArgs.includes("--numstat");
  if (quiet && exitCode) {
    throw new GitUsageError("git diff accepts only one of --quiet or --exit-code");
  }
  if (check && (quiet || exitCode)) {
    throw new GitUsageError("git diff --check cannot be combined with --quiet or --exit-code");
  }
  if (check && (nameOnly || nameStatus || stat || numstat)) {
    throw new GitUsageError("git diff --check cannot be combined with stat or name projections");
  }
  if ([nameOnly, nameStatus, stat, numstat].filter(Boolean).length > 1) {
    throw new GitUsageError("git diff accepts only one output projection");
  }
  if (nul && !nameOnly && !nameStatus && !numstat) {
    throw new GitUsageError("git diff -z requires --name-only, --name-status, or --numstat");
  }
  const commandArgs = optionArgs
    .filter((arg) => ![
      "--check", "--quiet", "--exit-code", "--no-color", "--color=never", "-z", "--numstat",
      "--name-only", "--name-status",
    ].includes(arg))
    .map((arg) => arg === "--staged" ? "--cached" : arg);
  if (parsedContext.contextLines !== undefined) commandArgs.unshift(`-U${parsedContext.contextLines}`);
  let revisions = commandArgs.filter((arg) => !arg.startsWith("-"));
  if (revisions.length > 2) throw new GitUsageError("git diff accepts at most two revisions");
  const tripleDot = revisions.filter((revision) => revision.includes("..."));
  if (tripleDot.length > 1 || (tripleDot.length === 1 && revisions.length !== 1)) {
    throw new GitUsageError("git diff accepts one A...B comparison at a time");
  }
  const root = repositoryRoot(context.py, context.cwd);
  const intentToAdd = cached && fsExists(context.py, `${root}/.git/index`)
    ? gitIndexIntentToAddPaths(
        new Uint8Array(context.py.FS.readFile(`${root}/.git/index`) as Uint8Array),
      )
    : new Set<string>();
  if (tripleDot.length) {
    if (cached) throw new GitUsageError("git diff A...B cannot be combined with --cached");
    const match = /^(.+)\.\.\.(.+)$/.exec(tripleDot[0]);
    if (!match) throw new GitUsageError("git diff triple-dot form requires both A and B");
    const base = await findMergeBase(context, root, match[1], match[2]);
    if (!base) throw new Error(`no merge base between ${match[1]} and ${match[2]}`);
    const right = await resolveDiffRevision(context, root, match[2]);
    const index = commandArgs.indexOf(tripleDot[0]);
    commandArgs.splice(index, 1, base, right);
    revisions = [base, right];
  }
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
  if (value.exitCode !== 0) {
    const rendered = render(value);
    const diagnostic = rendered.stderr ?? rendered.stdout;
    return { exitCode: 2, ...(diagnostic ? { stderr: diagnostic } : {}) };
  }
  let output = stat
    ? value.stdout
    : filterDiffExcludedPaths(value.stdout, intentToAdd);
  let structuralRecords: DiffNameRecord[] | undefined;
  let verifiedWorktreeChanges: Set<string> | undefined;
  const records = async () => structuralRecords ??= await structuralDiffNames(
    context, root, revisions, cached, unborn, verifiedWorktreeChanges,
  );
  if (nameOnly || nameStatus) {
    if (!cached && revisions.length < 2) verifiedWorktreeChanges = changedPathsFromPatch(output);
    let projected = await records();
    if (cached && !unborn) projected = coalesceExactRenames(projected);
    output = renderDiffNames(projected, nameStatus, paths, nul);
  } else if (numstat) {
    if (!cached && revisions.length < 2) verifiedWorktreeChanges = changedPathsFromPatch(output);
    const allRecords = await records();
    const selectedRecords = allRecords.filter((record) =>
      record.paths.some((path) => diffPathSelected(path, paths))
    );
    const binary = await preflightNumstat(
      context, root, selectedRecords, !cached && revisions.length < 2,
    );
    output = renderDiffNumstat(
      filterDiffPaths(output, paths, allRecords), selectedRecords, binary, nul,
    );
  } else if (stat && (paths.length || intentToAdd.size)) {
    const patchArgs = commandArgs.filter((arg) => arg !== "--stat");
    const patch = await invoke(context, ["diff", ...patchArgs], root);
    if (patch.exitCode !== 0) {
      const rendered = render(patch);
      const diagnostic = rendered.stderr ?? rendered.stdout;
      return { exitCode: 2, ...(diagnostic ? { stderr: diagnostic } : {}) };
    }
    const patchOutput = filterDiffExcludedPaths(patch.stdout, intentToAdd);
    if (!cached && revisions.length < 2) verifiedWorktreeChanges = changedPathsFromPatch(patchOutput);
    const allRecords = await records();
    const selectedRecords = allRecords.filter((record) =>
      record.paths.some((path) => diffPathSelected(path, paths))
    );
    output = renderDiffStat(filterDiffPaths(patchOutput, paths, allRecords), selectedRecords);
  } else output = filterDiffPaths(output, paths, paths.length ? await records() : []);
  if (check) {
    const failures = checkDiffWhitespace(output);
    return failures ? result(1, failures) : result(0, "");
  }
  const changed = output.length > 0;
  if (quiet) return result(changed ? 1 : 0, "");
  return {
    exitCode: exitCode && changed ? 1 : 0,
    ...(output ? { stdout: encoder.encode(output) } : {}),
    ...(value.stderr ? { stderr: encoder.encode(value.stderr) } : {}),
  };
}

function catFilePredicateRequested(args: string[]): boolean {
  return args.some((arg) =>
    arg === "-e" || (/^-[^-]+$/.test(arg) && arg.slice(1).includes("e"))
  );
}

function commitFormat(value: string | undefined, pretty: boolean, command: "log" | "show"): string {
  if (value === undefined) throw new GitUsageError(`git ${command} format requires a value`);
  let format = value;
  if (pretty && value === "oneline") format = "%H %s";
  else if (pretty && value.startsWith("format:")) format = value.slice(7);
  else if (pretty && value.startsWith("tformat:")) format = value.slice(8);
  else if (pretty && /^[A-Za-z][A-Za-z0-9-]*$/.test(value)) {
    throw new GitUsageError(`unsupported git ${command} pretty format: ${value}`);
  }
  if (format.length > 256) throw new GitUsageError(`git ${command} format exceeds 256 characters`);
  for (let index = 0; index < format.length; index++) {
    if (format[index] !== "%") continue;
    const atom = format[++index];
    if (atom === undefined) throw new GitUsageError(`git ${command} format has a dangling %`);
    if (["H", "h", "s", "n", "%"].includes(atom)) continue;
    if (atom === "x") {
      const hex = format.slice(index + 1, index + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex) || Number.parseInt(hex, 16) > 0x7f) {
        throw new GitUsageError(`git ${command} supports ASCII %xNN escapes from %x00 through %x7f`);
      }
      index += 2;
      continue;
    }
    throw new GitUsageError(`unsupported git ${command} format atom: %${atom}`);
  }
  return format;
}

function renderCommitFormat(format: string, oid: string, subject: string): string {
  let output = "";
  for (let index = 0; index < format.length; index++) {
    if (format[index] !== "%") { output += format[index]; continue; }
    const atom = format[++index];
    if (atom === "H") output += oid;
    else if (atom === "h") output += oid.slice(0, 7);
    else if (atom === "s") output += subject;
    else if (atom === "n") output += "\n";
    else if (atom === "%") output += "%";
    else if (atom === "x") {
      output += String.fromCharCode(Number.parseInt(format.slice(index + 1, index + 3), 16));
      index += 2;
    }
  }
  return output;
}

function renderGitLogDate(timestamp: number, timezoneOffset: number): string {
  const date = new Date((timestamp - timezoneOffset * 60) * 1000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const day = days[date.getUTCDay()];
  const month = months[date.getUTCMonth()];
  if (!day || !month) throw new Error("commit author date is outside the supported range");
  const pad = (value: number): string => String(value).padStart(2, "0");
  const sign = timezoneOffset > 0 || Object.is(timezoneOffset, -0) ? "-" : "+";
  const offset = Math.abs(timezoneOffset);
  return `${day} ${month} ${String(date.getUTCDate()).padStart(2, " ")} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ` +
    `${date.getUTCFullYear()} ${sign}${pad(Math.floor(offset / 60))}${pad(offset % 60)}`;
}

function projectedLogFormatIsSafe(format: string): boolean {
  if (/[\0\r\n]/.test(format)) return false;
  let identity = false;
  for (let index = 0; index < format.length; index++) {
    if (format[index] !== "%") continue;
    const atom = format[++index];
    if (atom === "H" || atom === "h") identity = true;
    else if (atom === "n") return false;
    else if (atom === "x") {
      const value = Number.parseInt(format.slice(index + 1, index + 3), 16);
      if (value === 0 || value === 0x0a || value === 0x0d) return false;
      index += 2;
    }
  }
  return identity;
}

function commitChangeRecords(changes: (string | null)[][] | undefined): DiffNameRecord[] {
  return (changes ?? []).map((change) => {
    const [newOid, oldOid, filepath] = change;
    if (typeof filepath !== "string" || (!newOid && !oldOid)) {
      throw new Error("git log returned an invalid path change");
    }
    const status = !oldOid ? "A" : !newOid ? "D" : "M";
    return {
      raw: `${status}\t${quoteDiffPath(filepath)}`,
      status,
      paths: [filepath],
      ...(oldOid ? { oldOid } : {}),
      ...(newOid ? { newOid } : {}),
    };
  });
}

function projectedLogLimit(kind: "commits" | "records"): never {
  const maximum = kind === "commits" ? MAX_PROJECTED_LOG_COMMITS : MAX_PROJECTED_LOG_RECORDS;
  throw new Error(`git log projected ${kind} limit exceeded (maximum ${maximum})`);
}

async function runLog(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const separator = args.indexOf("--");
  const beforePaths = separator < 0 ? args : args.slice(0, separator);
  const supported = args.some((arg) =>
    [
      "--all", "--graph", "--stat", "--name-only", "--name-status", "--numstat", "-z",
      "--oneline", "--format", "--pretty", "--no-color", "--color=never",
    ].includes(arg) ||
    arg.startsWith("--format=") || arg.startsWith("--pretty=")
  ) || separator >= 0;
  if (!supported) return runLibgitCommand(context, context.cwd, ["log", ...args]);
  const root = repositoryRoot(context.py, context.cwd);
  const fs = gitFs(context);
  const paths = separator < 0 ? [] : args.slice(separator + 1).map((path) =>
    pathFromRepository(root, context.cwd, path)
  );
  if (separator >= 0 && !paths.length) throw new GitUsageError("git log -- requires at least one path");
  let depth = 100;
  let oneline = false;
  let graph = false;
  let stat = false;
  let nameOnly = false;
  let nameStatus = false;
  let numstat = false;
  let nul = false;
  let all = false;
  let projection: string | undefined;
  const revisions: string[] = [];
  for (let index = 0; index < beforePaths.length; index++) {
    const arg = beforePaths[index];
    if (arg === "--all") all = true;
    else if (arg === "--graph") graph = true;
    else if (arg === "--stat") stat = true;
    else if (arg === "--name-only") nameOnly = true;
    else if (arg === "--name-status") nameStatus = true;
    else if (arg === "--numstat") numstat = true;
    else if (arg === "-z") nul = true;
    else if (arg === "--oneline") oneline = true;
    else if (arg === "--format" || arg.startsWith("--format=")) {
      if (projection !== undefined) throw new GitUsageError("git log accepts one format projection");
      projection = commitFormat(arg === "--format" ? beforePaths[++index] : arg.slice(9), false, "log");
    }
    else if (arg === "--pretty" || arg.startsWith("--pretty=")) {
      if (projection !== undefined) throw new GitUsageError("git log accepts one format projection");
      projection = commitFormat(arg === "--pretty" ? beforePaths[++index] : arg.slice(9), true, "log");
    }
    else if (arg === "--no-color" || arg === "--color=never") continue;
    else if (arg === "-n" || arg === "--max-count") depth = Number(beforePaths[++index]);
    else if (arg.startsWith("--max-count=")) depth = Number(arg.slice(12));
    else if (/^-n[0-9]+$/.test(arg)) depth = Number(arg.slice(2));
    else if (/^-[0-9]+$/.test(arg)) depth = Number(arg.slice(1));
    else if (arg.startsWith("-")) throw new GitUsageError(`unsupported browser log option: ${arg}`);
    else revisions.push(arg);
  }
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 10_000) throw new GitUsageError("invalid log count");
  if (revisions.length > 1) throw new GitUsageError("git log accepts at most one revision");
  if (all && revisions.length) throw new GitUsageError("git log --all and an explicit revision are mutually exclusive");
  const pathProjection = nameOnly || nameStatus || numstat;
  if ([nameOnly, nameStatus, numstat].filter(Boolean).length > 1) {
    throw new GitUsageError("git log accepts only one output projection");
  }
  if (nul && !pathProjection) {
    throw new GitUsageError("git log -z requires --name-only, --name-status, or --numstat");
  }
  if (pathProjection && stat) {
    throw new GitUsageError("git log path projections cannot be combined with --stat");
  }
  if (pathProjection && graph) {
    throw new GitUsageError("git log path projections cannot be combined with --graph");
  }
  if (projection !== undefined && oneline) throw new GitUsageError("git log --format/--pretty and --oneline are mutually exclusive");
  if (projection !== undefined && stat) throw new GitUsageError("git log --format/--pretty and --stat are unsupported together");
  if (pathProjection && projection !== undefined && !projectedLogFormatIsSafe(projection)) {
    throw new GitUsageError("projected log format must be single-line and contain %H or %h");
  }
  const revision = revisions[0] ?? "HEAD";
  const refs = all
    ? [
        ...(await isomorphicGit.listBranches({ fs, dir: root })),
        ...(await isomorphicGit.listTags({ fs, dir: root })).map((tag) => `refs/tags/${tag}`),
        ...(await isomorphicGit.listBranches({ fs, dir: root, remote: "origin" }).catch(() => []))
          .map((branch) => `refs/remotes/origin/${branch}`),
      ]
    : [revision];
  const commits = new Map<string, Awaited<ReturnType<typeof isomorphicGit.log>>[number]>();
  for (const ref of refs.length ? refs : ["HEAD"]) {
    const entries = await isomorphicGit.log({
      fs,
      dir: root,
      ref,
      depth: paths.length ? 10_000 : depth,
      includeChanges: stat || pathProjection || paths.length > 0,
    });
    for (const entry of entries) commits.set(entry.oid, entry);
  }
  const ordered = [...commits.values()].filter((entry) =>
    !paths.length || entry.commit.changes?.some((change) =>
      diffPathSelected(change[2]!, paths)
    )
  ).sort(
    (a, b) => b.commit.committer.timestamp - a.commit.committer.timestamp,
  ).slice(0, depth);
  if (pathProjection) {
    if (ordered.length > MAX_PROJECTED_LOG_COMMITS) projectedLogLimit("commits");
    const recordsByCommit = new Map<string, { all: DiffNameRecord[]; selected: DiffNameRecord[] }>();
    let recordCount = 0;
    for (const { oid, commit } of ordered) {
      const allRecords = commitChangeRecords(commit.changes);
      const selectedRecords = allRecords.filter((record) =>
        record.paths.some((path) => diffPathSelected(path, paths))
      );
      recordCount += selectedRecords.length;
      if (recordCount > MAX_PROJECTED_LOG_RECORDS) projectedLogLimit("records");
      recordsByCommit.set(oid, { all: allRecords, selected: selectedRecords });
    }

    let output = "";
    let outputBytes = 0;
    const append = (value: string): void => {
      outputBytes += encoder.encode(value).byteLength;
      if (outputBytes > MAX_PROJECTED_LOG_OUTPUT_BYTES) {
        throw new Error("git log projected output exceeds limit");
      }
      output += value;
    };
    const numstatState = numstatPreflightState();
    for (const { oid, commit } of ordered) {
      const subject = commit.message.split(/\r?\n/, 1)[0];
      if (projection !== undefined) append(`${renderCommitFormat(projection, oid, subject)}\n`);
      else if (oneline) append(`${oid.slice(0, 7)} ${subject}\n`);
      else {
        append(
          `commit ${oid}\nAuthor: ${commit.author.name} <${commit.author.email}>\n` +
          `Date:   ${renderGitLogDate(commit.author.timestamp, commit.author.timezoneOffset)}\n\n` +
          `    ${subject}\n\n`,
        );
      }

      const records = recordsByCommit.get(oid)!;
      if (numstat) {
        const parent = commit.parent[0] ?? EMPTY_TREE_OID;
        const patch = await invoke(context, ["diff", parent, oid], root);
        if (patch.exitCode !== 0) {
          const diagnostic = normalizeLibgitOutput(patch.stderr || patch.stdout).trim();
          throw new Error(diagnostic || `could not compare commit ${oid}`);
        }
        const selectedPatch = filterDiffPaths(patch.stdout, paths, records.all);
        const binary = await preflightNumstat(
          context, root, records.selected, false, numstatState,
        );
        append(renderDiffNumstat(selectedPatch, records.selected, binary, nul));
      } else {
        append(renderDiffNames(records.selected, nameStatus, [], nul));
      }
      append(nul ? "\0" : "\n");
    }
    return result(0, output);
  }
  return result(0, ordered.map(({ oid, commit }) => {
    const prefix = graph ? "* " : "";
    const subject = commit.message.split(/\r?\n/, 1)[0];
    if (projection !== undefined) {
      const formatted = renderCommitFormat(projection, oid, subject);
      return formatted ? `${prefix}${formatted}\n` : "";
    }
    if (oneline) return `${prefix}${oid.slice(0, 7)} ${subject}\n`;
    let text = `${prefix}commit ${oid}\nAuthor: ${commit.author.name} <${commit.author.email}>\n` +
      `Date:   ${renderGitLogDate(commit.author.timestamp, commit.author.timezoneOffset)}\n\n` +
      `    ${subject}\n`;
    if (stat && commit.changes?.length) {
      const changes = commit.changes.filter((change) =>
        !paths.length || diffPathSelected(change[2]!, paths)
      );
      text += `${changes.map((change) => ` ${quoteDiffPath(change[2]!)} | changed\n`).join("")}` +
        ` ${changes.length} file(s) changed\n`;
    }
    return `${text}\n`;
  }).join(""));
}

async function runShow(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  const separator = args.indexOf("--");
  const parsedContext = extractDiffContext(separator < 0 ? args : args.slice(0, separator), "show");
  const beforePaths = parsedContext.args;
  const paths = separator < 0 ? [] : args.slice(separator + 1);
  let stat = false;
  let noPatch = false;
  let oneline = false;
  let nameOnly = false;
  let nameStatus = false;
  let numstat = false;
  let nul = false;
  let projection: string | undefined;
  const revisions: string[] = [];
  for (let index = 0; index < beforePaths.length; index++) {
    const arg = beforePaths[index];
    if (arg === "--stat") stat = true;
    else if (arg === "--numstat") numstat = true;
    else if (arg === "--name-only") nameOnly = true;
    else if (arg === "--name-status") nameStatus = true;
    else if (arg === "-z") nul = true;
    else if (arg === "-s" || arg === "--no-patch") noPatch = true;
    else if (arg === "--oneline") oneline = true;
    else if (arg === "--format" || arg.startsWith("--format=")) {
      if (projection !== undefined) throw new GitUsageError("git show accepts one format projection");
      projection = commitFormat(arg === "--format" ? beforePaths[++index] : arg.slice(9), false, "show");
    } else if (arg === "--pretty" || arg.startsWith("--pretty=")) {
      if (projection !== undefined) throw new GitUsageError("git show accepts one format projection");
      projection = commitFormat(arg === "--pretty" ? beforePaths[++index] : arg.slice(9), true, "show");
    } else if (arg === "--no-color" || arg === "--color=never") {
      continue;
    } else if (arg.startsWith("-")) throw new GitUsageError(`unsupported show option: ${arg}`);
    else revisions.push(arg);
  }
  if (revisions.length > 1) throw new GitUsageError("git show accepts at most one revision");
  if (projection !== undefined && oneline) throw new GitUsageError("git show --format/--pretty and --oneline are mutually exclusive");
  if ([nameOnly, nameStatus, stat, numstat].filter(Boolean).length > 1) {
    throw new GitUsageError("git show accepts only one output projection");
  }
  if (nul && !nameOnly && !nameStatus && !numstat) {
    throw new GitUsageError("git show -z requires --name-only, --name-status, or --numstat");
  }
  if (noPatch && (nameOnly || nameStatus || stat || numstat)) {
    throw new GitUsageError("git show --no-patch cannot be combined with an output projection");
  }
  const revision = revisions[0] ?? "HEAD";
  const oid = await resolveDiffRevision(context, root, revision);
  let commit: Awaited<ReturnType<typeof isomorphicGit.readCommit>>["commit"];
  try {
    ({ commit } = await isomorphicGit.readCommit({ fs: gitFs(context), dir: root, oid }));
  } catch {
    throw new Error(`object is not a commit: ${revision}`);
  }
  const parent = commit.parent[0] ?? EMPTY_TREE_OID;
  const selector = paths.length ? ["--", ...paths] : [];
  if (noPatch && paths.length) {
    const selected = await runDiff(context, [parent, oid, "--name-only", ...selector]);
    if (selected.exitCode !== 0 || !selected.stdout?.byteLength) return selected;
  }
  const metadataArgs = [
    ...(oneline ? ["--oneline"] : projection !== undefined ? ["--format", projection] : []),
    "-n", "1", oid,
  ];
  const metadata = await runLog(context, metadataArgs);
  if (metadata.exitCode !== 0 || noPatch) return metadata;
  const shown = await runDiff(context, [
    ...(parsedContext.contextLines === undefined ? [] : [`-U${parsedContext.contextLines}`]),
    parent, oid,
    ...(stat ? ["--stat"] : numstat ? ["--numstat"] : nameOnly ? ["--name-only"] : nameStatus ? ["--name-status"] : []),
    ...(nul ? ["-z"] : []),
    ...selector,
  ]);
  if (shown.exitCode !== 0) return shown;
  if (paths.length && !shown.stdout?.byteLength) return result(0, "");
  const output = `${metadata.stdout ? decoder.decode(metadata.stdout) : ""}` +
    `${shown.stdout ? decoder.decode(shown.stdout) : ""}`;
  if (numstat && encoder.encode(output).byteLength > MAX_NUMSTAT_OUTPUT_BYTES) {
    numstatLimit("stdout bytes", MAX_NUMSTAT_OUTPUT_BYTES);
  }
  return {
    exitCode: 0,
    ...(output ? { stdout: encoder.encode(output) } : {}),
    ...(metadata.stderr?.byteLength ? { stderr: metadata.stderr } :
      shown.stderr?.byteLength ? { stderr: shown.stderr } : {}),
  };
}

async function walkRevList(
  context: HostCommandContext,
  root: string,
  revision: string,
  maxCount?: number,
): Promise<string[]> {
  const pending = [await resolveDiffRevision(context, root, revision)];
  const visited = new Set<string>();
  const oids: string[] = [];
  let first = true;
  while (pending.length && (maxCount === undefined || oids.length < maxCount)) {
    const candidate = pending.pop()!;
    if (visited.has(candidate)) continue;
    let entry: Awaited<ReturnType<typeof isomorphicGit.readCommit>>;
    try {
      entry = await isomorphicGit.readCommit({ fs: gitFs(context), dir: root, oid: candidate });
    } catch (error) {
      if (first) throw new Error(`revision is not a commit: ${revision}`);
      throw error;
    }
    first = false;
    if (visited.has(entry.oid)) continue;
    if (maxCount === undefined && oids.length === MAX_REV_LIST_COMMITS) {
      throw new Error(`rev-list exceeds ${MAX_REV_LIST_COMMITS} commits`);
    }
    visited.add(entry.oid);
    oids.push(entry.oid);
    for (let index = entry.commit.parent.length - 1; index >= 0; index--) {
      pending.push(entry.commit.parent[index]);
    }
  }
  return oids;
}

async function runRevList(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  let maxCount: number | undefined;
  let count = false;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--count") {
      if (count) throw new Error("rev-list --count may be specified once");
      count = true;
    } else if (arg === "--max-count") {
      const value = args[++index];
      maxCount = Number(value);
      if (!/^\d+$/.test(value ?? "") || !Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > MAX_REV_LIST_COMMITS) {
        throw new Error(`rev-list count must be from 1 to ${MAX_REV_LIST_COMMITS}`);
      }
    } else if (arg.startsWith("--max-count=")) {
      const value = arg.slice(12);
      maxCount = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > MAX_REV_LIST_COMMITS) {
        throw new Error(`rev-list count must be from 1 to ${MAX_REV_LIST_COMMITS}`);
      }
    } else if (arg.startsWith("-")) throw new Error(`unsupported rev-list option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 1) throw new Error("rev-list requires exactly one revision");
  const oids = await walkRevList(context, root, positional[0], maxCount);
  return result(0, count ? `${oids.length}\n` : oids.map((oid) => `${oid}\n`).join(""));
}

async function runRevParse(context: HostCommandContext, args: string[]): Promise<HostCommandResult> {
  const root = repositoryRoot(context.py, context.cwd);
  if (args.length === 1) {
    if (args[0] === "--show-toplevel") return result(0, `${root}\n`);
    if (args[0] === "--show-prefix") {
      return result(0, context.cwd === root ? "\n" : `${context.cwd.slice(root.length + 1)}/\n`);
    }
    if (args[0] === "--is-inside-work-tree") return result(0, "true\n");
    if (args[0] === "--git-dir" || args[0] === "--git-common-dir") {
      return result(0, `${root}/.git\n`);
    }
  }
  if (args.length === 2 && args[0] === "--abbrev-ref") {
    if (args[1] !== "HEAD") throw new GitUsageError("bounded --abbrev-ref supports only HEAD");
    return result(0, `${currentBranch(context.py, root) || "HEAD"}\n`);
  }

  let verify = false;
  let quiet = false;
  let shortLength: number | undefined;
  const revisions: string[] = [];
  for (const arg of args) {
    if (arg === "--verify") verify = true;
    else if (arg === "-q" || arg === "--quiet") quiet = true;
    else if (arg === "--short") shortLength = 7;
    else if (arg.startsWith("--short=")) {
      const value = arg.slice(8);
      if (!/^\d+$/.test(value)) throw new GitUsageError(`invalid short object length: ${value}`);
      shortLength = Number(value);
    } else if (arg.startsWith("-")) throw new GitUsageError(`unsupported rev-parse option: ${arg}`);
    else revisions.push(arg);
  }
  if (quiet && !verify) throw new GitUsageError("rev-parse --quiet requires --verify");
  if (shortLength !== undefined && (!Number.isSafeInteger(shortLength) || shortLength < 4 || shortLength > 40)) {
    throw new GitUsageError("rev-parse --short length must be from 4 to 40");
  }
  if (revisions.length !== 1) throw new GitUsageError("rev-parse requires exactly one revision");
  try {
    const oid = await resolveDiffRevision(context, root, revisions[0]);
    return result(0, `${shortLength === undefined ? oid : oid.slice(0, shortLength)}\n`);
  } catch (error) {
    if (quiet) return result(1, "");
    throw error;
  }
}

interface PlannedPathCollision {
  local: string;
  planned: string;
  relation: "equals" | "is ancestor of" | "is descendant of";
}

function sortedPrefixMatch(paths: string[], prefix: string): string | undefined {
  let low = 0;
  let high = paths.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (paths[middle] < prefix) low = middle + 1;
    else high = middle;
  }
  const candidate = paths[low];
  return candidate?.startsWith(prefix) ? candidate : undefined;
}

function plannedPathCollision(
  local: string,
  plannedPaths: string[],
  plannedSet: Set<string>,
): PlannedPathCollision | undefined {
  if (plannedSet.has(local)) return { local, planned: local, relation: "equals" };
  const descendant = sortedPrefixMatch(plannedPaths, `${local}/`);
  if (descendant) return { local, planned: descendant, relation: "is ancestor of" };
  let slash = local.lastIndexOf("/");
  while (slash > 0) {
    const ancestor = local.slice(0, slash);
    if (plannedSet.has(ancestor)) {
      return { local, planned: ancestor, relation: "is descendant of" };
    }
    slash = ancestor.lastIndexOf("/");
  }
  return undefined;
}

function trackedStateIsDirty(rows: ExactStatusRow[]): boolean {
  return rows.some(([, head, workdir, stage]) =>
    (head !== 0 || stage !== 0) && (head !== stage || workdir !== stage)
  );
}

async function preflightUntrackedWrites(
  context: HostCommandContext,
  root: string,
  requestedPaths: string[],
  operation: "merge" | "cherry-pick",
  knownRows?: ExactStatusRow[],
): Promise<HostCommandResult | null> {
  const rows = knownRows ?? await statusMatrix(context, root, { ignored: true });
  const plannedPaths = [...new Set(requestedPaths)].sort();
  const untrackedPaths = rows
    .filter(([, head, workdir, stage]) => head === 0 && stage === 0 && workdir !== 0)
    .map(([filepath]) => filepath)
    .sort();
  if (
    rows.length > MAX_GIT_PREFLIGHT_PATHS ||
    plannedPaths.length > MAX_GIT_PREFLIGHT_PATHS ||
    untrackedPaths.length > MAX_GIT_PREFLIGHT_PATHS
  ) {
    return errorResult(
      2,
      `fatal: ${operation} preflight path limit exceeded (${MAX_GIT_PREFLIGHT_PATHS}); ` +
        "no repository state was changed\n",
    );
  }
  const plannedSet = new Set(plannedPaths);
  const collisions = untrackedPaths.flatMap((local) => {
    const collision = plannedPathCollision(local, plannedPaths, plannedSet);
    return collision ? [collision] : [];
  });
  if (!collisions.length) return null;

  const visible = collisions.slice(0, MAX_GIT_COLLISION_DIAGNOSTICS);
  const diagnostics: string[] = [];
  for (const collision of visible) {
    const ignored = await isomorphicGit.isIgnored({
      fs: gitFs(context), dir: root, filepath: collision.local,
    }).catch(() => false);
    diagnostics.push(
      `error: untracked path collision: ${quoteStatusPath(collision.local)} ` +
        `${collision.relation} ${operation} output ${quoteStatusPath(collision.planned)}` +
        `${ignored ? " [ignored]" : ""}\n`,
    );
  }
  if (collisions.length > visible.length) {
    diagnostics.push(`error: ${collisions.length - visible.length} additional collision(s) omitted\n`);
  }
  diagnostics.push(
    `fatal: ${operation} preflight rejected ${collisions.length} untracked collision(s); ` +
      "no repository state was changed\n",
  );
  return errorResult(1, diagnostics.join(""));
}

async function preflightCherryPick(
  context: HostCommandContext,
  root: string,
  oid: string,
  parent: string,
): Promise<HostCommandResult | null> {
  const rows = await statusMatrix(context, root, { ignored: true });
  const nativeStatus = await invoke(context, ["status", "--porcelain"], root);
  if (
    trackedStateIsDirty(rows) ||
    conflictPathsFromStatus(`${nativeStatus.stdout}\n${nativeStatus.stderr}`).length
  ) {
    return errorResult(
      1,
      "error: local changes would be overwritten by cherry-pick; commit or stash them first\n",
    );
  }
  if (rows.length > MAX_GIT_PREFLIGHT_PATHS) {
    return errorResult(
      2,
      `fatal: cherry-pick preflight path limit exceeded (${MAX_GIT_PREFLIGHT_PATHS}); ` +
        "no repository state was changed\n",
    );
  }
  const records = await structuralDiffNames(context, root, [parent, oid], false, false);
  return preflightUntrackedWrites(
    context,
    root,
    records.flatMap((record) => record.paths),
    "cherry-pick",
    rows,
  );
}

async function preflightMerge(
  context: HostCommandContext,
  root: string,
  revision: string,
): Promise<HostCommandResult | null> {
  if (fsExists(context.py, `${root}/.git/MERGE_HEAD`)) {
    return errorResult(1, "error: cannot start another merge while a merge is in progress\n");
  }
  const visibleRows = await statusMatrix(context, root);
  const nativeStatus = await invoke(context, ["status", "--porcelain"], root);
  if (
    trackedStateIsDirty(visibleRows) ||
    conflictPathsFromStatus(`${nativeStatus.stdout}\n${nativeStatus.stderr}`).length
  ) {
    return errorResult(1, "error: cannot merge with tracked or staged changes; commit or stash them first\n");
  }

  const head = await resolveDiffRevision(context, root, "HEAD");
  const target = await resolveDiffRevision(context, root, revision);
  const bases = await isomorphicGit.findMergeBase({ fs: gitFs(context), dir: root, oids: [head, target] })
    .catch(() => [] as string[]);
  if (bases.includes(target)) return result(0, "Already up to date.\n");

  const rows = await statusMatrix(context, root, { ignored: true });
  const records = await structuralDiffNames(context, root, [head, target], false, false);
  return preflightUntrackedWrites(
    context,
    root,
    records.flatMap((record) => record.paths),
    "merge",
    rows,
  );
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
    return runCommit(context, ["-m", message]);
  }
  let noCommit = false;
  const revisions: string[] = [];
  for (const arg of args) {
    if (arg === "--no-commit") noCommit = true;
    else if (arg.startsWith("-")) throw new GitUsageError(`unsupported merge option: ${arg}`);
    else revisions.push(arg);
  }
  if (revisions.length !== 1) throw new GitUsageError("merge requires exactly one branch or revision");
  const preflight = await preflightMerge(context, root, revisions[0]);
  if (preflight) return preflight;
  const merged = await invoke(
    context,
    ["merge", ...(noCommit ? ["--no-commit"] : []), revisions[0]],
    root,
  );
  const merging = fsExists(context.py, `${root}/.git/MERGE_HEAD`);
  if (noCommit && merging) {
    const status = await invoke(context, ["status", "--porcelain"], root);
    if (!conflictPathsFromStatus(`${status.stdout}\n${status.stderr}`).length) {
      return result(0, "Merge prepared; run git commit to complete it.\n");
    }
  }
  const rendered = render(merged);
  if (merging || conflictPathsFromStatus(`${merged.stdout}\n${merged.stderr}`).length) {
    return { ...rendered, exitCode: 1 };
  }
  return rendered;
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
    const separator = args.indexOf("--");
    if (separator < 0) return args;
    return [
      ...args.slice(0, separator),
      ...args.slice(separator + 1).map((arg) => arg.startsWith("-") ? `./${arg}` : arg),
    ];
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

function conflictPathsFromStatus(output: string): string[] {
  return [...output.matchAll(/^conflict:\s+a:(.*?)\s+o:(.*?)\s+t:(.*?)$/gm)].map(
    (match) => [match[1], match[2], match[3]].find((path) => path !== "NULL")!,
  ).filter(Boolean);
}

function normalizeStatus(py: Pyodide, root: string, args: string[], output: string): string {
  const porcelain = args.some((arg) =>
    ["--porcelain", "--porcelain=v1", "--short", "-s", "-z"].includes(arg)
  );
  const conflicts = conflictPathsFromStatus(output);
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

interface StatusRecord {
  code: string;
  path: string;
  source?: string;
}

interface StatusInvocation {
  porcelain: boolean;
  hasPaths: boolean;
  invalidOption?: string;
}

const STATUS_OPTIONS = new Set([
  "--short", "-s", "--branch", "-b", "--porcelain", "--porcelain=v1", "-z",
]);

function inspectStatusInvocation(args: string[]): StatusInvocation {
  let options = true;
  let porcelain = false;
  let hasPaths = false;
  for (const arg of args) {
    if (options && arg === "--") { options = false; continue; }
    if (!options || !arg.startsWith("-")) {
      hasPaths = true;
      continue;
    }
    if (STATUS_OPTIONS.has(arg)) {
      if (["--short", "-s", "--porcelain", "--porcelain=v1", "-z"].includes(arg)) {
        porcelain = true;
      }
      continue;
    }
    if (/^-[sbz]+$/.test(arg)) {
      if (arg.includes("s") || arg.includes("z")) porcelain = true;
      continue;
    }
    if (/^-u(?:no|normal|all)$/.test(arg) ||
        /^--untracked-files=(?:no|normal|all)$/.test(arg)) continue;
    return { porcelain, hasPaths, invalidOption: arg };
  }
  return { porcelain, hasPaths };
}

function renderHumanStatus(
  records: StatusRecord[],
  branch: string | null,
  unborn: boolean,
): string {
  let output = branch
    ? `On branch ${branch}\n`
    : "HEAD detached\n";
  if (unborn) output += "\nNo commits yet\n";

  const unmerged = records.filter((record) => record.code.includes("U"));
  const staged = records.filter((record) =>
    record.code !== "??" && !record.code.includes("U") && record.code[0] !== " "
  );
  const unstaged = records.filter((record) =>
    record.code !== "??" && !record.code.includes("U") && record.code[1] !== " "
  );
  const untracked = records.filter((record) => record.code === "??");
  const renderPath = (record: StatusRecord, column: 0 | 1): string => {
    const code = record.code[column];
    const action = code === "A" ? "new file" : code === "D" ? "deleted" :
      code === "R" ? "renamed" : "modified";
    const path = record.source
      ? `${quoteStatusPath(record.source)} -> ${quoteStatusPath(record.path)}`
      : quoteStatusPath(record.path);
    return `\t${action}: ${path}\n`;
  };
  if (staged.length) {
    output += "\nChanges to be committed:\n";
    for (const record of staged) output += renderPath(record, 0);
  }
  if (unstaged.length) {
    output += "\nChanges not staged for commit:\n";
    for (const record of unstaged) output += renderPath(record, 1);
  }
  if (unmerged.length) {
    output += "\nUnmerged paths:\n";
    for (const record of unmerged) output += `\tboth modified: ${quoteStatusPath(record.path)}\n`;
  }
  if (untracked.length) {
    output += "\nUntracked files:\n";
    for (const record of untracked) output += `\t${quoteStatusPath(record.path)}\n`;
  }
  if (!records.length) output += "\nnothing to commit, working tree clean\n";
  return output;
}

async function runStatusPorcelain(
  context: HostCommandContext,
  args: string[],
  porcelain = true,
): Promise<HostCommandResult> {
  let options = true;
  let includeUntracked = true;
  let branchOutput = false;
  let nul = false;
  const pathArgs: string[] = [];
  for (const arg of args) {
    if (options && arg === "--") { options = false; continue; }
    if (options && (/^-u(?:no|normal|all)$/.test(arg) ||
        /^--untracked-files=(?:no|normal|all)$/.test(arg))) {
      const mode = arg.startsWith("--") ? arg.slice("--untracked-files=".length) : arg.slice(2);
      includeUntracked = mode !== "no"; continue;
    }
    if (options && STATUS_OPTIONS.has(arg)) {
      if (arg === "-z") nul = true;
      if (["--branch", "-b", "-sb"].includes(arg)) branchOutput = true;
      continue;
    }
    if (options && /^-[sbz]{2,}$/.test(arg)) {
      nul ||= arg.includes("z");
      branchOutput ||= arg.includes("b");
      continue;
    }
    if (options && arg.startsWith("-")) {
      return errorResult(2, `git: unsupported status option: ${arg}\n`);
    }
    pathArgs.push(arg);
  }
  const root = repositoryRoot(context.py, context.cwd);
  const intentToAdd = fsExists(context.py, `${root}/.git/index`)
    ? gitIndexIntentToAddPaths(
        new Uint8Array(context.py.FS.readFile(`${root}/.git/index`) as Uint8Array),
      )
    : new Set<string>();
  const paths = pathArgs.map((path) => pathFromRepository(root, context.cwd, path));
  const fs = gitFs(context);
  let filepaths = paths.length ? paths : ["."];
  if (!includeUntracked) {
    const tracked = new Set(await isomorphicGit.listFiles({ fs, dir: root }));
    for (const path of await isomorphicGit.listFiles({ fs, dir: root, ref: "HEAD" }).catch(() => [])) tracked.add(path);
    filepaths = [...tracked].filter((path) => diffPathSelected(path, paths));
  }
  const rows = filepaths.length
    ? await statusMatrix(context, root, { filepaths })
    : [];
  const rowByPath = new Map(rows.map((row) => [row[0], row]));
  const branch = currentBranch(context.py, root);
  const unborn = Boolean(
    branch && !fsExists(context.py, branchRef(root, branch)) && !packedBranches(context.py, root).has(branch)
  );
  const merging = fsExists(context.py, `${root}/.git/MERGE_HEAD`);
  const conflictPaths = new Set<string>();
  if (merging) {
    const native = await invoke(context, ["status", "--porcelain"], root);
    for (const path of conflictPathsFromStatus(native.stdout)) conflictPaths.add(path);
  }

  const renames = new Map<string, { destination: string; working: string }>();
  if (!merging && !unborn) {
    const staged = coalesceExactRenames(await structuralDiffNames(context, root, [], true, false));
    for (const record of staged) {
      if (record.status !== "R100" || record.paths.length !== 2) continue;
      const [source, destination] = record.paths;
      const sourceRow = rowByPath.get(source);
      const destinationRow = rowByPath.get(destination);
      if (!sourceRow || !destinationRow || sourceRow[2] !== 0 || sourceRow[3] !== 0 || destinationRow[3] === 0) {
        continue;
      }
      const working = destinationRow[2] === destinationRow[3]
        ? " "
        : destinationRow[2] === 0 ? "D" : "M";
      renames.set(source, { destination, working });
    }
  }

  const renamedPaths = new Set<string>();
  for (const [source, rename] of renames) {
    renamedPaths.add(source);
    renamedPaths.add(rename.destination);
  }
  const records: StatusRecord[] = [];
  for (const [path, head, worktree, stage] of rows) {
    if (conflictPaths.has(path)) {
      records.push({ code: "UU", path });
      conflictPaths.delete(path);
      continue;
    }
    if (intentToAdd.has(path)) {
      records.push({ code: worktree === 0 ? " D" : " A", path });
      continue;
    }
    const rename = renames.get(path);
    if (rename) {
      records.push({ code: `R${rename.working}`, path: rename.destination, source: path });
      continue;
    }
    if (renamedPaths.has(path) || (head === worktree && worktree === stage)) continue;
    if (head === 0 && worktree === 2 && stage === 0) {
      if (!includeUntracked) continue;
      records.push({ code: "??", path });
      continue;
    }
    const index = head === stage ? " " : head === 0 ? "A" : stage === 0 ? "D" : "M";
    const working = worktree === stage ? " " : worktree === 0 ? "D" : "M";
    records.push({ code: `${index}${working}`, path });
  }
  for (const path of conflictPaths) records.push({ code: "UU", path });
  const visibleRecords = records.filter((record) =>
    diffPathSelected(record.path, paths) || Boolean(record.source && diffPathSelected(record.source, paths))
  ).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  if (!porcelain) return result(0, renderHumanStatus(visibleRecords, branch, unborn));

  let output = "";
  if (branchOutput) {
    output += branch
      ? `## ${unborn ? `No commits yet on ${branch}` : branch}${nul ? "\0" : "\n"}`
      : `## HEAD (no branch)${nul ? "\0" : "\n"}`;
  }
  for (const record of visibleRecords) {
    if (nul) {
      output += record.source
        ? `${record.code} ${record.path}\0${record.source}\0`
        : `${record.code} ${record.path}\0`;
    } else {
      output += record.source
        ? `${record.code} ${quoteStatusPath(record.source)} -> ${quoteStatusPath(record.path)}\n`
        : `${record.code} ${quoteStatusPath(record.path)}\n`;
    }
  }
  return result(0, output);
}

function rejectVirtualSnapshotRefs(context: HostCommandContext, command: string, args: string[]): void {
  if (!new Set([
    "branch", "checkout", "diff", "log", "show", "blame", "rev-list", "rev-parse", "merge-base", "cat-file", "merge",
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

interface CommitRequest {
  amend: boolean;
  all: boolean;
  allowEmpty: boolean;
  quiet: boolean;
  noEdit: boolean;
  messages: string[];
  stdinMessage: boolean;
}

function parseCommitRequest(args: string[]): CommitRequest {
  const request: CommitRequest = {
    amend: false,
    all: false,
    allowEmpty: false,
    quiet: false,
    noEdit: false,
    messages: [],
    stdinMessage: false,
  };
  const addMessage = (message: string | undefined, option: string) => {
    if (message === undefined) throw new GitUsageError(`${option} requires a message`);
    request.messages.push(message);
  };
  const addFile = (path: string | undefined, option: string) => {
    if (path === undefined) throw new GitUsageError(`${option} requires a file`);
    if (path !== "-") throw new GitUsageError("commit message files are unavailable; use -F - with piped stdin");
    if (request.stdinMessage) throw new GitUsageError("commit accepts only one -F/--file source");
    request.stdinMessage = true;
  };
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === "--amend") request.amend = true;
    else if (value === "-a" || value === "--all") request.all = true;
    else if (value === "--allow-empty") request.allowEmpty = true;
    else if (value === "-q" || value === "--quiet") request.quiet = true;
    else if (value === "--no-edit") request.noEdit = true;
    else if (value === "--no-verify" || value === "--no-gpg-sign") {
      // Hooks and signing are unavailable in the browser; these conventional
      // opt-out spellings are truthful compatibility no-ops.
    } else if (value === "-m" || value === "--message") {
      addMessage(args[++index], value);
    } else if (value.startsWith("--message=")) {
      addMessage(value.slice("--message=".length), "--message");
    } else if (value.startsWith("-m") && value.length > 2) {
      addMessage(value.slice(2), "-m");
    } else if (value === "-F" || value === "--file") {
      addFile(args[++index], value);
    } else if (value === "-F-") {
      addFile("-", "-F");
    } else if (value.startsWith("--file=")) {
      addFile(value.slice("--file=".length), "--file");
    } else if (value === "-am") {
      request.all = true;
      addMessage(args[++index], "-m");
    } else if (value.startsWith("-am") && value.length > 3) {
      request.all = true;
      addMessage(value.slice(3), "-m");
    } else if (value === "--") {
      throw new GitUsageError("commit path operands are unavailable; stage paths explicitly with git add");
    } else if (value.startsWith("-")) {
      throw new GitUsageError(`unsupported commit option: ${value}`);
    } else {
      throw new GitUsageError(
        `commit path operand '${value}' is unavailable; stage paths explicitly with git add`,
      );
    }
  }
  if (request.stdinMessage && request.messages.length) {
    throw new GitUsageError("commit -m/--message and -F/--file are mutually exclusive");
  }
  if (request.noEdit && !request.amend) {
    throw new GitUsageError("commit --no-edit requires --amend");
  }
  if (request.noEdit && (request.stdinMessage || request.messages.length)) {
    throw new GitUsageError("commit --no-edit and an explicit message are mutually exclusive");
  }
  if (!request.noEdit && !request.stdinMessage && !request.messages.length) {
    throw new GitUsageError(
      request.amend
        ? "commit --amend requires -m, -F -, or --no-edit"
        : "commit requires -m/--message or -F -",
    );
  }
  return request;
}

function commitMessage(context: HostCommandContext, request: CommitRequest): string | undefined {
  if (request.noEdit) return undefined;
  const message = request.stdinMessage
    ? decoder.decode(context.stdin ?? new Uint8Array())
    : request.messages.join("\n\n");
  if (message.includes("\0")) throw new GitUsageError("commit message cannot contain NUL");
  const normalized = message.trimEnd();
  if (!normalized) throw new GitUsageError("commit message is empty");
  return normalized;
}

function commitDate(value: string | undefined, variable: string): {
  timestamp: number;
  timezoneOffset: number;
} | undefined {
  if (!value) return undefined;
  let timestamp: number;
  let timezoneOffset: number | undefined;
  const internal = /^@?(-?\d+)(?:\s+([+-])(\d{2})(\d{2}))?$/.exec(value.trim());
  if (internal) {
    timestamp = Number(internal[1]);
    if (internal[2]) {
      const minutes = Number(internal[3]) * 60 + Number(internal[4]);
      if (minutes > 14 * 60) throw new GitUsageError(`${variable} has an invalid timezone`);
      timezoneOffset = internal[2] === "+" ? -minutes : minutes;
    }
  } else {
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds)) throw new GitUsageError(`${variable} has an invalid date`);
    timestamp = Math.floor(milliseconds / 1000);
    const offset = /(Z|([+-])(\d{2}):?(\d{2}))$/i.exec(value.trim());
    if (offset?.[1].toUpperCase() === "Z") timezoneOffset = 0;
    else if (offset?.[2]) {
      const minutes = Number(offset[3]) * 60 + Number(offset[4]);
      if (minutes > 14 * 60) throw new GitUsageError(`${variable} has an invalid timezone`);
      timezoneOffset = offset[2] === "+" ? -minutes : minutes;
    }
  }
  if (!Number.isSafeInteger(timestamp)) throw new GitUsageError(`${variable} is outside the supported range`);
  return {
    timestamp,
    timezoneOffset: timezoneOffset ?? new Date(timestamp * 1000).getTimezoneOffset(),
  };
}

async function runCommit(
  context: HostCommandContext,
  args: string[],
): Promise<HostCommandResult> {
  const request = parseCommitRequest(args);
  const message = commitMessage(context, request);
  const root = repositoryRoot(context.py, context.cwd);
  const mergeHeadPath = `${root}/.git/MERGE_HEAD`;
  const merging = fsExists(context.py, mergeHeadPath);
  if (request.amend && merging) throw new GitUsageError("cannot amend while a merge is in progress");

  const indexPath = `${root}/.git/index`;
  const hadIndex = fsExists(context.py, indexPath);
  const indexBefore = hadIndex
    ? new Uint8Array(context.py.FS.readFile(indexPath) as Uint8Array)
    : undefined;
  let stagedByAll = false;
  try {
    if (request.all) {
      await runAdd(context, ["-u"]);
      stagedByAll = true;
    }
    if (!request.amend && !merging && !request.allowEmpty && !(await hasStagedChanges(context, root))) {
      return errorResult(1, "nothing to commit\n");
    }

    const overrides = configOverrides(context);
    const fallback = identity(context) || { name: "Piodide", email: "piodide@browser.local" };
    const globalPath = globalConfigPath(context);
    const configuredName = configValue(context.py, root, "user.name", globalPath) || fallback.name;
    const configuredEmail = configValue(context.py, root, "user.email", globalPath) || fallback.email;
    const now = Math.floor(Date.now() / 1000);
    const defaultDate = { timestamp: now, timezoneOffset: new Date(now * 1000).getTimezoneOffset() };
    const author = {
      name: context.env?.GIT_AUTHOR_NAME || overrides["user.name"] || configuredName,
      email: context.env?.GIT_AUTHOR_EMAIL || overrides["user.email"] || configuredEmail,
      ...(commitDate(context.env?.GIT_AUTHOR_DATE, "GIT_AUTHOR_DATE") ?? defaultDate),
    };
    const committer = {
      name: context.env?.GIT_COMMITTER_NAME || overrides["user.name"] || configuredName,
      email: context.env?.GIT_COMMITTER_EMAIL || overrides["user.email"] || configuredEmail,
      ...(commitDate(context.env?.GIT_COMMITTER_DATE, "GIT_COMMITTER_DATE") ?? defaultDate),
    };
    let parent: string[] | undefined;
    if (merging) {
      const first = await isomorphicGit.resolveRef({ fs: gitFs(context), dir: root, ref: "HEAD" });
      const others = fsReadText(context.py, mergeHeadPath).trim().split(/\r?\n/).filter(Boolean);
      if (!others.length || others.some((oid) => !/^[0-9a-f]{40}$/.test(oid))) {
        throw new Error("MERGE_HEAD contains an invalid object id");
      }
      parent = [first, ...others];
    }
    await isomorphicGit.commit({
      fs: gitFs(context, { hideIntentToAdd: true }),
      dir: root,
      amend: request.amend,
      ...(message !== undefined ? { message } : {}),
      ...(request.amend ? {} : { author }),
      committer,
      ...(parent ? { parent } : {}),
      disallowEmpty: !request.allowEmpty && !request.amend && !merging,
    });
    if (merging) clearMergeState(context.py, root);
  } catch (error) {
    if (stagedByAll) {
      if (indexBefore) context.py.FS.writeFile(indexPath, indexBefore);
      else if (!hadIndex && fsExists(context.py, indexPath)) context.py.FS.unlink(indexPath);
    }
    throw error;
  }
  if (request.quiet) return result(0, "");
  const summary = await runLog(context, ["--oneline", "-n", "1", "HEAD"]);
  return summary.exitCode === 0 ? summary : result(0, "");
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
  let diffCommand = false;
  let predicateMergeBase = false;
  let predicateCatFile = false;
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
    diffCommand = command === "diff";
    predicateMergeBase = command === "merge-base" && args[1] === "--is-ancestor";
    predicateCatFile = command === "cat-file" && catFilePredicateRequested(args.slice(1));
    if (command === "help" || command === "-h" || command === "--help") {
      const topic = command === "help" ? args[1] : undefined;
      if (topic && !COMMAND_HELP[topic]) {
        return errorResult(1, `git: '${topic}' is not an available browser Git command\n`);
      }
      return result(0, topic ? COMMAND_HELP[topic] : HELP);
    }
    if (
      !predicateCatFile &&
      args.slice(1).some((arg) => arg === "-h" || arg === "--help") &&
      (!["check-ignore", "ls-tree", "grep"].includes(command) || args.length === 2)
    ) {
      if (!COMMAND_HELP[command]) {
        return errorResult(1, `git: '${command}' is not an available browser Git command\n`);
      }
      return result(0, COMMAND_HELP[command]);
    }
    if (command === "--version" || command === "version") {
      return result(0, "git version 2.0.0-piodide (libgit2 + isomorphic-git)\n");
    }
    const statusInvocation = command === "status"
      ? inspectStatusInvocation(args.slice(1))
      : undefined;
    if (statusInvocation?.invalidOption !== undefined) {
      return errorResult(2, `git: unsupported status option: ${statusInvocation.invalidOption}\n`);
    }
    rejectVirtualSnapshotRefs(scoped, command, args.slice(1));
    if (statusInvocation && (statusInvocation.porcelain || statusInvocation.hasPaths)) {
      return await runStatusPorcelain(scoped, args.slice(1), statusInvocation.porcelain);
    }
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
    if (command === "rm") return await runRm(scoped, args.slice(1));
    if (command === "mv") return await runMv(scoped, args.slice(1));
    if (command === "apply") return await runApply(scoped, args.slice(1));
    if (command === "diff") return await runDiff(scoped, args.slice(1));
    if (command === "remote") return await runRemote(scoped, args.slice(1));
    if (command === "restore") return await runRestore(scoped, args.slice(1));
    if (command === "checkout" && args.includes("--")) return await runCheckout(scoped, args.slice(1));
    if (command === "reset") return await runReset(scoped, args.slice(1));
    if (command === "clean") return await runClean(scoped, args.slice(1));
    if (command === "stash") return await runStash(scoped, args.slice(1));
    if (command === "tag" && ["-d", "--delete"].includes(args[1] ?? "")) {
      return runTagDelete(scoped, args.slice(1));
    }
    if (command === "cherry-pick") return await runCherryPick(scoped, args.slice(1));
    if (command === "gc") return await runGc(scoped);
    if (command === "fsck") return await runFsck(scoped);
    if (command === "ls-files") return await runLsFiles(scoped, args.slice(1));
    if (command === "ls-tree") return await runLsTree(scoped, args.slice(1));
    if (command === "grep") return await runGitGrep(scoped, args.slice(1));
    if (command === "check-ignore") return await runCheckIgnore(scoped, args.slice(1));
    if (command === "show-ref") return runShowRef(scoped, args.slice(1));
    if (command === "log") return await runLog(scoped, args.slice(1));
    if (command === "show") return await runShow(scoped, args.slice(1));
    if (command === "rev-list") return await runRevList(scoped, args.slice(1));
    if (command === "rev-parse") return await runRevParse(scoped, args.slice(1));
    if (command === "merge-base") return await runMergeBase(scoped, args.slice(1));
    if (command === "cat-file") return await runCatFile(scoped, args.slice(1));
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
    if (command === "commit") return await runCommit(scoped, args.slice(1));
    return await runLibgitCommand(scoped, cwd, args);
  } catch (error) {
    if (predicateCatFile) return result(2, "");
    const exitCode = error instanceof GitUsageError || diffCommand || predicateMergeBase ? 2 : 1;
    return errorResult(exitCode, `git: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
