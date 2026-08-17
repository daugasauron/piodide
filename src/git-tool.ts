import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { type Pyodide, fsExists, fsIsDir } from "./pyodide-host.ts";
import {
  normalizeGitHubApiUrl,
  verifyGitHubCredentials,
  type GitHubCredentials,
} from "./git-remote.ts";
import { runGitEngineCommand } from "./git-engine.ts";

export { normalizeGitHubApiUrl, verifyGitHubCredentials };
export type { GitHubCredentials };

export const GitParams = Type.Object({
  operation: Type.Union([
    Type.Literal("init"),
    Type.Literal("status"),
    Type.Literal("add"),
    Type.Literal("commit"),
    Type.Literal("log"),
    Type.Literal("diff"),
    Type.Literal("branch"),
    Type.Literal("switch"),
    Type.Literal("checkout"),
    Type.Literal("clone"),
    Type.Literal("fetch"),
    Type.Literal("pull"),
    Type.Literal("push"),
    Type.Literal("merge"),
    Type.Literal("restore"),
    Type.Literal("fsck"),
  ]),
  cwd: Type.Optional(
    Type.String({
      description:
        "Repository directory. Defaults to /home/web; clone creates cwd or /home/web/<project>.",
    }),
  ),
  paths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Paths for add, checkout, diff, or restore, relative to the repository.",
      maxItems: 100,
    }),
  ),
  message: Type.Optional(
    Type.String({
      description: "Commit message. Required for commit.",
      maxLength: 10_000,
    }),
  ),
  project: Type.Optional(
    Type.String({
      description: "GitHub URL, owner/repository, or a repository path under /home/web. Required for clone.",
      maxLength: 2_000,
    }),
  ),
  branch: Type.Optional(
    Type.String({ description: "Branch to create, select, delete, or clone." }),
  ),
  corsProxy: Type.Optional(
    Type.String({ description: "Trusted CORS proxy for full browser smart-HTTP Git transport." }),
  ),
  create: Type.Optional(
    Type.Boolean({ description: "Create the branch while switching or checking out." }),
  ),
  delete: Type.Optional(
    Type.Boolean({ description: "Safely delete the named branch if it is fully merged." }),
  ),
  abort: Type.Optional(
    Type.Boolean({ description: "Abort an in-progress merge." }),
  ),
  continue: Type.Optional(
    Type.Boolean({ description: "Continue an in-progress merge after conflicts are staged." }),
  ),
  staged: Type.Optional(
    Type.Boolean({ description: "For diff, compare staged changes with HEAD; for restore, restore only the index." }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum log entries (default 10, maximum 50).",
      minimum: 1,
      maximum: 50,
    }),
  ),
});

export type GitParamsValue = Static<typeof GitParams>;

export interface GitDetails {
  operation: string;
  cwd: string;
  exitCode: number;
}

interface GitInvocation {
  args: string[];
  cwd: string;
}

function text(value: string) {
  return { type: "text" as const, text: value };
}

function validateArgument(value: string): string {
  if (value.includes("\0")) throw new Error("Git arguments cannot contain NUL bytes.");
  return value;
}

