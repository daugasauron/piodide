import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";

import {
  createToolResponseFormat,
  parsePromptedToolCalls,
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
      '<tool_result>{"tool_call_id":"call_read","content":"contents"}</tool_result>',
  });
});
