/**
 * Browser-only streaming client for OpenAI-compatible Chat Completions APIs
 * (OpenAI, OpenRouter, Groq, Together, local llama.cpp, …). It speaks the
 * pi-ai `AssistantMessageEvent` protocol directly, so the agent loop never
 * needs a Node runtime — it just `fetch`es from the page.
 */
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
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
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel } from "@earendil-works/pi-ai";

type ContentBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; idx: number; id: string; name: string; args: string };

interface OaiChoiceDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  reasoning_text?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }> | null;
}
interface OaiChunk {
  choices?: Array<{ delta?: OaiChoiceDelta; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    prompt_cache_hit_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
}

export const streamOpenAI: StreamFn = (model, context, options) => {
  const stream = new EventQueue();
  void run(model, context, options ?? {}, stream).catch((err) =>
    emitError(stream, model, err instanceof Error ? err.message : String(err)),
  );
  // EventQueue is structurally compatible at runtime; cast past pi-ai's private
  // class members which otherwise block structural assignability.
  return stream as unknown as AssistantMessageEventStream;
};

/**
 * A minimal AssistantMessageEventStream-compatible queue: producers `push`
 * events, consumers iterate and call `result()` for the final message. We roll
 * our own (rather than import pi-ai's class, which is type-only in its .d.ts)
 * to keep the bundle clean and bundler-safe.
 */
export class EventQueue {
  private q: AssistantMessageEvent[] = [];
  private waiters: Array<(r: IteratorResult<AssistantMessageEvent>) => void> = [];
  private done = false;
  private resolveResult!: (m: AssistantMessage) => void;
  private resultPromise: Promise<AssistantMessage>;

  constructor() {
    this.resultPromise = new Promise((res) => {
      this.resolveResult = res;
    });
  }

  result(): Promise<AssistantMessage> {
    return this.resultPromise;
  }

  push(ev: AssistantMessageEvent): void {
    if (this.done) return;
    if (ev.type === "done") {
      this.done = true;
      this.resolveResult(ev.message);
    } else if (ev.type === "error") {
      this.done = true;
      this.resolveResult(ev.error);
    }
    const w = this.waiters.shift();
    if (w) w({ value: ev, done: false });
    else this.q.push(ev);
  }

