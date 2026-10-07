import { afterEach, expect, it, vi } from "vitest";
import { deliverTrace } from "./delivery.js";
import { connectionTestTrace } from "./test-trace.js";
afterEach(() => {
  vi.useRealTimers();
});
it("bounds uncooperative exporters and cleans the timer after normal completion", async () => {
  vi.useFakeTimers();
  const trace = connectionTestTrace("2026-10-08T00:00:00.000Z", "test");
  const exporter = { export: vi.fn(() => Promise.resolve()) };
  await deliverTrace(exporter, trace, new AbortController().signal);
  expect(exporter.export).toHaveBeenCalledWith(trace, expect.any(AbortSignal));
  expect(vi.getTimerCount()).toBe(0);
  const slow = { export: () => new Promise<void>(() => undefined) };
  const pending = deliverTrace(slow, trace, new AbortController().signal);
  const rejection = expect(pending).rejects.toMatchObject({ code: "cancelled" });
  await vi.advanceTimersByTimeAsync(9999);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await rejection;
  expect(vi.getTimerCount()).toBe(0);
  await expect(deliverTrace(slow, trace, AbortSignal.abort())).rejects.toMatchObject({
    code: "cancelled",
  });
  const abort = new AbortController();
  const cancelled = deliverTrace(slow, trace, abort.signal);
  abort.abort();
  await expect(cancelled).rejects.toMatchObject({ code: "cancelled" });
});

it("releases its abort listener and cancels exporter-owned work after success", async () => {
  const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
  let owned: AbortSignal | undefined;
  try {
    await deliverTrace(
      {
        export: (_trace, signal) => {
          owned = signal;
          return Promise.resolve();
        },
      },
      connectionTestTrace("2026-10-08T00:00:00.000Z", "test"),
      new AbortController().signal,
    );
    expect(owned?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  } finally {
    vi.restoreAllMocks();
  }
});
