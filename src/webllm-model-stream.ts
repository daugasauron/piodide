import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  ChatCompletionMessageParam,
} from "@mlc-ai/web-llm";

import { toBrowserChatMessages } from "./browser-model-stream.ts";
import {
  EventQueue,
  OpenAIEventAdapter,
  type OaiChunk,
  zeroUsage,
} from "./openai-stream.ts";
import { getWebLLMModel } from "./webllm-models.ts";
import { webLLMRuntime, type WebLLMChatRequest } from "./webllm-runtime.ts";

export const streamWebLLMModel: StreamFn = (model, context, options) => {
  const stream = new EventQueue();
  void run(model, context, options ?? {}, stream).catch((error) => {
    emitError(
      stream,
      model,
      error instanceof Error ? error.message : String(error),
      options?.signal?.aborted || isAbortError(error) ? "aborted" : "error",
    );
  });
  return stream as unknown as AssistantMessageEventStream;
};

async function run(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  stream: EventQueue,
): Promise<void> {
  const descriptor = getWebLLMModel(model.id);
  if (!descriptor) throw new Error(`Unknown WebLLM model: ${model.id}`);

  await webLLMRuntime.ensureLoaded(model.id, options.signal);
  const events = new OpenAIEventAdapter(model, stream);
  const tools = context.tools?.length && descriptor.tools ? context.tools : [];
  const thinking = descriptor.thinking === true && options.reasoning !== undefined;
  const generation =
    thinking && descriptor.thinkingGeneration
      ? descriptor.thinkingGeneration
      : descriptor.generation;
  const systemPrompt = tools.length
    ? `${context.systemPrompt ?? ""}\n\n${toolProtocol(tools, thinking)}`.trim()
    : context.systemPrompt;
  const request: WebLLMChatRequest = {
    messages: toWebLLMMessages({
      ...context,
      systemPrompt,
    }),
    max_tokens: model.maxTokens,
    temperature: generation.temperature,
    top_p: generation.topP,
    stream_options: { include_usage: true },
    ...(descriptor.thinking === true
      ? { extra_body: { enable_thinking: thinking } }
      : {}),
  };
  if (tools.length) {
    request.response_format = createToolResponseFormat(tools);
  }

  let output = "";
  let streamedThinking = "";
  let streamedAnswer = "";
  let usage: OaiChunk["usage"];
  let finishReason: string | null = "stop";
  for await (const chunk of webLLMRuntime.streamChat(
    model.id,
    request,
    options.signal,
  )) {
    output += chunk.choices?.[0]?.delta?.content ?? "";
    const partial = inspectPartialQwenOutput(output, thinking);
    if (
      partial.thinking.startsWith(streamedThinking) &&
      partial.thinking.length > streamedThinking.length
    ) {
      const delta = partial.thinking.slice(streamedThinking.length);
      streamedThinking = partial.thinking;
      events.accept({
        choices: [{ delta: { reasoning_content: delta }, finish_reason: null }],
      });
    }
    if (
      partial.contentKind === "answer" &&
      partial.content.startsWith(streamedAnswer) &&
      partial.content.length > streamedAnswer.length
    ) {
      const delta = partial.content.slice(streamedAnswer.length);
      streamedAnswer = partial.content;
      events.accept({
        choices: [{ delta: { content: delta }, finish_reason: null }],
      });
    }
    if (chunk.usage) usage = chunk.usage;
    if (chunk.choices?.[0]?.finish_reason) {
      finishReason = chunk.choices[0].finish_reason;
    }
  }

  const split = splitQwenThinkingOutput(output, thinking);
  const response = {
    ...split,
    content: recoverWebLLMAnswer(split.content, latestToolResultContent(context)),
  };
  const reasoningDelta = response.thinking && streamedThinking.length === 0
    ? { reasoning_content: response.thinking }
    : {};
  const toolCalls = parsePromptedToolCalls(
    response.content,
    new Set(tools.map((tool) => tool.name)),
  );
  if (toolCalls?.length) {
    events.accept({
      choices: [
        {
          delta: {
            ...reasoningDelta,
            tool_calls: toolCalls.map((toolCall, index) => ({
              index,
              id: `call_${crypto.randomUUID().replaceAll("-", "")}`,
              type: "function",
              function: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.arguments),
              },
            })),
          },
          finish_reason: "tool_calls",
        },
      ],
      usage,
    });
  } else {
    const remainingContent = response.content.startsWith(streamedAnswer)
      ? response.content.slice(streamedAnswer.length)
      : response.content;
    events.accept({
      choices: [
        {
          delta: { ...reasoningDelta, content: remainingContent },
          finish_reason: finishReason,
        },
      ],
      usage,
    });
  }
  events.finish();
}

