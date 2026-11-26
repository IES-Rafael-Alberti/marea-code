import { MessageIdSchema } from "@marea/protocol";
import { afterEach, expect, it, vi } from "vitest";

import { collect, harness, message } from "./deepagents-runtime.fixture.js";
import { createFixtureController, FixtureIds } from "./student.fixture.js";
import { restartText } from "./turn-text.js";
import { TurnProgress } from "./turn-progress.js";

afterEach(() => vi.useRealTimers());

it("remembers the text left after a discarded answer for the next stream of the message", async () => {
  for (const [discardedLength, kept] of [
    [4, "ab"],
    [10, ""],
  ] as const) {
    const instance = harness();
    instance.deep.messages = [
      { type: "assistant-text-delta", text: "abcdef" },
      { type: "assistant-text-restarted", discardedLength },
      { type: "turn-completed" },
    ];
    const turn = message();
    await expect(
      collect(instance.runtime.streamMessage(turn, new AbortController().signal)),
    ).resolves.toContainEqual({ type: "assistant-text-restarted", discardedLength });
    instance.deep.messages = [{ type: "turn-completed" }];
    instance.deep.startedMessageId = null;
    await collect(instance.runtime.streamMessage(turn, new AbortController().signal));
    expect(instance.deep.messageTurns.at(-1)?.assistantText).toBe(kept);
  }
});

it("stores the shortened text and tells the screen exactly what was dropped", async () => {
  const fixture = createFixtureController();
  await fixture.controller.start("Restart");
  const messageId = MessageIdSchema.parse("message:restart");
  await fixture.localSession.setTurn({ messageId, state: "started", text: "Kept partial" });
  const identity = { attemptId: "attempt:one", messageId };
  const present = vi.fn();
  const progress = new TurnProgress(
    { localSession: fixture.localSession, ids: new FixtureIds(), flushOutbox: vi.fn() },
    identity,
  );
  const restart = vi.spyOn(progress, "restart");
  for (const [text, discardedLength, kept, reported] of [
    [["Kept ", "partial"], 8, "Kept", 8],
    [["Kept"], 9, "", 4],
  ] as const) {
    const held = [...text];
    await restartText(
      { localSession: fixture.localSession, studentInterface: { present } as never },
      identity,
      held,
      discardedLength,
      progress,
    );
    expect(held).toEqual([kept]);
    expect((await fixture.localSession.findTurn(messageId))?.text ?? "").toBe(kept);
    expect(present).toHaveBeenLastCalledWith({
      ...identity,
      type: "assistant-text-restarted",
      discardedLength: reported,
    });
  }
  expect(restart).toHaveBeenCalledTimes(2);
});

it("publishes a regenerated snapshot of the same length as the discarded one", async () => {
  const f = createFixtureController();
  await f.controller.start("Progress restart");
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const flushOutbox = vi.fn(() => Promise.resolve());
  const options = { localSession: f.localSession, ids: new FixtureIds(), flushOutbox };
  const messageId = MessageIdSchema.parse("message:regenerated");
  const progress = new TurnProgress(
    { ...options, liveProgress: true },
    { messageId, attemptId: "attempt:one" },
  );
  await progress.publish("old answer");
  await vi.advanceTimersByTimeAsync(0);
  progress.restart();
  // Within the throttle window: a restart sends the first new snapshot at once.
  await progress.publish("new answer");
  await vi.advanceTimersByTimeAsync(0);
  progress.restart();
  await progress.publish("new answer");
  await vi.advanceTimersByTimeAsync(0);
  const retried = new TurnProgress(
    { ...options, liveProgress: true },
    { messageId, attemptId: "attempt:two" },
  );
  await retried.publish("old answer");
  expect(
    (await f.localSession.pendingEvents(128)).map((event) =>
      event.eventType === "assistant-progress" ? event.content : event.eventType,
    ),
  ).toEqual(["old answer", "new answer", "new answer", "old answer"]);
});
