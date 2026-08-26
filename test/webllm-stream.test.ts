import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";

import {
  createToolResponseFormat,
  inspectPartialQwenOutput,
  parsePromptedToolCalls,
  recoverWebLLMAnswer,
  splitQwenThinkingOutput,
  toWebLLMMessages,
} from "../src/webllm-model-stream.ts";

const TOOLS = new Set(["read", "write"]);

test("WebLLM prompt bridge leaves ordinary text alone", () => {
  assert.equal(parsePromptedToolCalls("Hello! How can I help?", TOOLS), undefined);
  assert.equal(
    parsePromptedToolCalls('{"name":"not a tool response"}', TOOLS),
    undefined,
  );
});

test("WebLLM prompt bridge parses tagged tool calls", () => {
  assert.deepEqual(
    parsePromptedToolCalls(
      '<tool_calls>[{"name":"read","arguments":{"path":"README.md"}}]</tool_calls>',
      TOOLS,
    ),
    [{ name: "read", arguments: { path: "README.md" } }],
  );
});

test("WebLLM prompt bridge recovers quoted and truncated source writes", () => {
  assert.deepEqual(
    parsePromptedToolCalls(
      '<tool_calls>[{"name":"write","arguments":{"path":"raylib-demo.c","content":"#include "raylib.h"\\nint value = 1;\\n"}}]</tool_calls>',
      TOOLS,
    ),
    [{
      name: "write",
      arguments: {
        path: "raylib-demo.c",
        content: '#include "raylib.h"\nint value = 1;\n',
      },
    }],
  );
  assert.deepEqual(
    parsePromptedToolCalls(
      '<tool_calls>[{"name":"write","arguments":{"path":"raylib-demo.c","content":"#include \\"raylib.h\\"\\nvoid game_',
      TOOLS,
    ),
    [{
      name: "write",
      arguments: {
        path: "raylib-demo.c",
        content: '#include "raylib.h"\nvoid game_',
      },
    }],
  );
});

test("WebLLM separates Qwen thinking from tool and answer content", () => {
  assert.deepEqual(
    splitQwenThinkingOutput(
      '<think>Inspect the workspace first.</think>\n\n<tool_calls>[]</tool_calls>',
      true,
    ),
    {
      thinking: "Inspect the workspace first.",
      content: "<tool_calls>[]</tool_calls>",
    },
  );
  assert.deepEqual(
    splitQwenThinkingOutput("<think>\n\n</think>\n\nDone", false),
    { content: "Done" },
  );
  assert.deepEqual(
    splitQwenThinkingOutput("Reason about it.</think>\nAnswer", true),
    { thinking: "Reason about it.", content: "Answer" },
  );
});

test("WebLLM streams only safe thinking and answer prefixes", () => {
  assert.deepEqual(
    inspectPartialQwenOutput("<think>Inspect the work", true),
    { thinking: "Inspect the work", content: "", contentKind: "pending" },
  );
  assert.deepEqual(
    inspectPartialQwenOutput("<think>Inspect</think><tool_", true),
    { thinking: "Inspect", content: "<tool_", contentKind: "control" },
  );
  assert.deepEqual(
    inspectPartialQwenOutput("<think>Inspect</think>Final answer", true),
    { thinking: "Inspect", content: "Final answer", contentKind: "answer" },
  );
});

test("WebLLM suppresses echoed tool-result envelopes and recovers appended answers", () => {
  const result = "</file>\n1\t# heading\n";
  assert.equal(
    recoverWebLLMAnswer(
      `<tool_result>${JSON.stringify({ tool_call_id: "call_1", content: `${result}\n# heading\n` })}</tool_result>`,
      result,
    ),
    "# heading",
  );
  assert.equal(
    recoverWebLLMAnswer('<tool_result>{"content":"opaque"}</tool_result>', result),
    "",
  );
});

test("WebLLM tool bridge constrains tagged JSON to the available tools", () => {
  const responseFormat = createToolResponseFormat([
    {
      name: "read",
      description: "Read a file",
      parameters: Type.Object({
        path: Type.String(),
      }),
    },
    {
      name: "write",
      description: "Write a file",
      parameters: Type.Object({
        path: Type.String(),
        content: Type.String(),
      }),
    },
  ]);

  assert.equal(responseFormat.type, "structural_tag");
  assert.equal(typeof responseFormat.structural_tag, "string");
  const structuralTag = JSON.parse(responseFormat.structural_tag as string);
  assert.equal(structuralTag.type, "structural_tag");
  assert.equal(structuralTag.format.type, "triggered_tags");
  assert.deepEqual(structuralTag.format.triggers, ["<tool_calls>"]);
  assert.equal(structuralTag.format.at_least_one, false);
  assert.equal(structuralTag.format.stop_after_first, true);

  const tag = structuralTag.format.tags[0];
  assert.equal(tag.begin, "<tool_calls>");
  assert.equal(tag.end, "</tool_calls>");
  const schema = tag.content.json_schema;
  assert.equal(schema.type, "array");
  assert.equal(schema.minItems, 1);
  assert.deepEqual(
    schema.items.oneOf.map(
      (variant: { properties: { name: { const: string } } }) =>
        variant.properties.name.const,
    ),
    ["read", "write"],
  );
  assert.equal(
    schema.items.oneOf[1].properties.arguments.properties.content.type,
    "string",
  );
});

test("WebLLM prompt bridge accepts stringified arguments and rejects unknown tools", () => {
  assert.deepEqual(
    parsePromptedToolCalls(
      '{"name":"write","arguments":"{\\"path\\":\\"x\\",\\"content\\":\\"y\\"}"}',
      TOOLS,
    ),
    [{ name: "write", arguments: { path: "x", content: "y" } }],
  );
  assert.equal(
    parsePromptedToolCalls(
      '<tool_call>{"name":"shell","arguments":{}}</tool_call>',
      TOOLS,
    ),
    undefined,
  );
});

test("WebLLM follow-up history uses supported roles and tagged tool results", () => {
  const messages = toWebLLMMessages({
    systemPrompt: "Use tools carefully.",
    messages: [
      { role: "user", content: "Read it", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect it." },
          {
            type: "toolCall",
            id: "call_read",
            name: "read",
            arguments: { path: "README.md" },
          },
        ],
        api: "browser-webllm",
        provider: "webllm",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_read",
        toolName: "read",
        content: [{ type: "text", text: "contents" }],
        isError: false,
        timestamp: 3,
      },
    ],
  });

  assert.deepEqual(messages[2], {
    role: "assistant",
    content:
      'I will inspect it.\n<tool_calls>[{"name":"read","arguments":{"path":"README.md"}}]</tool_calls>',
  });
  assert.deepEqual(messages[3], {
    role: "user",
    content:
      "[Tool result for call call_read]\ncontents\n[End tool result]\n" +
      "Continue the original request. Do not quote or reproduce this result block.",
  });
});
