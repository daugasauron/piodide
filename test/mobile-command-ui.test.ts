import assert from "node:assert/strict";
import test from "node:test";
import {
  MOBILE_COMMANDS,
  MOBILE_COMMAND_MAX_WIDTH,
  readMobileClipboard,
  shouldUseMobileCommands,
} from "../src/mobile-command-ui.ts";

test("mobile command drawer exposes setup, thinking, and demo commands", () => {
  assert.deepEqual(
    MOBILE_COMMANDS.map(({ command }) => command),
    ["/provider", "/login", "/model", "/thinking", "/demo"],
  );
});

test("mobile command drawer requires a coarse pointer and phone-sized viewport", () => {
  assert.equal(shouldUseMobileCommands(390, true), true);
  assert.equal(shouldUseMobileCommands(MOBILE_COMMAND_MAX_WIDTH, true), true);
  assert.equal(shouldUseMobileCommands(MOBILE_COMMAND_MAX_WIDTH + 1, true), false);
  assert.equal(shouldUseMobileCommands(390, false), false);
});

test("mobile token paste reads plain text with both clipboard APIs", async () => {
  assert.equal(await readMobileClipboard({ readText: async () => "token.from-readText" }), "token.from-readText");
  assert.equal(
    await readMobileClipboard({
      readText: async () => {
        throw new Error("readText blocked");
      },
      read: async () => [
        {
          types: ["text/plain"],
          getType: async () => new Blob(["token.from-read"]),
        },
      ],
    }),
    "token.from-read",
  );
});

test("mobile token paste reports unavailable or empty clipboards", async () => {
  await assert.rejects(readMobileClipboard(undefined), /unavailable/);
  await assert.rejects(readMobileClipboard({ readText: async () => "" }), /does not contain text/);
});
