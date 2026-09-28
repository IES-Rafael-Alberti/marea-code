import { afterEach, expect, it, vi } from "vitest";
import { discardTelemetryPort } from "./port-ownership.js";
import { runtimeFixture } from "./runtime.fixture.js";
afterEach(() => vi.useRealTimers());
it("aborts expired cleanup and does not leave timers after a completed cleanup", async () => {
  vi.useFakeTimers();
  const f = runtimeFixture();
  const signals: AbortSignal[] = [];
  const pending = discardTelemetryPort(
    {
      ...f.otlp.port,
      shutdown: (signal) => {
        signals.push(signal);
        return new Promise(() => undefined);
      },
    },
    10,
  );
  await vi.advanceTimersByTimeAsync(10);
  await pending;
  expect(signals[0]?.aborted).toBe(true);
  await discardTelemetryPort(f.otlp.port, 10);
  expect(vi.getTimerCount()).toBe(0);
});