  end(result?: AssistantMessage): void {
    this.done = true;
    if (result) this.resolveResult(result);
    while (this.waiters.length) this.waiters.shift()!({ value: undefined as never, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    while (true) {
      if (this.q.length) {
        yield this.q.shift()!;
      } else if (this.done) {
        return;
      } else {
        const r = await new Promise<IteratorResult<AssistantMessageEvent>>((res) =>
          this.waiters.push(res),
        );
        if (r.done) return;
        yield r.value;
      }
    }
  }
}

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

  const body = buildRequestBody(model, context, options);
  const url = model.baseUrl.replace(/\/+$/, "") + "/chat/completions";

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: browserRequestHeaders(model, context, apiKey),
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (err) {
    emitError(
      stream,
      model,
      `Network request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    emitError(stream, model, `HTTP ${resp.status} ${resp.statusText}\n${text}`.trim());
    return;
  }

  // Emit the initial empty assistant message, then drive the event protocol
  // from the SSE stream.
  const blocks: ContentBlock[] = [];
  const toolPosByIndex = new Map<number, number>();
  let textStarted = false;
  let textPos = -1;
  let reasoningStarted = false;
  let reasoningPos = -1;
  let usage: Usage = zeroUsage();
  let stopReason: AssistantMessage["stopReason"] = "stop";

  stream.push({ type: "start", partial: snapshot(model, blocks, usage, stopReason) });

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const finish = (reason: AssistantMessage["stopReason"]) => {
    stopReason = reason;
    if (reasoningStarted) {
      stream.push({
        type: "thinking_end",
        contentIndex: reasoningPos,
        content: (blocks[reasoningPos] as { text: string }).text,
        partial: snapshot(model, blocks, usage, stopReason),
      });
    }
    if (textStarted) {
      stream.push({
        type: "text_end",
        contentIndex: textPos,
        content: (blocks[textPos] as { text: string }).text,
        partial: snapshot(model, blocks, usage, stopReason),
      });
    }
    for (const [, pos] of [...toolPosByIndex.entries()].sort((a, b) => a[0] - b[0])) {
      const b = blocks[pos] as Extract<ContentBlock, { kind: "tool" }>;
      const toolCall: ToolCall = {
        type: "toolCall",
        id: b.id || `call_${pos}`,
        name: b.name,
        arguments: tryParseJson(b.args),
      };
      stream.push({
        type: "toolcall_end",
        contentIndex: pos,
        toolCall,
        partial: snapshot(model, blocks, usage, stopReason),
      });
    }
    stream.push({ type: "done", reason: mapDoneReason(reason), message: snapshot(model, blocks, usage, stopReason) });
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        finish(stopReason);
        return;
      }
      let chunk: OaiChunk;
      try {
        chunk = JSON.parse(payload) as OaiChunk;
      } catch {
        continue;
      }
      if (chunk.usage) usage = mapUsage(chunk.usage);

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      // OpenAI-compatible providers use several names for the same reasoning
      // delta. Pick the first populated field to avoid duplicate traces.
      const reasoningDelta = [
        delta.reasoning_content,
        delta.reasoning,
        delta.reasoning_text,
      ].find((value): value is string => typeof value === "string" && value.length > 0);
      if (reasoningDelta) {
        if (!reasoningStarted) {
          reasoningStarted = true;
          reasoningPos = blocks.push({ kind: "thinking", text: "" }) - 1;
          stream.push({
            type: "thinking_start",
            contentIndex: reasoningPos,
            partial: snapshot(model, blocks, usage, stopReason),
          });
        }
        (blocks[reasoningPos] as { text: string }).text += reasoningDelta;
        stream.push({
          type: "thinking_delta",
          contentIndex: reasoningPos,
          delta: reasoningDelta,
          partial: snapshot(model, blocks, usage, stopReason),
        });
      }

      // text
      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (!textStarted) {
          textStarted = true;
          textPos = blocks.push({ kind: "text", text: "" }) - 1;
          stream.push({
            type: "text_start",
            contentIndex: textPos,
            partial: snapshot(model, blocks, usage, stopReason),
          });
        }
        (blocks[textPos] as { text: string }).text += delta.content;
        stream.push({
          type: "text_delta",
          contentIndex: textPos,
          delta: delta.content,
          partial: snapshot(model, blocks, usage, stopReason),
        });
      }

      // tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let pos = toolPosByIndex.get(tc.index);
          if (pos === undefined) {
            pos = blocks.push({ kind: "tool", idx: tc.index, id: tc.id ?? "", name: tc.function?.name ?? "", args: "" }) - 1;
            toolPosByIndex.set(tc.index, pos);
            stream.push({
              type: "toolcall_start",
              contentIndex: pos,
              partial: snapshot(model, blocks, usage, stopReason),
            });
          }
          const block = blocks[pos] as Extract<ContentBlock, { kind: "tool" }>;
          if (tc.id) block.id = tc.id;
          if (tc.function?.name) block.name = tc.function.name;
          const frag = tc.function?.arguments ?? "";
          if (frag.length > 0) {
            block.args += frag;
            stream.push({
              type: "toolcall_delta",
              contentIndex: pos,
              delta: frag,
              partial: snapshot(model, blocks, usage, stopReason),
            });
          }
        }
      }

      if (choice.finish_reason) {
        // Usage commonly arrives in a final choices:[] chunk after the stop
        // reason. Keep reading through [DONE] so the persistent footer gets it.
        stopReason = mapStopReason(choice.finish_reason);
      }
    }
  }
  // Stream ended without an explicit finish marker.
  finish(stopReason);
}

/* --------------------------- request building --------------------------- */

function browserRequestHeaders(
  model: Model<Api>,
  context: Context,
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  for (const [name, value] of Object.entries(model.headers ?? {})) {
    // Fetch owns these headers in a browser. In particular, setting the
    // native pi Copilot User-Agent would be silently discarded.
    if (
      ["user-agent", "host", "content-length", "cookie"].includes(
        name.toLowerCase(),
      )
    ) {
      continue;
    }
    headers[name] = value;
  }
  if (model.provider === "github-copilot") {
    const last = context.messages[context.messages.length - 1];
    headers["X-Initiator"] = last && last.role !== "user" ? "agent" : "user";
    headers["Openai-Intent"] = "conversation-edits";
    if (
      context.messages.some(
        (message) =>
          (message.role === "user" || message.role === "toolResult") &&
          Array.isArray(message.content) &&
          message.content.some((content) => content.type === "image"),
      )
    ) {
      headers["Copilot-Vision-Request"] = "true";
    }
  }
  return headers;
}

function buildRequestBody(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
) {
  const messages: unknown[] = [];
  if (context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });
  for (const m of context.messages) messages.push(toOpenAIMessage(m));

  const body: Record<string, unknown> = {
    model: model.id,
    messages,
    stream: true,
    // NOTE: stream_options { include_usage } is intentionally omitted — many
    // OpenAI-compatible servers (Moonshot, Zhipu, …) reject unknown fields.
    // Usage is still consumed when a provider includes it without this flag.
  };
  if (model.provider === "github-copilot") {
    body.stream_options = { include_usage: true };
  }
  body[completionTokenLimitField(model)] = model.maxTokens || 8192;
  if (context.tools && context.tools.length > 0) {
    body.tools = context.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        // TypeBox schemas are JSON-Schema objects once their symbol keys are dropped.
        parameters: JSON.parse(JSON.stringify(t.parameters)),
      },
    }));
    body.tool_choice = "auto";
  }
  // Provider-specific request extras.
  const extra = (model as unknown as { extraBody?: Record<string, unknown> }).extraBody;
  if (extra) Object.assign(body, extra);
  applyThinking(body, model, options.reasoning);
  return body;
}

export function completionTokenLimitField(
  model: Pick<Model<Api>, "baseUrl" | "compat" | "provider">,
): "max_completion_tokens" | "max_tokens" {
  const configured = (
    model.compat as
      | { maxTokensField?: "max_completion_tokens" | "max_tokens" }
      | undefined
  )?.maxTokensField;
  if (configured) return configured;

  // OpenAI deprecated max_tokens and newer models reject it. Keep the legacy
  // field as the conservative default for third-party compatible endpoints.
  const isOpenAI =
    model.provider === "openai" ||
    model.provider === "github-copilot" ||
    /^https:\/\/api\.openai\.com(?:\/|$)/i.test(model.baseUrl);
  return isOpenAI ? "max_completion_tokens" : "max_tokens";
}

function applyThinking(
  body: Record<string, unknown>,
  model: Model<Api>,
  requested: SimpleStreamOptions["reasoning"],
): void {
  if (!model.reasoning) return;

  const level = requested ? clampThinkingLevel(model, requested) : "off";
  const enabled = level !== "off";
  const compat = (model.compat ?? {}) as Record<string, unknown>;
  const format =
    typeof compat.thinkingFormat === "string"
      ? compat.thinkingFormat
      : model.provider === "openrouter"
        ? "openrouter"
        : model.provider === "zhipu" || model.provider === "zhipu-coding"
          ? "zai"
          : "openai";
  const mapped = model.thinkingLevelMap?.[level];
  const effort = typeof mapped === "string" ? mapped : level;
  const supportsEffort = compat.supportsReasoningEffort !== false;

  switch (format) {
    case "zai":
    case "deepseek":
      body.thinking = enabled
        ? { type: "enabled", ...(format === "zai" ? { clear_thinking: false } : {}) }
        : { type: "disabled" };
      if (enabled && supportsEffort) body.reasoning_effort = effort;
      break;
    case "openrouter":
      body.reasoning = { effort: enabled ? effort : model.thinkingLevelMap?.off ?? "none" };
      break;
    case "together":
      body.reasoning = { enabled };
      if (enabled && supportsEffort) body.reasoning_effort = effort;
      break;
    case "qwen":
      body.enable_thinking = enabled;
      break;
    case "qwen-chat-template":
      body.chat_template_kwargs = { enable_thinking: enabled, preserve_thinking: true };
      break;
    case "string-thinking":
      body.thinking = enabled ? effort : model.thinkingLevelMap?.off ?? "none";
      break;
    case "ant-ling":
      if (enabled && typeof mapped === "string") body.reasoning = { effort: mapped };
      break;
    default:
      if (enabled && supportsEffort) {
        body.reasoning_effort = effort;
      } else if (!enabled && typeof model.thinkingLevelMap?.off === "string") {
        body.reasoning_effort = model.thinkingLevelMap.off;
      }
  }
}

function toOpenAIMessage(m: Message): unknown {
  switch (m.role) {
    case "user": {
      if (typeof m.content === "string") return { role: "user", content: m.content };
      return {
        role: "user",
        content: m.content.map((c) =>
          c.type === "text"
            ? { type: "text", text: c.text }
            : { type: "image_url", image_url: { url: `data:${(c as ImageContent).mimeType};base64,${(c as ImageContent).data}` } },
        ),
      };
    }
    case "assistant": {
      const textParts = m.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("");
      const toolCalls = m.content.filter((c): c is ToolCall => c.type === "toolCall");
      const out: Record<string, unknown> = { role: "assistant" };
      out.content = textParts.length > 0 ? textParts : null;
      if (toolCalls.length > 0) {
        out.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      return out;
    }
    case "toolResult": {
      const text = m.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("");
      return { role: "tool", tool_call_id: m.toolCallId, content: text };
    }
  }
}

/* ------------------------------ snapshots ------------------------------- */

function snapshot(
  model: Model<Api>,
  blocks: ContentBlock[],
  usage: Usage,
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    content: blocks.map((b) =>
      b.kind === "text"
        ? ({ type: "text", text: b.text } as TextContent)
        : b.kind === "thinking"
          ? ({ type: "thinking", thinking: b.text } as ThinkingContent)
          : ({
              type: "toolCall",
              id: b.id || `call_${b.idx}`,
              name: b.name,
              arguments: b.args ? tryParseJson(b.args) : {},
            } as ToolCall),
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

export function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function mapUsage(u: NonNullable<OaiChunk["usage"]>): Usage {
  const prompt = u.prompt_tokens ?? 0;
  const output = u.completion_tokens ?? 0;
  const cacheRead =
    u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
  const cacheWrite = u.prompt_tokens_details?.cache_write_tokens ?? 0;
  const input = Math.max(0, prompt - cacheRead - cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: u.completion_tokens_details?.reasoning_tokens,
    totalTokens: u.total_tokens ?? input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function mapStopReason(r: string): AssistantMessage["stopReason"] {
  switch (r) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "toolUse";
    default:
      return "stop";
  }
}

function mapDoneReason(r: AssistantMessage["stopReason"]): "stop" | "length" | "toolUse" {
  if (r === "length") return "length";
  if (r === "toolUse") return "toolUse";
  return "stop";
}

export function tryParseJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
