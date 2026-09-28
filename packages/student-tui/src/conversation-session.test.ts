import { temporaryTurnFailure } from "./conversation-controller.test-support.js";
import { describe, expect, it, vi } from "vitest";

import type { SignalSource } from "./contracts.js";
import type {
  ConversationAction,
  ConversationAttemptId,
  ConversationPendingTurn,
  ConversationSnapshot,
} from "./conversation-contracts.js";
import { createConversationTuiSession } from "./conversation-session.js";
import { createSignalHarness } from "../test-support/signal-harness.js";

function createTarget(
  onMessage: (
    text: string,
    signal: AbortSignal,
    messageId: string,
    attemptId: ConversationAttemptId,
  ) => Promise<void> = () => Promise.resolve(),
  initialTurn?: ConversationPendingTurn,
) {
  const snapshots: ConversationSnapshot[] = [];
  const dispose = vi.fn();
  const signals = createSignalHarness();
  const exits: number[] = [];
  const binding = createConversationTuiSession({
    ...(initialTurn === undefined ? {} : { initialTurn }),
    onMessage,
    setExitCode(code): void {
      exits.push(code);
    },
    signals: signals.source,
    view: {
      dispose,
      render(snapshot): void {
        snapshots.push(snapshot);
      },
    },
  });
  return { binding, dispose, exits, signals, snapshots };
}

