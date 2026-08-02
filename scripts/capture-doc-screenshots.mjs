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
  if (!writeScreenshots) return;
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
    // Do not let the readiness poll observe the old execution context while
    // Page.reload is still navigating.
    await client.send("Runtime.evaluate", { expression: `delete window.__pi` });
    await client.send("Page.reload", { ignoreCache: true });
    await waitForPython(client);
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
    if (commandResult.value !== '["/provider","/login","/model"]') {
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
              body: await response.clone().text(),
              requestBody: typeof args[1]?.body === "string" ? args[1].body : ""
            });
          }
          return response;
        };
      })()`,
    });
    const cleanLoginTestKey = glmApiKey || "docs.mobile-paste-test";
    // Mobile rich-text clipboards can surround an otherwise valid token with
    // invisible bidirectional format marks. Exercise that exact cleanup path.
    const loginTestKey = `\u202A${cleanLoginTestKey}\u2069`;
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
        const message = document.querySelector(".mobile-command-form-message")?.textContent ?? "";
        const pasted = input?.value === expected
          && message.includes("Pasted " + expected.length + " characters")
          && message.includes("ending " + expected.slice(-4));
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

    const loginDeadline = Date.now() + 15_000;
    let loginResponse = null;
    while (Date.now() < loginDeadline) {
      const { result } = await client.send("Runtime.evaluate", {
        expression: `window.__piodideGlmResponses
          .find((response) => response.url.endsWith("/chat/completions")) ?? null`,
        returnByValue: true,
      });
      if (result.value) {
        loginResponse = result.value;
        break;
      }
      await sleep(200);
    }
    const loginVerified =
      (loginResponse?.status === 200 && loginResponse.body.includes('"model":"glm-5.2"')) ||
      (loginResponse?.status === 429 &&
        loginResponse.body.includes('"code":"1310"') &&
        loginResponse.body.includes("Weekly/Monthly Limit Exhausted"));
    if (!loginVerified) {
      throw new Error(`Unexpected GLM login verification: ${JSON.stringify(loginResponse)}`);
    }
    const loginBody = JSON.parse(loginResponse.requestBody);
    if (
      loginBody.model !== "glm-5.2" ||
      loginBody.max_tokens !== 1 ||
      loginBody.stream !== false
    ) {
      throw new Error(`Unexpected GLM login request: ${loginResponse.requestBody}`);
    }
    const promptDeadline = Date.now() + 5_000;
    while (Date.now() < promptDeadline) {
      const { result } = await client.send("Runtime.evaluate", {
        expression: `!window.__pi.prompt.isOccupied()`,
        returnByValue: true,
      });
      if (result.value) break;
      await sleep(100);
    }
    await client.send("Runtime.evaluate", {
      expression: `window.__piodideGlmResponses = []`,
    });

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
      throw new Error(
        `Unexpected authenticated GLM response: ${JSON.stringify(responseResult)}`,
      );
    }
    console.log(
      successfulCompletion
        ? "validated authenticated GLM-5.2 request → streamed HTTP 200 completion"
        : "validated authenticated GLM request → HTTP 429 code 1310",
    );
    console.log("validated mobile GLM Coding → GLM-5.2 → login flow");
  } finally {
    client?.close();
    chrome.kill("SIGTERM");
    await sleep(300);
    rmSync(profile, { recursive: true, force: true });
  }
}

await main();
