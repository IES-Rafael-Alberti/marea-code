import { expect, it } from "vitest";

import { createConversationControllerTarget } from "./conversation-controller.test-support.js";

it("resolves approve all as an approval of the rest of the batch", async () => {
  const target = createConversationControllerTarget();
  target.controller.handle({ type: "submit", text: "Run both" });
  const decision = target.controller.requestApproval({
    approvalId: "review:batch-0",
    path: "",
    summary: "dir",
    batch: { position: 1, total: 2, remaining: ["execute cd"] },
  });
  expect(target.snapshots.at(-1)?.approval?.batch).toEqual({
    position: 1,
    total: 2,
    remaining: ["execute cd"],
  });
  expect(target.controller.handle({ type: "approve-all", interruptId: "other" })).toBe(false);
  expect(target.controller.handle({ type: "approve-all", interruptId: "review:batch-0" })).toBe(
    true,
  );
  await expect(decision).resolves.toEqual({ decision: "approved", remaining: true });
});
