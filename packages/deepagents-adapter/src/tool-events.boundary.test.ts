import { describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "./contracts.js";
import { observeExecution, type ToolLifecycleEvent } from "./tool-events.boundary.js";

function collect() {
  const events: ToolLifecycleEvent[] = [];
  return {
    events,
    report: (event: ToolLifecycleEvent): void => {
      events.push(event);
    },
  };
}

describe("observed tool execution", () => {
  it("reports start and finish around the implementation", async () => {
    const seen = collect();
    const execute = vi.fn((input: Readonly<Record<string, string>>) =>
      Promise.resolve(`read:${input.path ?? ""}`),
    );
    const observed = observeExecution(
      "marea_read_project",
      (input) => execute(Object.freeze({ ...input })),
      seen.report,
    );

    await expect(observed({ path: "exercise.txt" })).resolves.toBe("read:exercise.txt");
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toEqual({ path: "exercise.txt" });
    expect(Object.isFrozen(execute.mock.calls[0]?.[0])).toBe(true);
    expect(seen.events).toHaveLength(2);
    const [started, finished] = seen.events;
    expect(started).toMatchObject({
      arguments: { path: "exercise.txt" },
      name: "marea_read_project",
      type: "tool-started",
    });
    expect(Object.isFrozen(started?.type === "tool-started" ? started.arguments : null)).toBe(true);
    const startedCallId = started?.type === "tool-started" ? started.callId : undefined;
    expect(finished).toMatchObject({
      callId: startedCallId,
      failed: false,
      result: "read:exercise.txt",
      type: "tool-finished",
    });
  });

  it("reports a failure with the error message and rethrows", async () => {
    const seen = collect();
    const failure = new Error("cannot read the file");
    const observed = observeExecution(
      "marea_read_project",
      () => Promise.reject(failure),
      seen.report,
    );

    await expect(observed({ path: "missing.txt" })).rejects.toBe(failure);
    expect(seen.events).toHaveLength(2);
    const [started, finished] = seen.events;
    const startedCallId = started?.type === "tool-started" ? started.callId : undefined;
    expect(finished).toMatchObject({
      callId: startedCallId,
      failed: true,
      result: "cannot read the file",
      type: "tool-finished",
    });
  });

  it("reports a non-Error failure with a safe message", async () => {
    const seen = collect();
    const deferred = Promise.withResolvers<string>();
    const observed = observeExecution("marea_read_project", () => deferred.promise, seen.report);
    deferred.reject("gone");

    await expect(observed({ path: "missing.txt" })).rejects.toBe("gone");
    expect(seen.events.at(-1)).toMatchObject({
      callId: seen.events[0]?.type === "tool-started" ? seen.events[0].callId : undefined,
      failed: true,
      result: "The tool failed without an error.",
      type: "tool-finished",
    });
  });

  it("keeps distinct executions paired by their own call id", async () => {
    const seen = collect();
    const observed = observeExecution(
      "marea_list_project",
      (input) => Promise.resolve(`listed:${input.path ?? ""}`),
      seen.report,
    );

    await observed({ path: "a" });
    await observed({ path: "b" });
    const starts = seen.events.filter(
      (event): event is Extract<AgentEvent, { type: "tool-started" }> =>
        event.type === "tool-started",
    );
    const finishes = seen.events.filter(
      (event): event is Extract<AgentEvent, { type: "tool-finished" }> =>
        event.type === "tool-finished",
    );
    expect(starts.map((event) => event.callId)).toHaveLength(2);
    expect(new Set(starts.map((event) => event.callId)).size).toBe(2);
    expect(finishes.map((event) => event.callId).toSorted()).toEqual(
      starts.map((event) => event.callId).toSorted(),
    );
  });
});

it("captures timestamps at execution rather than when the consumer drains events", async () => {
  const clock = vi.spyOn(Date.prototype, "toISOString");
  try {
    clock.mockReturnValue("2026-09-21T10:00:01.000Z");
    const seen = collect();
    const deferred = Promise.withResolvers<string>();
    const execute = observeExecution("marea_read_project", () => deferred.promise, seen.report);
    const running = execute({});
    clock.mockReturnValue("2026-09-21T10:00:02.000Z");
    deferred.resolve("file");
    await running;
    clock.mockReturnValue("2026-09-21T10:01:00.000Z");
    expect(seen.events.map((event) => event.occurredAt)).toEqual([
      "2026-09-21T10:00:01.000Z",
      "2026-09-21T10:00:02.000Z",
    ]);
  } finally {
    clock.mockRestore();
  }
});