export interface QwenThinkingOutput {
  thinking?: string;
  content: string;
}

export interface PartialQwenOutput {
  thinking: string;
  content: string;
  contentKind: "pending" | "answer" | "control";
}

/** Return only prefixes that are safe to render while Qwen is still streaming. */
export function inspectPartialQwenOutput(
  output: string,
  thinkingEnabled: boolean,
): PartialQwenOutput {
  let thinking = "";
  let content = "";
  const opening = output.match(/^\s*<think>\s*/i);
  if (opening) {
    const body = output.slice(opening[0].length);
    const closingIndex = body.toLowerCase().indexOf("</think>");
    if (closingIndex < 0) {
      thinking = withoutPartialSuffix(body, "</think>").trimStart();
      return { thinking, content: "", contentKind: "pending" };
    }
    thinking = body.slice(0, closingIndex).trim();
    content = body.slice(closingIndex + "</think>".length).trimStart();
  } else if (thinkingEnabled) {
    const closingIndex = output.toLowerCase().indexOf("</think>");
    if (closingIndex < 0) return { thinking: "", content: "", contentKind: "pending" };
    thinking = output.slice(0, closingIndex).trim();
    content = output.slice(closingIndex + "</think>".length).trimStart();
  } else {
    content = output;
  }

  const trimmed = content.trimStart();
  if (!trimmed) return { thinking, content, contentKind: "pending" };
  const lower = trimmed.toLowerCase();
  const controlTags = ["<tool_calls>", "<tool_call>", "<tool_result>"];
  if (controlTags.some((tag) => tag.startsWith(lower) || lower.startsWith(tag))) {
    return { thinking, content, contentKind: "control" };
  }
  return { thinking, content, contentKind: "answer" };
}

/** Separate Qwen's visible `<think>` block from answer/tool content. */
export function splitQwenThinkingOutput(
  output: string,
  thinkingEnabled: boolean,
): QwenThinkingOutput {
  const opening = output.match(/^\s*<think>\s*/i);
  if (opening) {
    const reasoningStart = opening[0].length;
    const closingIndex = output.toLowerCase().indexOf("</think>", reasoningStart);
    if (closingIndex >= 0) {
      const thinking = output.slice(reasoningStart, closingIndex).trim();
      const content = output.slice(closingIndex + "</think>".length).trimStart();
      return {
        ...(thinkingEnabled && thinking ? { thinking } : {}),
        content,
      };
    }
    if (thinkingEnabled) {
      const thinking = output.slice(reasoningStart).trim();
      return { ...(thinking ? { thinking } : {}), content: "" };
    }
  }

  // Some runtimes include the opening tag in the assistant prompt rather than
  // in generated tokens, but still return the closing tag in the response.
  if (thinkingEnabled) {
    const closingIndex = output.toLowerCase().indexOf("</think>");
    if (closingIndex >= 0) {
      const thinking = output.slice(0, closingIndex).trim();
      const content = output.slice(closingIndex + "</think>".length).trimStart();
      return { ...(thinking ? { thinking } : {}), content };
    }
  }

  return { content: output };
}

