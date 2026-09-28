import { expect, it } from "vitest";
import { createConversationControllerTarget as setup } from "./conversation-controller.test-support.js";

const request = { interruptId: "q1", questions: [{ text: "Why?", choices: [], required: true }] };
it("answers the same interrupt without approving a write or accepting a duplicate", async () => {
  const { controller } = setup();
  await expect(controller.requestQuestions(request)).rejects.toThrow();
  controller.handle({ type: "submit", text: "Hello" });
  const reply = controller.requestQuestions(request, "message:1", "attempt:1");
  expect(controller.snapshot()).toMatchObject({ questions: request, status: "questions" });
  await expect(controller.requestQuestions(request)).rejects.toThrow(
    "The conversation cannot request questions now.",
  );
  await expect(controller.requestApproval({ path: "x", summary: "Write" })).rejects.toThrow();
  expect(controller.handle({ type: "approve" })).toBe(false);
  expect(controller.handle({ type: "answers", interruptId: "old", values: ["Yes"] })).toBe(false);
  expect(controller.handle({ type: "answers", interruptId: "q1", values: ["Yes"] })).toBe(true);
  await expect(reply).resolves.toEqual({ type: "answers", values: ["Yes"] });
  expect(controller.snapshot().questions).toBeUndefined();
  expect(controller.snapshot().status).toBe("streaming");
  expect(controller.handle({ type: "answers", interruptId: "q1", values: ["Again"] })).toBe(false);
  controller.dispose();
});

it.each(["cancel", "complete", "fail", "dispose"] as const)(
  "%s resolves pending questions as cancelled",
  async (operation) => {
    const { controller } = setup();
    controller.handle({ type: "submit", text: "Hello" });
    const pending = controller.requestQuestions(request);
    controller[operation]();
    await expect(pending).resolves.toEqual({ type: "cancel" });
    expect(controller.snapshot().questions).toBeUndefined();
    expect(controller.handle({ type: "answers", interruptId: "q1", values: ["Late"] })).toBe(false);
    controller.dispose();
  },
);

it("rejects questions during a write approval or for another attempt", async () => {
  const { controller } = setup();
  controller.handle({ type: "submit", text: "Hello" });
  await expect(controller.requestQuestions(request, "foreign")).rejects.toThrow();
  await expect(controller.requestQuestions(request, "message:1", "foreign")).rejects.toThrow();
  const approval = controller.requestApproval({ path: "x", summary: "Write" });
  await expect(controller.requestQuestions(request)).rejects.toThrow();
  controller.dispose();
  await expect(approval).resolves.toBe("rejected");
});

it("binds rejection reasons to the pending approval identity and bounds the durable reason", async () => {
  const { controller } = setup();
  controller.handle({ type: "submit", text: "Write" });
  const pending = controller.requestApproval({ approvalId: "a1", path: "x", summary: "Write" });
  expect(controller.handle({ type: "reject", interruptId: "stale", reason: "Wrong" })).toBe(false);
  expect(controller.handle({ type: "reject", interruptId: "a1", reason: "x".repeat(2050) })).toBe(
    true,
  );
  await expect(pending).resolves.toEqual({ decision: "rejected", reason: "x".repeat(2048) });
  controller.dispose();
});

it("preserves the legacy decision action and refuses an identified action after resolution", async () => {
  const { controller } = setup();
  controller.handle({ type: "submit", text: "Write" });
  const pending = controller.requestApproval({ approvalId: "a1", path: "x", summary: "Write" });
  expect(controller.handle({ type: "approve" })).toBe(true);
  await expect(pending).resolves.toBe("approved");
  expect(controller.handle({ type: "approve", interruptId: "a1" })).toBe(false);
  controller.dispose();
});
