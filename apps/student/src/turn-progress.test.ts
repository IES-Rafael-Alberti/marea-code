import { afterEach, expect, it, vi } from "vitest";
import { MessageIdSchema } from "@marea/protocol";
import { TurnProgress } from "./turn-progress.js";
import { createFixtureController, FixtureIds } from "./student.fixture.js";
afterEach(() => vi.useRealTimers());
it("persists bounded snapshots without blocking student streaming on network delivery", async () => {
  const f = createFixtureController();
  await f.controller.start("Progress");
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const pending = Promise.withResolvers<undefined>();
  const flushOutbox = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
  const options = { localSession: f.localSession, ids: new FixtureIds(), flushOutbox };
  const identity = { messageId: MessageIdSchema.parse("message:live"), attemptId: "a" };
  await new TurnProgress(options, identity).publish("disabled");
  expect(flushOutbox).not.toHaveBeenCalled();
  const progress = new TurnProgress({ ...options, liveProgress: true }, identity);
  await progress.publish("first");
  await progress.publish("coalesced");
  await vi.advanceTimersByTimeAsync(250);
  await progress.publish("still waiting");
  expect(flushOutbox).toHaveBeenCalledOnce();
  pending.resolve(undefined);
  await vi.advanceTimersByTimeAsync(0);
  await progress.publish("x".repeat(17000));
  await vi.advanceTimersByTimeAsync(0);
  await progress.publish("throttled");
  expect(flushOutbox).toHaveBeenCalledTimes(2);
  flushOutbox.mockRejectedValueOnce(new Error("offline"));
  await vi.advanceTimersByTimeAsync(250);
  await progress.publish("offline snapshot");
  await vi.advanceTimersByTimeAsync(1000);
  await progress.publish("do not accumulate more while offline");
  expect(flushOutbox).toHaveBeenCalledTimes(3);
  expect(await f.localSession.pendingEvents(128)).toMatchObject([
    { eventType: "assistant-progress", content: "first", truncated: false },
    { eventType: "assistant-progress", content: "x".repeat(16384), truncated: true },
    { eventType: "assistant-progress", content: "offline snapshot", truncated: false },
  ]);
});
it("discards only acknowledged progress deduplication keys, retaining durable decisions", async () => {
  const f = createFixtureController();
  await f.controller.start("Progress retention");
  const ids = new FixtureIds();
  const messageId = MessageIdSchema.parse("message:retention");
  for (const key of ["progress:one", "progress:two", "other:message"]) {
    await f.localSession.appendEvent(key, (sequence, occurredAt) =>
      key.startsWith("progress:")
        ? {
            eventId: ids.event(),
            sequence,
            occurredAt,
            eventType: "assistant-progress",
            messageId,
            content: key,
            truncated: false,
          }
        : {
            eventId: ids.event(),
            sequence,
            occurredAt,
            eventType: "student-message",
            messageId,
            content: key,
          },
    );
  }
  const pending = await f.localSession.prepareDelivery(128);
  const first = pending[0];
  if (first === undefined) throw new Error("Missing progress");
  await f.localSession.acknowledge(first.sequence);
  expect((await f.localSession.load()).run?.eventKeys).toEqual(["progress:two", "other:message"]);
  await f.localSession.acknowledge(first.sequence + 2);
  expect((await f.localSession.load()).run?.eventKeys).toEqual(["other:message"]);
  expect(await f.localSession.pendingEvents(128)).toEqual([]);
});
it("does not mark an exactly bounded snapshot as truncated", async () => {
  const f = createFixtureController();
  await f.controller.start("Exact limit");
  const progress = new TurnProgress(
    {
      localSession: f.localSession,
      ids: new FixtureIds(),
      flushOutbox: () => Promise.resolve(),
      liveProgress: true,
    },
    { messageId: MessageIdSchema.parse("message:limit"), attemptId: "attempt" },
  );
  await progress.publish("x".repeat(16384));
  expect(await f.localSession.pendingEvents(128)).toMatchObject([
    { content: "x".repeat(16384), truncated: false },
  ]);
});
