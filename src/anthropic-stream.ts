/**
 * Browser-only streaming client for Anthropic's native Messages API. Speaks the
 * pi-ai `AssistantMessageEvent` protocol, same as the OpenAI client. Used when
 * the active provider's api is "anthropic-messages".
 */
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

import { EventQueue, tryParseJson, zeroUsage } from "./openai-stream.ts";

type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; signature: string; redacted?: boolean }
  | { kind: "tool"; id: string; name: string; args: string };

interface AnthEvent {
  type: string;
  index?: number;
  content_block?: {
    type: string;
    text?: string;
    thinking?: string;
    signature?: string;
    data?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };
  delta?: {
    type: string;
    text?: string;
    thinking?: string;
    signature?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  message?: { usage?: AnthUsage };
  usage?: AnthUsage;
  delta_stop_reason?: string;
}

interface AnthUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export const streamAnthropic: StreamFn = (model, context, options) => {
  const stream = new EventQueue();
  void run(model, context, options ?? {}, stream).catch((err) =>
    emitError(stream, model, err instanceof Error ? err.message : String(err)),
  );
  return stream as unknown as AssistantMessageEventStream;
};

async function run(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  stream: EventQueue,
): Promise<void> {
  const apiKey = options.apiKey;
  if (!apiKey) {
    emitError(stream, model, "No API key. Run /login first.");
    return;
  }

  const body = buildBody(model, context, options);
  const url = model.baseUrl.replace(/\/+$/, "") + "/v1/messages";

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // Required for direct browser calls — without it Anthropic blocks CORS.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (err) {
    emitError(stream, model, `Network request failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    emitError(stream, model, `HTTP ${resp.status} ${resp.statusText}\n${text}`.trim());
    return;
  }

  const blocks: Block[] = [];
  let usage: Usage = zeroUsage();
  let stopReason: AssistantMessage["stopReason"] = "stop";

  stream.push({ type: "start", partial: snapshot(model, blocks, usage, stopReason) });

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const finish = () => {
    stream.push({ type: "done", reason: doneReason(stopReason), message: snapshot(model, blocks, usage, stopReason) });
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);

      if (line === "") {
        continue;
      }
      if (line.startsWith(":")) continue; // comment / keep-alive
      if (line.startsWith("event:")) {
        continue;
      }
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;

      let ev: AnthEvent;
      try {
        ev = JSON.parse(payload) as AnthEvent;
      } catch {
        continue;
      }

      switch (ev.type) {
        case "message_start":
          usage = withUsage(usage, ev.message?.usage);
          break;
        case "content_block_start": {
          const idx = ev.index ?? blocks.length;
          const cb = ev.content_block;
          if (cb?.type === "tool_use") {
            blocks[idx] = { kind: "tool", id: cb.id ?? "", name: cb.name ?? "", args: "" };
            stream.push({ type: "toolcall_start", contentIndex: idx, partial: snapshot(model, blocks, usage, stopReason) });
          } else if (cb?.type === "thinking") {
            blocks[idx] = {
              kind: "thinking",
              text: cb.thinking ?? "",
              signature: cb.signature ?? "",
            };
            stream.push({
              type: "thinking_start",
              contentIndex: idx,
              partial: snapshot(model, blocks, usage, stopReason),
            });
          } else if (cb?.type === "redacted_thinking") {
            blocks[idx] = {
              kind: "thinking",
              text: "",
              signature: cb.data ?? "",
              redacted: true,
            };
          } else {
            blocks[idx] = { kind: "text", text: cb?.text ?? "" };
            stream.push({ type: "text_start", contentIndex: idx, partial: snapshot(model, blocks, usage, stopReason) });
          }
          break;
        }
        case "content_block_delta": {
          const idx = ev.index ?? 0;
          const b = blocks[idx];
          if (!b || !ev.delta) break;
          if (ev.delta.type === "text_delta" && b.kind === "text") {
            b.text += ev.delta.text ?? "";
            stream.push({ type: "text_delta", contentIndex: idx, delta: ev.delta.text ?? "", partial: snapshot(model, blocks, usage, stopReason) });
          } else if (ev.delta.type === "thinking_delta" && b.kind === "thinking") {
            b.text += ev.delta.thinking ?? "";
            stream.push({
              type: "thinking_delta",
              contentIndex: idx,
              delta: ev.delta.thinking ?? "",
              partial: snapshot(model, blocks, usage, stopReason),
            });
          } else if (ev.delta.type === "signature_delta" && b.kind === "thinking") {
            b.signature += ev.delta.signature ?? "";
          } else if (ev.delta.type === "input_json_delta" && b.kind === "tool") {
            b.args += ev.delta.partial_json ?? "";
            stream.push({ type: "toolcall_delta", contentIndex: idx, delta: ev.delta.partial_json ?? "", partial: snapshot(model, blocks, usage, stopReason) });
          }
          break;
        }
        case "content_block_stop": {
          const idx = ev.index ?? 0;
          const b = blocks[idx];
          if (!b) break;
          if (b.kind === "text") {
            stream.push({ type: "text_end", contentIndex: idx, content: b.text, partial: snapshot(model, blocks, usage, stopReason) });
          } else if (b.kind === "thinking") {
            if (!b.redacted) {
              stream.push({
                type: "thinking_end",
                contentIndex: idx,
                content: b.text,
                partial: snapshot(model, blocks, usage, stopReason),
              });
            }
          } else {
            stream.push({
              type: "toolcall_end",
              contentIndex: idx,
              toolCall: { type: "toolCall", id: b.id, name: b.name, arguments: b.args ? tryParseJson(b.args) : {} },
              partial: snapshot(model, blocks, usage, stopReason),
            });
          }
          break;
        }
        case "message_delta":
          if (ev.delta?.stop_reason) stopReason = mapStop(ev.delta.stop_reason);
          usage = withUsage(usage, ev.usage);
          break;
        case "message_stop":
          finish();
          return;
        default:
          break; // ping, etc.
      }
    }
  }
  finish();
}

/* --------------------------- request building --------------------------- */

function buildBody(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
) {
  const messages = toAnthropicMessages(context.messages);
  const body: Record<string, unknown> = {
    model: model.id,
    max_tokens: model.maxTokens || 4096,
    stream: true,
    messages,
  };
  if (context.systemPrompt) body.system = context.systemPrompt;
  if (context.tools && context.tools.length > 0) {
    body.tools = context.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: JSON.parse(JSON.stringify(t.parameters)),
    }));
  }
  if (model.reasoning) {
    const level = options.reasoning ? clampThinkingLevel(model, options.reasoning) : "off";
    if (level === "off") {
      if (model.thinkingLevelMap?.off !== null) body.thinking = { type: "disabled" };
    } else if (
      (model.compat as { forceAdaptiveThinking?: boolean } | undefined)
        ?.forceAdaptiveThinking
    ) {
      body.thinking = { type: "adaptive" };
      body.output_config = { effort: anthropicEffort(model, level) };
    } else {
      const budget = thinkingBudget(level, options);
      body.thinking = { type: "enabled", budget_tokens: budget };
      body.max_tokens = Math.max(Number(body.max_tokens), budget + 1024);
    }
  }
  return body;
}

function anthropicEffort(
  model: Model<Api>,
  level: Exclude<SimpleStreamOptions["reasoning"], undefined>,
): string {
  const mapped = model.thinkingLevelMap?.[level];
  if (typeof mapped === "string") return mapped;
  if (level === "minimal" || level === "low") return "low";
  if (level === "medium") return "medium";
  if (level === "xhigh" || level === "max") return level;
  return "high";
}

function thinkingBudget(
  level: Exclude<SimpleStreamOptions["reasoning"], undefined>,
  options: SimpleStreamOptions,
): number {
  const custom =
    level === "xhigh" || level === "max"
      ? undefined
      : options.thinkingBudgets?.[level];
  if (typeof custom === "number") return custom;
  switch (level) {
    case "minimal":
      return 1024;
    case "low":
      return 2048;
    case "medium":
      return 4096;
    case "high":
      return 8192;
    case "xhigh":
      return 16_384;
    case "max":
      return 32_768;
    default:
      return 1024;
  }
}

/** Map pi messages → Anthropic messages, merging consecutive tool results. */
function toAnthropicMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const content =
        typeof m.content === "string"
          ? m.content
          : m.content.map((c) =>
              c.type === "text"
                ? { type: "text", text: c.text }
                : { type: "image", source: { type: "base64", media_type: (c as ImageContent).mimeType, data: (c as ImageContent).data } },
            );
      out.push({ role: "user", content });
    } else if (m.role === "assistant") {
      const content: unknown[] = [];
      for (const c of m.content) {
        if (c.type === "text") content.push({ type: "text", text: c.text });
        else if (c.type === "thinking" && c.thinkingSignature) {
          content.push(
            c.redacted
              ? { type: "redacted_thinking", data: c.thinkingSignature }
              : {
                  type: "thinking",
                  thinking: c.thinking,
                  signature: c.thinkingSignature,
                },
          );
        }
        else if (c.type === "toolCall")
          content.push({ type: "tool_use", id: c.id, name: c.name, input: (c as ToolCall).arguments });
      }
      out.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "" }] });
    } else if (m.role === "toolResult") {
      const text = m.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("");
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: text };
      const last = out[out.length - 1];
      // Anthropic wants consecutive tool results grouped into one user message.
      if (last && typeof last === "object" && (last as { role?: string }).role === "user" && Array.isArray((last as { content: unknown }).content)) {
        (last as { content: unknown[] }).content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return out;
}

/* ------------------------------ snapshots ------------------------------- */

function snapshot(
  model: Model<Api>,
  blocks: Block[],
  usage: Usage,
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content: blocks
      .filter((b) => b != null)
      .map((b) =>
        b.kind === "text"
          ? ({ type: "text", text: b.text } as TextContent)
          : b.kind === "thinking"
            ? ({
                type: "thinking",
                thinking: b.text,
                thinkingSignature: b.signature,
                redacted: b.redacted,
              } as ThinkingContent)
            : ({ type: "toolCall", id: b.id, name: b.name, arguments: b.args ? tryParseJson(b.args) : {} } as ToolCall),
      ),
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

function emitError(stream: EventQueue, model: Model<Api>, message: string) {
  const error: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: message }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
  stream.push({ type: "error", reason: "error", error });
}

/* ------------------------------- mappers -------------------------------- */

function withUsage(u: Usage, raw?: AnthUsage): Usage {
  const input = raw?.input_tokens ?? u.input;
  const output = raw?.output_tokens ?? u.output;
  const cacheRead = raw?.cache_read_input_tokens ?? u.cacheRead;
  const cacheWrite = raw?.cache_creation_input_tokens ?? u.cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { ...u.cost },
  };
}

function mapStop(r: string): AssistantMessage["stopReason"] {
  switch (r) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    default:
      return "stop";
  }
}

function doneReason(r: AssistantMessage["stopReason"]): "stop" | "length" | "toolUse" {
  if (r === "length") return "length";
  if (r === "toolUse") return "toolUse";
  return "stop";
}
