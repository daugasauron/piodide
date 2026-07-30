import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

import { makeModel } from "../src/model.ts";
import {
  EventQueue,
  OpenAIEventAdapter,
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
    },
  ]);
});
