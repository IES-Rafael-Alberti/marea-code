import { describe, expect, it, vi } from "vitest";

import { runBoundedOperation } from "./deadline.js";

describe("bounded exporter operations", () => {
  it("reports a completed operation", async () => {
    await expect(
      runBoundedOperation(() => Promise.resolve(), new AbortController().signal, 100),
    ).resolves.toBe("succeeded");
  });

  it("cleans up its deadline and cancellation listener after completion", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");

    try {
      await runBoundedOperation(() => Promise.resolve(), controller.signal, 100);

      expect(vi.getTimerCount()).toBe(0);
      expect(removeListener).toHaveBeenCalledOnce();
      expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates an operation failure", async () => {
    await expect(
      runBoundedOperation(
        () => Promise.reject(new Error("private exporter failure")),
        new AbortController().signal,
        100,
      ),
    ).resolves.toBe("failed");
  });

  it("does not start an operation when already cancelled", async () => {
    const controller = new AbortController();
    const operation = vi.fn(() => Promise.resolve());
    controller.abort();

    await expect(runBoundedOperation(operation, controller.signal, 100)).resolves.toBe("cancelled");
    expect(operation).not.toHaveBeenCalled();
  });

  it("cancels an operation in progress", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const operation = runBoundedOperation(
      async (signal) => {
        receivedSignal = signal;
        await new Promise<void>(() => undefined);
      },
      controller.signal,
      100,
    );

    controller.abort();

    await expect(operation).resolves.toBe("cancelled");
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("classifies a rejection caused by caller cancellation", async () => {
    const controller = new AbortController();
    const operation = runBoundedOperation(
      async (signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        });
      },
      controller.signal,
      100,
    );

    controller.abort();

    await expect(operation).resolves.toBe("cancelled");
  });

  it("times out an unresponsive operation", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    const operation = runBoundedOperation(
      async (signal) => {
        receivedSignal = signal;
        await new Promise<void>(() => undefined);
      },
      new AbortController().signal,
      10,
    );

    await vi.advanceTimersByTimeAsync(10);

    await expect(operation).resolves.toBe("timed-out");
    expect(receivedSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("classifies a rejection caused by timeout", async () => {
    vi.useFakeTimers();
    const operation = runBoundedOperation(
      async (signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
      new AbortController().signal,
      10,
    );

    await vi.advanceTimersByTimeAsync(10);

    await expect(operation).resolves.toBe("timed-out");
    vi.useRealTimers();
  });
});
