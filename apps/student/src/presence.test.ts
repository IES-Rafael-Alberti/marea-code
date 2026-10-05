import { afterEach, expect, it, vi } from "vitest";
import { createFixtureController, FixtureServer, RUN_TOKEN } from "./student.fixture.js";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("sends presence periodically, avoids overlapping heartbeats and stops on close", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<undefined>();
  const heartbeat = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(undefined);
  const server = Object.assign(new FixtureServer(), { heartbeat });
  const f = createFixtureController({ server });
  await f.controller.start("Project");
  await vi.advanceTimersByTimeAsync(30000);
  expect(heartbeat).toHaveBeenCalledOnce();
  pending.resolve(undefined);
  await vi.advanceTimersByTimeAsync(30000);
  expect(heartbeat).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30000);
  expect(heartbeat).toHaveBeenCalledTimes(3);
  await f.controller.close();
  await vi.advanceTimersByTimeAsync(60000);
  expect(heartbeat).toHaveBeenCalledTimes(3);
});

it("does not send presence when closing during token acquisition", async () => {
  vi.useFakeTimers();
  const heartbeat = vi.fn().mockResolvedValue(undefined);
  const f = createFixtureController({ server: Object.assign(new FixtureServer(), { heartbeat }) });
  const pending = Promise.withResolvers<typeof RUN_TOKEN>();
  vi.spyOn(f.controller, "modelRunToken").mockReturnValue(pending.promise);
  await f.controller.start("Project");
  await f.controller.close();
  pending.resolve(RUN_TOKEN);
  await vi.advanceTimersByTimeAsync(1);
  expect(heartbeat).not.toHaveBeenCalled();
});

it("owns one unreferenced timer and discards callbacks already queued when closing", async () => {
  vi.useFakeTimers();
  const intervals = vi.spyOn(globalThis, "setInterval");
  const heartbeat = vi.fn().mockResolvedValue(undefined);
  const server = Object.assign(new FixtureServer(), { heartbeat });
  const f = createFixtureController({ server });
  await f.controller.start("Project");
  await vi.advanceTimersByTimeAsync(0);
  const timer = intervals.mock.results[0]?.value as ReturnType<typeof setInterval>;
  expect(timer.hasRef()).toBe(false);
  await f.controller.start("Project");
  expect(intervals).toHaveBeenCalledTimes(1);
  expect(heartbeat).toHaveBeenCalledTimes(1);
  expect(heartbeat.mock.contexts[0]).toBe(server);
  const queuedCallback = intervals.mock.calls[0]?.[0] as () => void;
  await f.controller.close();
  expect(vi.getTimerCount()).toBe(0);
  const token = vi.spyOn(f.controller, "modelRunToken");
  queuedCallback();
  await vi.advanceTimersByTimeAsync(0);
  expect(token).not.toHaveBeenCalled();
  expect(heartbeat).toHaveBeenCalledTimes(1);
});
