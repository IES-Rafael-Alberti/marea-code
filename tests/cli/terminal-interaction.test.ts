import type {
  ConversationApprovalDecision,
  ConversationController,
  ConversationSnapshot,
} from "../../packages/student-tui/src/conversation-contracts.js";
import { createConversationController } from "../../packages/student-tui/src/conversation-controller.js";
import { describe, expect, it } from "vitest";

function viewHarness() {
  const snapshots: ConversationSnapshot[] = [];
  const view = {
    dispose: () => {
      return;
    },
    render: (snapshot: ConversationSnapshot) => snapshots.push(snapshot),
  };
  return { snapshots, view };
}

describe("TUI acceptance paths", () => {
  it("runs the visible edit path through approval, assistant output, and completion", async () => {
    const observed = viewHarness();
    let approval = Promise.resolve<ConversationApprovalDecision>("rejected");
    const holder: { controller?: ConversationController } = {};
    const controller = createConversationController({
      onExit: () => {
        return;
      },
      onMessage: async () => {
        const active = holder.controller;
        if (active === undefined) throw new Error("TUI controller was not initialized.");
        approval = active.requestApproval({ path: "notes/tide.txt", summary: "Create notes" });
        if ((await approval) === "approved") {
          active.appendAssistantText("Saved.");
          active.complete();
        }
      },
      view: observed.view,
    });
    holder.controller = controller;

    expect(controller.handle({ text: "Prepare the notes", type: "submit" })).toBe(true);
    await Promise.resolve();
    expect(controller.snapshot()).toMatchObject({
      approval: { path: "notes/tide.txt", summary: "Create notes" },
      status: "approval",
    });
    expect(controller.handle({ type: "approve" })).toBe(true);
    await approval;
    await Promise.resolve();

    expect(controller.snapshot()).toMatchObject({
      messages: [
        { author: "student", text: "Prepare the notes" },
        { author: "marea", text: "Saved." },
      ],
      status: "ready",
    });
    expect(observed.snapshots.some((snapshot) => snapshot.status === "approval")).toBe(true);
  });

  it("resolves a displayed approval as rejected when the turn is cancelled", async () => {
    const observed = viewHarness();
    const holder: { controller?: ConversationController } = {};
    let decision: ConversationApprovalDecision | undefined;
    const approvalReady = Promise.withResolvers<boolean>();
    const controller = createConversationController({
      onExit: () => {
        return;
      },
      onMessage: async () => {
        const active = holder.controller;
        if (active === undefined) throw new Error("TUI controller was not initialized.");
        decision = await active.requestApproval({ path: "notes.txt", summary: "Write notes" });
        approvalReady.resolve(true);
      },
      view: observed.view,
    });
    holder.controller = controller;

    expect(controller.handle({ text: "Write notes", type: "submit" })).toBe(true);
    await Promise.resolve();
    expect(controller.snapshot().status).toBe("approval");
    expect(controller.cancel()).toBe(true);
    await approvalReady.promise;

    expect(decision).toBe("rejected");
    expect(controller.snapshot()).toMatchObject({ approval: null, status: "cancelled" });
    expect(observed.snapshots.at(-1)?.messages).toEqual([
      { author: "student", text: "Write notes" },
    ]);
  });

  it("accepts a distinct next message only after cancellation has settled", async () => {
    const observed = viewHarness();
    const first = Promise.withResolvers<undefined>();
    const controller = createConversationController({
      onExit: () => {
        return;
      },
      onMessage: () => first.promise,
      view: observed.view,
    });
    expect(controller.handle({ text: "Stop me", type: "submit" })).toBe(true);
    expect(controller.cancel()).toBe(true);
    expect(controller.handle({ text: "Too soon", type: "submit" })).toBe(false);
    first.resolve(undefined);
    await Promise.resolve();
    expect(controller.handle({ text: "Continue", type: "submit" })).toBe(true);
    expect(controller.snapshot().messages).toEqual([
      { author: "student", text: "Stop me" },
      { author: "student", text: "Continue" },
    ]);
  });
});
