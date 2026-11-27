import { describe, expect, it, vi } from "vitest";

import { collect } from "./adapter.fixture.js";
import { AgentAdapterError } from "./contracts.js";
import { translateRun } from "./upstream.boundary.js";

async function* textChunks(): AsyncGenerator<string> {
  await Promise.resolve();
  yield "";
  yield "visible";
}

async function* messages(): AsyncGenerator<{ readonly text: AsyncIterable<string> }> {
  await Promise.resolve();
  yield { text: textChunks() };
}

describe("stream translation boundary", () => {
  it("waits for durable text before exposing each visible delta", async () => {
    const entered = Promise.withResolvers<undefined>();
    const persisted = Promise.withResolvers<undefined>();
    const recordTurn = vi.fn(async () => {
      entered.resolve(undefined);
      await persisted.promise;
    });
    const iterator = translateRun(
      () => Promise.resolve({ messages: messages(), output: Promise.resolve({ messages: [] }) }),
      new AbortController().signal,
      undefined,
      recordTurn,
    );
    let exposed = false;
    const next = iterator.next().then((result) => {
      exposed = true;
      return result;
    });
    await entered.promise;
    expect(exposed).toBe(false);
    expect(recordTurn).toHaveBeenCalledWith("in-progress", [
      { type: "assistant-text-delta", text: "visible" },
    ]);
    persisted.resolve(undefined);
    await expect(next).resolves.toEqual({
      done: false,
      value: { type: "assistant-text-delta", text: "visible" },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "turn-completed" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("does not expose text when its durable write fails", async () => {
    const error = new AgentAdapterError("invalid-checkpoint-state", "synthetic disk failure");
    const iterator = translateRun(
      () => Promise.resolve({ messages: messages(), output: Promise.resolve({ messages: [] }) }),
      new AbortController().signal,
      undefined,
      () => Promise.reject(error),
    );
    await expect(iterator.next()).rejects.toBe(error);
  });

  it("drops empty upstream text chunks", async () => {
    const events = await collect(
      translateRun(
        () =>
          Promise.resolve({
            messages: messages(),
            output: Promise.resolve({ messages: [] }),
          }),
        new AbortController().signal,
      ),
    );

    expect(events).toEqual([
      { type: "assistant-text-delta", text: "visible" },
      { type: "turn-completed" },
    ]);
  });

  it("translates an approval without requiring a recovery recorder", async () => {
    const events = await collect(
      translateRun(
        () =>
          Promise.resolve({
            messages: messages(),
            output: Promise.resolve({
              __interrupt__: [
                {
                  id: "review-1",
                  value: {
                    actionRequests: [
                      {
                        name: "confirm_change",
                        args: { path: "notes.txt" },
                        description: "Confirm the change.",
                      },
                    ],
                    reviewConfigs: [
                      {
                        actionName: "confirm_change",
                        allowedDecisions: ["approve", "edit", "reject"],
                      },
                    ],
                  },
                },
              ],
            }),
          }),
        new AbortController().signal,
      ),
    );

    expect(events).toEqual([
      { type: "assistant-text-delta", text: "visible" },
      expect.objectContaining({ type: "tool-approval-required", reviewId: "review-1" }),
    ]);
  });

  it("passes a regenerated answer through without comparing it to earlier text", async () => {
    const events = await translateText(
      messageStream({ text: textStream("per", "sisted", " tail") }),
    );

    expect(events).toEqual([
      { type: "assistant-text-delta", text: "per" },
      { type: "assistant-text-delta", text: "sisted" },
      { type: "assistant-text-delta", text: " tail" },
      { type: "turn-completed" },
    ]);
  });

  it("preserves adapter errors raised by the recovery recorder", async () => {
    const error = new AgentAdapterError("invalid-checkpoint-state", "synthetic recorder failure");

    await expect(translateText(messageStream(), () => Promise.reject(error))).rejects.toBe(error);
  });

  it("records a submitted approval with the completed turn", async () => {
    const recordTurn = vi.fn(() => Promise.resolve());

    await expect(
      collect(
        translateRun(
          () =>
            Promise.resolve({
              messages: messages(),
              output: Promise.resolve({ messages: [] }),
            }),
          new AbortController().signal,
          "approve",
          recordTurn,
        ),
      ),
    ).resolves.toEqual([
      { type: "tool-approval-submitted", decision: "approve" },
      { type: "assistant-text-delta", text: "visible" },
      { type: "turn-completed" },
    ]);
    expect(recordTurn).toHaveBeenCalledWith("completed", [
      { type: "tool-approval-submitted", decision: "approve" },
      { type: "assistant-text-delta", text: "visible" },
      { type: "turn-completed" },
    ]);
  });

  it("records cancellation when an aborted run fails and tolerates no recorder", async () => {
    const controller = new AbortController();
    const cancelTurn = vi.fn(() => Promise.resolve());
    controller.abort();
    const failingRun = () => Promise.reject(new Error("aborted upstream run"));

    await expect(
      collect(translateRun(failingRun, controller.signal, undefined, undefined, cancelTurn)),
    ).resolves.toEqual([{ type: "turn-cancelled" }]);
    expect(cancelTurn).toHaveBeenCalledWith([{ type: "turn-cancelled" }]);
    await expect(collect(translateRun(failingRun, controller.signal))).resolves.toEqual([
      { type: "turn-cancelled" },
    ]);
  });
});

function translateText(
  messageValues: AsyncIterable<{ readonly text: AsyncIterable<string> }>,
  recordTurn?: Parameters<typeof translateRun>[3],
) {
  return collect(
    translateRun(
      () =>
        Promise.resolve({
          messages: messageValues,
          output: Promise.resolve({ messages: [] }),
        }),
      new AbortController().signal,
      undefined,
      recordTurn,
    ),
  );
}

async function* messageStream(
  ...values: { readonly text: AsyncIterable<string> }[]
): AsyncGenerator<{ readonly text: AsyncIterable<string> }> {
  await Promise.resolve();
  yield* values;
}

async function* textStream(...values: string[]): AsyncGenerator<string> {
  await Promise.resolve();
  yield* values;
}

it("drains tools executed while awaiting the next model message before its answer", async () => {
  const pending: import("./tool-events.boundary.js").ToolLifecycleEvent[] = [];
  async function* chunks(text: string) {
    await Promise.resolve();
    yield text;
  }
  async function* responses() {
    await Promise.resolve();
    yield { text: chunks("Before") };
    pending.push({
      type: "tool-started",
      callId: "read",
      name: "marea_read_project",
      arguments: {},
    });
    pending.push({ type: "tool-finished", callId: "read", result: "file", failed: false });
    yield { text: chunks("After") };
  }
  const events = await collect(
    translateRun(
      () => Promise.resolve({ messages: responses(), output: Promise.resolve({ messages: [] }) }),
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      () => pending.splice(0),
    ),
  );
  expect(events.map((event) => event.type)).toEqual([
    "assistant-text-delta",
    "tool-started",
    "tool-finished",
    "assistant-text-delta",
    "turn-completed",
  ]);
});
