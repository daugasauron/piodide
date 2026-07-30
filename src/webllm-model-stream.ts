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
  const systemPrompt = tools.length
    ? `${context.systemPrompt ?? ""}\n\n${toolProtocol(tools)}`.trim()
    : context.systemPrompt;
  const request: WebLLMChatRequest = {
    messages: toWebLLMMessages({
      ...context,
      systemPrompt,
    }),
    max_tokens: model.maxTokens,
    temperature: descriptor.generation.temperature,
    top_p: descriptor.generation.topP,
    stream_options: { include_usage: true },
  };
  if (tools.length) {
    request.response_format = createToolResponseFormat(tools);
  }

  let output = "";
  let usage: OaiChunk["usage"];
  let finishReason: string | null = "stop";
  for await (const chunk of webLLMRuntime.streamChat(
    model.id,
    request,
    options.signal,
  )) {
    output += chunk.choices?.[0]?.delta?.content ?? "";
    if (chunk.usage) usage = chunk.usage;
    if (chunk.choices?.[0]?.finish_reason) {
      finishReason = chunk.choices[0].finish_reason;
    }
  }

  const toolCalls = parsePromptedToolCalls(
    output,
    new Set(tools.map((tool) => tool.name)),
  );
  if (toolCalls?.length) {
    events.accept({
      choices: [
        {
          delta: {
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
    events.accept({
      choices: [
        {
          delta: { content: output },
          finish_reason: finishReason,
        },
      ],
      usage,
    });
  }
  events.finish();
}

export function toWebLLMMessages(context: Context): ChatCompletionMessageParam[] {
  return toBrowserChatMessages(context).map((message): ChatCompletionMessageParam => {
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
): string {
  const definitions = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: JSON.parse(JSON.stringify(tool.parameters)),
  }));
  return `Tool-call protocol for this WebLLM model:
- If no tool is needed, answer the user normally. A greeting or general question never needs a tool.
- If a tool is needed, output only this envelope and no prose:
  <tool_calls>[{"name":"tool_name","arguments":{"argument":"value"}}]</tool_calls>
- Use only a listed tool, preserve its exact name, and provide arguments matching its schema.
- Multiple independent calls may appear in the JSON array.

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
    return undefined;
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
