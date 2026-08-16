import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { type Pyodide, fsExists, fsIsDir } from "./pyodide-host.ts";
import {
  normalizeGitHubApiUrl,
  verifyGitHubCredentials,
  type GitHubCredentials,
} from "./git-remote.ts";

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
      description: "Paths for add or diff, relative to the repository.",
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
    Type.Boolean({ description: "Delete the named branch." }),
  ),
  abort: Type.Optional(
    Type.Boolean({ description: "Abort an in-progress merge." }),
  ),
  continue: Type.Optional(
    Type.Boolean({ description: "Continue an in-progress merge after conflicts are staged." }),
  ),
  staged: Type.Optional(
    Type.Boolean({ description: "For diff, compare staged changes with HEAD." }),
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

function text(value: string) {
  return { type: "text" as const, text: value };
}

function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("Git arguments cannot contain NUL bytes.");
  return `'${value.replaceAll("'", `'\\''`)}'`;
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
  return params.branch;
}

function gitCommand(params: GitParamsValue): { command: string; cwd: string } {
  const cwd = workspacePath(params.cwd);
  const pathArgs = (params.paths ?? []).map(shellQuote).join(" ");
  switch (params.operation) {
    case "init":
      return {
        command: `git init${params.branch ? ` -b ${shellQuote(params.branch)}` : ""}`,
        cwd,
      };
    case "status":
      return { command: "git status", cwd };
    case "add":
      return { command: pathArgs ? `git add -- ${pathArgs}` : "git add -A", cwd };
    case "commit":
      if (!params.message?.trim()) throw new Error("commit requires message.");
      return { command: `git commit -m ${shellQuote(params.message)}`, cwd };
    case "log":
      return { command: `git log --oneline -n ${Math.min(50, Math.max(1, params.limit ?? 10))}`, cwd };
    case "diff":
      return {
        command: `git diff${params.staged ? " --staged" : ""}${pathArgs ? ` -- ${pathArgs}` : ""}`,
        cwd,
      };
    case "branch": {
      const branch = params.branch?.trim();
      if (params.delete && !branch) throw new Error("branch deletion requires branch.");
      return {
        command: branch
          ? `git branch${params.delete ? " -d" : ""} ${shellQuote(branch)}`
          : "git branch",
        cwd,
      };
    }
    case "switch": {
      const branch = requireBranch(params);
      return { command: `git switch${params.create ? " -c" : ""} ${shellQuote(branch)}`, cwd };
    }
    case "checkout": {
      const branch = requireBranch(params);
      return { command: `git checkout${params.create ? " -b" : ""} ${shellQuote(branch)}`, cwd };
    }
    case "clone": {
      if (!params.project?.trim()) throw new Error("clone requires project.");
      const destination = params.cwd ? cwd : cloneDirectory(params.project);
      const target = destination.slice("/home/web/".length);
      return {
        command:
          `git clone${params.branch ? ` -b ${shellQuote(params.branch)}` : ""}` +
          `${params.corsProxy ? ` --cors-proxy ${shellQuote(params.corsProxy)}` : ""} ` +
          `${shellQuote(params.project)} ${shellQuote(target)}`,
        cwd: "/home/web",
      };
    }
    case "fetch":
      return { command: `git fetch${params.corsProxy ? ` --cors-proxy ${shellQuote(params.corsProxy)}` : ""}`, cwd };
    case "pull":
      return { command: `git pull${params.corsProxy ? ` --cors-proxy ${shellQuote(params.corsProxy)}` : ""}`, cwd };
    case "push":
      return { command: `git push${params.branch ? ` origin ${shellQuote(params.branch)}` : ""}${params.corsProxy ? ` --cors-proxy ${shellQuote(params.corsProxy)}` : ""}`, cwd };
    case "merge":
      if (params.abort && params.continue) throw new Error("merge abort and continue are mutually exclusive.");
      if (params.abort) return { command: "git merge --abort", cwd };
      if (params.continue) return { command: "git merge --continue", cwd };
      return { command: `git merge ${shellQuote(requireBranch(params))}`, cwd };
    case "restore":
      if (!pathArgs) throw new Error("restore requires paths.");
      return { command: `git restore -- ${pathArgs}`, cwd };
    case "fsck":
      return { command: "git fsck", cwd };
  }
}

export function createGitTool(
  py: Pyodide,
  getCredentials: () => GitHubCredentials | null,
): AgentTool<typeof GitParams, GitDetails> {
  return {
    name: "git",
    label: "Git",
    description:
      "Use Slop's compiled Git frontend in /home/web. Repositories use canonical Git data. " +
      "Full smart-HTTP clone/fetch/pull/push works with CORS-enabled servers or an explicitly " +
      "trusted CORS proxy. GitHub uses a bounded single-branch snapshot fallback without a " +
      "proxy; run /github for private repositories and pushes.",
    parameters: GitParams,
    executionMode: "sequential",
    async execute(_id, params, signal) {
      const invocation = gitCommand(params);
      if (params.operation === "init" && !fsExists(py, invocation.cwd)) {
        py.FS.mkdirTree(invocation.cwd);
      }
      if (!fsExists(py, invocation.cwd) || !fsIsDir(py, invocation.cwd)) {
        throw new Error(`Not a directory: ${invocation.cwd}`);
      }
      const { runSlopCommand } = await import("./slop.ts");
      let stdout = "";
      let stderr = "";
      const result = await runSlopCommand(py, invocation.command, {
        cwd: invocation.cwd,
        signal,
        getGitHubCredentials: getCredentials,
        onStdout: (chunk) => { stdout += chunk; },
        onStderr: (chunk) => { stderr += chunk; },
      });
      const output = `${stdout}${stderr}` || `[exit ${result.exitCode}]\n`;
      if (result.exitCode !== 0) throw new Error(output.trimEnd());
      const resultCwd = params.operation === "clone"
        ? workspacePath(params.cwd ?? cloneDirectory(params.project!))
        : invocation.cwd;
      return {
        content: [text(output)],
        details: { operation: params.operation, cwd: resultCwd, exitCode: result.exitCode },
      };
    },
  };
}
