import assert from "node:assert/strict";
import test from "node:test";

import {
  formatSubmittedPrompt,
  PromptLine,
  type TermWriter,
} from "../src/termui.ts";

const ANSI = /\x1b\[[0-9;]*m/g;

function captureWriter(columns = 24) {
  const writes: string[] = [];
  const lines: string[] = [];
  const writer: TermWriter = {
    cols: columns,
    rows: 20,
    write(value) {
      writes.push(value);
    },
    writeln(value) {
      lines.push(value);
    },
    ensureNewline() {},
    replaceCurrentLine() {},
    clearPreviousLines() {},
    setCursorVisible() {},
  };
  return { writer, writes, lines };
}

test("submitted prompts use the app palette and wrap inside one background block", () => {
  const lines = formatSubmittedPrompt("abcdefghijklmnopqrst", 24);

  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.includes("\x1b[48;2;36;40;59m")));
  assert.equal(lines[0].replace(ANSI, ""), "    abcdefghijklmnop  ");
  assert.equal(lines[1].replace(ANSI, ""), "    qrst              ");

  const prose = formatSubmittedPrompt("model setup works", 20)
    .map((line) => line.replace(ANSI, "").trim());
  assert.deepEqual(prose, ["model setup", "works"]);
});

test("the main prompt highlights conversation but leaves slash commands plain", () => {
  const submitted: string[] = [];
  const conversation = captureWriter();
  const prompt = new PromptLine({
    writer: conversation.writer,
    onSubmit: (value) => submitted.push(value),
    onAbort() {},
    highlightSubmitted: (value) => !value.startsWith("/"),
  });

  prompt.start();
  prompt.feed("explain this\r");

  assert.deepEqual(submitted, ["explain this"]);
  assert.equal(conversation.lines.length, 3);
  assert.deepEqual([conversation.lines[0], conversation.lines[2]], ["", ""]);
  assert.match(conversation.lines[1], /\x1b\[48;2;36;40;59m/);
  assert.equal(conversation.lines[1].replace(ANSI, "").trim(), "explain this");

  const command = captureWriter();
  const commandPrompt = new PromptLine({
    writer: command.writer,
    onSubmit() {},
    onAbort() {},
    highlightSubmitted: (value) => !value.startsWith("/"),
  });
  commandPrompt.start();
  commandPrompt.feed("/status\r");

  assert.deepEqual(command.lines, [""]);
  assert.doesNotMatch(command.writes.join(""), /\x1b\[48;2;36;40;59m/);
});

test("app-generated prompts can be shown as normal user turns", () => {
  const transcript = captureWriter(40);
  const prompt = new PromptLine({
    writer: transcript.writer,
    onSubmit() {},
    onAbort() {},
  });

  prompt.showSubmittedPrompt("Build something spectacular");

  assert.equal(transcript.lines.length, 3);
  assert.deepEqual([transcript.lines[0], transcript.lines[2]], ["", ""]);
  assert.match(transcript.lines[1], /\x1b\[48;2;36;40;59m/);
  assert.equal(
    transcript.lines[1].replace(ANSI, "").trim(),
    "Build something spectacular",
  );
});
