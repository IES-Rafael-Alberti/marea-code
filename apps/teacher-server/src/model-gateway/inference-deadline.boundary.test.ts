import type {
  InferenceCancellation,
  InferenceProviderEvent,
  InferenceProviderRequest,
} from "@marea/plugin-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cancellationFor } from "./inference-cancellation.js";
import { streamWithinDeadline } from "./inference-deadline.boundary.js";

const request: InferenceProviderRequest = {
  messages: [],
  tools: [],
  requestId: "request:deadline",
  upstreamModel: "synthetic-model",
};
const text: InferenceProviderEvent = { type: "text-delta", text: "Visible" };
const done: IteratorResult<InferenceProviderEvent> = { done: true, value: undefined };
const cancellationError = {
  code: "aborted",
  message: "The inference request was cancelled.",
  retryable: false,
};

function fixture(cleanup?: () => Promise<IteratorResult<InferenceProviderEvent>>) {
  const controller = new AbortController();
  const next = vi
    .fn<() => Promise<IteratorResult<InferenceProviderEvent>>>()
    .mockResolvedValue(done);
  const stream = vi.fn<
    (
      request: InferenceProviderRequest,
      cancellation: InferenceCancellation,
    ) => AsyncIterable<InferenceProviderEvent>
  >(() => ({
    [Symbol.asyncIterator]: () => ({
      next,
      ...(cleanup === undefined ? {} : { return: cleanup }),
    }),
  }));
  return {
    controller,
    next,
    stream,
    iterator: streamWithinDeadline({ stream }, request, cancellationFor(controller.signal), 100),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("bounded provider iteration", () => {
  it("forwards ordered events and clears the timer and subscription on ordinary completion", async () => {
    const test = fixture();
    test.next.mockResolvedValueOnce({ done: false, value: text });
    expect(await test.iterator.next()).toEqual({ done: false, value: text });
    expect(test.stream).toHaveBeenCalledOnce();
    expect(test.stream.mock.calls[0]?.[0]).toBe(request);
    const upstream = test.stream.mock.calls[0]?.[1];
    expect(upstream?.aborted).toBe(false);
    expect(await test.iterator.next()).toEqual(done);
    expect(upstream?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    test.controller.abort();
    expect(test.next).toHaveBeenCalledTimes(2);
  });

  it("rejects pre-cancelled work without contacting a provider", async () => {
    const test = fixture();
    test.controller.abort();
    const subscribe = vi.fn(() => () => undefined);
    const iterator = streamWithinDeadline(
      { stream: test.stream },
      request,
      { aborted: true, subscribe },
      100,
    );
    await expect(iterator.next()).rejects.toMatchObject(cancellationError);
    expect(subscribe).not.toHaveBeenCalled();
    expect(test.stream).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a hung provider independently of its willingness to observe cancellation", async () => {
    const cleanup = vi.fn(() => Promise.resolve(done));
    const test = fixture(cleanup);
    const pending = Promise.withResolvers<IteratorResult<InferenceProviderEvent>>();
    test.next.mockReturnValue(pending.promise);
    let finished = false;
    const result = test.iterator.next().finally(() => {
      finished = true;
    });
    const rejected = expect(result).rejects.toMatchObject({
      code: "deadline-exceeded",
      message: "The configured inference duration limit was reached.",
      retryable: false,
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(test.stream.mock.calls[0]?.[1].aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve(done);
  });

  it("propagates cancellation while suspended at a yield and while awaiting a provider result", async () => {
    for (const duringNext of [false, true]) {
      const cleanup = vi.fn(() => Promise.resolve(done));
      const test = fixture(cleanup);
      test.next.mockImplementationOnce(() => {
        if (duringNext) test.controller.abort();
        return Promise.resolve({ done: false, value: text });
      });
      if (!duringNext) {
        expect(await test.iterator.next()).toEqual({ done: false, value: text });
        test.controller.abort();
      }
      await expect(test.iterator.next()).rejects.toMatchObject(cancellationError);
      expect(test.next).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("cleans up cancellation races and exceptions during subscription or provider creation", async () => {
    for (const fail of ["subscribe", "create", "cancel", "silent-cancel"] as const) {
      const cleanup = vi.fn();
      let cancelled = false;
      const stream = vi.fn((): AsyncIterable<InferenceProviderEvent> => {
        throw new Error("create failed");
      });
      const cancellation = {
        get aborted() {
          return cancelled;
        },
        subscribe(listener: () => void) {
          if (fail === "subscribe") throw new Error("subscribe failed");
          if (fail === "cancel" || fail === "silent-cancel") {
            cancelled = true;
            if (fail === "cancel") listener();
          }
          return cleanup;
        },
      };
      const iterator = streamWithinDeadline({ stream }, request, cancellation, 100);
      await expect(iterator.next()).rejects.toThrow(
        fail === "cancel" || fail === "silent-cancel"
          ? cancellationError.message
          : `${fail} failed`,
      );
      expect(cleanup).toHaveBeenCalledTimes(fail === "subscribe" ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("observes iterator cleanup rejection without losing a completed stream", async () => {
    const cleanup = vi.fn(() => Promise.reject(new Error("cleanup failed")));
    const test = fixture(cleanup);
    expect(await test.iterator.next()).toEqual(done);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await Promise.resolve();
  });
});

it("retains cancellation as the cause while a consumer pauses past the deadline", async () => {
  const test = fixture();
  test.next.mockResolvedValueOnce({ done: false, value: text });
  expect(await test.iterator.next()).toEqual({ done: false, value: text });
  test.controller.abort();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(101);
  await expect(test.iterator.next()).rejects.toMatchObject(cancellationError);
});
