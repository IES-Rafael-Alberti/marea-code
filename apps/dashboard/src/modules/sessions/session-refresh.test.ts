import { afterEach, expect, it, vi } from "vitest";
import { SessionRefresh } from "./session-refresh.js";
afterEach(() => vi.useRealTimers());
it("coalesces notifications during an outstanding read and polls after catching up", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<undefined>();
  const read = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockImplementation(() => {
      // Stop a broken immediate-refresh loop so the call-count assertion can report it.
      if (read.mock.calls.length > 3) loop.dispose();
      return Promise.resolve();
    });
  const loop = new SessionRefresh(read, 2000);
  const first = loop.refresh();
  loop.invalidate();
  loop.invalidate();
  expect(read).toHaveBeenCalledTimes(1);
  pending.resolve(undefined);
  await first;
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1999);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(3);
  loop.dispose();
  await loop.refresh();
  await vi.advanceTimersByTimeAsync(4000);
  expect(read).toHaveBeenCalledTimes(3);
});
it("does not restart a disposed in-flight read, even when it fails", async () => {
  vi.useFakeTimers();
  const pending = Promise.withResolvers<undefined>();
  const read = vi.fn(() => pending.promise);
  const loop = new SessionRefresh(read, 2000);
  const first = loop.refresh();
  loop.invalidate();
  loop.dispose();
  pending.reject(new Error("read failed"));
  await expect(first).rejects.toThrow("read failed");
  await vi.advanceTimersByTimeAsync(4000);
  expect(read).toHaveBeenCalledOnce();
});
