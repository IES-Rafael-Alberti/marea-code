import { describe, expect, it, vi } from "vitest";

import { ClosureFlow } from "./run-closure-flow.js";

function setup(perform: (key: string, signal: AbortSignal) => Promise<void>) {
  const onClosed = vi.fn();
  const changed = vi.fn();
  const flow = new ClosureFlow(perform, onClosed, changed);
  return { flow, onClosed, changed };
}

describe("closing confirmation flow", () => {
  it("opens a confirmation with its own idempotency key and cancels it before anything is sent", () => {
    const perform = vi.fn(() => Promise.resolve());
    const { flow, changed } = setup(perform);
    expect(flow.phase).toBe("idle");
    flow.open();
    expect(flow.phase).toBe("confirming");
    expect(changed).toHaveBeenCalledTimes(1);
    flow.cancel();
    expect(flow.phase).toBe("idle");
    expect(changed).toHaveBeenCalledTimes(2);
    expect(perform).not.toHaveBeenCalled();
  });

  it("closes, tells the host and returns to idle on success", async () => {
    const perform = vi.fn(() => Promise.resolve());
    const { flow, onClosed, changed } = setup(perform);
    flow.open();
    const confirming = flow.confirm();
    expect(flow.phase).toBe("busy");
    await confirming;
    expect(flow.phase).toBe("idle");
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(perform).toHaveBeenCalledWith(
      expect.stringMatching(/^close:[0-9a-f-]{36}$/u),
      expect.any(AbortSignal),
    );
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("cannot be cancelled while the request is in flight", async () => {
    const release = Promise.withResolvers<undefined>();
    const { flow, changed } = setup(() => release.promise);
    flow.open();
    const confirming = flow.confirm();
    const before = changed.mock.calls.length;
    flow.cancel();
    expect(flow.phase).toBe("busy");
    expect(changed).toHaveBeenCalledTimes(before);
    release.resolve(undefined);
    await confirming;
    expect(flow.phase).toBe("idle");
  });

  it("keeps the dialog open after a failure and retries with the same key and a fresh request", async () => {
    const keys: string[] = [];
    const perform = vi
      .fn<(key: string, signal: AbortSignal) => Promise<void>>()
      .mockImplementationOnce((key) => {
        keys.push(key);
        return Promise.reject(new Error("offline"));
      })
      .mockImplementationOnce((key) => {
        keys.push(key);
        return Promise.resolve();
      });
    const { flow, onClosed } = setup(perform);
    flow.open();
    await flow.confirm();
    expect(flow.phase).toBe("failed");
    expect(onClosed).not.toHaveBeenCalled();
    await flow.confirm();
    expect(flow.phase).toBe("idle");
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(keys[1]).toBe(keys[0]);
    flow.open();
    await flow.confirm();
    expect(perform.mock.calls[2]?.[0]).not.toBe(keys[0]);
  });

  it("sends an empty key when confirmed before being opened", async () => {
    const perform = vi.fn<(key: string, signal: AbortSignal) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const { flow } = setup(perform);
    await flow.confirm();
    expect(perform.mock.calls[0]?.[0]).toBe("");
  });

  it("asks for a redraw when a request fails, showing the failed phase", async () => {
    const phases: string[] = [];
    const perform = () => Promise.reject(new Error("offline"));
    const changed = vi.fn(() => phases.push(flow.phase));
    const flow = new ClosureFlow(perform, vi.fn(), changed);
    flow.open();
    await flow.confirm();
    expect(phases).toEqual(["confirming", "busy", "failed"]);
  });

  it("can still be cancelled after a failure", async () => {
    const { flow } = setup(() => Promise.reject(new Error("offline")));
    flow.open();
    await flow.confirm();
    flow.cancel();
    expect(flow.phase).toBe("idle");
  });

  it("aborts the request on disposal and then reports nothing, whether it succeeds or fails", async () => {
    for (const outcome of ["success", "failure"]) {
      const release = Promise.withResolvers<undefined>();
      let signal: AbortSignal | undefined;
      const { flow, onClosed, changed } = setup((_key, received) => {
        signal = received;
        return release.promise;
      });
      flow.open();
      const confirming = flow.confirm();
      const before = changed.mock.calls.length;
      flow.dispose();
      expect(signal?.aborted).toBe(true);
      if (outcome === "success") release.resolve(undefined);
      else release.reject(new Error("aborted"));
      await confirming;
      expect(changed).toHaveBeenCalledTimes(before);
      expect(onClosed).not.toHaveBeenCalled();
    }
  });

  it("disposes safely before anything was sent", () => {
    const { flow } = setup(() => Promise.resolve());
    expect(() => {
      flow.dispose();
    }).not.toThrow();
  });
});
