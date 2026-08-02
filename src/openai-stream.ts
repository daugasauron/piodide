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

export interface OaiChoiceDelta {
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
export interface OaiChunk {
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

/** Converts OpenAI-shaped streaming chunks into the pi-ai event protocol. */
export class OpenAIEventAdapter {
  private readonly model: Model<Api>;
  private readonly stream: EventQueue;
  private readonly blocks: ContentBlock[] = [];
  private readonly toolPosByIndex = new Map<number, number>();
  private textStarted = false;
  private textPos = -1;
  private reasoningStarted = false;
  private reasoningPos = -1;
  private usage: Usage = zeroUsage();
  private stopReason: AssistantMessage["stopReason"] = "stop";
  private finished = false;

  constructor(model: Model<Api>, stream: EventQueue) {
    this.model = model;
    this.stream = stream;
    stream.push({
      type: "start",
      partial: snapshot(model, this.blocks, this.usage, this.stopReason),
    });
  }

  accept(chunk: OaiChunk): void {
    if (this.finished) return;
    if (chunk.usage) this.usage = mapUsage(chunk.usage);

    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    const reasoningDelta = [
      delta.reasoning_content,
      delta.reasoning,
      delta.reasoning_text,
    ].find((value): value is string => typeof value === "string" && value.length > 0);

    if (reasoningDelta) {
      if (!this.reasoningStarted) {
        this.reasoningStarted = true;
        this.reasoningPos = this.blocks.push({ kind: "thinking", text: "" }) - 1;
        this.stream.push({
          type: "thinking_start",
          contentIndex: this.reasoningPos,
          partial: this.snapshot(),
        });
      }
      (this.blocks[this.reasoningPos] as { text: string }).text += reasoningDelta;
      this.stream.push({
        type: "thinking_delta",
        contentIndex: this.reasoningPos,
        delta: reasoningDelta,
        partial: this.snapshot(),
      });
    }

    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!this.textStarted) {
        this.textStarted = true;
        this.textPos = this.blocks.push({ kind: "text", text: "" }) - 1;
        this.stream.push({
          type: "text_start",
          contentIndex: this.textPos,
          partial: this.snapshot(),
        });
      }
      (this.blocks[this.textPos] as { text: string }).text += delta.content;
      this.stream.push({
        type: "text_delta",
        contentIndex: this.textPos,
        delta: delta.content,
        partial: this.snapshot(),
      });
    }

    for (const toolCall of delta.tool_calls ?? []) {
      let position = this.toolPosByIndex.get(toolCall.index);
      if (position === undefined) {
        position =
          this.blocks.push({
            kind: "tool",
            idx: toolCall.index,
            id: toolCall.id ?? "",
            name: toolCall.function?.name ?? "",
            args: "",
          }) - 1;
        this.toolPosByIndex.set(toolCall.index, position);
        this.stream.push({
          type: "toolcall_start",
          contentIndex: position,
          partial: this.snapshot(),
        });
      }
      const block = this.blocks[position] as Extract<ContentBlock, { kind: "tool" }>;
      if (toolCall.id) block.id = toolCall.id;
      if (toolCall.function?.name) block.name = toolCall.function.name;
      const fragment = toolCall.function?.arguments ?? "";
      if (fragment) {
        block.args += fragment;
        this.stream.push({
          type: "toolcall_delta",
          contentIndex: position,
          delta: fragment,
          partial: this.snapshot(),
        });
      }
    }

    if (choice.finish_reason) {
      this.stopReason = mapStopReason(choice.finish_reason);
    }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    // Some local OpenAI-compatible runtimes (notably Wllama 3.5.1) emit
    // structured tool-call deltas but finish with `stop`. The structured call
    // is authoritative; the agent must execute it instead of treating this as
    // a final text response.
    if (this.toolPosByIndex.size > 0) this.stopReason = "toolUse";

    if (this.reasoningStarted) {
      this.stream.push({
        type: "thinking_end",
        contentIndex: this.reasoningPos,
        content: (this.blocks[this.reasoningPos] as { text: string }).text,
        partial: this.snapshot(),
      });
    }
    if (this.textStarted) {
      this.stream.push({
        type: "text_end",
        contentIndex: this.textPos,
        content: (this.blocks[this.textPos] as { text: string }).text,
        partial: this.snapshot(),
      });
    }
    for (const [, position] of [...this.toolPosByIndex.entries()].sort((a, b) => a[0] - b[0])) {
      const block = this.blocks[position] as Extract<ContentBlock, { kind: "tool" }>;
      const toolCall: ToolCall = {
        type: "toolCall",
        id: block.id || `call_${position}`,
        name: block.name,
        arguments: tryParseJson(block.args),
      };
      this.stream.push({
        type: "toolcall_end",
        contentIndex: position,
        toolCall,
        partial: this.snapshot(),
      });
    }
    this.stream.push({
      type: "done",
      reason: mapDoneReason(this.stopReason),
      message: this.snapshot(),
    });
  }

  private snapshot(): AssistantMessage {
    return snapshot(this.model, this.blocks, this.usage, this.stopReason);
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
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
    emitError(stream, model, formatHttpError(resp.status, resp.statusText, text));
    return;
  }

  const events = new OpenAIEventAdapter(model, stream);
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
        events.finish();
        return;
      }
      let chunk: OaiChunk;
      try {
        chunk = JSON.parse(payload) as OaiChunk;
      } catch {
        continue;
      }
      events.accept(chunk);
    }
  }
  // Stream ended without an explicit finish marker.
  events.finish();
}

/* --------------------------- request building --------------------------- */

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
        : ["zhipu", "zhipu-coding", "zhipu-coding-cn"].includes(model.provider)
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

export function formatHttpError(
  status: number,
  statusText: string,
  text: string,
): string {
  const trimmed = text.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown };
      return `Error: ${status}: ${JSON.stringify(parsed.error ?? parsed)}`;
    } catch {
      return `Error: ${status}${statusText ? ` ${statusText}` : ""}: ${trimmed}`;
    }
  }
  return `Error: ${status}${statusText ? ` ${statusText}` : ""}`;
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
