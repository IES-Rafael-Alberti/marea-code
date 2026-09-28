import { describe, expect, it, vi } from "vitest";

import type { SignalSource, StudentTuiSnapshot, StudentTuiView } from "./contracts.js";
import { createStudentTuiSession } from "./session.js";
import { createSignalHarness } from "../test-support/signal-harness.js";

function createTarget() {
  const snapshots: StudentTuiSnapshot[] = [];
  const dispose = vi.fn();
  const view: StudentTuiView = {
    dispose,
    render(snapshot): void {
      snapshots.push(snapshot);
    },
  };
  const exits: number[] = [];
  const signals = createSignalHarness();
  const binding = createStudentTuiSession({
    setExitCode(code): void {
      exits.push(code);
    },
    signals: signals.source,
    view,
  });
  return { binding, dispose, exits, signals, snapshots };
}

describe("createStudentTuiSession", () => {
  it("reports and cleans up an initial render failure", () => {
    const dispose = vi.fn();

    expect(() =>
      createStudentTuiSession({
        setExitCode: vi.fn(),
        signals: createSignalHarness().source,
        view: {
          dispose,
          render(): void {
            throw new Error("private renderer detail");
          },
        },
      }),
    ).toThrow("Student TUI setup failed.");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("streams, marks completion, and closes with successful semantics", async () => {
    const target = createTarget();
    const cancelled = vi.fn();
    void target.binding.session.cancellation.then(cancelled);

    expect(target.binding.session.appendText("answer")).toBe(true);
    expect(target.binding.session.complete()).toBe(true);
    expect(target.binding.session.close()).toBe(true);
    expect(target.binding.session.close()).toBe(false);
    expect(target.binding.session.appendText("late")).toBe(false);
    expect(target.binding.session.complete()).toBe(false);
    await expect(target.binding.session.outcome).resolves.toEqual({
      exitCode: 0,
      reason: "closed",
    });
    await Promise.resolve();
    expect(cancelled).not.toHaveBeenCalled();
    expect(target.exits).toEqual([0]);
    expect(target.dispose).toHaveBeenCalledOnce();
    expect(target.signals.removals.get("SIGINT")).toHaveBeenCalledOnce();
    expect(target.signals.removals.get("SIGTERM")).toHaveBeenCalledOnce();
  });

  it("cancels current work without terminating the interface", async () => {
    const target = createTarget();

    target.binding.session.appendText("active");
    target.binding.handleIntent("cancel");
    target.binding.handleIntent("cancel");

    await expect(target.binding.session.cancellation).resolves.toBeUndefined();
    expect(target.exits).toEqual([]);
    expect(target.dispose).not.toHaveBeenCalled();
    expect(target.binding.session.snapshot().status).toBe("cancelled");

    target.binding.handleIntent("quit");
    await expect(target.binding.session.outcome).resolves.toEqual({ exitCode: 0, reason: "quit" });
  });

  it("maps an explicit keyboard interrupt to SIGINT semantics", async () => {
    const target = createTarget();

    target.binding.session.appendText("active");
    target.binding.handleIntent("interrupt");
    target.binding.handleIntent("interrupt");

    await expect(target.binding.session.cancellation).resolves.toBeUndefined();
    await expect(target.binding.session.outcome).resolves.toEqual({
      exitCode: 130,
      reason: "sigint",
    });
    expect(target.exits).toEqual([130]);
  });

  it.each([
    ["SIGINT", "sigint", 130],
    ["SIGTERM", "sigterm", 143],
  ] as const)("maps %s to %s and removes both listeners", async (signal, reason, exitCode) => {
    const target = createTarget();
    const handler = target.signals.handlers.get(signal);

    target.binding.session.appendText("active");
    expect(handler).toBeTypeOf("function");
    handler?.();

    await expect(target.binding.session.outcome).resolves.toEqual({ exitCode, reason });
    expect(target.binding.session.snapshot().status).toBe("cancelled");
    expect(target.signals.removals.get("SIGINT")).toHaveBeenCalledOnce();
    expect(target.signals.removals.get("SIGTERM")).toHaveBeenCalledOnce();
  });

  it.each([
    ["quit", "quit"],
    ["close", "closed"],
  ] as const)(
    "notifies cancellation before %s terminates an active turn",
    async (action, reason) => {
      const target = createTarget();
      target.binding.session.appendText("active");

      if (action === "quit") target.binding.handleIntent("quit");
      else target.binding.session.close();

      await expect(target.binding.session.cancellation).resolves.toBeUndefined();
      await expect(target.binding.session.outcome).resolves.toEqual({ exitCode: 0, reason });
    },
  );

  it("rolls back the first listener when the second subscription fails", () => {
    const removeFirst = vi.fn();
    const dispose = vi.fn();
    const source: SignalSource = {
      subscribe(signal): () => void {
        if (signal === "SIGTERM") throw new Error("subscription failed");
        return removeFirst;
      },
    };

    expect(() =>
      createStudentTuiSession({
        setExitCode: vi.fn(),
        signals: source,
        view: { dispose, render: vi.fn() },
      }),
    ).toThrow("Student TUI signal setup failed.");
    expect(removeFirst).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("settles an interruption even when every cleanup callback fails", async () => {
    const removeFirst = vi.fn(() => {
      throw new Error("first removal failed");
    });
    const removeSecond = vi.fn(() => {
      throw new Error("second removal failed");
    });
    const setExitCode = vi.fn(() => {
      throw new Error("exit code failed");
    });
    const dispose = vi.fn(() => {
      throw new Error("dispose failed");
    });
    const source: SignalSource = {
      subscribe(signal): () => void {
        return signal === "SIGINT" ? removeFirst : removeSecond;
      },
    };
    const binding = createStudentTuiSession({
      setExitCode,
      signals: source,
      view: { dispose, render: vi.fn() },
    });

    binding.session.appendText("active");
    binding.handleIntent("interrupt");

    await expect(binding.session.cancellation).resolves.toBeUndefined();
    await expect(binding.session.outcome).resolves.toEqual({ exitCode: 130, reason: "sigint" });
    expect(removeFirst).toHaveBeenCalledOnce();
    expect(removeSecond).toHaveBeenCalledOnce();
    expect(setExitCode).toHaveBeenCalledWith(130);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