export function recoverWebLLMAnswer(
  output: string,
  latestToolResult?: string,
): string {
  const match = output.match(/^\s*<tool_result>\s*([\s\S]*?)\s*<\/tool_result>\s*$/i);
  if (!match) return output;
  try {
    const parsed = JSON.parse(match[1]) as { content?: unknown };
    if (typeof parsed.content !== "string") return "";
    if (latestToolResult && parsed.content.startsWith(latestToolResult)) {
      return parsed.content.slice(latestToolResult.length).trim();
    }
  } catch {
    // A malformed control envelope is never useful user-facing answer text.
  }
  return "";
}

function latestToolResultContent(context: Context): string | undefined {
  const messages = toBrowserChatMessages(context);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "tool" && typeof message.content === "string") {
      return message.content;
    }
  }
  return undefined;
}

function withoutPartialSuffix(value: string, suffix: string): string {
  const lower = value.toLowerCase();
  const target = suffix.toLowerCase();
  for (let length = Math.min(target.length - 1, lower.length); length > 0; length--) {
    if (lower.endsWith(target.slice(0, length))) return value.slice(0, -length);
  }
  return value;
}

export function toWebLLMMessages(context: Context): ChatCompletionMessageParam[] {
  return toBrowserChatMessages(context).map((message): ChatCompletionMessageParam => {
    if (message.role === "tool") {
      // The Qwen MLC conversation template only defines system, user, and
      // assistant roles. Passing OpenAI's `tool` role reaches WebLLM's prompt
      // builder and fails before generation with "Role is not supported:
      // tool". Replay it through a role every catalogue template accepts,
      // but avoid an XML/JSON envelope that small Qwen models may imitate in
      // their final answer.
      return {
        role: "user",
        content:
          `[Tool result for call ${message.tool_call_id}]\n` +
          `${message.content}\n` +
          "[End tool result]\nContinue the original request. Do not quote or reproduce this result block.",
      };
    }
    if (message.role !== "assistant") {
      return message as ChatCompletionMessageParam;
    }
    const calls = (message.tool_calls ?? []).map((toolCall) => ({
      name: toolCall.function.name,
      arguments: parseArguments(toolCall.function.arguments),
    }));
    const text = typeof message.content === "string" ? message.content : "";
    return {
      role: "assistant",
      content: [
        text,
        calls.length
          ? `<tool_calls>${JSON.stringify(calls)}</tool_calls>`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  });
}

interface PromptedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function toolProtocol(
  tools: NonNullable<Context["tools"]>,
  thinking: boolean,
): string {
  const definitions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: JSON.parse(JSON.stringify(tool.parameters)),
  }));
  return `Tool-call protocol for this WebLLM model:
- If no tool is needed, answer the user normally. A greeting or general question never needs a tool.
- If a tool is needed, ${
    thinking
      ? "first reason briefly inside <think>...</think>, then output only this envelope and no other prose"
      : "output only this envelope and no prose"
  }:
  <tool_calls>[{"name":"tool_name","arguments":{"argument":"value"}}]</tool_calls>
- Use only a listed tool, preserve its exact name, and provide arguments matching its schema.
- Multiple independent calls may appear in the JSON array.
- Tool results are returned in clearly delimited result blocks. Treat them as the results of your calls, then continue the original task without repeating a successful call.
- Never quote, reproduce, or wrap a tool result in your answer.

Available tools:
${JSON.stringify(definitions)}`;
}

export function createToolResponseFormat(
  tools: NonNullable<Context["tools"]>,
): NonNullable<WebLLMChatRequest["response_format"]> {
  const variants = tools.map((tool) => ({
    type: "object",
    properties: {
      name: { const: tool.name },
      arguments: JSON.parse(JSON.stringify(tool.parameters)),
    },
    required: ["name", "arguments"],
    additionalProperties: false,
  }));
  const itemSchema = variants.length === 1 ? variants[0] : { oneOf: variants };
  const structuralTag = {
    type: "structural_tag",
    format: {
      type: "triggered_tags",
      triggers: ["<tool_calls>"],
      tags: [
        {
          type: "tag",
          begin: "<tool_calls>",
          content: {
            type: "json_schema",
            json_schema: {
              type: "array",
              items: itemSchema,
              minItems: 1,
            },
          },
          end: "</tool_calls>",
        },
      ],
      // Ordinary answers remain unconstrained unless the model starts the
      // tool envelope. One envelope can contain any number of independent
      // calls, so stop matching once that envelope is complete.
      at_least_one: false,
      stop_after_first: true,
    },
  };
  return {
    type: "structural_tag",
    // Passing the serialized form avoids coupling this app to XGrammar's
    // internal TypeScript declarations, which WebLLM does not re-export.
    structural_tag: JSON.stringify(structuralTag),
  };
}

