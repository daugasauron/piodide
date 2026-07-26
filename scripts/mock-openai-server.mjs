// Minimal mock for OpenAI Chat Completions, OpenAI Responses, and Anthropic
// Messages streaming, so piodide's streamFns can be exercised without real API
// keys. Stateful chat/messages requests emit a tool call, then a final answer.
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 5180);
const log = (message, ...args) => console.log(`[mock] ${message}`, ...args);

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "*");
}

/* ----------------------------- OpenAI shape ---------------------------- */
function oaiChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
function oaiTurn1(reasoning = false) {
  const code = "print(1 + 1)";
  return [
    ...(reasoning
      ? [
          oaiChunk({ id: "r1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", reasoning: "First reasoning line.\n\n" }, finish_reason: null }] }),
          oaiChunk({ choices: [{ index: 0, delta: { reasoning_text: "Second reasoning line.\n" }, finish_reason: null }] }),
        ]
      : []),
    oaiChunk({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Let me compute that. " }, finish_reason: null }] }),
    oaiChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "python", arguments: "" } }] }, finish_reason: null }] }),
    oaiChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ code }) } }] }, finish_reason: null }] }),
    oaiChunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    oaiChunk({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 } }),
    "data: [DONE]\n\n",
  ];
}
function oaiTurn2(toolText) {
  const answer = markdownAnswer(toolText);
  const lines = [oaiChunk({ id: "c2", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })];
  for (const fragment of answer.match(/[\s\S]{1,12}/g) ?? []) {
    lines.push(oaiChunk({ choices: [{ index: 0, delta: { content: fragment }, finish_reason: null }] }));
  }
  lines.push(oaiChunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
  lines.push(oaiChunk({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
  lines.push("data: [DONE]\n\n");
  return lines;
}

/* ------------------------- OpenAI Responses shape ---------------------- */
function responsesChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function responsesCreated() {
  return responsesChunk({
    type: "response.created",
    response: {
      id: "resp_1",
      object: "response",
      status: "in_progress",
      output: [],
    },
  });
}

function responsesToolCallWithoutTerminal() {
  const args = JSON.stringify({ code: "print(1 + 1)" });
  const item = {
    id: "fc_1",
    type: "function_call",
    call_id: "call_1",
    name: "python",
    arguments: args,
    status: "completed",
  };
  return [
    responsesCreated(),
    responsesChunk({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    }),
    responsesChunk({
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: args,
    }),
    responsesChunk({
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: item.id,
      arguments: args,
    }),
    responsesChunk({
      type: "response.output_item.done",
      output_index: 0,
      item,
    }),
    "data: [DONE]\n\n",
  ];
}

function responsesStream(model, sawToolResult) {
  if (model === "gpt-5.6-sol" && !sawToolResult) {
    return responsesToolCallWithoutTerminal();
  }
  const text = "Recovered response stream.";
  const item = {
    id: "msg_responses_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const events = [
    responsesCreated(),
    responsesChunk({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    }),
    responsesChunk({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      delta: text,
    }),
  ];
  if (model === "gpt-5.6-luna") {
    return [...events, "data: [DONE]\n\n"];
  }
  events.push(
    responsesChunk({
      type: "response.output_text.done",
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      text,
    }),
    responsesChunk({
      type: "response.output_item.done",
      output_index: 0,
      item,
    }),
  );
  if (model !== "gpt-5.6-sol") {
    events.push(
      responsesChunk({
        type: "response.completed",
        response: {
          id: "resp_1",
          object: "response",
          status: "completed",
          output: [item],
          usage: {
            input_tokens: 4,
            output_tokens: 3,
            total_tokens: 7,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      }),
    );
  }
  // gpt-5.6-sol deliberately omits response.completed; luna returned above
  // with an unfinished output item.
  return [...events, "data: [DONE]\n\n"];
}

/* --------------------------- Anthropic shape --------------------------- */
function antChunk(obj) {
  return `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
}
function antTurn1() {
  return [
    antChunk({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } } }),
    antChunk({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    antChunk({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me compute that. " } }),
    antChunk({ type: "content_block_stop", index: 0 }),
    antChunk({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "python", input: {} } }),
    antChunk({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"code": "print(1 + 1)"}' } }),
    antChunk({ type: "content_block_stop", index: 1 }),
    antChunk({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } }),
    antChunk({ type: "message_stop" }),
  ];
}
function antTurn2(toolText) {
  return [
    antChunk({ type: "message_start", message: { id: "msg_2", usage: { input_tokens: 25, output_tokens: 0 } } }),
    antChunk({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    antChunk({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: markdownAnswer(toolText) } }),
    antChunk({ type: "content_block_stop", index: 0 }),
    antChunk({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }),
    antChunk({ type: "message_stop" }),
  ];
}

function markdownAnswer(toolText) {
  const result = (toolText || "(empty)").trim();
  return `## Result\n\n**Python returned:** \`${result}\`\n\n| tool | status |\n| --- | --- |\n| python | success |\n`;
}

/* -------------------------------- server ------------------------------- */
const server = createServer((req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  const isAnthropic = req.url.endsWith("/v1/messages");
  const isOpenAI = req.url.endsWith("/chat/completions");
  const isResponses = req.url.endsWith("/responses");
  if (req.method !== "POST" || (!isAnthropic && !isOpenAI && !isResponses)) {
    res.writeHead(404);
    return res.end("not found");
  }

  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let parsed = {};
    try {
      parsed = JSON.parse(body || "{}");
    } catch {}
    if (isResponses) {
      const sawToolResult =
        Array.isArray(parsed.input) &&
        parsed.input.some((item) => item?.type === "function_call_output");
      log("responses request: model=%s toolResult=%s", parsed.model, sawToolResult);
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      for (const line of responsesStream(parsed.model, sawToolResult)) res.write(line);
      return res.end();
    }
    const messages = parsed.messages || [];
    const last = messages[messages.length - 1];
    const wantsReasoning = JSON.stringify(messages).includes("reasoning-test");

    // Detect the tool result coming back. OpenAI: last role "tool".
    // Anthropic: last message role "user" whose content is an array containing
    // a tool_result block.
    let sawToolResult = false;
    let toolText = "";
    if (isOpenAI) {
      sawToolResult = last && last.role === "tool";
      toolText = (last && last.content) || "";
    } else {
      const isToolResultMsg = (m) =>
        m && m.role === "user" && Array.isArray(m.content) && m.content.some((c) => c && c.type === "tool_result");
      sawToolResult = isToolResultMsg(last);
      if (sawToolResult) {
        const tr = last.content.find((c) => c && c.type === "tool_result");
        toolText = (tr && tr.content) || "";
      }
    }

    log("%s request: messages=%d tools=%d toolResult=%s", isAnthropic ? "anthropic" : "openai", messages.length, (parsed.tools || []).length, sawToolResult);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    const lines = isOpenAI ? (sawToolResult ? oaiTurn2(toolText) : oaiTurn1(wantsReasoning)) : sawToolResult ? antTurn2(toolText) : antTurn1();
    for (const l of lines) res.write(l);
    res.end();
  });
});

server.listen(PORT, "127.0.0.1", () => log(`listening on http://127.0.0.1:${PORT}  (openai: /v1/chat/completions, anthropic: /v1/messages)`));
