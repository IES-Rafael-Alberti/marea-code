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
      runBatch: vi.fn().mockResolvedValue(0),
    };
    const runtime = new EvaluationRuntime({ worker, intervalMs, onError: vi.fn() });
    runtime.start();
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(worker.runBatch).toHaveBeenCalledOnce();
    await runtime.stop();
    runtime.start();
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(worker.runBatch).toHaveBeenCalledTimes(2);
    await runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("runs bounded batches outside requests, starts once and waits for cancellation before stopping", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    const worker = {
      discoverClosedRuns: vi.fn(() => 1),
      runBatch: vi.fn((input: AbortSignal) => {
        signal = input;
        return new Promise<number>((resolve) => {
          finish = () => {
            resolve(1);
          };
        });
      }),
    };
    const runtime = new EvaluationRuntime({ worker, intervalMs: 10, onError: vi.fn() });
    runtime.start();
    runtime.start();
    expect(worker.runBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(worker.discoverClosedRuns).toHaveBeenCalledTimes(1);
    expect(worker.runBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(worker.runBatch).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = runtime.stop().then(() => {
      stopped = true;
    });
    expect(signal?.aborted).toBe(true);
    expect(stopped).toBe(false);
    finish?.();
    await stopping;
    await vi.advanceTimersByTimeAsync(100);
    expect(worker.runBatch).toHaveBeenCalledTimes(1);
    await runtime.stop();
    runtime.start();
    await Promise.all([runtime.stop(), runtime.stop()]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports safe failures and continues subsequent ticks without overlapping", async () => {
    vi.useFakeTimers();
    const worker = {
      discoverClosedRuns: vi.fn(() => 0),
      runBatch: vi
        .fn()
        .mockRejectedValueOnce(new Error("private provider data"))
        .mockResolvedValue(0),
    };
    const onError = vi.fn();
    const runtime = new EvaluationRuntime({ worker, intervalMs: 10, onError });
    runtime.start();
    await vi.advanceTimersByTimeAsync(20);
    expect(worker.runBatch).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls).toEqual([[]]);
    await runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs the housekeeping step before discovery in every tick", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const worker = {
      discoverClosedRuns: vi.fn(() => {
        order.push("discover");
        return 0;
      }),
      runBatch: vi.fn(() => {
        order.push("batch");
        return Promise.resolve(0);
      }),
    };
    const runtime = new EvaluationRuntime({
      worker,
      beforeTick: () => {
        order.push("housekeeping");
      },
      intervalMs: 10,
      onError: vi.fn(),
    });
    runtime.start();
    await vi.advanceTimersByTimeAsync(20);
    await runtime.stop();
    expect(order).toEqual([
      "housekeeping",
      "discover",
      "batch",
      "housekeeping",
      "discover",
      "batch",
    ]);
  });

  it("reports a failed housekeeping step and still evaluates queued work", async () => {
    vi.useFakeTimers();
    const worker = {
      discoverClosedRuns: vi.fn(() => 0),
      runBatch: vi.fn().mockResolvedValue(0),
    };
    const onError = vi.fn();
    const runtime = new EvaluationRuntime({
      worker,
      beforeTick: () => {
        throw new Error("private database detail");
      },
      intervalMs: 10,
      onError,
    });
    runtime.start();
    await vi.advanceTimersByTimeAsync(10);
    await runtime.stop();
    expect(onError.mock.calls).toEqual([[]]);
    expect(worker.discoverClosedRuns).toHaveBeenCalledOnce();
    expect(worker.runBatch).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid interval %s",
    (intervalMs) => {
      expect(
        () =>
          new EvaluationRuntime({
            worker: { discoverClosedRuns: () => 0, runBatch: () => Promise.resolve(0) },
            intervalMs,
            onError: () => undefined,
          }),
      ).toThrow(
        new TypeError("The evaluation worker interval must be an integer from 1 to 2147483647."),
      );
    },
  );
});
