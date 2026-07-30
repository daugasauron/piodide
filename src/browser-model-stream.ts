import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
  ChatCompletionMessage,
  ChatCompletionTool,
} from "@wllama/wllama/esm/types/oai-compat.js";

import {
  getBrowserModel,
  type BrowserModelDef,
} from "./browser-models.ts";
import { browserModelRuntime, type BrowserChatRequest } from "./browser-model-runtime.ts";
import { EventQueue, OpenAIEventAdapter, zeroUsage } from "./openai-stream.ts";

export const streamBrowserModel: StreamFn = (model, context, options) => {
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
  const descriptor = getBrowserModel(model.id);
  if (!descriptor) throw new Error(`Unknown browser model: ${model.id}`);

  await browserModelRuntime.ensureLoaded(model.id, options.signal);
  const events = new OpenAIEventAdapter(model, stream);
  const request = createBrowserChatRequest(
    model,
    descriptor,
    context,
    options.reasoning,
  );

  for await (const chunk of browserModelRuntime.streamChat(
    model.id,
    request,
    options.signal,
  )) {
    events.accept(chunk);
  }
  events.finish();
}

export function createBrowserChatRequest(
  model: Model<Api>,
  descriptor: BrowserModelDef,
  context: Context,
  reasoning: SimpleStreamOptions["reasoning"],
): BrowserChatRequest {
  const thinking = descriptor.thinking === true && reasoning !== undefined;
  const generation =
    thinking && descriptor.thinkingGeneration
      ? descriptor.thinkingGeneration
      : descriptor.generation;
  const request: BrowserChatRequest = {
    model: model.id,
    messages: toBrowserChatMessages(context),
    max_tokens: model.maxTokens,
    temperature: generation.temperature,
    top_p: generation.topP,
    top_k: generation.topK,
    cache_prompt: true,
    chat_template_kwargs: {
      enable_thinking: thinking,
    },
  };
  if (context.tools?.length && descriptor.tools) {
    request.tools = context.tools.map(
      (tool): ChatCompletionTool => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: JSON.parse(JSON.stringify(tool.parameters)),
        },
      }),
    );
    request.tool_choice = "auto";
  }
  return request;
}

export function toBrowserChatMessages(context: Context): ChatCompletionMessage[] {
  const messages: ChatCompletionMessage[] = [];
  if (context.systemPrompt) {
    messages.push({ role: "system", content: context.systemPrompt });
  }
  for (const message of context.messages) {
    messages.push(toMessage(message));
  }
  return messages;
}

function toMessage(message: Message): ChatCompletionMessage {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        content:
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((content): content is TextContent => content.type === "text")
                .map((content) => content.text)
                .join(""),
      };
    case "assistant": {
      const content = message.content
        .filter((item): item is TextContent => item.type === "text")
        .map((item) => item.text)
        .join("");
      const toolCalls = message.content.filter(
        (item): item is ToolCall => item.type === "toolCall",
      );
      return {
        role: "assistant",
        content: content || null,
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((toolCall) => ({
                id: toolCall.id,
                type: "function" as const,
                function: {
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.arguments),
                },
              })),
            }
          : {}),
      };
    }
    case "toolResult":
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content
          .filter((item): item is TextContent => item.type === "text")
          .map((item) => item.text)
          .join(""),
      };
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
