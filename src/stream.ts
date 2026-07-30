/** Pick the right browser streamFn based on the active model's wire format. */
import type {
  AssistantMessage,
  AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { streamAnthropic } from "./anthropic-stream.ts";
import { streamOpenAI } from "./openai-stream.ts";

// TEMPORARY: this API targets the opt-in loopback Codex proxy. Force SSE so
// the proxy can remain a tiny HTTP relay instead of implementing WebSockets.
const openAICodexResponses = openAICodexResponsesApi();
const openAIResponses = openAIResponsesApi();
const MISSING_RESPONSES_TERMINAL =
  "OpenAI Responses stream ended before a terminal response event";

function recoverMissingResponsesTerminal(
  source: AssistantMessageEventStream,
): AssistantMessageEventStream {
  const Stream = source.constructor as new () => AssistantMessageEventStream;
  const target = new Stream();

  void (async () => {
    const openBlocks = new Set<string>();
    let completedText = false;
    let completedToolCall = false;

    for await (const event of source) {
      if (event.type.endsWith("_start") && "contentIndex" in event) {
        openBlocks.add(`${event.type.slice(0, -6)}:${event.contentIndex}`);
      } else if (event.type.endsWith("_end") && "contentIndex" in event) {
        openBlocks.delete(`${event.type.slice(0, -4)}:${event.contentIndex}`);
        completedText ||= event.type === "text_end";
        completedToolCall ||= event.type === "toolcall_end";
      }

      if (
        event.type === "error" &&
        event.reason === "error" &&
        event.error.errorMessage?.includes(MISSING_RESPONSES_TERMINAL) &&
        openBlocks.size === 0 &&
        (completedText || completedToolCall)
      ) {
        const reason = completedToolCall ? "toolUse" : "stop";
        const message: AssistantMessage = {
          ...event.error,
          stopReason: reason,
          errorMessage: undefined,
        };
        target.push({ type: "done", reason, message });
        return;
      }

      target.push(event);
      if (event.type === "done" || event.type === "error") return;
    }
  })();

  return target;
}

export const streamDispatch: StreamFn = (model, context, options) => {
  if (model.api === "anthropic-messages") {
    return streamAnthropic(model, context, options);
  }
  if (model.api === "openai-responses") {
    return recoverMissingResponsesTerminal(
      openAIResponses.streamSimple(model, context, options),
    );
  }
  if (model.api === "openai-codex-responses") {
    return openAICodexResponses.streamSimple(model, context, {
      ...options,
      transport: "sse",
    });
  }
  return streamOpenAI(model, context, options);
};
