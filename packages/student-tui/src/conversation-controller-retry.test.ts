import { describe, expect, it, vi } from "vitest";

import {
  TurnFailureSignal,
  type ConversationController,
  type ConversationSnapshot,
} from "./conversation-contracts.js";
import { temporaryTurnFailure } from "./conversation-controller.test-support.js";
import { createConversationController } from "./conversation-controller.js";

type Attempt = "fail" | "fatal" | "ok" | "hold";

function target(attempts: Attempt[], automaticRetries?: number) {
  const snapshots: ConversationSnapshot[] = [];
  const calls: { messageId: string; attemptId: string; signal: AbortSignal }[] = [];
  const held = Promise.withResolvers<undefined>();
  const onMessage = vi.fn(
    (_text: string, signal: AbortSignal, messageId: string, attemptId: string) => {
      calls.push({ messageId, attemptId, signal });
      const next = attempts.shift() ?? "ok";
      if (next === "fail") return Promise.reject(temporaryTurnFailure());
      if (next === "fatal")
        return Promise.reject(
          new TurnFailureSignal({
            detail: "",
            hasPrefix: false,
            kind: "unexpected",
            recoverable: true,
            retryable: false,
          }),
        );
      if (next === "hold") return held.promise;
      return Promise.resolve();
    },
  );
  const controller: ConversationController = createConversationController({
    ...(automaticRetries === undefined ? {} : { automaticRetries }),
    onExit: vi.fn(),
    onMessage,
    view: { dispose: vi.fn(), render: (snapshot) => snapshots.push(snapshot) },
  });
  return { controller, snapshots, calls, held, onMessage };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe("automatic retry of a recoverable turn failure", () => {
  it("retries the same message silently and never shows the failure when a retry succeeds", async () => {
    const subject = target(["fail", "ok"]);
    expect(subject.controller.handle({ type: "submit", text: "Explain loops" })).toBe(true);
    await settle();
    expect(subject.calls).toHaveLength(2);
    expect(subject.calls[1]?.messageId).toBe(subject.calls[0]?.messageId);
    expect(subject.calls[1]?.attemptId).not.toBe(subject.calls[0]?.attemptId);
    expect(subject.snapshots.some((snapshot) => snapshot.status === "failed")).toBe(false);
    expect(subject.snapshots.at(-1)).toMatchObject({ status: "streaming", automaticRetry: 1 });
    expect(
      subject.snapshots.filter((snapshot) => snapshot.messages.some((m) => m.author === "student")),
    ).not.toHaveLength(0);
    expect(
      subject.snapshots.at(-1)?.messages.filter((message) => message.author === "student"),
    ).toHaveLength(1);
  });

  it("shows the failure, offering /retry, after the first attempt and two retries fail", async () => {
    const subject = target(["fail", "fail", "fail", "ok"]);
    subject.controller.handle({ type: "submit", text: "Explain loops" });
    await settle();
    expect(subject.calls).toHaveLength(3);
    expect(subject.snapshots.map((snapshot) => snapshot.automaticRetry ?? 0)).toContain(2);
    expect(subject.snapshots.at(-1)).toMatchObject({
      status: "failed",
      failure: { retryable: true },
    });
    expect(subject.snapshots.at(-1)?.automaticRetry).toBeUndefined();
    // The student's own /retry starts a fresh allowance of automatic retries.
    expect(subject.controller.handle({ type: "retry" })).toBe(true);
    await settle();
    expect(subject.calls).toHaveLength(4);
    expect(subject.snapshots.at(-1)).toMatchObject({ status: "streaming" });
    expect(subject.snapshots.at(-1)?.automaticRetry).toBeUndefined();
  });

  it("counts retries per message, so a new message gets its own allowance", async () => {
    const subject = target(["fail", "fail", "fail", "fail", "ok"]);
    subject.controller.handle({ type: "submit", text: "First" });
    await settle();
    expect(subject.snapshots.at(-1)?.status).toBe("failed");
    subject.controller.handle({ type: "submit", text: "Second" });
    await settle();
    expect(subject.calls).toHaveLength(5);
    expect(subject.calls[3]?.messageId).toBe(subject.calls[4]?.messageId);
    expect(subject.calls[3]?.messageId).not.toBe(subject.calls[0]?.messageId);
  });

  it("does not retry a failure that is not retryable", async () => {
    const subject = target(["fatal"]);
    subject.controller.handle({ type: "submit", text: "Explain loops" });
    await settle();
    expect(subject.calls).toHaveLength(1);
    expect(subject.snapshots.at(-1)).toMatchObject({ status: "failed" });
  });

  it("does not retry after the student cancels or exits", async () => {
    const cancelled = target(["hold"]);
    cancelled.controller.handle({ type: "submit", text: "Explain loops" });
    expect(cancelled.controller.handle({ type: "cancel" })).toBe(true);
    cancelled.held.reject(temporaryTurnFailure());
    await settle();
    expect(cancelled.calls).toHaveLength(1);
    expect(cancelled.snapshots.at(-1)?.status).toBe("cancelled");
    const exiting = target(["hold"]);
    exiting.controller.handle({ type: "submit", text: "Explain loops" });
    expect(exiting.controller.handle({ type: "exit" })).toBe(true);
    exiting.held.reject(temporaryTurnFailure());
    await settle();
    expect(exiting.calls).toHaveLength(1);
  });

  it("does not retry behind a pending approval; the approval fails with the turn", async () => {
    const subject = target(["hold", "ok"]);
    subject.controller.handle({ type: "submit", text: "Explain loops" });
    const decision = subject.controller.requestApproval({ path: "src/a.ts", summary: "Change" });
    subject.held.reject(temporaryTurnFailure());
    await settle();
    expect(subject.calls).toHaveLength(1);
    await expect(decision).resolves.toBe("rejected");
    expect(subject.snapshots.at(-1)).toMatchObject({ status: "failed", approval: null });
  });

  it("respects a configured number of retries", async () => {
    const none = target(["fail", "ok"], 0);
    none.controller.handle({ type: "submit", text: "Explain loops" });
    await settle();
    expect(none.calls).toHaveLength(1);
    expect(none.snapshots.at(-1)?.status).toBe("failed");
    const one = target(["fail", "fail", "ok"], 1);
    one.controller.handle({ type: "submit", text: "Explain loops" });
    await settle();
    expect(one.calls).toHaveLength(2);
    expect(one.snapshots.at(-1)?.status).toBe("failed");
  });
});
