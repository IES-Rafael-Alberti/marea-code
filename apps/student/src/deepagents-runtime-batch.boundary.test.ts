import { describe, expect, it } from "vitest";

import type { AgentEvent } from "./contracts.js";
import {
  approvalRequired,
  collect,
  effect,
  harness,
  message,
  runId,
  snapshot,
} from "./deepagents-runtime.fixture.js";

const batchApproval = approvalRequired({
  reviewId: "review-9",
  toolName: "marea_execute",
  arguments: { command: "dir" },
  description: "Run dir",
  actions: [
    { index: 0, toolName: "marea_execute", arguments: { command: "dir" }, description: "Run dir" },
    {
      index: 1,
      toolName: "marea_write_file",
      arguments: { path: "notes.txt", content: "content" },
      description: "Create notes.",
    },
  ],
});

function resumeBatch(instance: ReturnType<typeof harness>) {
  const resume = instance.runtime.resumeBatch?.bind(instance.runtime);
  if (resume === undefined) throw new Error("The bridge resumes batches.");
  return resume;
}

describe("DeepAgents bridge for a batch of approvals", () => {
  it("translates a multi-action interrupt into one batch request", async () => {
    const instance = harness(true);
    instance.deep.messages = [batchApproval];
    const events = await collect(
      instance.runtime.streamMessage(message(), new AbortController().signal),
    );
    expect(events).toMatchObject([
      {
        type: "approval-batch-required",
        reviewId: "review-9",
        actions: [
          { kind: "operation", request: { approvalId: "review-9:batch-0", tool: "execute" } },
          { kind: "write", approvalId: "review-9:batch-1", path: "notes.txt" },
        ],
      },
    ]);
  });

  it("resumes every action at once, authorizing what was already done", async () => {
    const instance = harness(true);
    instance.deep.messages = [batchApproval];
    const [batch] = (await collect(
      instance.runtime.streamMessage(message(), new AbortController().signal),
    )) as [Extract<AgentEvent, { readonly type: "approval-batch-required" }>];
    const resumed = await collect(
      resumeBatch(instance)(
        {
          runId,
          snapshot: snapshot(),
          messageId: message().messageId,
          reviewId: "review-9",
          actions: batch.actions,
          decisions: [
            { kind: "operation", decision: "rejected", reason: "No.", result: null },
            { kind: "write", decision: "approved", effect },
          ],
        },
        new AbortController().signal,
      ),
    );
    expect(instance.deep.resumes.at(-1)).toMatchObject({
      reviewId: "review-9",
      toolName: "marea_execute",
      decision: { type: "reject", reason: "No." },
      decisions: [{ type: "reject", reason: "No." }, { type: "approve" }],
    });
    // The write tool replays the effect applied before resuming.
    expect(instance.deep.toolResult).toBeNull();
    expect(resumed.at(-1)).toEqual({ type: "turn-completed" });
  });

  it("clears every authorization even when the resume fails", async () => {
    const instance = harness(true);
    instance.deep.messages = [batchApproval];
    const [batch] = (await collect(
      instance.runtime.streamMessage(message(), new AbortController().signal),
    )) as [Extract<AgentEvent, { readonly type: "approval-batch-required" }>];
    instance.deep.failResume = true;
    await expect(
      collect(
        resumeBatch(instance)(
          {
            runId,
            snapshot: snapshot(),
            messageId: message().messageId,
            reviewId: "review-9",
            actions: batch.actions,
            decisions: [
              { kind: "operation", decision: "approved", result: "listing" },
              { kind: "write", decision: "approved", effect },
            ],
          },
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow("resume failed");
    await expect(
      instance.options[0]?.approvalTool.execute({ path: "notes.txt", content: "content" }),
    ).rejects.toThrow("not approved");
  });
});
