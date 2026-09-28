import { temporaryTurnFailure } from "./conversation-controller.test-support.js";
import { describe, expect, it } from "vitest";

import {
  createConversationControllerTarget,
  deferredConversationTurns,
} from "./conversation-controller.test-support.js";

describe("conversation controller recovery", () => {
  it("accepts trimmed exit and retry commands at the controller boundary", async () => {
    const exited = createConversationControllerTarget();
    expect(exited.controller.handle({ text: "  /exit  ", type: "submit" })).toBe(true);
    expect(exited.onExit).toHaveBeenCalledOnce();
    expect(exited.controller.handle({ text: "after exit", type: "submit" })).toBe(false);

    const failure = Promise.reject(temporaryTurnFailure());
    const retried = createConversationControllerTarget(() => failure);
    retried.controller.handle({ text: "Question", type: "submit" });
    await expect(failure).rejects.toThrow("The conversation turn failed.");
    await Promise.resolve();
    expect(retried.controller.handle({ text: " /retry ", type: "submit" })).toBe(true);
    expect(retried.controller.snapshot().messages).toEqual([
      { author: "student", text: "Question" },
    ]);
  });

  it("hydrates a pending turn and resumes it with a new attempt", async () => {
    const operation = Promise.withResolvers<undefined>();
    const target = createConversationControllerTarget(
      (_text, _signal, messageId, attemptId) => {
        expect(messageId).toBe("message:old");
        expect(attemptId).toBe("attempt:new");
        return operation.promise;
      },
      undefined,
      undefined,
      () => "attempt:new",
      {
        assistantText: "Saved prefix",
        messageId: "message:old",
        text: "Continue my work",
      },
    );

    expect(target.controller.snapshot()).toEqual({
      approval: null,
      messages: [
        { author: "student", text: "Continue my work" },
        { author: "marea", text: "Saved prefix" },
      ],
      status: "streaming",
    });
    expect(target.controller.handle({ text: "new input", type: "submit" })).toBe(false);
    expect(target.controller.resumeTurn()).toBe(true);
    expect(target.controller.resumeTurn()).toBe(false);
    expect(target.controller.appendAssistantText(" continued", "message:old", "attempt:new")).toBe(
      true,
    );
    expect(target.controller.snapshot().messages).toEqual([
      { author: "student", text: "Continue my work" },
      { author: "marea", text: "Saved prefix continued" },
    ]);

    expect(target.controller.complete("message:old", "attempt:new")).toBe(true);
    operation.resolve(undefined);
    await Promise.resolve();
    expect(target.controller.handle({ text: "new input", type: "submit" })).toBe(true);
  });

  it("hydrates a pending turn without creating an empty assistant message", () => {
    const target = createConversationControllerTarget(
      () => Promise.resolve(),
      undefined,
      undefined,
      undefined,
      { assistantText: "", messageId: "message:old", text: "Continue my work" },
    );

    expect(target.controller.snapshot().messages).toEqual([
      { author: "student", text: "Continue my work" },
    ]);
    expect(target.controller.resumeTurn()).toBe(true);
    target.controller.complete();
  });

  it("does not resume a hydrated turn after disposal", () => {
    const target = createConversationControllerTarget(
      () => Promise.resolve(),
      undefined,
      undefined,
      undefined,
      { assistantText: "Saved", messageId: "message:old", text: "Continue" },
    );

    expect(target.controller.dispose()).toBe(true);
    expect(target.controller.resumeTurn()).toBe(false);
  });

  it("keeps the deferred-turn fixture stable beyond its two configured turns", () => {
    const { first, onMessage, second } = deferredConversationTurns();
    const signal = new AbortController().signal;

    expect(onMessage("First", signal, "message:one", "attempt:one")).toBe(first.promise);
    expect(onMessage("Second", signal, "message:two", "attempt:two")).toBe(second.promise);
    expect(onMessage("Extra", signal, "message:three", "attempt:three")).toBe(second.promise);
    first.resolve(undefined);
    second.resolve(undefined);
  });

  it("releases a completed turn when its operation settled before the terminal event", async () => {
    const target = createConversationControllerTarget(() => Promise.resolve());

    target.controller.handle({ type: "submit", text: "First" });
    await Promise.resolve();
    expect(target.controller.complete()).toBe(true);
    expect(target.controller.handle({ type: "submit", text: "Second" })).toBe(true);
    target.controller.complete();
  });

  it("releases a cancelled turn when its operation settled before the terminal event", async () => {
    const target = createConversationControllerTarget(() => Promise.resolve());

    target.controller.handle({ type: "submit", text: "First" });
    await Promise.resolve();
    expect(target.controller.cancel()).toBe(true);
    expect(target.controller.handle({ type: "submit", text: "Second" })).toBe(true);
    target.controller.complete();
  });
});
