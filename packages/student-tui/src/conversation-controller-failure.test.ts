import { createConversationController } from "./conversation-controller.js";
import { describe, expect, it, vi } from "vitest";

import { TurnFailureSignal, type TurnFailureInfo } from "./conversation-contracts.js";
import { createConversationControllerTarget as setup } from "./conversation-controller.test-support.js";

describe("conversation controller failures", () => {
  it("carries a classified failure from a rejected turn operation", async () => {
    const failure: TurnFailureInfo = {
      detail: "The request exceeds the configured inference limits.",
      hasPrefix: false,
      kind: "provider-interrupted",
      recoverable: true,
      retryable: false,
    };
    const rejected = Promise.reject(new TurnFailureSignal(failure));
    const target = setup(() => rejected);

    target.controller.handle({ type: "submit", text: "Try again" });
    await expect(rejected).rejects.toThrow("The conversation turn failed.");
    await Promise.resolve();
    expect(target.controller.snapshot()).toEqual({
      approval: null,
      failure,
      messages: [{ author: "student", text: "Try again" }],
      status: "failed",
    });
    target.controller.handle({ type: "submit", text: "Next" });
    const next = target.controller.snapshot();
    expect(next.status).toBe("streaming");
    expect("failure" in next).toBe(false);
    target.controller.cancel();
  });

  it("leaves an unclassified rejection without a failure key", async () => {
    const rejected = Promise.reject(new Error("temporary failure"));
    const target = setup(() => rejected);

    target.controller.handle({ type: "submit", text: "Try again" });
    await expect(rejected).rejects.toThrow("temporary failure");
    await Promise.resolve();
    const snapshot = target.controller.snapshot();
    expect(snapshot.status).toBe("failed");
    expect("failure" in snapshot).toBe(false);
    expect(target.controller.handle({ type: "retry" })).toBe(false);
  });

  it("keeps a classified failure when the turn fails during an approval", async () => {
    const failure: TurnFailureInfo = {
      detail: "",
      hasPrefix: true,
      kind: "provider-interrupted",
      recoverable: true,
      retryable: true,
    };
    const turn = Promise.withResolvers<undefined>();
    const target = setup(() => turn.promise);

    target.controller.handle({ type: "submit", text: "Change it" });
    const decision = target.controller.requestApproval({ path: "src/a.ts", summary: "Change" });
    turn.reject(new TurnFailureSignal(failure));
    await expect(decision).resolves.toBe("rejected");
    const snapshot = target.controller.snapshot();
    expect(snapshot.status).toBe("failed");
    expect(snapshot.approval).toBeNull();
    expect(snapshot.failure).toEqual(failure);
  });
});

it.each([false, true])(
  "requires explicit recovery of a hydrated failure (retryable=%s)",
  (retryable) => {
    const failure: TurnFailureInfo = {
      code: "unavailable",
      detail: "interrupted",
      hasPrefix: true,
      kind: "provider-interrupted",
      recoverable: true,
      retryable,
    };
    const send = vi.fn(() => Promise.resolve());
    const target = setup(send, vi.fn(), undefined, undefined, {
      messageId: "message:saved",
      text: "Original",
      assistantText: "Saved",
      failure,
    });
    expect(target.controller.snapshot()).toEqual({
      approval: null,
      failure,
      messages: [
        { author: "student", text: "Original" },
        { author: "marea", text: "Saved" },
      ],
      status: "failed",
    });
    expect(target.controller.resumeTurn()).toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(target.controller.handle({ type: "retry" })).toBe(retryable);
    expect(send).toHaveBeenCalledTimes(retryable ? 1 : 0);
    if (retryable)
      expect(send).toHaveBeenCalledWith(
        "Original",
        expect.any(AbortSignal),
        "message:saved",
        expect.any(String),
      );
  },
);

it("refuses a reentrant retry until the failed operation has settled", async () => {
  const result = Promise.withResolvers<undefined>();
  const attempts: boolean[] = [];
  const controller = createConversationController({
    onExit: vi.fn(),
    onMessage: () => result.promise,
    view: {
      dispose: vi.fn(),
      render: (snapshot) => {
        if (snapshot.status === "failed") attempts.push(controller.handle({ type: "retry" }));
      },
    },
  });
  controller.handle({ type: "submit", text: "Input" });
  result.reject(
    new TurnFailureSignal({
      detail: "Interrupted",
      kind: "provider-interrupted",
      hasPrefix: false,
      retryable: true,
      recoverable: true,
    }),
  );
  await Promise.resolve();
  expect(attempts).toEqual([false]);
  expect(controller.handle({ type: "retry" })).toBe(true);
  controller.cancel();
});
