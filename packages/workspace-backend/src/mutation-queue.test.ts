import { describe, expect, it, vi } from "vitest";

import { MutationQueue } from "./mutation-queue.js";

describe("mutation queue", () => {
  it("runs one mutation at a time in submission order", async () => {
    const queue = new MutationQueue();
    const order: string[] = [];
    let releaseFirst = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run(async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
      return 1;
    });
    const secondAction = vi.fn(() => {
      order.push("second");
      return Promise.resolve(2);
    });
    const second = queue.run(secondAction);

    await vi.waitFor(() => {
      expect(order).toEqual(["first-start"]);
    });
    expect(secondAction).not.toHaveBeenCalled();
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("continues after a failed mutation", async () => {
    const queue = new MutationQueue();
    const failure = new Error("expected failure");
    const first = queue.run(() => Promise.reject(failure));
    const second = queue.run(() => Promise.resolve("completed"));

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBe("completed");
  });
});
