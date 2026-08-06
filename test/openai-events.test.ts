import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

import { makeModel } from "../src/model.ts";
import {
  EventQueue,
  formatHttpError,
  OpenAIEventAdapter,
  streamOpenAI,
} from "../src/openai-stream.ts";

test("OpenAI event adapter preserves streamed text, tool arguments, and usage", async () => {
  const model = makeModel({
    baseUrl: "browser://wllama",
    modelId: "test-local-model",
    api: "browser-wllama",
    provider: "browser",
  });
  const queue = new EventQueue();
  const adapter = new OpenAIEventAdapter(model, queue);

  adapter.accept({ choices: [{ delta: { content: "I will inspect it." } }] });
  adapter.accept({
    choices: [
      {
        delta: {
          reasoning_details: [
            {
              type: "reasoning.encrypted",
              id: "call_read",
              format: "anthropic-claude-v1",
              data: "signed-state",
            },
          ],
          tool_calls: [
            {
              index: 0,
              id: "call_read",
              function: { name: "read", arguments: "{\"path\":" },
            },
          ],
        },
      },
    ],
  });
  adapter.accept({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              function: { arguments: "\"/home/web/main.c\"}" },
            },
          ],
        },
        // Wllama 3.5.1 currently labels a native Qwen tool call as `stop`.
        // The adapter must trust the structured tool-call delta.
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 14,
      total_tokens: 134,
      prompt_tokens_details: { cached_tokens: 20 },
    },
  });
  adapter.finish();

  const events: AssistantMessageEvent[] = [];
  for await (const event of queue) events.push(event);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      "start",
      "text_start",
      "text_delta",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "text_end",
      "toolcall_end",
      "done",
    ],
  );

  const message = await queue.result();
  assert.equal(message.stopReason, "toolUse");
  assert.deepEqual(message.usage, {
    input: 100,
    output: 14,
    cacheRead: 20,
    cacheWrite: 0,
    reasoning: undefined,
    totalTokens: 134,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  });
  assert.deepEqual(message.content, [
    { type: "text", text: "I will inspect it." },
    {
      type: "toolCall",
      id: "call_read",
      name: "read",
      arguments: { path: "/home/web/main.c" },
      thoughtSignature:
        '{"type":"reasoning.encrypted","id":"call_read","format":"anthropic-claude-v1","data":"signed-state"}',
    },
  ]);
});

test("OpenAI HTTP errors unwrap provider error envelopes", () => {
  assert.equal(
    formatHttpError(
      429,
      "Too Many Requests",
      '{"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted"}}',
    ),
    'Error: 429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted"}',
  );
  assert.equal(
    formatHttpError(401, "Unauthorized", "token expired or incorrect"),
    "Error: 401 Unauthorized: token expired or incorrect",
  );
});

test("OpenRouter requests send attribution, tools, and replayed reasoning", async () => {
  const originalFetch = globalThis.fetch;
  let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => {
    request = { input, init };
    return new Response(
      'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n",
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  };

  try {
    const model = makeModel({
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "anthropic/claude-sonnet-4.6",
      api: "openai-completions",
      provider: "openrouter",
      headers: { "X-OpenRouter-Title": "Piodide" },
      info: {
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        reasoning: true,
      },
    });
    const stream = await streamOpenAI(
      model,
      {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "I should inspect the file." },
              {
                type: "toolCall",
                id: "call_read",
                name: "read",
                arguments: { path: "/home/web/main.c" },
                thoughtSignature:
                  '{"type":"reasoning.encrypted","id":"call_read","format":"anthropic-claude-v1","data":"signed-state"}',
              },
            ],
            api: "openai-completions",
            provider: "openrouter",
            model: "anthropic/claude-sonnet-4.6",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 0,
          },
          {
            role: "toolResult",
            toolCallId: "call_read",
            toolName: "read",
            content: [{ type: "text", text: "int main(void) {}" }],
            isError: false,
            timestamp: 0,
          },
        ],
        tools: [],
      },
      { apiKey: "sk-or-v1-test", reasoning: "high" },
    );
    const result = await stream.result();
    assert.equal(result.stopReason, "stop");

    assert.equal(String(request?.input), "https://openrouter.ai/api/v1/chat/completions");
    const headers = new Headers(request?.init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer sk-or-v1-test");
    assert.equal(headers.get("X-OpenRouter-Title"), "Piodide");
    const body = JSON.parse(String(request?.init?.body)) as {
      reasoning?: { effort?: string };
      reasoning_details?: unknown[];
      messages: Array<Record<string, unknown>>;
    };
    assert.deepEqual(body.reasoning, { effort: "high" });
    assert.equal(body.messages[0].reasoning, undefined);
    assert.deepEqual(body.messages[0].reasoning_details, [
      {
        type: "reasoning.encrypted",
        id: "call_read",
        format: "anthropic-claude-v1",
        data: "signed-state",
      },
    ]);
    assert.deepEqual(body.messages[0].tool_calls, [
      {
        id: "call_read",
        type: "function",
        function: { name: "read", arguments: '{"path":"/home/web/main.c"}' },
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
