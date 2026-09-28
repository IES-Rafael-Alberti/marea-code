import { afterEach, describe, expect, it, vi } from "vitest";

import { EvaluationRuntime } from "./evaluation-runtime.boundary.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("hosted evaluation scheduling", () => {
  it.each([1, 2_147_483_647])("accepts timer boundary %s", async (intervalMs) => {
    vi.useFakeTimers();
    const worker = {
      discoverClosedRuns: vi.fn(() => 0),
      runNext: vi.fn().mockResolvedValue(false),
    };
    const runtime = new EvaluationRuntime({ worker, intervalMs, onError: vi.fn() });
    runtime.start();
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(worker.runNext).toHaveBeenCalledOnce();
    await runtime.stop();
    runtime.start();
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(worker.runNext).toHaveBeenCalledTimes(2);
    await runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("runs bounded serial ticks outside requests, starts once and waits for cancellation before stopping", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    const worker = {
      discoverClosedRuns: vi.fn(() => 1),
      runNext: vi.fn((input: AbortSignal) => {
        signal = input;
        return new Promise<boolean>((resolve) => {
          finish = () => {
            resolve(true);
          };
        });
      }),
    };
    const runtime = new EvaluationRuntime({ worker, intervalMs: 10, onError: vi.fn() });
    runtime.start();
    runtime.start();
    expect(worker.runNext).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(worker.discoverClosedRuns).toHaveBeenCalledTimes(1);
    expect(worker.runNext).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(worker.runNext).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    expect(signal?.aborted).toBe(true);
    expect(stopped).toBe(false);
    finish?.();
    await stopping;
    await vi.advanceTimersByTimeAsync(100);
    expect(worker.runNext).toHaveBeenCalledTimes(1);
    await runtime.stop();
    runtime.start();
    await Promise.all([runtime.stop(), runtime.stop()]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports safe failures and continues subsequent ticks without overlapping", async () => {
    vi.useFakeTimers();
    const worker = {
      discoverClosedRuns: vi.fn(() => 0),
      runNext: vi
        .fn()
        .mockRejectedValueOnce(new Error("private provider data"))
        .mockResolvedValue(false),
    };
    const onError = vi.fn();
    const runtime = new EvaluationRuntime({ worker, intervalMs: 10, onError });
    runtime.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(worker.runNext).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls).toEqual([[]]);
    await runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid interval %s",
    (intervalMs) => {
      expect(
        () =>
          new EvaluationRuntime({
            worker: { discoverClosedRuns: () => 0, runNext: () => Promise.resolve(false) },
            intervalMs,
            onError: () => undefined,
          }),
      ).toThrow(
        new TypeError("The evaluation worker interval must be an integer from 1 to 2147483647."),
      );
    },
  );
});