describe("conversation TUI session", () => {
  it("exposes a bound-only resume operation for a hydrated pending turn", async () => {
    const operation = Promise.withResolvers<undefined>();
    const onMessage = vi.fn(() => operation.promise);
    const target = createTarget(onMessage, {
      assistantText: "Saved prefix",
      messageId: "message:old",
      text: "Continue my work",
    });

    expect(target.binding.session.snapshot().messages).toEqual([
      { author: "student", text: "Continue my work" },
      { author: "marea", text: "Saved prefix" },
    ]);
    expect(target.binding.session.resumeTurn()).toBe(true);
    expect(onMessage).toHaveBeenCalledWith(
      "Continue my work",
      expect.any(AbortSignal),
      "message:old",
      expect.any(String),
    );
    expect(target.binding.session.resumeTurn()).toBe(false);
    operation.resolve(undefined);
    await Promise.resolve();
    target.binding.session.close();
    await target.binding.session.outcome;
  });

  it("runs messages and approvals before a clean close", async () => {
    const target = createTarget();

    expect(target.binding.handleAction({ type: "submit", text: "Help" })).toBe(true);
    expect(target.binding.session.appendAssistantText("Working")).toBe(true);
    const approval = target.binding.session.requestApproval({
      path: "notes.txt",
      summary: "Create notes",
    });
    expect(target.binding.handleAction({ type: "approve" })).toBe(true);
    await expect(approval).resolves.toBe("approved");
    expect(target.binding.session.complete()).toBe(true);
    expect(target.binding.session.close()).toBe(true);
    expect(target.binding.session.close()).toBe(false);

    await expect(target.binding.session.outcome).resolves.toEqual({
      exitCode: 0,
      reason: "closed",
    });
    expect(target.exits).toEqual([0]);
    expect(target.dispose).toHaveBeenCalledOnce();
    expect(target.signals.removals.get("SIGINT")).toHaveBeenCalledOnce();
    expect(target.signals.removals.get("SIGTERM")).toHaveBeenCalledOnce();
  });

  it("forwards tool rows while open and refuses them once closed", async () => {
    const target = createTarget();

    expect(target.binding.handleAction({ type: "submit", text: "Read it" })).toBe(true);
    expect(
      target.binding.session.toolStarted({
        arguments: { path: "a.txt" },
        callId: "call:1",
        name: "marea_read_project",
      }),
    ).toBe(true);
    expect(
      target.binding.session.toolFinished({ callId: "call:1", failed: false, result: "content" }),
    ).toBe(true);
    expect(target.binding.session.thinking("stale", "stale")).toBe(false);
    expect(target.binding.session.thinking()).toBe(true);
    expect(target.binding.session.snapshot().activity).toBe("thinking");
    expect(target.binding.session.snapshot().tools).toEqual([
      {
        arguments: { path: "a.txt" },
        callId: "call:1",
        name: "marea_read_project",
        outcome: { failed: false, result: "content" },
      },
    ]);
    expect(target.binding.session.close()).toBe(true);
    expect(target.binding.session.thinking()).toBe(false);
    expect(target.binding.session.toolStarted({ arguments: {}, callId: "call:2", name: "x" })).toBe(
      false,
    );
    expect(
      target.binding.session.toolFinished({ callId: "call:2", failed: false, result: "r" }),
    ).toBe(false);
    await expect(target.binding.session.outcome).resolves.toEqual({
      exitCode: 0,
      reason: "closed",
    });
  });

  it.each([
    ["SIGINT", "sigint", 130],
    ["SIGTERM", "sigterm", 143],
  ] as const)("maps %s to a terminal outcome", async (signal, reason, exitCode) => {
    const target = createTarget();
    target.binding.handleAction({ type: "submit", text: "Active" });

    target.signals.handlers.get(signal)?.();

    await expect(target.binding.session.outcome).resolves.toEqual({ exitCode, reason });
    expect(target.binding.session.snapshot().status).toBe("cancelled");
    expect(target.exits).toEqual([exitCode]);
  });

  it("maps the Ctrl+C action to interruption and refuses late operations", async () => {
    const target = createTarget();
    target.binding.handleAction({ type: "submit", text: "Active" });

    expect(target.binding.handleAction({ type: "exit" })).toBe(true);
    expect(target.binding.handleAction({ type: "exit" })).toBe(false);
    expect(target.binding.session.appendAssistantText("late")).toBe(false);
    expect(target.binding.session.complete()).toBe(false);
    expect(target.binding.session.fail()).toBe(false);
    await expect(
      target.binding.session.requestApproval({ path: "late.txt", summary: "Late" }),
    ).rejects.toThrow("already closed");
    await expect(target.binding.session.outcome).resolves.toEqual({
      exitCode: 130,
      reason: "sigint",
    });
  });

  it("explicitly closes while cancelling and resolves a pending approval", async () => {
    const operation = Promise.withResolvers<undefined>();
    const target = createTarget(vi.fn(() => operation.promise));

    expect(target.binding.handleAction({ type: "submit", text: "Change" })).toBe(true);
    const approval = target.binding.session.requestApproval({
      path: "notes.txt",
      summary: "Create notes",
    });
    expect(target.binding.session.close()).toBe(true);

    await expect(approval).resolves.toBe("rejected");
    await expect(target.binding.session.outcome).resolves.toEqual({
      exitCode: 0,
      reason: "closed",
    });
    expect(target.dispose).toHaveBeenCalledOnce();
    expect(target.binding.handleAction({ type: "submit", text: "late" })).toBe(false);

    operation.resolve(undefined);
    await Promise.resolve();
  });

  it("exposes retry after a recoverable failure", async () => {
    const failure = Promise.reject(temporaryTurnFailure());
    const onMessage = vi.fn(() => failure);
    const target = createTarget(onMessage);

    expect(target.binding.session.retry?.()).toBe(false);
    expect(target.binding.handleAction({ type: "submit", text: "Try again" })).toBe(true);
    await Promise.resolve();
    expect(target.binding.session.retry?.()).toBe(true);
    expect(onMessage).toHaveBeenCalledTimes(2);
    target.binding.session.complete();
  });

  it("exposes cancellation with the cancelled status through the session", async () => {
    const operation = Promise.withResolvers<undefined>();
    const target = createTarget(() => operation.promise);

    expect(target.binding.handleAction({ type: "submit", text: "Cancel me" })).toBe(true);
    expect(target.binding.session.cancel()).toBe(true);
    expect(target.binding.session.snapshot().status).toBe("cancelled");

    operation.resolve(undefined);
    await Promise.resolve();
    target.binding.session.close();
    await target.binding.session.outcome;
  });

  it("disposes a rendered view when signal subscription fails", () => {
    const remove = vi.fn();
    const dispose = vi.fn();
    const signals: SignalSource = {
      subscribe(signal): () => void {
        if (signal === "SIGTERM") throw new Error("private signal failure");
        return remove;
      },
    };

    expect(() =>
      createConversationTuiSession({
        onMessage: () => Promise.resolve(),
        setExitCode: vi.fn(),
        signals,
        view: { dispose, render: vi.fn() },
      }),
    ).toThrow("Conversation TUI signal setup failed.");
    expect(remove).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("sanitizes initial rendering failure and tolerates cleanup failures", async () => {
    const renderFailure = vi.fn(() => {
      throw new Error("private renderer failure");
    });
    const disposeAfterRenderFailure = vi.fn(() => {
      throw new Error("private dispose failure");
    });

    expect(() =>
      createConversationTuiSession({
        onMessage: () => Promise.resolve(),
        setExitCode: vi.fn(),
        signals: createSignalHarness().source,
        view: { dispose: disposeAfterRenderFailure, render: renderFailure },
      }),
    ).toThrow("Conversation TUI setup failed.");
    expect(disposeAfterRenderFailure).toHaveBeenCalledOnce();

    const dispose = vi.fn(() => {
      throw new Error("private dispose failure");
    });
    const remove = vi.fn(() => {
      throw new Error("private removal failure");
    });
    const setExitCode = vi.fn(() => {
      throw new Error("private exit failure");
    });
    const source: SignalSource = { subscribe: () => remove };
    const binding = createConversationTuiSession({
      onMessage: () => Promise.resolve(),
      setExitCode,
      signals: source,
      view: { dispose, render: vi.fn() },
    });

    binding.session.close();

    await expect(binding.session.outcome).resolves.toEqual({ exitCode: 0, reason: "closed" });
    expect(dispose).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledTimes(2);
    expect(setExitCode).toHaveBeenCalledWith(0);
  });

  it("passes non-exit actions through its owned controller", () => {
    const target = createTarget();
    const action: ConversationAction = { type: "cancel" };

    expect(target.binding.handleAction(action)).toBe(false);
    expect(target.binding.session.retry?.()).toBe(false);
    expect(target.binding.session.fail()).toBe(false);
  });
});

it("binds question requests to the active session and refuses them after closure", async () => {
  const target = createTarget();
  target.binding.handleAction({ type: "submit", text: "Help" });
  const request = { interruptId: "q1", questions: [{ text: "Why?", choices: [], required: true }] };
  const pending = target.binding.session.requestQuestions?.(request, "message:1", "attempt:1");
  expect(
    target.binding.handleAction({ type: "answers", interruptId: "q1", values: ["Because"] }),
  ).toBe(true);
  await expect(pending).resolves.toEqual({ type: "answers", values: ["Because"] });
  target.binding.session.close();
  await expect(target.binding.session.requestQuestions?.(request)).rejects.toThrow(
    "already closed",
  );
  await target.binding.session.outcome;
});
