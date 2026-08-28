import assert from "node:assert/strict";
import test from "node:test";

import { ThinkingOverlay } from "../src/thinking-overlay.ts";

test("thinking is visible only on the transient overlay and clears completely", () => {
  const root = { hidden: true };
  const content = {
    textContent: "" as string | null,
    scrollTop: 0,
    get scrollHeight() {
      return this.textContent?.length ?? 0;
    },
  };
  const overlay = new ThinkingOverlay(root, content, 13);

  overlay.append("inspect ");
  overlay.append("the workspace");
  assert.equal(root.hidden, false);
  assert.equal(content.textContent, "the workspace");
  assert.equal(content.scrollTop, 13);

  overlay.clear();
  assert.equal(root.hidden, true);
  assert.equal(content.textContent, "");
  assert.equal(content.scrollTop, 0);
});
