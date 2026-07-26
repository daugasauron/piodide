import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import {
  createMonacoNeovim,
  type MonacoNeovimClient,
  type HostCommand,
} from "@monaco-neovim-wasm/wasm-async";

import type { Pyodide } from "./pyodide-host.ts";

const PY_ROOT = "/home/web";
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SYNC_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_SYNC_TOTAL_BYTES = 24 * 1024 * 1024;
const MAX_TREE_ENTRIES = 30_000;
const MAX_TREE_DEPTH = 64;

// 0.1.28's host-autocmd installer stops at an unsupported VisualEnter event,
// before registering buffer events. Its deferred cursor callback also does not
// run in the async WASM worker, so use direct notifications for those events.
const BRIDGE_COMPAT_LUA = String.raw`
  local root = ...
  local api = vim.api
  local chan = vim.g.monaco_neovim_wasm_chan
  if type(chan) ~= "number" then
    error("Monaco bridge channel is unavailable")
  end

  pcall(api.nvim_clear_autocmds, { group = "MonacoNeovimWasm" })
  local group = api.nvim_create_augroup("PiodideMonacoBuffers", { clear = true })
  local function send_cursor()
    local cursor = api.nvim_win_get_cursor(0)
    vim.rpcnotify(chan, "monaco_cursor", cursor[1], cursor[2])
  end
  local function send_mode()
    local info = api.nvim_get_mode() or {}
    local cursor = api.nvim_win_get_cursor(0)
    vim.rpcnotify(
      chan,
      "monaco_mode",
      info.mode or "",
      info.blocking and true or false,
      vim.fn.reg_recording() or "",
      vim.fn.reg_executing() or "",
      cursor[1],
      cursor[2]
    )
  end
  local function send_visual()
    local mode = (api.nvim_get_mode() or {}).mode or ""
    if mode:match("[vV" .. string.char(22) .. "]") then
      vim.rpcnotify(chan, "monaco_visual_changed")
    end
  end
  local function send_recording()
    vim.rpcnotify(chan, "monaco_recording", vim.fn.reg_recording() or "")
  end
  local function send_scrolloff()
    vim.rpcnotify(chan, "monaco_scrolloff", vim.o.scrolloff or 0)
  end
  local function send_buffer()
    local buf = api.nvim_get_current_buf()
    local name = api.nvim_buf_get_name(buf) or ""
    if (root == "/" and name:sub(1, 1) == "/")
        or name:sub(1, #root + 1) == root .. "/" then
      vim.bo[buf].readonly = false
    end
    vim.rpcnotify(chan, "monaco_buf_enter", {
      buf = buf,
      name = name,
      filetype = (vim.bo[buf] and vim.bo[buf].filetype) or "",
    })
    send_cursor()
  end

  api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
    group = group,
    callback = function()
      send_cursor()
      send_visual()
    end,
  })
  api.nvim_create_autocmd({ "ModeChanged", "InsertEnter", "InsertLeave" }, {
    group = group,
    callback = function()
      send_mode()
      send_visual()
    end,
  })
  api.nvim_create_autocmd({ "BufEnter", "BufWinEnter" }, {
    group = group,
    callback = send_buffer,
  })
  api.nvim_create_autocmd("BufDelete", {
    group = group,
    callback = function(event)
      vim.rpcnotify(chan, "monaco_buf_delete", {
        buf = (event and event.buf) or api.nvim_get_current_buf(),
      })
    end,
  })
  pcall(api.nvim_create_autocmd, { "RecordingEnter", "RecordingLeave" }, {
    group = group,
    callback = send_recording,
  })
  api.nvim_create_autocmd("OptionSet", {
    group = group,
    pattern = "scrolloff",
    callback = send_scrolloff,
  })

  send_mode()
  send_buffer()
  send_scrolloff()
  send_recording()
`;

