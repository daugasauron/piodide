import assert from "node:assert/strict";
import { test } from "node:test";

import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { browserModelRuntime } from "../src/browser-model-runtime.ts";
import { streamBrowserModel } from "../src/browser-model-stream.ts";
import { makeModel } from "../src/model.ts";
import { webLLMRuntime } from "../src/webllm-runtime.ts";
import { streamWebLLMModel } from "../src/webllm-model-stream.ts";

const ReadParams = Type.Object({ path: Type.String() });

function readTool(executions: string[]) {
  return {
    name: "read_file",
    label: "Read file",
    description: "Read a text file.",
    parameters: ReadParams,
    async execute(_toolCallId: string, params: unknown) {
      const { path } = params as { path: string };
      executions.push(path);
      return {
        content: [{ type: "text" as const, text: "local-tool-result" }],
        details: { path },
      };
    },
  } as AgentTool;
}

function assistantText(message: unknown): string | undefined {
  const content = (message as { role?: string; content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content.find((item) => (item as { type?: string }).type === "text") as
    | { text?: string }
    | undefined;
  return text?.text;
}

function assistantThinking(message: unknown): string | undefined {
  const content = (message as { role?: string; content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const thinking = content.find(
    (item) => (item as { type?: string }).type === "thinking",
  ) as { thinking?: string } | undefined;
  return thinking?.thinking;
}

test("Wllama completes an assistant -> tool -> assistant agent loop", async () => {
  const runtime = browserModelRuntime as unknown as {
    ensureLoaded: typeof browserModelRuntime.ensureLoaded;
    streamChat: typeof browserModelRuntime.streamChat;
  };
  const originalEnsureLoaded = runtime.ensureLoaded;
  const originalStreamChat = runtime.streamChat;
  const requests: Array<{ messages: Array<{ role: string }> }> = [];
  const executions: string[] = [];

  runtime.ensureLoaded = async () => {};
  runtime.streamChat = (async function* (_modelId, request) {
    requests.push(request as unknown as { messages: Array<{ role: string }> });
    const followingTool = request.messages.some((message) => message.role === "tool");
    if (followingTool) {
      yield {
        choices: [{
          delta: { reasoning_content: "Verify the tool result.", content: "wllama-complete" },
          finish_reason: "stop",
        }],
      } as never;
      return;
    }
    yield {
      choices: [
        {
          delta: {
            reasoning_content: "Inspect the file before answering.",
            tool_calls: [
              {
                index: 0,
                id: "call_wllama_read",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: '{"path":"/home/web/e2e.txt"}',
                },
              },
            ],
          },
          // Exercise Wllama's observed native behavior: a structured call can
          // still carry a `stop` finish reason.
          finish_reason: "stop",
        },
      ],
    } as never;
  }) as typeof runtime.streamChat;

  try {
    const model = makeModel({
      baseUrl: "browser://wllama",
      modelId: "qwen3.5-2b-q4km",
      api: "browser-wllama",
      provider: "wllama",
    });
    const agent = new Agent({
      initialState: {
        systemPrompt: "Use the available tool.",
        model,
        thinkingLevel: "high",
        tools: [readTool(executions)],
        messages: [],
      },
      streamFn: streamBrowserModel,
      convertToLlm: (messages) => messages as Message[],
      toolExecution: "sequential",
    });

    await agent.prompt("Read /home/web/e2e.txt");

    assert.deepEqual(executions, ["/home/web/e2e.txt"]);
    assert.deepEqual(agent.state.messages.map((message) => message.role), [
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    assert.equal(requests.length, 2);
    assert.equal(
      (requests[0] as unknown as { chat_template_kwargs?: { enable_thinking?: boolean } })
        .chat_template_kwargs?.enable_thinking,
      true,
    );
    assert.equal(requests[1].messages.at(-1)?.role, "tool");
    assert.equal(
      assistantThinking(agent.state.messages[1]),
      "Inspect the file before answering.",
    );
    assert.equal(
      assistantThinking(agent.state.messages.at(-1)),
      "Verify the tool result.",
    );
    assert.equal(assistantText(agent.state.messages.at(-1)), "wllama-complete");
  } finally {
    runtime.ensureLoaded = originalEnsureLoaded;
    runtime.streamChat = originalStreamChat;
  }
});

test("WebLLM completes an assistant -> tool -> assistant agent loop", async () => {
  const runtime = webLLMRuntime as unknown as {
    ensureLoaded: typeof webLLMRuntime.ensureLoaded;
    streamChat: typeof webLLMRuntime.streamChat;
  };
  const originalEnsureLoaded = runtime.ensureLoaded;
  const originalStreamChat = runtime.streamChat;
  const requests: Array<{
    messages: Array<{ role: string; content?: unknown }>;
    extra_body?: { enable_thinking?: boolean };
  }> = [];
  const executions: string[] = [];

  runtime.ensureLoaded = async () => {};
  runtime.streamChat = (async function* (_modelId, request) {
    requests.push(
      request as unknown as {
        messages: Array<{ role: string; content?: unknown }>;
        extra_body?: { enable_thinking?: boolean };
      },
    );
    const followingTool = request.messages.some(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("The application already executed read_file"),
    );
    yield {
      choices: [
        {
          delta: {
            content: followingTool
              ? "<think>Verify the tool result.</think>webllm-complete"
              : '<think>Inspect the file before answering.</think><tool_calls>[{"name":"read_file","arguments":{"path":"/home/web/e2e.txt"}}]</tool_calls>',
          },
          finish_reason: "stop",
        },
      ],
    } as never;
  }) as typeof runtime.streamChat;

  try {
    const model = makeModel({
      baseUrl: "browser://webllm",
      modelId: "Qwen3.5-2B-q4f16_1-MLC",
      api: "browser-webllm",
      provider: "webllm",
    });
    const agent = new Agent({
      initialState: {
        systemPrompt: "Use the available tool.",
        model,
        thinkingLevel: "high",
        tools: [readTool(executions)],
        messages: [],
      },
      streamFn: streamWebLLMModel,
      convertToLlm: (messages) => messages as Message[],
      toolExecution: "sequential",
    });

    await agent.prompt("Read /home/web/e2e.txt");

    assert.deepEqual(executions, ["/home/web/e2e.txt"]);
    assert.deepEqual(agent.state.messages.map((message) => message.role), [
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].extra_body?.enable_thinking, true);
    assert.equal(requests[1].messages.at(-1)?.role, "user");
    assert.match(
      String(requests[1].messages.at(-1)?.content),
      /The application already executed read_file/,
    );
    assert.equal(
      assistantThinking(agent.state.messages[1]),
      "Inspect the file before answering.",
    );
    assert.equal(
      assistantThinking(agent.state.messages.at(-1)),
      "Verify the tool result.",
    );
    assert.equal(assistantText(agent.state.messages.at(-1)), "webllm-complete");
  } finally {
    runtime.ensureLoaded = originalEnsureLoaded;
    runtime.streamChat = originalStreamChat;
  }
});