export function parsePromptedToolCalls(
  output: string,
  allowedNames: ReadonlySet<string>,
): PromptedToolCall[] | undefined {
  const tagged =
    output.match(/<tool_calls>\s*([\s\S]*?)\s*<\/tool_calls>/i)?.[1] ??
    output.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i)?.[1];
  const candidate = tagged ?? output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return parseLooseWriteToolCall(output, allowedNames);
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  if (values.length === 0) return undefined;

  const calls: PromptedToolCall[] = [];
  for (const value of values) {
    if (!isRecord(value) || typeof value.name !== "string") return undefined;
    if (!allowedNames.has(value.name)) return undefined;
    let args: unknown = value.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        return undefined;
      }
    }
    if (!isRecord(args)) return undefined;
    calls.push({ name: value.name, arguments: args });
  }
  return calls;
}

/**
 * Recover a tagged `write` call when a small local model forgets to JSON-escape
 * quotes in a large source string, or reaches its output limit before closing
 * the envelope. The agent still validates the recovered arguments before the
 * tool executes. Keeping this fallback specific to `write` avoids guessing at
 * arbitrary malformed tool payloads.
 */
function parseLooseWriteToolCall(
  output: string,
  allowedNames: ReadonlySet<string>,
): PromptedToolCall[] | undefined {
  if (!allowedNames.has("write")) return undefined;
  const start = output.match(/<tool_calls?>\s*/i);
  if (!start || start.index === undefined) return undefined;
  let body = output.slice(start.index + start[0].length);
  const closingTag = body.search(/<\/tool_calls?>/i);
  const complete = closingTag >= 0;
  if (complete) body = body.slice(0, closingTag);

  const prefix = body.match(
    /^\s*\[?\s*\{\s*"name"\s*:\s*"write"\s*,\s*"arguments"\s*:\s*\{\s*"path"\s*:\s*("(?:\\.|[^"\\])*")\s*,\s*"content"\s*:\s*"/i,
  );
  if (!prefix) return undefined;

  let path: unknown;
  try {
    path = JSON.parse(prefix[1]);
  } catch {
    return undefined;
  }
  if (typeof path !== "string") return undefined;

  let encodedContent = body.slice(prefix[0].length);
  if (complete) {
    const suffix = encodedContent.match(/"\s*\}\s*\}\s*\]?\s*$/);
    if (!suffix || suffix.index === undefined) return undefined;
    encodedContent = encodedContent.slice(0, suffix.index);
  }
  // Do not swallow a second call into the file if the model attempted a batch.
  if (/"\s*\}\s*\}\s*,\s*\{\s*"name"\s*:/i.test(encodedContent)) {
    return undefined;
  }

  return [{
    name: "write",
    arguments: { path, content: decodeLooseJsonString(encodedContent) },
  }];
}

function decodeLooseJsonString(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== "\\" || index + 1 >= value.length) {
      decoded += character;
      continue;
    }
    const escape = value[++index];
    const simple: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    if (escape in simple) {
      decoded += simple[escape];
      continue;
    }
    if (escape === "u" && /^[0-9a-f]{4}$/i.test(value.slice(index + 1, index + 5))) {
      decoded += String.fromCharCode(Number.parseInt(value.slice(index + 1, index + 5), 16));
      index += 4;
      continue;
    }
    decoded += `\\${escape}`;
  }
  return decoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function emitError(
  stream: EventQueue,
  model: Model<Api>,
  message: string,
  reason: "error" | "aborted",
): void {
  const error: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: message }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: reason,
    errorMessage: message,
    timestamp: Date.now(),
  };
  stream.push({ type: "error", reason, error });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