const EXPLORER_LUA = String.raw`
  local cwd, initial_files, initial_dirs = ...
  local root = "/"
  _G.PiodideFiles = {}
  _G.PiodideDirs = {}

  _G.PiodideSetManifest = function(files, dirs)
    local next_files = {}
    for _, path in ipairs(files or {}) do
      if type(path) == "string" and path:sub(1, 1) == "/" then
        next_files[path] = true
      end
    end
    local next_dirs = {}
    for _, path in ipairs(dirs or {}) do
      if type(path) == "string" and path:sub(1, 1) == "/" then
        next_dirs[path] = true
      end
    end
    _G.PiodideFiles = next_files
    _G.PiodideDirs = next_dirs
  end

  local function normalize(path)
    local parts = {}
    for segment in tostring(path or ""):gmatch("[^/]+") do
      if segment == ".." then
        table.remove(parts)
      elseif segment ~= "." and segment ~= "" then
        table.insert(parts, segment)
      end
    end
    return "/" .. table.concat(parts, "/")
  end

  local function parent(path)
    local value = normalize(path)
    if value == "/" then return "/" end
    local result = value:match("^(.*)/[^/]+$") or "/"
    return result == "" and "/" or result
  end

  local function child_path(dir, name)
    return dir == "/" and "/" .. name or dir .. "/" .. name
  end

  _G.PiodideExplore = function(requested)
    local dir
    if type(requested) ~= "string" or requested == "" then
      dir = normalize(_G.PiodideCwd or cwd)
    elseif requested:sub(1, 1) == "/" then
      dir = normalize(requested)
    else
      dir = normalize(child_path(_G.PiodideCwd or cwd, requested))
    end
    if dir ~= "/" and not _G.PiodideDirs[dir] then
      vim.notify("Not a directory: " .. dir, vim.log.levels.WARN)
      dir = normalize(_G.PiodideCwd or cwd)
    end

    local children = {}
    local function add_manifest_entry(path, declared_kind)
      local prefix = dir == "/" and "/" or dir .. "/"
      if path:sub(1, #prefix) ~= prefix then return end
      local rest = path:sub(#prefix + 1)
      local name, tail = rest:match("^([^/]+)(.*)$")
      if not name or name == "" then return end
      local kind = tail ~= "" and "dir" or declared_kind
      local existing = children[name]
      if not existing or kind == "dir" then
        children[name] = {
          kind = kind,
          path = child_path(dir, name),
        }
      end
    end

    for path, _ in pairs(_G.PiodideDirs or {}) do
      add_manifest_entry(path, "dir")
    end
    for path, _ in pairs(_G.PiodideFiles or {}) do
      add_manifest_entry(path, "file")
    end

    local names = vim.tbl_keys(children)
    table.sort(names, function(a, b)
      local ak, bk = children[a].kind, children[b].kind
      if ak ~= bk then
        return ak == "dir"
      end
      return a:lower() < b:lower()
    end)

    local buf = vim.api.nvim_get_current_buf()
    local switch_buffer = false
    if vim.bo[buf].buftype ~= "nofile" or not vim.b[buf].piodide_explorer then
      buf = vim.api.nvim_create_buf(false, true)
      switch_buffer = true
    end
    vim.bo[buf].buftype = "nofile"
    vim.bo[buf].bufhidden = "wipe"
    vim.bo[buf].swapfile = false
    vim.bo[buf].filetype = "piodide"
    vim.bo[buf].modifiable = true

    local lines = {
      "  cwd:  " .. normalize(_G.PiodideCwd or cwd),
      "  path: " .. dir,
      "  <Enter> open  - parent  % file  d directory  D delete",
      "",
      "  ../",
    }
    local entries = {}
    entries[tostring(#lines)] = { kind = "dir", path = parent(dir) }
    for _, name in ipairs(names) do
      local entry = children[name]
      table.insert(lines, (entry.kind == "dir" and "  " .. name .. "/" or "  " .. name))
      entries[tostring(#lines)] = entry
    end
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
    vim.bo[buf].modifiable = false
    vim.bo[buf].modified = false
    vim.b[buf].piodide_explorer = true
    vim.b[buf].piodide_dir = dir
    vim.b[buf].piodide_entries = entries

    local function selected()
      return vim.b[buf].piodide_entries[tostring(vim.fn.line("."))]
    end
    local function notify_fs(action, payload)
      payload = payload or {}
      payload.action = action
      vim.rpcnotify(
        vim.g.monaco_neovim_wasm_chan,
        "monaco_host_command",
        payload
      )
    end
    local function open_selected()
      local entry = selected()
      if not entry then return end
      if entry.kind == "dir" then
        _G.PiodideExplore(entry.path)
      else
        vim.rpcnotify(vim.g.monaco_neovim_wasm_chan, "monaco_host_command", {
          action = "edit",
          path = entry.path,
        })
      end
    end
    vim.keymap.set("n", "<CR>", open_selected, { buffer = buf, silent = true })
    vim.keymap.set("n", "<kEnter>", open_selected, { buffer = buf, silent = true })
    vim.keymap.set("n", "-", function()
      _G.PiodideExplore(parent(dir))
    end, { buffer = buf, silent = true })
    vim.keymap.set("n", "q", "<cmd>bdelete<CR>", { buffer = buf, silent = true })
    vim.keymap.set("n", "r", function()
      notify_fs("refresh", { path = dir })
    end, { buffer = buf, silent = true })
    vim.keymap.set("n", "%", function()
      local name = vim.fn.input("New file: ")
      if name == "" then return end
      if name:sub(1, 1) == "/" or name:find("\0", 1, true) then return end
      for segment in name:gmatch("[^/]+") do
        if segment == "." or segment == ".." then return end
      end
      local path = child_path(dir, name)
      notify_fs("create", { path = path })
      vim.rpcnotify(vim.g.monaco_neovim_wasm_chan, "monaco_host_command", {
        action = "edit",
        path = path,
      })
    end, { buffer = buf, silent = true })
    vim.keymap.set("n", "d", function()
      local name = vim.fn.input("New directory: ")
      if name == "" then return end
      if name:sub(1, 1) == "/" or name:find("\0", 1, true) then return end
      for segment in name:gmatch("[^/]+") do
        if segment == "." or segment == ".." then return end
      end
      local path = normalize(child_path(dir, name))
      notify_fs("mkdir", { path = path })
    end, { buffer = buf, silent = true })
    vim.keymap.set("n", "D", function()
      local entry = selected()
      if not entry or entry.path == root then return end
      if vim.fn.confirm("Delete " .. vim.fn.fnamemodify(entry.path, ":t") .. "?", "&Yes\n&No", 2) == 1 then
        notify_fs("delete", {
          path = entry.path,
          kind = entry.kind,
        })
      end
    end, { buffer = buf, silent = true })

    if switch_buffer then
      vim.api.nvim_set_current_buf(buf)
    end
    local first = 5
    vim.api.nvim_win_set_cursor(0, { math.min(first, #lines), 0 })
  end

  _G.PiodideSetManifest(initial_files, initial_dirs)
  _G.PiodideCwd = normalize(cwd)
  vim.env.PWD = _G.PiodideCwd
  pcall(vim.api.nvim_del_user_command, "Explore")
  vim.api.nvim_create_user_command("Explore", function(opts)
    _G.PiodideExplore(opts.args)
  end, { nargs = "?" })
`;

