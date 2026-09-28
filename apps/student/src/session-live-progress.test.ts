import { expect, it, vi } from "vitest";
import { createFixtureController, FixtureAgent } from "./student.fixture.js";
it("continues rendering while a progress upload is blocked and serializes the final delivery", async () => {
  const network = Promise.withResolvers<undefined>();
  const uploading = Promise.withResolvers<undefined>();
  const continueModel = Promise.withResolvers<undefined>();
  const secondDelta = Promise.withResolvers<undefined>();
  const agent = new FixtureAgent();
  agent.streamMessage = async function* () {
    yield { type: "assistant-text-delta", text: "First" };
    await continueModel.promise;
    yield { type: "assistant-text-delta", text: " second" };
    secondDelta.resolve(undefined);
    yield { type: "turn-completed" };
  };
  const f = createFixtureController({ agent, liveProgress: true });
  await f.controller.start("Slow upload");
  const append = f.server.appendRunEvents.bind(f.server);
  let active = 0;
  let maximum = 0;
  vi.spyOn(f.server, "appendRunEvents").mockImplementation(async (token, request) => {
    maximum = Math.max(maximum, ++active);
    try {
      if (request.events.some((event) => event.eventType === "assistant-progress")) {
        uploading.resolve(undefined);
        await network.promise;
      }
      return await append(token, request);
    } finally {
      active--;
    }
  });
  const sending = f.controller.sendMessage("message:slow", "Explain", new AbortController().signal);
  await uploading.promise;
  continueModel.resolve(undefined);
  await secondDelta.promise;
  expect(f.studentInterface.events).toContainEqual(
    expect.objectContaining({ type: "assistant-text", text: " second" }),
  );
  expect(maximum).toBe(1);
  network.resolve(undefined);
  await sending;
  expect([...f.server.events.values()].at(-1)).toMatchObject({
    eventType: "turn-ended",
    state: "completed",
  });
  expect(
    [...f.server.events.values()].find((event) => event.eventType === "assistant-message"),
  ).toMatchObject({ content: "First second" });
  expect(maximum).toBe(1);
});
it("returns cancellation even when its final audit delivery is offline", async () => {
  const agent = new FixtureAgent();
  const abort = new AbortController();
  agent.streamMessage = async function* () {
    await Promise.resolve();
    abort.abort(new Error("student cancelled"));
    abort.signal.throwIfAborted();
    yield { type: "turn-completed" };
  };
  const f = createFixtureController({ agent });
  await f.controller.start("Cancel offline");
  const append = f.server.appendRunEvents.bind(f.server);
  const appendSpy = vi
    .spyOn(f.server, "appendRunEvents")
    .mockImplementation((token, request) =>
      request.events.some((event) => event.eventType === "turn-ended")
        ? Promise.reject(new Error("offline"))
        : append(token, request),
    );
  await f.controller.sendMessage("message:cancel", "Stop", abort.signal);
  expect(f.studentInterface.events.at(-1)).toMatchObject({ type: "turn-cancelled" });
  await vi.waitFor(() => {
    expect(appendSpy).toHaveBeenCalledTimes(2);
  });
  expect(await f.localSession.pendingEvents(128)).toContainEqual(
    expect.objectContaining({ eventType: "turn-ended", state: "cancelled" }),
  );
});
it("publishes combined streaming prefixes across upload intervals", async () => {
  const agent = new FixtureAgent();
  const f = createFixtureController({ agent, liveProgress: true });
  await f.controller.start("Two snapshots");
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  agent.streamMessage = async function* () {
    yield { type: "assistant-text-delta", text: "First" };
    await vi.waitFor(() => {
      expect([...f.server.events.values()]).toContainEqual(
        expect.objectContaining({ eventType: "assistant-progress", content: "First" }),
      );
    });
    now.mockReturnValue(2000);
    yield { type: "assistant-text-delta", text: " second" };
    yield { type: "turn-completed" };
  };
  try {
    await f.controller.sendMessage("message:prefixes", "Explain", new AbortController().signal);
    expect(
      [...f.server.events.values()].filter((event) => event.eventType === "assistant-progress"),
    ).toMatchObject([{ content: "First" }, { content: "First second" }]);
  } finally {
    now.mockRestore();
  }
});
