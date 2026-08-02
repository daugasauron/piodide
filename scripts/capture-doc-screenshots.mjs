#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(root, "screens");
const appUrl = process.env.DOCS_SCREENSHOT_URL || "http://localhost:5173/piodide/";
const debugAppUrl = new URL(appUrl);
debugAppUrl.searchParams.set("dbg", "1");
const chromeBin = process.env.CHROME_BIN || "google-chrome-stable";
const glmApiKey = process.env.DOCS_GLM_API_KEY?.trim() || "";
const writeScreenshots = process.env.DOCS_SCREENSHOT_WRITE !== "0";
const screenshotOnly = process.env.DOCS_SCREENSHOT_ONLY?.trim() || "";
const viewport = { width: 1440, height: 900 };

const sleep = (milliseconds) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

async function waitForFile(path, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await sleep(100);
  }
}

async function waitForPage(port, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find(
        (target) => target.type === "page" && target.url.startsWith(appUrl),
      );
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome may be listening before its first page target is ready.
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for the Piodide page target");
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    };
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      socket.onopen = resolveOpen;
      socket.onerror = () => rejectOpen(new Error("Could not connect to Chrome DevTools"));
    });
    return new CdpClient(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function waitForPython(client, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { result } = await client.send("Runtime.evaluate", {
      expression: `Boolean(window.__pi?.py?.FS && window.__pi?.prompt)`,
      returnByValue: true,
    });
    if (result.value) return;
    await sleep(200);
  }
  throw new Error("Timed out waiting for the Piodide Python runtime");
}

async function waitForSlop(client, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { result } = await client.send("Runtime.evaluate", {
      expression: `Boolean(
        window.__pi?.view === "slop"
        && window.__pi?.slop?.alive
        && window.__pi?.slopTerminal?.term
      )`,
      returnByValue: true,
    });
    if (result.value) return;
    await sleep(200);
  }
  throw new Error("Timed out waiting for the Slop shell");
}

async function waitForPyodideFile(client, path, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const { result } = await client.send("Runtime.evaluate", {
      expression: `Boolean(window.__pi?.py?.FS.analyzePath(${JSON.stringify(path)}).exists)`,
      returnByValue: true,
    });
    if (result.value) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function press(client, key, code, modifiers = 0) {
  const virtualKeyCode =
    key === "Enter" ? 13 : key === "Escape" ? 27 : key.toUpperCase().charCodeAt(0);
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: virtualKeyCode,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: virtualKeyCode,
  });
}

async function submit(client, text) {
  for (const character of text) {
    await client.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: character,
      text: character,
      unmodifiedText: character,
    });
    await client.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: character,
    });
  }
  await press(client, "Enter", "Enter");
}

async function focusTerminal(client) {
  const point = { x: 120, y: 240, button: "left", clickCount: 1 };
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point });
  await sleep(100);
}

