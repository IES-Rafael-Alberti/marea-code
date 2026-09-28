import { describe, expect, it } from "vitest";

import {
  approval,
  approvalRequired,
  collect,
  effect,
  harness,
  message,
} from "./deepagents-runtime.fixture.js";

describe("DeepAgents bridge replay integrity", () => {
  it("rearms only the persisted write while an approved graph is still in progress", async () => {
    const { deep, runtime } = harness();
    deep.startedMessageId = "message:1";
    deep.forcedRecovery = { type: "in-progress", assistantText: "Saved", events: [] };
    deep.toolArguments = { path: "recovered.txt", content: "Recovered content" };
    await expect(
      collect(
        runtime.resumeApproval(
          {
            ...approval("approved", effect),
            assistantText: "Saved",
            path: "recovered.txt",
            content: "Recovered content",
          },
          new AbortController().signal,
        ),
      ),
    ).resolves.toEqual([{ type: "turn-completed" }]);
    expect(deep.toolResult).toBe(JSON.stringify(effect));
    expect(deep.resumes[0]).toMatchObject({
      assistantText: "Saved",
      messageId: "message:1",
      reviewId: "approval:1",
      decision: { type: "approve" },
    });
    await expect(deep.executeTool?.execute(deep.toolArguments)).rejects.toThrow(
      "DeepAgents attempted a workspace write that was not approved.",
    );
  });

  it("finds the approval after replay text and rejects a missing recovered review", async () => {
    const { deep, runtime } = harness();
    await collect(runtime.streamMessage(message(), new AbortController().signal));
    deep.forcedRecovery = {
      type: "pending-approval",
      assistantText: "Thinking more",
      events: [{ type: "assistant-text-delta", text: " more" }, approvalRequired()],
    };
    await expect(
      collect(runtime.resumeApproval(approval("approved", effect), new AbortController().signal)),
    ).resolves.toEqual([{ type: "turn-completed" }]);
    deep.forcedRecovery = { type: "pending-approval", assistantText: "Thinking", events: [] };
    await expect(
      collect(runtime.resumeApproval(approval("approved", effect), new AbortController().signal)),
    ).rejects.toThrow("The DeepAgents approval is not pending for this message.");
  });

  it("never authorizes tool execution for a rejected review", async () => {
    const { deep, runtime } = harness();
    await collect(runtime.streamMessage(message(), new AbortController().signal));
    deep.executeRejected = true;
    await expect(
      collect(runtime.resumeApproval(approval("rejected", null), new AbortController().signal)),
    ).rejects.toThrow("DeepAgents attempted a workspace write that was not approved.");
  });

  it("replays an already completed approval without arming the tool again", async () => {
    const { deep, runtime } = harness();
    deep.startedMessageId = "message:1";
    deep.forcedRecovery = {
      type: "completed",
      assistantText: "",
      events: [{ type: "turn-completed" }],
    };
    const originalResume = deep.resumeApproval.bind(deep);
    deep.resumeApproval = async function* (turn, signal) {
      expect(this.executeTool).not.toBeNull();
      await expect(
        this.executeTool?.execute({ content: "content", path: "notes.txt" }),
      ).rejects.toThrow("DeepAgents attempted a workspace write that was not approved.");
      this.executeTool = null;
      yield* originalResume(turn, signal);
    };
    await expect(
      collect(runtime.resumeApproval(approval("approved", effect), new AbortController().signal)),
    ).resolves.toEqual([{ type: "turn-completed" }]);
    expect(deep.recoveries[0]?.assistantText).toBe("");
    expect(deep.resumes[0]?.reviewId).toBe("approval:1");
  });

  it("retains an explicit prefix across terminal events and later retries", async () => {
    const { deep, runtime } = harness();
    deep.messages = [{ type: "turn-completed" }];
    await collect(
      runtime.streamMessage(
        { ...message(), assistantText: "Saved prefix" },
        new AbortController().signal,
      ),
    );
    await collect(runtime.streamMessage(message(), new AbortController().signal));
    expect(deep.messageTurns.map((turn) => turn.assistantText)).toEqual([
      "Saved prefix",
      "Saved prefix",
    ]);
  });

  it("persists an approval resume prefix even when the resumed graph emits no text", async () => {
    const { deep, runtime } = harness();
    await collect(runtime.streamMessage(message(), new AbortController().signal));
    deep.forcedRecovery = {
      type: "pending-approval",
      assistantText: "Thinking suffix",
      events: [approvalRequired()],
    };
    await collect(
      runtime.resumeApproval(
        { ...approval("approved", effect), assistantText: "Thinking suffix" },
        new AbortController().signal,
      ),
    );
    deep.forcedRecovery = undefined;
    deep.messages = [{ type: "turn-completed" }];
    await collect(runtime.streamMessage(message(), new AbortController().signal));
    expect(deep.messageTurns.at(-1)?.assistantText).toBe("Thinking suffix");
  });
});