function workspacePath(value: string | undefined): string {
  const raw = value?.trim() || "/home/web";
  const absolute = raw.startsWith("/") ? raw : `/home/web/${raw}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const resolved = `/${parts.join("/")}`;
  if (resolved !== "/home/web" && !resolved.startsWith("/home/web/")) {
    throw new Error("Git repositories must stay inside /home/web.");
  }
  return resolved;
}

function cloneDirectory(project: string): string {
  const trimmed = project.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1).replace(/\.git$/i, "");
  if (!name || name === "." || name === "..") throw new Error("Cannot derive a clone directory.");
  return workspacePath(name);
}

function requireBranch(params: GitParamsValue): string {
  if (!params.branch?.trim()) throw new Error(`${params.operation} requires branch.`);
  return validateArgument(params.branch);
}

function gitInvocation(params: GitParamsValue): GitInvocation {
  const cwd = workspacePath(params.cwd);
  const paths = (params.paths ?? []).map(validateArgument);
  let args: string[];
  switch (params.operation) {
    case "init":
      args = ["init", ...(params.branch ? ["-b", validateArgument(params.branch)] : [])];
      break;
    case "status":
      args = ["status"];
      break;
    case "add":
      if (!paths.length) throw new Error("add requires paths; use ['.'] to stage all changes.");
      args = ["add", "--", ...paths];
      break;
    case "commit":
      if (!params.message?.trim()) throw new Error("commit requires message.");
      args = ["commit", "-m", validateArgument(params.message)];
      break;
    case "log":
      args = ["log", "--oneline", "-n", String(Math.min(50, Math.max(1, params.limit ?? 10)))];
      break;
    case "diff":
      args = ["diff", ...(params.staged ? ["--staged"] : []), ...(paths.length ? ["--", ...paths] : [])];
      break;
    case "branch": {
      const branch = params.branch?.trim();
      if (params.delete && !branch) throw new Error("branch deletion requires branch.");
      args = branch ? ["branch", ...(params.delete ? ["-d"] : []), validateArgument(branch)] : ["branch"];
      break;
    }
    case "switch":
      args = ["switch", ...(params.create ? ["-c"] : []), requireBranch(params)];
      break;
    case "checkout":
      if (paths.length) {
        if (params.create) throw new Error("checkout cannot create a branch while restoring paths.");
        args = ["checkout", ...(params.branch ? [validateArgument(params.branch)] : []), "--", ...paths];
      } else {
        args = ["checkout", ...(params.create ? ["-b"] : []), requireBranch(params)];
      }
      break;
    case "clone": {
      if (!params.project?.trim()) throw new Error("clone requires project.");
      const destination = params.cwd ? cwd : cloneDirectory(params.project);
      const target = destination.slice("/home/web/".length);
      args = [
        "clone",
        ...(params.branch ? ["-b", validateArgument(params.branch)] : []),
        ...(params.corsProxy ? ["--cors-proxy", validateArgument(params.corsProxy)] : []),
        validateArgument(params.project),
        validateArgument(target),
      ];
      return { args, cwd: "/home/web" };
    }
    case "fetch":
      args = ["fetch", ...(params.corsProxy ? ["--cors-proxy", validateArgument(params.corsProxy)] : [])];
      break;
    case "pull":
      args = ["pull", ...(params.corsProxy ? ["--cors-proxy", validateArgument(params.corsProxy)] : [])];
      break;
    case "push":
      args = [
        "push",
        ...(params.branch ? ["origin", validateArgument(params.branch)] : []),
        ...(params.corsProxy ? ["--cors-proxy", validateArgument(params.corsProxy)] : []),
      ];
      break;
    case "merge":
      if (params.abort && params.continue) throw new Error("merge abort and continue are mutually exclusive.");
      args = params.abort ? ["merge", "--abort"]
        : params.continue ? ["merge", "--continue"]
        : ["merge", requireBranch(params)];
      break;
    case "restore":
      if (!paths.length) throw new Error("restore requires paths.");
      args = ["restore", ...(params.staged ? ["--staged"] : []), "--", ...paths];
      break;
    case "fsck":
      args = ["fsck"];
      break;
  }
  return { args, cwd };
}

export function createGitTool(
  py: Pyodide,
  getCredentials: () => GitHubCredentials | null,
): AgentTool<typeof GitParams, GitDetails> {
  return {
    name: "git",
    label: "Git",
    description:
      "Use the browser Git engine in /home/web. Repositories use canonical Git data. " +
      "Full smart-HTTP clone/fetch/pull/push works with CORS-enabled servers or an explicitly " +
      "trusted CORS proxy. GitHub uses a bounded single-branch snapshot fallback without a " +
      "proxy; run /github for private repositories and pushes.",
    parameters: GitParams,
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const invocation = gitInvocation(params);
      if (params.operation === "init" && !fsExists(py, invocation.cwd)) {
        py.FS.mkdirTree(invocation.cwd);
      }
      if (!fsExists(py, invocation.cwd) || !fsIsDir(py, invocation.cwd)) {
        throw new Error(`Not a directory: ${invocation.cwd}`);
      }
      const response = await runGitEngineCommand({
        py,
        cwd: invocation.cwd,
        args: ["git-engine", ...invocation.args],
        signal,
        getGitHubCredentials: getCredentials,
      });
      const outputBytes = (response.stdout?.byteLength ?? 0) + (response.stderr?.byteLength ?? 0);
      if (outputBytes > 1024 * 1024) {
        throw new Error("Git output exceeds 1048576 bytes; narrow the command or write smaller output.");
      }
      const decoder = new TextDecoder();
      const stdout = decoder.decode(response.stdout ?? new Uint8Array());
      const stderr = decoder.decode(response.stderr ?? new Uint8Array());
      const output = `${stdout}${stderr}` || `[exit ${response.exitCode}]\n`;
      if (response.exitCode !== 0) throw new Error(output.trimEnd());
      const resultCwd = params.operation === "clone"
        ? workspacePath(params.cwd ?? cloneDirectory(params.project!))
        : invocation.cwd;
      return {
        content: [text(output)],
        details: { operation: params.operation, cwd: resultCwd, exitCode: response.exitCode },
      };
    },
  };
}
