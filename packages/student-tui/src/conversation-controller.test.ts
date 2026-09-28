import { temporaryTurnFailure } from "./conversation-controller.test-support.js";
import { describe, expect, it, vi } from "vitest";

import {
  createConversationControllerTarget,
  deferredConversationTurns,
  submitAfterFirstTurnSettles,
} from "./conversation-controller.test-support.js";

const setup = createConversationControllerTarget;

describe("conversation controller", () => {
  it("submits one bounded message, streams an answer, and completes", async () => {
    const onMessage = vi.fn(() => Promise.resolve());
    const target = setup(onMessage);

    expect(target.snapshots[0]).toEqual({ approval: null, messages: [], status: "ready" });
    expect(target.controller.handle({ type: "submit", text: "" })).toBe(false);
    expect(target.controller.handle({ type: "submit", text: "x".repeat(8_193) })).toBe(false);
    const exactLimit = setup();
    expect(exactLimit.controller.handle({ type: "submit", text: "x".repeat(8_192) })).toBe(true);
    exactLimit.controller.cancel();
    expect(target.controller.handle({ type: "submit", text: "  Hello Marea  " })).toBe(true);
    expect(target.controller.snapshot().status).toBe("streaming");
    expect(target.controller.handle({ type: "submit", text: "second" })).toBe(false);
    expect(onMessage).toHaveBeenCalledWith(
      "Hello Marea",
      expect.any(AbortSignal),
      expect.any(String),
      expect.any(String),
    );
    expect(target.controller.appendAssistantText("")).toBe(false);
    expect(target.controller.appendAssistantText("Hel")).toBe(true);
    expect(target.controller.appendAssistantText("lo")).toBe(true);
    expect(target.controller.complete()).toBe(true);
    expect(target.controller.complete()).toBe(false);
    expect(target.controller.snapshot()).toEqual({
      approval: null,
      messages: [
        { author: "student", text: "Hello Marea" },
        { author: "marea", text: "Hello" },
      ],
      status: "ready",
    });
    expect(Object.isFrozen(target.controller.snapshot())).toBe(true);
    expect(Object.isFrozen(target.controller.snapshot().messages)).toBe(true);
    expect(target.snapshots.at(-1)).toEqual(target.controller.snapshot());
    await expect(
      target.controller.requestApproval({ path: "src/late.ts", summary: "Late" }),
    ).rejects.toThrow("The conversation cannot request an approval now.");
  });

  it("keeps assistant messages separate across consecutive turns", async () => {
    const target = setup();

    target.controller.handle({ type: "submit", text: "First" });
    target.controller.appendAssistantText("One");
    target.controller.complete();
    await Promise.resolve();
    target.controller.handle({ type: "submit", text: "Second" });
    target.controller.appendAssistantText("T");
    target.controller.appendAssistantText("wo");

    expect(target.controller.snapshot().messages).toEqual([
      { author: "student", text: "First" },
      { author: "marea", text: "One" },
      { author: "student", text: "Second" },
      { author: "marea", text: "Two" },
    ]);
  });

  it("assigns incrementing identities to new messages", async () => {
    const onMessage = vi.fn((...args: [string, AbortSignal, string, string]) => {
      expect(args).toHaveLength(4);
      return Promise.resolve();
    });
    const target = setup(onMessage);

    target.controller.handle({ type: "submit", text: "First" });
    target.controller.complete();
    await Promise.resolve();
    target.controller.handle({ type: "submit", text: "Second" });

    expect(onMessage.mock.calls.map((call) => call[2])).toEqual(["message:1", "message:2"]);
    expect(onMessage.mock.calls.map((call) => call[3])).toEqual(["attempt:1", "attempt:2"]);
    target.controller.complete();
  });

  /* slash commands are covered by the screen and recovery suites */

  it("presents and resolves one approval while streaming", async () => {
    const target = setup();

    target.controller.handle({ type: "submit", text: "Change it" });
    const decision = target.controller.requestApproval({
      path: "src/example.ts",
      summary: "Update example",
    });

    expect(target.controller.snapshot()).toMatchObject({
      approval: { path: "src/example.ts", summary: "Update example" },
      status: "approval",
    });
    expect(target.controller.appendAssistantText("Waiting")).toBe(true);
    await expect(
      target.controller.requestApproval({ path: "src/other.ts", summary: "Other" }),
    ).rejects.toThrow("The conversation cannot request an approval now.");
    expect(target.controller.handle({ type: "approve" })).toBe(true);
    await expect(decision).resolves.toBe("approved");
    expect(target.controller.handle({ type: "reject" })).toBe(false);
    expect(target.controller.snapshot().status).toBe("streaming");
  });

  it("accepts approval events for the current message identity", async () => {
    let messageId = "";
    const target = setup((text, signal, currentMessageId) => {
      expect(text).toBe("Change it");
      expect(signal).toBeInstanceOf(AbortSignal);
      messageId = currentMessageId;
      return Promise.resolve();
    });

    target.controller.handle({ type: "submit", text: "Change it" });
    const decision = target.controller.requestApproval(
      { path: "src/a.ts", summary: "Change" },
      messageId,
    );
    expect(target.controller.handle({ type: "approve" })).toBe(true);
    await expect(decision).resolves.toBe("approved");
  });

  it.each([
    ["reject", "rejected", "streaming"],
    ["complete", "rejected", "ready"],
    ["fail", "rejected", "failed"],
  ] as const)("resolves an approval as %s through %s", async (action, expected, status) => {
    const target = setup();
    target.controller.handle({ type: "submit", text: "Change it" });
    const decision = target.controller.requestApproval({ path: "src/a.ts", summary: "Change" });

    if (action === "reject") target.controller.handle({ type: "reject" });
    else if (action === "complete") target.controller.complete();
    else target.controller.fail();

    await expect(decision).resolves.toBe(expected);
    expect(target.controller.snapshot().status).toBe(status);
  });

  it("cancels an active approval and rejects the local effect", async () => {
    let receivedSignal: AbortSignal | undefined;
    const target = setup((_text, signal) => {
      receivedSignal = signal;
      return Promise.resolve();
    });

    target.controller.handle({ type: "submit", text: "Change it" });
    const decision = target.controller.requestApproval({ path: "src/a.ts", summary: "Change" });
    expect(target.controller.handle({ type: "cancel" })).toBe(true);

    await expect(decision).resolves.toBe("rejected");
    expect(target.controller.handle({ type: "approve" })).toBe(false);
    await expect(
      target.controller.requestApproval({ path: "late.ts", summary: "Late" }),
    ).rejects.toThrow();
    expect(receivedSignal?.aborted).toBe(true);
    expect(target.controller.snapshot().status).toBe("cancelled");
    expect(target.controller.cancel()).toBe(false);
    expect(target.controller.complete()).toBe(false);
    expect(target.controller.fail()).toBe(false);
    expect(target.controller.appendAssistantText("late")).toBe(false);
    await expect(
      target.controller.requestApproval({ path: "late.ts", summary: "Late" }),
    ).rejects.toThrow();
  });

  it("waits for a cancelled stream to settle before accepting another message", async () => {
    const { first, messageIds, onMessage, second } = deferredConversationTurns();
    const target = setup(onMessage);

    expect(target.controller.handle({ type: "submit", text: "First" })).toBe(true);
    target.controller.appendAssistantText("Partial", messageIds[0]);
    expect(target.controller.handle({ type: "cancel" })).toBe(true);
    expect(target.controller.handle({ type: "submit", text: "Second" })).toBe(false);
    expect(target.controller.snapshot()).toEqual({
      approval: null,
      messages: [
        { author: "student", text: "First" },
        { author: "marea", text: "Partial" },
      ],
      status: "cancelled",
    });

    first.resolve(undefined);
    await Promise.resolve();
    expect(target.controller.handle({ type: "submit", text: "Second" })).toBe(true);
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(messageIds[0]).not.toBe(messageIds[1]);
    target.controller.complete(messageIds[1]);
    second.resolve(undefined);
  });

  it("waits for a completed stream to settle before accepting another message", async () => {
    const { first, identities, onMessage, second } = deferredConversationTurns();
    const target = setup(onMessage);

    target.controller.handle({ type: "submit", text: "First" });
    expect(target.controller.complete(identities[0]?.messageId, identities[0]?.attemptId)).toBe(
      true,
    );
    expect(target.controller.snapshot().status).toBe("ready");
    await submitAfterFirstTurnSettles(target.controller, () => {
      first.resolve(undefined);
    });
    expect(
      target.controller.appendAssistantText(
        "late",
        identities[0]?.messageId,
        identities[0]?.attemptId,
      ),
    ).toBe(false);
    target.controller.complete(identities[1]?.messageId, identities[1]?.attemptId);
    second.resolve(undefined);
  });

  it("ignores a rejection delivered after cancellation", async () => {
    const operation = Promise.withResolvers<undefined>();
    const target = setup(() => operation.promise);

    target.controller.handle({ type: "submit", text: "First" });
    expect(target.controller.handle({ type: "cancel" })).toBe(true);
    operation.reject(new Error("cancelled stream failure"));
    await Promise.resolve();

    expect(target.controller.snapshot().status).toBe("cancelled");
    expect(target.controller.handle({ type: "submit", text: "Second" })).toBe(true);
    target.controller.complete();
  });

  it("ignores settlement from a failed older turn after a new turn starts", async () => {
    const { first, onMessage, second } = deferredConversationTurns();
    const target = setup(onMessage);

    target.controller.handle({ type: "submit", text: "First" });
    expect(target.controller.fail()).toBe(true);
    await submitAfterFirstTurnSettles(target.controller, () => {
      first.resolve(undefined);
    });
    expect(target.controller.appendAssistantText("current")).toBe(true);
    target.controller.complete();
    second.resolve(undefined);
  });

  it("waits for an approval turn to settle after cancellation", async () => {
    const operation = Promise.withResolvers<undefined>();
    const target = setup(() => operation.promise);

    target.controller.handle({ type: "submit", text: "Change it" });
    const decision = target.controller.requestApproval({ path: "src/a.ts", summary: "Change" });
    expect(target.controller.handle({ type: "cancel" })).toBe(true);
    await expect(decision).resolves.toBe("rejected");
    expect(target.controller.handle({ type: "submit", text: "Not yet" })).toBe(false);

    operation.resolve(undefined);
    await Promise.resolve();
    expect(target.controller.handle({ type: "submit", text: "Now" })).toBe(true);
  });

  it("ignores late events from a settled older turn", async () => {
    const { first, messageIds, onMessage, second } = deferredConversationTurns();
    const target = setup(onMessage);

    target.controller.handle({ type: "submit", text: "First" });
    target.controller.handle({ type: "cancel" });
    first.resolve(undefined);
    await Promise.resolve();
    target.controller.handle({ type: "submit", text: "Second" });

    expect(target.controller.appendAssistantText("late", messageIds[0])).toBe(false);
    expect(target.controller.complete(messageIds[0])).toBe(false);
    expect(target.controller.fail(messageIds[0])).toBe(false);
    await expect(
      target.controller.requestApproval({ path: "late.ts", summary: "Late" }, messageIds[0]),
    ).rejects.toThrow("cannot request");
    expect(target.controller.appendAssistantText("current", messageIds[1])).toBe(true);
    expect(target.controller.snapshot().messages).toEqual([
      { author: "student", text: "First" },
      { author: "student", text: "Second" },
      { author: "marea", text: "current" },
    ]);
    target.controller.complete(messageIds[1]);
    second.resolve(undefined);
  });

  it("fails the current message when given its identity", () => {
    let messageId = "";
    const target = setup((text, signal, currentMessageId) => {
      expect(text).toBe("Try again");
      expect(signal).toBeInstanceOf(AbortSignal);
      messageId = currentMessageId;
      return Promise.resolve();
    });

    target.controller.handle({ type: "submit", text: "Try again" });
    expect(target.controller.fail(messageId)).toBe(true);
    expect(target.controller.snapshot().status).toBe("failed");
  });

  it("keeps a recoverable failure visible and accepts a new message", async () => {
    const rejected = Promise.reject(temporaryTurnFailure());
    const onMessage = vi.fn(() => rejected);
    const target = setup(onMessage);

    target.controller.handle({ type: "submit", text: "Try again" });
    await expect(rejected).rejects.toThrow("The conversation turn failed.");
    await Promise.resolve();
    expect(target.controller.snapshot()).toEqual({
      approval: null,
      failure: {
        detail: "temporary failure",
        hasPrefix: false,
        kind: "provider-interrupted",
        recoverable: true,
        retryable: true,
      },
      messages: [{ author: "student", text: "Try again" }],
      status: "failed",
    });
    expect(target.controller.handle({ type: "submit", text: "A different message" })).toBe(true);
    expect(target.controller.snapshot().messages).toEqual([
      { author: "student", text: "Try again" },
      { author: "student", text: "A different message" },
    ]);
    target.controller.complete();
  });

  it("recovers from a synchronous message handler failure", async () => {
    const target = setup(() => {
      throw temporaryTurnFailure();
    });

    expect(target.controller.handle({ type: "submit", text: "Try" })).toBe(true);
    await Promise.resolve();
    expect(target.controller.snapshot().status).toBe("failed");
  });

  it("retries a failed turn with its identity and assigns new messages new identities", async () => {
    const ids = ["message:one", "message:two"];
    const nextMessageId = vi.fn(() => ids.shift() ?? "message:unexpected");
    const firstFailure = Promise.reject(temporaryTurnFailure());
    const onMessage = vi.fn((...args: [string, AbortSignal, string, string]) => {
      expect(args[0]).toBeTypeOf("string");
      expect(args[1]).toBeInstanceOf(AbortSignal);
      expect(args[2]).toBeTypeOf("string");
      expect(args[3]).toBeTypeOf("string");
      return firstFailure;
    });
    const target = setup(onMessage, vi.fn(), nextMessageId);

    expect(target.controller.handle({ type: "retry" })).toBe(false);
    target.controller.handle({ type: "submit", text: "Retry me" });
    expect(target.controller.handle({ type: "retry" })).toBe(false);
    await expect(firstFailure).rejects.toThrow("The conversation turn failed.");
    await Promise.resolve();
    expect(target.controller.handle({ type: "retry" })).toBe(true);
    expect(onMessage.mock.calls[1]?.[2]).toBe(onMessage.mock.calls[0]?.[2]);
    expect(onMessage.mock.calls[1]?.[3]).not.toBe(onMessage.mock.calls[0]?.[3]);
    expect(target.controller.snapshot().messages).toEqual([
      { author: "student", text: "Retry me" },
    ]);
    target.controller.complete(onMessage.mock.calls[1]?.[2]);
    await Promise.resolve();

    expect(target.controller.handle({ type: "submit", text: "New message" })).toBe(true);
    expect(onMessage.mock.calls[2]?.[2]).not.toBe(onMessage.mock.calls[0]?.[2]);
    expect(nextMessageId).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls.map((call) => call[2])).toEqual([
      "message:one",
      "message:one",
      "message:two",
    ]);
    target.controller.complete(onMessage.mock.calls[2]?.[2]);
    target.controller.dispose();
    expect(target.controller.handle({ type: "retry" })).toBe(false);
  });

  it("waits for a failed attempt and rejects late events from its retry", async () => {
    const { first, identities, onMessage, second } = deferredConversationTurns();
    const target = setup(onMessage);

    target.controller.handle({ type: "submit", text: "Try again" });
    expect(target.controller.handle({ type: "retry" })).toBe(false);
    first.reject(temporaryTurnFailure());
    await Promise.resolve();

    expect(target.controller.handle({ type: "retry" })).toBe(true);
    expect(identities[1]?.messageId).toBe(identities[0]?.messageId);
    expect(identities[1]?.attemptId).not.toBe(identities[0]?.attemptId);
    expect(
      target.controller.appendAssistantText(
        "late",
        identities[0]?.messageId,
        identities[0]?.attemptId,
      ),
    ).toBe(false);
    expect(target.controller.complete(identities[0]?.messageId, identities[0]?.attemptId)).toBe(
      false,
    );
    expect(target.controller.fail(identities[0]?.messageId, identities[0]?.attemptId)).toBe(false);
    await expect(
      target.controller.requestApproval(
        { path: "late.ts", summary: "Late" },
        identities[0]?.messageId,
        identities[0]?.attemptId,
      ),
    ).rejects.toThrow("cannot request");
    expect(
      target.controller.appendAssistantText(
        "current",
        identities[1]?.messageId,
        identities[1]?.attemptId,
      ),
    ).toBe(true);
    target.controller.complete(identities[1]?.messageId, identities[1]?.attemptId);
    second.resolve(undefined);
  });

  it("does not retry a failed turn after disposal", async () => {
    const failure = Promise.reject(temporaryTurnFailure());
    const target = setup(() => failure);

    target.controller.handle({ type: "submit", text: "Try again" });
    await Promise.resolve();
    expect(target.controller.snapshot().status).toBe("failed");
    expect(target.controller.dispose()).toBe(true);
    expect(target.controller.handle({ type: "retry" })).toBe(false);
  });

  it("requests exit once and cancels the active turn", async () => {
    let receivedSignal: AbortSignal | undefined;
    const target = setup((_text, signal) => {
      receivedSignal = signal;
      return Promise.resolve();
    });

    target.controller.handle({ type: "submit", text: "Active" });
    const decision = target.controller.requestApproval({ path: "src/a.ts", summary: "Change" });

    expect(target.controller.handle({ type: "exit" })).toBe(true);
    expect(target.controller.handle({ type: "exit" })).toBe(false);
    await expect(decision).resolves.toBe("rejected");
    expect(receivedSignal?.aborted).toBe(true);
    expect(target.onExit).toHaveBeenCalledOnce();
  });

  it("marks an active turn failed and ignores a late rejected callback", async () => {
    const rejected = setup(() => Promise.reject(new Error("immediate failure")));
    rejected.controller.handle({ type: "submit", text: "Rejected" });
    await Promise.resolve();
    expect(rejected.controller.snapshot().status).toBe("failed");

    const pending = Promise.withResolvers<undefined>();
    const target = setup(() => pending.promise);

    target.controller.handle({ type: "submit", text: "First" });
    expect(target.controller.fail()).toBe(true);
    pending.reject(new Error("private failure"));
    await Promise.resolve();
    expect(target.controller.snapshot().status).toBe("failed");

    const late = Promise.withResolvers<undefined>();
    const second = setup(() => late.promise);
    second.controller.handle({ type: "submit", text: "Second" });
    second.controller.complete();
    late.reject(new Error("late failure"));
    await Promise.resolve();
    expect(second.controller.snapshot().status).toBe("ready");
  });

  it("disposes once and refuses later actions", async () => {
    const target = setup();

    expect(target.controller.dispose()).toBe(true);
    expect(target.controller.dispose()).toBe(false);
    expect(target.controller.appendAssistantText("late")).toBe(false);
    expect(target.controller.handle({ type: "submit", text: "late" })).toBe(false);
    expect(target.controller.handle({ type: "approve" })).toBe(false);
    await expect(
      target.controller.requestApproval({ path: "src/a.ts", summary: "Late" }),
    ).rejects.toThrow();
    expect(target.dispose).toHaveBeenCalledOnce();
  });
});

it("ignores answers when no question interrupt is pending", () => {
  const target = setup(() => Promise.resolve());
  expect(
    target.controller.handle({ type: "answers", interruptId: "missing", values: ["One"] }),
  ).toBe(false);
});