interface PyTreeSnapshot {
  files: string[];
  directories: string[];
  skipped: number;
}

interface NvimBufferSnapshot {
  buffers: Array<{
    id: number;
    path: string;
    text: string;
    modified: boolean;
    current: boolean;
  }>;
  skipped: number;
}

interface NvimLoadedBuffer {
  id: number;
  path: string;
  modified: boolean;
}

export interface NeovimController {
  readonly client: MonacoNeovimClient;
  readonly editor: monaco.editor.IStandaloneCodeEditor;
  syncFromPyodide(): Promise<string>;
  syncToPyodide(): Promise<string>;
  focus(): void;
}

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker(_moduleId: string, _label: string): Worker;
    };
  }
}

window.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

let themeDefined = false;

export async function createNeovimController(
  py: Pyodide,
  mount: HTMLElement,
  commandline: HTMLElement,
  setStatus: (message: string, warning?: boolean) => void,
): Promise<NeovimController> {
  const initialTree = snapshotPyodideTree(py);
  const workspaceFiles = initialTree.files.filter(
    (path) => path.startsWith(`${PY_ROOT}/`),
  );
  let commandText: string | null = null;
  let messageText: string | null = null;

  defineTheme();
  const model = monaco.editor.createModel("", "markdown");
  const editor = monaco.editor.create(mount, {
    model,
    theme: "piodide-nvim",
    automaticLayout: true,
    fontFamily: '"IosevkaTerm Nerd Font", monospace',
    fontSize: 16,
    lineHeight: 23,
    fontLigatures: true,
    minimap: { enabled: false },
    overviewRulerLanes: 0,
    overviewRulerBorder: false,
    padding: { top: 7, bottom: 7 },
    renderWhitespace: "selection",
    occurrencesHighlight: "off",
    selectionHighlight: false,
    smoothScrolling: false,
    scrollBeyondLastLine: false,
    wordWrap: "off",
    cursorBlinking: "phase",
  });

  const renderCommandline = () => {
    const value = commandText || messageText || "";
    commandline.textContent = value;
    commandline.classList.toggle("visible", value.length > 0);
  };

  const readmePath = `${PY_ROOT}/README.md`;
  const startPath = initialTree.files.includes(readmePath)
    ? readmePath
    : (workspaceFiles[0] ?? "");
  let startText = "";
  if (startPath) {
    try {
      startText = readPyodideFile(py, startPath);
    } catch {
      // Binary or oversized files are left unopened.
    }
  }
  const seedLines = startText.replace(/\r\n?/g, "\n").split("\n");
  const startupLua = `
    vim.opt.runtimepath:prepend("/nvim/runtime")
    package.path = "/nvim/runtime/lua/?.lua;/nvim/runtime/lua/?/init.lua;" .. package.path
    vim.cmd("filetype plugin indent on")
    vim.cmd("syntax enable")
  `;

  let client: MonacoNeovimClient;
  client = createMonacoNeovim(editor, {
    env: { PWD: pyodideCwd(py) },
    inputMode: "message",
    hostCommands: true,
    onHostCommand: (command) =>
      handlePyodideHostCommand(client, editor, py, command, setStatus),
    seedLines,
    seedName: startPath,
    seedFiletype: startPath.endsWith(".md") ? "markdown" : "",
    seedFromMonaco: false,
    initialSync: "nvimToMonaco",
    syncModelFromMonaco: "insertOnly",
    startupCommands: [
      "set noswapfile signcolumn=no number norelativenumber",
      "set mouse=a nowrap laststatus=0 cmdheight=1",
      "set shortmess+=F",
      "set clipboard=unnamedplus",
    ],
    startupLua,
    clipboard: {
      readText: () => navigator.clipboard.readText(),
      writeText: (text) => navigator.clipboard.writeText(text),
    },
    status: (text, warn) => setStatus(text, warn),
    onStartError: (message) => setStatus(message || "Neovim failed to start", true),
    onWarning: (message) => setStatus(message, true),
    onExit: (code, stderr) =>
      setStatus(`Neovim exited (${code})${stderr ? `: ${stderr}` : ""}`, true),
    onModeChange: (mode) => setStatus(`${mode} · Ctrl+Shift+E toggles agent`),
    onCmdline: (text) => {
      commandText = text;
      renderCommandline();
    },
    onMessage: (text) => {
      messageText = text;
      renderCommandline();
    },
    shouldHandleKey: (event) =>
      !(event.ctrlKey && event.shiftKey && event.code === "KeyE"),
  });
  editor.onDidChangeModel(() => requestAnimationFrame(() => editor.focus()));

  setStatus(
    `starting · ${workspaceFiles.length} files${
      initialTree.skipped ? ` · ${initialTree.skipped} skipped` : ""
    }`,
  );
  try {
    await client.start();
    await client.execLua(BRIDGE_COMPAT_LUA, ["/"]);
    await client.execLua(EXPLORER_LUA, [
      pyodideCwd(py),
      initialTree.files,
      initialTree.directories,
    ]);
    const hasExplore = await client.call<number>("nvim_eval", ["exists(':Explore')"]);
    if (Number(hasExplore) !== 2) throw new Error("the :Ex browser did not register");
  } catch (error) {
    client.dispose();
    editor.dispose();
    model.dispose();
    throw error;
  }

  setStatus(
    `ready · ${workspaceFiles.length} files${
      initialTree.skipped ? ` · ${initialTree.skipped} skipped` : ""
    }`,
  );

  return {
    client,
    editor,

    async syncFromPyodide() {
      const tree = snapshotPyodideTree(py);
      const loaded = await getLoadedPyodideBuffers(client);
      const paths: string[] = [];
      const texts: string[] = [];
      let total = 0;
      let skipped = tree.skipped;
      for (const buffer of loaded) {
        if (buffer.modified || !isPyodideFile(py, buffer.path)) continue;
        try {
          const text = readPyodideText(py, buffer.path);
          const bytes = new TextEncoder().encode(text).byteLength;
          if (
            bytes > MAX_SYNC_TEXT_BYTES ||
            total + bytes > MAX_SYNC_TOTAL_BYTES
          ) {
            skipped += 1;
            continue;
          }
          paths.push(buffer.path);
          texts.push(text);
          total += bytes;
        } catch {
          skipped += 1;
        }
      }
      await updateNeovimFromPyodide(
        client,
        tree,
        pyodideCwd(py),
        paths,
        texts,
      );
      return `${tree.files.length} files · ${tree.directories.length} dirs${
        skipped ? ` · ${skipped} skipped` : ""
      }`;
    },

    async syncToPyodide() {
      const snapshot = await getModifiedPyodideBuffers(client);
      if (snapshot.skipped) {
        throw new Error(
          `${snapshot.skipped} modified buffer${
            snapshot.skipped === 1 ? " is" : "s are"
          } too large to save safely`,
        );
      }
      const active = snapshot.buffers.find((buffer) => buffer.current);
      if (active) active.text = editor.getModel()?.getValue() ?? active.text;
      let written = 0;
      for (const buffer of snapshot.buffers) {
        if (!buffer.modified) continue;
        const path = resolvePyodidePath(py, buffer.path);
        const slash = path.lastIndexOf("/");
        if (slash > 0) py.FS.mkdirTree(path.slice(0, slash));
        py.FS.writeFile(path, buffer.text, { encoding: "utf8" });
        written += 1;
      }
      if (written) {
        await client.execLua(
          `
            local ids = ...
            for _, id in ipairs(ids) do
              if vim.api.nvim_buf_is_valid(id) then
                vim.bo[id].modified = false
              end
            end
          `,
          [snapshot.buffers.filter((buffer) => buffer.modified).map((buffer) => buffer.id)],
        );
      }
      return `${written} file${written === 1 ? "" : "s"} saved to Pyodide`;
    },

    focus() {
      editor.focus();
    },
  };
}