async function exerciseHtmlPreview(client, expectedWidth, expectedHeight, expectMobile) {
  const evaluation = await client.send("Runtime.evaluate", {
    expression: `(async () => {
      window.__pi.py.FS.writeFile(
        "/home/web/e2e-preview.html",
        "<!doctype html><title>Preview check</title><style>body{background:#123;color:white}</style><h1>Preview check</h1>"
      );
      await window.__pi.run("/html /home/web/e2e-preview.html");
      const preview = document.querySelector("#html-preview");
      const rect = preview.getBoundingClientRect();
      const trigger = document.querySelector("#mobile-command-trigger");
      return {
        hidden: preview.hidden,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        back: document.querySelector("#html-preview-close")?.textContent.trim(),
        bodyClass: document.body.classList.contains("html-preview-open"),
        triggerDisplay: getComputedStyle(trigger).display
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      `HTML preview check threw: ${evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text}`,
    );
  }
  const opened = evaluation.result;
  const state = opened.value;
  if (
    state.hidden ||
    state.x !== 0 ||
    state.y !== 0 ||
    Math.abs(state.width - expectedWidth) > 1 ||
    Math.abs(state.height - expectedHeight) > 1 ||
    state.back !== "← Back to agent" ||
    !state.bodyClass ||
    (expectMobile && state.triggerDisplay !== "none")
  ) {
    throw new Error(`Unexpected HTML preview layout: ${JSON.stringify(opened.value)}`);
  }
  await client.send("Runtime.evaluate", {
    expression: `document.querySelector("#html-preview-close").click()`,
  });
  const { result: closed } = await client.send("Runtime.evaluate", {
    expression: `document.querySelector("#html-preview").hidden
      && !document.body.classList.contains("html-preview-open")`,
    returnByValue: true,
  });
  if (!closed.value) throw new Error("HTML preview did not return to the agent");
}

async function exerciseHtmlDebug(client) {
  const evaluation = await client.send("Runtime.evaluate", {
    expression: `(async () => {
      const tool = window.__pi.agent.state.tools.find(({ name }) => name === "html_debug");
      if (!tool) throw new Error("html_debug tool is missing");
      window.__pi.py.FS.writeFile(
        "/home/web/e2e-debug-good.html",
        "<!doctype html><script>console.log('debug-ready')</script><h1>ok</h1>"
      );
      const passed = await tool.execute(
        "e2e-html-debug-good",
        { path: "/home/web/e2e-debug-good.html", settleMs: 100 }
      );
      window.__pi.py.FS.writeFile(
        "/home/web/e2e-debug-bad.html",
        "<!doctype html><script>setTimeout(() => { throw new Error('debug-sentinel') }, 0)</script>"
      );
      let failed = "";
      try {
        await tool.execute(
          "e2e-html-debug-bad",
          { path: "/home/web/e2e-debug-bad.html", settleMs: 100 }
        );
      } catch (error) {
        failed = error instanceof Error ? error.message : String(error);
      }
      return {
        passed: passed.content?.[0]?.text ?? "",
        failed,
        previewHidden: document.querySelector("#html-preview").hidden,
        debugFrames: document.querySelectorAll("iframe[data-html-debug]").length
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      `HTML debug check threw: ${evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text}`,
    );
  }
  const state = evaluation.result.value;
  if (
    !state.passed.includes("HTML debug passed") ||
    !state.passed.includes("debug-ready") ||
    !state.failed.includes("debug-sentinel") ||
    !state.previewHidden ||
    state.debugFrames !== 0
  ) {
    throw new Error(`Unexpected HTML debug result: ${JSON.stringify(state)}`);
  }
}

async function exerciseSlopChannels(client) {
  const evaluation = await client.send("Runtime.evaluate", {
    expression: `(async () => {
      const tool = window.__pi.agent.state.tools.find(({ name }) => name === "slop");
      if (!tool) throw new Error("slop tool is missing");
      const systemPrompt = window.__pi.agent.state.systemPrompt;
      const result = await tool.execute(
        "e2e-slop-channels",
        { command: "echo shell-out; python -c \\\"import sys; print('python-out'); print('python-err', file=sys.stderr)\\\"; nosuchcmd" }
      );
      const redirected = await tool.execute(
        "e2e-slop-redirects",
        { command: "python -c \\\"import sys; print('redirected-python', file=sys.stderr)\\\" 2> python.err; cat /missing-e2e 2> cat.err; cc --not-real 2> cc.err; printf 'a b c' | xargs -n 2 echo ITEM" }
      );
      const decode = (path) => new TextDecoder().decode(window.__pi.py.FS.readFile(path));
      return {
        stdout: result.details?.stdout ?? "",
        stderr: result.details?.stderr ?? "",
        stdoutBytes: result.details?.stdoutBytes ?? -1,
        stderrBytes: result.details?.stderrBytes ?? -1,
        content: result.content?.[0]?.text ?? "",
        redirectedStdout: redirected.details?.stdout ?? "",
        redirectedStderr: redirected.details?.stderr ?? "",
        pythonErrorFile: decode("/home/web/python.err"),
        catErrorFile: decode("/home/web/cat.err"),
        ccErrorFile: decode("/home/web/cc.err"),
        promptUsesDirectWasi:
          systemPrompt.includes("run_wasi")
          && (
            systemPrompt.includes("do not route ordinary WASI execution through Python")
            || systemPrompt.includes("Do not run WASI through Python")
          )
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      `Slop channel check threw: ${evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text}`,
    );
  }
  const state = evaluation.result.value;
  if (
    !state.stdout.includes("shell-out") ||
    !state.stdout.includes("python-out") ||
    state.stdout.includes("python-err") ||
    !state.stderr.includes("python-err") ||
    !state.stderr.includes("command not found: nosuchcmd") ||
    state.stdoutBytes <= 0 ||
    state.stderrBytes <= 0 ||
    !state.content.includes("stdout:\n") ||
    !state.content.includes("stderr:\n") ||
    !state.redirectedStdout.includes("ITEM a b\nITEM c\n") ||
    state.redirectedStderr !== "" ||
    !state.pythonErrorFile.includes("redirected-python") ||
    !state.catErrorFile.includes("missing-e2e") ||
    !state.ccErrorFile.includes("unsupported option: --not-real") ||
    !state.promptUsesDirectWasi
  ) {
    throw new Error(`Unexpected Slop channels: ${JSON.stringify(state)}`);
  }
}

async function shortcut(client, key, code) {
  // DevTools modifier bits: Ctrl=2, Shift=8.
  await press(client, key, code, 10);
}

async function screenshot(
  client,
  name,
  height = viewport.height,
  width = viewport.width,
) {
  if (!writeScreenshots || (screenshotOnly && screenshotOnly !== name)) return;
  const { data } = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width,
      height,
      scale: 1,
    },
  });
  const path = join(outputDir, name);
  writeFileSync(path, Buffer.from(data, "base64"));
  console.log(`captured ${path}`);
}

async function main() {
  mkdirSync(outputDir, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "piodide-docs-chrome-"));
  const devToolsFile = join(profile, "DevToolsActivePort");
  const chrome = spawn(
    chromeBin,
    [
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-extensions",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      `--window-size=${viewport.width},${viewport.height}`,
      "--force-device-scale-factor=1",
      debugAppUrl.toString(),
    ],
    { stdio: "ignore" },
  );

  let client;
  try {
    await waitForFile(devToolsFile);
    const [port] = readFileSync(devToolsFile, "utf8").trim().split(/\s+/);
    client = await CdpClient.connect(await waitForPage(port));
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      ...viewport,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitForPython(client);
    await exerciseHtmlDebug(client);
    await exerciseSlopChannels(client);
    await exerciseHtmlPreview(client, viewport.width, viewport.height, false);
    await focusTerminal(client);

    await submit(client, "/provider");
    await sleep(800);
    await screenshot(client, "providers.png", 540);

    await press(client, "Enter", "Enter");
    await sleep(800);
    await submit(client, "/model");
    await sleep(800);
    await screenshot(client, "local-models.png", 500);

    await press(client, "Escape", "Escape");
    await shortcut(client, "s", "KeyS");
    await waitForSlop(client);
    await client.send("Runtime.evaluate", {
      expression: `window.__pi.slopTerminal.term.focus()`,
    });
    await submit(client, "pwd");
    await submit(client, "ls");
    await submit(client, `/bin/python -c "print(6 * 7)" > python-output.txt`);
    await waitForPyodideFile(client, "/home/web/python-output.txt");
    const { result: pythonResult } = await client.send("Runtime.evaluate", {
      expression: `new TextDecoder().decode(
        window.__pi.py.FS.readFile("/home/web/python-output.txt")
      )`,
      returnByValue: true,
    });
    if (pythonResult.value !== "42\n") {
      throw new Error(`Unexpected /bin/python output: ${JSON.stringify(pythonResult.value)}`);
    }
    await sleep(800);
    await screenshot(client, "slop-shell.png", 500);

    await shortcut(client, "s", "KeyS");
    await sleep(500);
    await shortcut(client, "e", "KeyE");
    await sleep(8_000);
    await screenshot(client, "neovim.png");

    await client.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await client.send("Runtime.evaluate", { expression: `delete window.__pi` });
    await client.send("Page.reload", { ignoreCache: true });
    await waitForPython(client);
    await exerciseHtmlPreview(client, 390, 844, true);

    const { result: mobileEnvironment } = await client.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        width: innerWidth,
        touchPoints: navigator.maxTouchPoints,
        enabled: document.body.classList.contains("mobile-commands-enabled"),
        triggerHidden: document.querySelector("#mobile-command-trigger")?.hidden
      })`,
      returnByValue: true,
    });
    console.log(`mobile environment ${mobileEnvironment.value}`);
    const { result: mobileFooterResult } = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const usage = document.querySelector("#footer-usage");
        const model = document.querySelector("#footer-model");
        const usageRect = usage.getBoundingClientRect();
        const modelRect = model.getBoundingClientRect();
        return JSON.stringify({
          usageX: Math.round(usageRect.x),
          usageY: Math.round(usageRect.y),
          modelX: Math.round(modelRect.x),
          modelY: Math.round(modelRect.y),
          usageFits: usage.scrollWidth <= usage.clientWidth,
          modelFits: model.scrollWidth <= model.clientWidth
        });
      })()`,
      returnByValue: true,
    });
    const mobileFooter = JSON.parse(mobileFooterResult.value);
    if (
      mobileFooter.usageX !== mobileFooter.modelX ||
      mobileFooter.modelY <= mobileFooter.usageY ||
      !mobileFooter.usageFits ||
      !mobileFooter.modelFits
    ) {
      throw new Error(`Unexpected mobile footer layout: ${mobileFooterResult.value}`);
    }

    // Exercise the actual edge gesture, not only the visible fallback button.
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 388, y: 420 }],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 300, y: 420 }],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await sleep(300);
    const { result: commandResult } = await client.send("Runtime.evaluate", {
      expression: `JSON.stringify(
        [...document.querySelectorAll("[data-mobile-command]")]
          .map((button) => button.dataset.mobileCommand)
      )`,
      returnByValue: true,
    });
    if (commandResult.value !== '["/provider","/login","/model","/thinking","/demo"]') {
      throw new Error(`Unexpected mobile command drawer: ${commandResult.value}`);
    }
    await screenshot(client, "mobile-commands.png", 844, 390);

    await client.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-mobile-command="/provider"]').click()`,
    });
    await sleep(300);
    await client.send("Runtime.evaluate", {
      expression: `(
        [...document.querySelectorAll(".mobile-option-button")]
          .find((button) => button.textContent.includes("Z.AI GLM Coding"))
          ?.click()
      )`,
    });
    await sleep(1_000);
    await client.send("Runtime.evaluate", {
      expression: `document.querySelector("#mobile-command-trigger").click()`,
    });
    await client.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-mobile-command="/model"]').click()`,
    });
    await sleep(500);
    const { result: modelResult } = await client.send("Runtime.evaluate", {
      expression: `(
        [...document.querySelectorAll(".mobile-option-button")]
          .some((button) => button.textContent.toLowerCase().includes("glm-5.2"))
      )`,
      returnByValue: true,
    });
    if (modelResult.value !== true) throw new Error("GLM-5.2 is missing from the mobile model list");
    await client.send("Runtime.evaluate", {
      expression: `(
        [...document.querySelectorAll(".mobile-option-button")]
          .find((button) => button.textContent.toLowerCase().includes("glm-5.2"))
          ?.click()
      )`,
    });
    await sleep(300);
    const { result: selectedModelResult } = await client.send("Runtime.evaluate", {
      expression: `(
        document.querySelector("#footer-model")?.textContent.includes("zhipu-coding")
        && document.querySelector("#footer-model")?.textContent.includes("glm-5.2")
      )`,
      returnByValue: true,
    });
    if (selectedModelResult.value !== true) {
      throw new Error("Mobile flow did not activate GLM-5.2 on the GLM Coding provider");
    }
    await client.send("Runtime.evaluate", {
      expression: `document.querySelector("#mobile-command-trigger").click()`,
    });
    await client.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-mobile-command="/thinking"]').click()`,
    });
    await sleep(300);
    const { result: thinkingResult } = await client.send("Runtime.evaluate", {
      expression: `JSON.stringify(
        [...document.querySelectorAll(".mobile-option-label")]
          .map((label) => label.textContent)
      )`,
      returnByValue: true,
    });
    if (thinkingResult.value !== '["off","low","medium","high","max"]') {
      throw new Error(`Unexpected GLM thinking levels: ${thinkingResult.value}`);
    }
    await client.send("Runtime.evaluate", {
      expression: `(
        [...document.querySelectorAll(".mobile-option-button")]
          .find((button) => button.textContent.trim().startsWith("high"))
          ?.click()
      )`,
    });
    await sleep(200);
    const { result: selectedThinkingResult } = await client.send("Runtime.evaluate", {
      expression: `document.querySelector("#footer-model")?.textContent.includes(" • high")`,
      returnByValue: true,
    });
    if (selectedThinkingResult.value !== true) {
      throw new Error("Mobile flow did not set GLM thinking effort to high");
    }
    await client.send("Runtime.evaluate", {
      expression: `document.querySelector("#mobile-command-trigger").click()`,
    });
    await client.send("Runtime.evaluate", {
      expression: `document.querySelector('[data-mobile-command="/login"]').click()`,
    });
    await sleep(300);
    const { result: loginResult } = await client.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        type: document.querySelector(".mobile-command-input")?.type,
        paste: [...document.querySelectorAll("button")].some((button) => button.textContent === "Paste"),
        connect: [...document.querySelectorAll("button")].some((button) => button.textContent === "Connect")
      })`,
      returnByValue: true,
    });
    if (loginResult.value !== '{"type":"password","paste":true,"connect":true}') {
      throw new Error(`Unexpected mobile login form: ${loginResult.value}`);
    }
    await screenshot(client, "mobile-login.png", 844, 390);

    await client.send("Runtime.evaluate", {
      expression: `(() => {
        window.__piodideGlmResponses = [];
        const live = ${glmApiKey ? "true" : "false"};
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const input = args[0];
          const url = typeof input === "string" ? input : input.url;
          const response = !live && url.endsWith("/chat/completions")
            ? new Response(
                '{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Test response."}',
                { status: 429, headers: { "Content-Type": "application/json" } }
              )
            : await originalFetch(...args);
          if (url.includes("/api/coding/paas/v4/")) {
            window.__piodideGlmResponses.push({
              url,
              status: response.status,
              body: await response.clone().text()
            });
          }
          return response;
        };
      })()`,
    });
    const loginTestKey = glmApiKey || "docs-mobile.paste-test";
    const { result: pasteHandle } = await client.send("Runtime.evaluate", {
      expression: `[...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Paste")`,
    });
    if (!pasteHandle.objectId) throw new Error("Mobile paste button is unavailable");
    await client.send("Runtime.callFunctionOn", {
      objectId: pasteHandle.objectId,
      functionDeclaration: `function(value) {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { readText: async () => value }
        });
        this.click();
      }`,
      arguments: [{ value: loginTestKey }],
    });
    await sleep(200);
    const { result: pastedResult } = await client.send("Runtime.callFunctionOn", {
      objectId: pasteHandle.objectId,
      functionDeclaration: `function(expected) {
        const input = document.querySelector(".mobile-command-input");
        const pasted = input?.value === expected;
        if (pasted) input.form.requestSubmit();
        return pasted;
      }`,
      arguments: [{ value: loginTestKey }],
      returnByValue: true,
    });
    if (pastedResult.value !== true) throw new Error("Mobile paste button did not fill the API key");
    await sleep(300);
    const { result: connectedResult } = await client.send("Runtime.evaluate", {
      expression: `!document.querySelector("#mobile-command-layer").classList.contains("open")
        && document.querySelector(".mobile-command-input") === null`,
      returnByValue: true,
    });
    if (connectedResult.value !== true) throw new Error("Mobile login did not complete");

    const { result: keyCheckResult } = await client.send("Runtime.evaluate", {
      expression: `window.__piodideGlmResponses
        .some((response) => response.url.endsWith("/models"))`,
      returnByValue: true,
    });
    if (keyCheckResult.value !== false) {
      throw new Error("Coding Plan login made an incompatible /models request");
    }

    await focusTerminal(client);
    await submit(client, "Reply with OK.");

    const deadline = Date.now() + 15_000;
    let responseResult = null;
    while (Date.now() < deadline) {
      const { result } = await client.send("Runtime.evaluate", {
        expression: `window.__piodideGlmResponses
          .find((response) => response.url.endsWith("/chat/completions")) ?? null`,
        returnByValue: true,
      });
      if (result.value) {
        responseResult = result.value;
        break;
      }
      await sleep(200);
    }
    const successfulCompletion =
      responseResult?.status === 200 &&
      responseResult.body.includes('"model":"glm-5.2"') &&
      responseResult.body.includes('"content":"OK"') &&
      responseResult.body.includes("data: [DONE]");
    const exhaustedQuota =
      responseResult?.status === 429 &&
      responseResult.body.includes('"code":"1310"') &&
      responseResult.body.includes("Weekly/Monthly Limit Exhausted");
    if (!successfulCompletion && !exhaustedQuota) {
      const { result: debugResult } = await client.send("Runtime.evaluate", {
        expression: `JSON.stringify({
          history: window.__pi.prompt.history,
          busy: window.__pi.prompt.busy,
          config: window.__pi.config,
          activeElement: document.activeElement?.tagName,
          drawerOpen: document.querySelector("#mobile-command-layer").classList.contains("open")
        })`,
        returnByValue: true,
      });
      throw new Error(
        `Unexpected authenticated GLM response: ${JSON.stringify(responseResult)} · ${debugResult.value}`,
      );
    }
    console.log(
      successfulCompletion
        ? "validated authenticated GLM-5.2 request → streamed HTTP 200 completion"
        : "validated authenticated GLM request → HTTP 429 code 1310",
    );

    const { result: doneResult } = await client.send("Runtime.evaluate", {
      expression: `(() => {
        window.__pi.term.input("/status", true);
        window.__pi.term.textarea.dispatchEvent(new InputEvent("beforeinput", {
          inputType: "insertParagraph",
          bubbles: true,
          cancelable: true
        }));
        return window.__pi.prompt.history.at(-1);
      })()`,
      returnByValue: true,
    });
    if (doneResult.value !== "/status") {
      throw new Error(`Mobile Done did not submit Enter: ${JSON.stringify(doneResult.value)}`);
    }

    await client.send("Runtime.evaluate", {
      expression: `(() => {
        for (let i = 0; i < 120; i++) window.__pi.writer.writeln("scrollback " + i);
        window.__pi.term.scrollToBottom();
      })()`,
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 180, y: 220 }],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 180, y: 520 }],
    });
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await sleep(200);
    const { result: scrollResult } = await client.send("Runtime.evaluate", {
      expression: `window.__pi.term.viewportY`,
      returnByValue: true,
    });
    if (!(scrollResult.value > 0)) {
      throw new Error(`Touch drag did not move terminal scrollback: ${scrollResult.value}`);
    }
    await client.send("Runtime.evaluate", {
      expression: `window.__pi.term.scrollToBottom()`,
    });

    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 500,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await sleep(200);
    const { result: viewportResult } = await client.send("Runtime.evaluate", {
      expression: `JSON.stringify({
        appHeight: getComputedStyle(document.documentElement).getPropertyValue("--app-height"),
        appWidth: getComputedStyle(document.documentElement).getPropertyValue("--app-width"),
        visualHeight: Math.round(visualViewport.height),
        visualWidth: Math.round(visualViewport.width),
        bodyX: Math.round(document.body.getBoundingClientRect().x),
        bodyY: Math.round(document.body.getBoundingClientRect().y),
        bodyWidth: Math.round(document.body.getBoundingClientRect().width),
        bodyHeight: Math.round(document.body.getBoundingClientRect().height),
        layoutScrollX: window.scrollX,
        layoutScrollY: window.scrollY,
        terminalInputFontSize: getComputedStyle(window.__pi.term.textarea).fontSize,
        viewportAtBottom: window.__pi.term.viewportY
      })`,
      returnByValue: true,
    });
    const keyboardViewport = JSON.parse(viewportResult.value);
    if (
      keyboardViewport.appHeight !== `${keyboardViewport.visualHeight}px` ||
      keyboardViewport.appWidth !== `${keyboardViewport.visualWidth}px` ||
      keyboardViewport.bodyX !== 0 ||
      keyboardViewport.bodyY !== 0 ||
      keyboardViewport.bodyWidth !== keyboardViewport.visualWidth ||
      keyboardViewport.bodyHeight !== keyboardViewport.visualHeight ||
      keyboardViewport.layoutScrollX !== 0 ||
      keyboardViewport.layoutScrollY !== 0 ||
      keyboardViewport.terminalInputFontSize !== "16px" ||
      keyboardViewport.viewportAtBottom !== 0
    ) {
      throw new Error(`Terminal did not follow the visual viewport: ${viewportResult.value}`);
    }
    console.log("validated mobile GLM Coding → GLM-5.2 → login flow");
  } finally {
    client?.close();
    chrome.kill("SIGTERM");
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}

await main();
