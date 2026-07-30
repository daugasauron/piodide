import assert from "node:assert/strict";
import test from "node:test";
import {
  MOBILE_COMMANDS,
  MOBILE_COMMAND_MAX_WIDTH,
  shouldUseMobileCommands,
} from "../src/mobile-command-ui.ts";

test("mobile command drawer exposes only provider, login, and model", () => {
  assert.deepEqual(
    MOBILE_COMMANDS.map(({ command }) => command),
    ["/provider", "/login", "/model"],
  );
});

test("mobile command drawer requires a coarse pointer and phone-sized viewport", () => {
  assert.equal(shouldUseMobileCommands(390, true), true);
  assert.equal(shouldUseMobileCommands(MOBILE_COMMAND_MAX_WIDTH, true), true);
  assert.equal(shouldUseMobileCommands(MOBILE_COMMAND_MAX_WIDTH + 1, true), false);
  assert.equal(shouldUseMobileCommands(390, false), false);
});