async function handlePyodideHostCommand(
  client: MonacoNeovimClient,
  editor: monaco.editor.IStandaloneCodeEditor,
  py: Pyodide,
  command: HostCommand,
  setStatus: (message: string, warning?: boolean) => void,
) {
  const action = command.action;
  const rawPath =
    "path" in command && typeof command.path === "string" ? command.path : "";
  let path = rawPath ? resolvePyodidePath(py, rawPath) : "";

  try {
    if (action === "edit") {
      if (!path) throw new Error("No file path");
      const text = readPyodideFile(py, path);
      const openText = (
        client as unknown as {
          openText(input: { path: string; text: string }): Promise<void>;
        }
      ).openText;
      if (!openText) throw new Error("Neovim file bridge is unavailable");
      await openText.call(client, { path, text });
      await client.call("nvim_buf_set_option", [0, "eol", text.endsWith("\n")]);
      setStatus(`opened · ${path}`);
      return;
    }

    if (action === "write" || action === "wq") {
      if (!path) {
        const current = await client.call<unknown>("nvim_buf_get_name", [0]);
        if (typeof current === "string") {
          path = resolvePyodidePath(py, current);
        }
      }
      if (!path) throw new Error("No file path");
      const text = editor.getModel()?.getValue() ?? "";
      const slash = path.lastIndexOf("/");
      if (slash > 0) py.FS.mkdirTree(path.slice(0, slash));
      py.FS.writeFile(path, text, { encoding: "utf8" });
      await client.call("nvim_buf_set_name", [0, path]);
      await client.call("nvim_buf_set_option", [0, "modified", false]);
      setStatus(`written · ${path}`);
      if (action === "wq") client.command("bdelete");
      return;
    }

    if (action === "quit") {
      client.command(command.bang ? "bdelete!" : "bdelete");
      return;
    }

    if (action === "create") {
      if (!path || path === "/") throw new Error("Invalid file path");
      if (py.FS.analyzePath(path).exists) {
        throw new Error(`Already exists: ${path}`);
      }
      const slash = path.lastIndexOf("/");
      if (slash > 0) py.FS.mkdirTree(path.slice(0, slash));
      py.FS.writeFile(path, "", { encoding: "utf8" });
    } else if (action === "mkdir") {
      if (!path || path === "/") throw new Error("Invalid directory path");
      if (py.FS.analyzePath(path).exists) {
        throw new Error(`Already exists: ${path}`);
      }
      py.FS.mkdirTree(path);
    } else if (action === "delete") {
      if (!path || path === "/") throw new Error("Cannot delete /");
      if (String(command.kind ?? "") === "dir") py.FS.rmdir(path);
      else py.FS.unlink(path);
    } else if (action !== "refresh") {
      setStatus(`Unsupported Neovim action: ${action}`, true);
      return;
    }

    const tree = snapshotPyodideTree(py);
    await updatePyodideManifest(client, tree, pyodideCwd(py));
    const verb =
      action === "create"
        ? "created"
        : action === "mkdir"
          ? "created directory"
          : action === "delete"
            ? "deleted"
            : "refreshed";
    setStatus(`${verb}${path ? ` · ${path}` : ""}`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function snapshotPyodideTree(py: Pyodide): PyTreeSnapshot {
  const files: string[] = [];
  const directories: string[] = [];
  let entries = 0;
  let skipped = 0;

  const visit = (directory: string, depth: number) => {
    if (depth > MAX_TREE_DEPTH || entries >= MAX_TREE_ENTRIES) {
      skipped += 1;
      return;
    }
    let names: string[];
    try {
      names = py.FS.readdir(directory)
        .filter((name) => name !== "." && name !== "..")
        .sort((a, b) => a.localeCompare(b));
    } catch {
      skipped += 1;
      return;
    }

    const childDirectories: string[] = [];
    for (const name of names) {
      if (entries++ >= MAX_TREE_ENTRIES) {
        skipped += 1;
        break;
      }
      const path = directory === "/" ? `/${name}` : `${directory}/${name}`;
      try {
        const stat = py.FS.lstat(path);
        if (py.FS.isDir(stat.mode)) {
          directories.push(path);
          childDirectories.push(path);
        } else {
          files.push(path);
        }
      } catch {
        skipped += 1;
      }
    }
    for (const child of childDirectories) visit(child, depth + 1);
  };

  visit("/", 0);
  return { files, directories, skipped };
}

function pyodideCwd(py: Pyodide): string {
  const value = py.runPython("import os; os.getcwd()");
  return typeof value === "string" && value.startsWith("/") ? value : PY_ROOT;
}

function resolvePyodidePath(py: Pyodide, path: string): string {
  const expanded =
    path === "~"
      ? PY_ROOT
      : path.startsWith("~/")
        ? `${PY_ROOT}/${path.slice(2)}`
        : path;
  const absolute = expanded.startsWith("/")
    ? expanded
    : `${pyodideCwd(py)}/${expanded}`;
  const parts: string[] = [];
  for (const segment of absolute.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

function isPyodideFile(py: Pyodide, path: string): boolean {
  try {
    const resolved = resolvePyodidePath(py, path);
    return (
      py.FS.analyzePath(resolved).exists &&
      !py.FS.isDir(py.FS.stat(resolved).mode)
    );
  } catch {
    return false;
  }
}

function readPyodideFile(py: Pyodide, path: string): string {
  const stat = py.FS.stat(path);
  if (py.FS.isDir(stat.mode)) throw new Error(`Is a directory: ${path}`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`File is too large to edit safely: ${path}`);
  }
  const bytes = new Uint8Array(py.FS.readFile(path) as Uint8Array);
  if (bytes.includes(0)) throw new Error(`Binary files are not supported: ${path}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`File is not valid UTF-8: ${path}`);
  }
}

function readPyodideText(py: Pyodide, path: string): string {
  return readPyodideFile(py, resolvePyodidePath(py, path));
}

async function getLoadedPyodideBuffers(
  client: MonacoNeovimClient,
): Promise<NvimLoadedBuffer[]> {
  return client.execLua<NvimLoadedBuffer[]>(`
    local result = {}
    for _, id in ipairs(vim.api.nvim_list_bufs()) do
      if vim.api.nvim_buf_is_loaded(id)
          and vim.bo[id].buftype == ""
          and vim.api.nvim_buf_get_name(id) ~= "" then
        table.insert(result, {
          id = id,
          path = vim.api.nvim_buf_get_name(id),
          modified = vim.bo[id].modified,
        })
      end
    end
    return result
  `);
}

async function getModifiedPyodideBuffers(
  client: MonacoNeovimClient,
): Promise<NvimBufferSnapshot> {
  return client.execLua<NvimBufferSnapshot>(
    `
      local max_file, max_total = ...
      local result = { buffers = {}, skipped = 0 }
      local total = 0
      for _, id in ipairs(vim.api.nvim_list_bufs()) do
        if vim.api.nvim_buf_is_loaded(id)
            and vim.bo[id].buftype == ""
            and vim.bo[id].modified
            and vim.api.nvim_buf_get_name(id) ~= "" then
          local lines = vim.api.nvim_buf_get_lines(id, 0, -1, false)
          local text = table.concat(lines, string.char(10))
          if vim.bo[id].eol then
            text = text .. string.char(10)
          end
          if #text <= max_file and total + #text <= max_total then
            table.insert(result.buffers, {
              id = id,
              path = vim.api.nvim_buf_get_name(id),
              text = text,
              modified = true,
              current = id == vim.api.nvim_get_current_buf(),
            })
            total = total + #text
          else
            result.skipped = result.skipped + 1
          end
        end
      end
      return result
    `,
    [MAX_SYNC_TEXT_BYTES, MAX_SYNC_TOTAL_BYTES],
  );
}

async function updatePyodideManifest(
  client: MonacoNeovimClient,
  tree: PyTreeSnapshot,
  cwd: string,
) {
  await client.execLua(
    `
      local files, dirs, cwd = ...
      if _G.PiodideSetManifest then
        _G.PiodideSetManifest(files, dirs)
      end
      _G.PiodideCwd = cwd
      vim.env.PWD = cwd
      if vim.b.piodide_explorer and _G.PiodideExplore then
        _G.PiodideExplore(vim.b.piodide_dir)
      end
    `,
    [tree.files, tree.directories, cwd],
  );
}

async function updateNeovimFromPyodide(
  client: MonacoNeovimClient,
  tree: PyTreeSnapshot,
  cwd: string,
  paths: string[],
  texts: string[],
) {
  await client.execLua(
    `
      local files, dirs, cwd, paths, texts = ...
      if _G.PiodideSetManifest then
        _G.PiodideSetManifest(files, dirs)
      end
      _G.PiodideCwd = cwd
      vim.env.PWD = cwd
      local changed = {}
      for index, path in ipairs(paths) do
        changed[path] = texts[index]
      end
      for _, id in ipairs(vim.api.nvim_list_bufs()) do
        local path = vim.api.nvim_buf_get_name(id)
        local text = changed[path]
        if text ~= nil
            and vim.api.nvim_buf_is_loaded(id)
            and vim.bo[id].buftype == ""
            and not vim.bo[id].modified then
          vim.bo[id].modifiable = true
          vim.api.nvim_buf_set_lines(
            id,
            0,
            -1,
            false,
            vim.split(text, string.char(10), { plain = true })
          )
          vim.bo[id].eol = text:sub(-1) == string.char(10)
          vim.bo[id].modified = false
        end
      end
      if vim.b.piodide_explorer and _G.PiodideExplore then
        _G.PiodideExplore(vim.b.piodide_dir)
      end
    `,
    [tree.files, tree.directories, cwd, paths, texts],
  );
}

function defineTheme() {
  if (themeDefined) return;
  themeDefined = true;
  monaco.editor.defineTheme("piodide-nvim", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "565F89", fontStyle: "italic" },
      { token: "keyword", foreground: "BB9AF7" },
      { token: "string", foreground: "9ECE6A" },
      { token: "number", foreground: "FF9E64" },
      { token: "type", foreground: "2AC3DE" },
      { token: "function", foreground: "7AA2F7" },
    ],
    colors: {
      "editor.background": "#1a1b26",
      "editor.foreground": "#c0caf5",
      "editorCursor.foreground": "#c0caf5",
      "editor.lineHighlightBackground": "#24283b",
      "editor.selectionBackground": "#33467c",
      "editorLineNumber.foreground": "#3b4261",
      "editorLineNumber.activeForeground": "#737aa2",
      "editorIndentGuide.background1": "#283457",
      "editorWhitespace.foreground": "#3b4261",
    },
  });
}
