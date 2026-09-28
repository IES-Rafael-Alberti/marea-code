import { describe, expect, it, vi } from "vitest";

import type { StreamEvent, StreamPort, TransportContext } from "./contracts.js";
import { createStreamBody, MAX_STREAM_EVENT_CHARACTERS } from "./http-stream.js";

const request = { input: "Help", streamId: "stream_1" } as const;
const principal = { id: "teacher-1" } as const;

async function abortPendingRead(
  source: AbortController,
  port: StreamPort,
  currentContext: () => TransportContext | undefined,
) {
  const enqueue = vi.spyOn(ReadableStreamDefaultController.prototype, "enqueue");
  const reader = createStreamBody(request, principal, port, source.signal).getReader();
  const pendingRead = reader.read();
  await vi.waitFor(() => {
    expect(currentContext()).toBeDefined();
  });
  source.abort();
  expect(await pendingRead).toEqual({ done: true, value: undefined });
  return enqueue;
}

interface ObservedTwoEventStream {
  readonly context: TransportContext | undefined;
  readonly iteratorClosed: boolean;
  readonly port: StreamPort;
}

function observedTwoEventStream(): ObservedTwoEventStream {
  let currentContext: TransportContext | undefined;
  let closed = false;
  return {
    get context() {
      return currentContext;
    },
    get iteratorClosed() {
      return closed;
    },
    port: {
      async *stream(_request, context) {
        await Promise.resolve();
        currentContext = context;
        try {
          yield { data: "first", type: "data" };
          yield { data: "ignored", type: "data" };
        } finally {
          closed = true;
        }
      },
    },
  };
}

describe("HTTP stream", () => {
  it("encodes every event as one NDJSON record", async () => {
    const source = new AbortController();
    const addListener = vi.spyOn(source.signal, "addEventListener");
    const removeListener = vi.spyOn(source.signal, "removeEventListener");
    let streamCalls = 0;
    const port: StreamPort = {
      async *stream(receivedRequest, context) {
        await Promise.resolve();
        streamCalls += 1;
        if (streamCalls > 1) {
          throw new Error("stream factory called more than once");
        }
        expect(receivedRequest).toEqual(request);
        expect(context.principal).toBe(principal);
        expect(context.signal.aborted).toBe(false);
        yield { data: "Hello", type: "data" };
        yield { type: "end" };
      },
    };
    const body = createStreamBody(request, principal, port, source.signal);
    expect(await new Response(body).text()).toBe(
      '{"data":"Hello","type":"data"}\n{"type":"end"}\n',
    );
    expect(addListener).toHaveBeenCalledOnce();
    expect(addListener.mock.calls[0]?.[0]).toBe("abort");
    expect(addListener.mock.calls[0]?.[2]).toEqual({ once: true });
    expect(removeListener).toHaveBeenCalledWith("abort", addListener.mock.calls[0]?.[1]);
    expect(streamCalls).toBe(1);
  });

  it("emits only a public failure record when execution throws", async () => {
    let context: TransportContext | undefined;
    const port: StreamPort = {
      async *stream(_request, receivedContext) {
        await Promise.resolve();
        context = receivedContext;
        yield* [] as StreamEvent[];
        throw new Error("private execution detail");
      },
    };
    const reader = createStreamBody(
      request,
      principal,
      port,
      new AbortController().signal,
    ).getReader();
    let closed = false;
    void reader.closed.then(() => {
      closed = true;
    });
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closedBeforeCleanup = closed;
    await reader.cancel();
    expect(text).toBe('{"type":"error","code":"stream_failed"}\n');
    expect(text).not.toContain("private execution detail");
    expect(closedBeforeCleanup).toBe(true);
    expect(context?.signal.aborted).toBe(true);
  });

  it("bounds data events before serializing them", async () => {
    const exactPort: StreamPort = {
      async *stream() {
        await Promise.resolve();
        yield { data: "x".repeat(MAX_STREAM_EVENT_CHARACTERS), type: "data" };
      },
    };
    const exactBody = createStreamBody(request, principal, exactPort, new AbortController().signal);
    expect((await new Response(exactBody).text()).length).toBeGreaterThan(
      MAX_STREAM_EVENT_CHARACTERS,
    );

    let oversizedIteratorClosed = false;
    const oversizedPort: StreamPort = {
      async *stream() {
        await Promise.resolve();
        try {
          yield { data: "x".repeat(MAX_STREAM_EVENT_CHARACTERS + 1), type: "data" };
          yield { data: "ignored", type: "data" };
        } finally {
          oversizedIteratorClosed = true;
        }
      },
    };
    const oversizedBody = createStreamBody(
      request,
      principal,
      oversizedPort,
      new AbortController().signal,
    );
    expect(await new Response(oversizedBody).text()).toBe(
      '{"type":"error","code":"stream_failed"}\n',
    );
    await vi.waitFor(() => {
      expect(oversizedIteratorClosed).toBe(true);
    });
  });

  it("does not start production for an already-aborted request", async () => {
    const source = new AbortController();
    source.abort();
    const stream = vi.fn<StreamPort["stream"]>(async function* () {
      await Promise.resolve();
      yield { type: "end" };
    });
    const body = createStreamBody(request, principal, { stream }, source.signal);
    expect(await new Response(body).text()).toBe("");
    expect(stream).not.toHaveBeenCalled();
  });

  it("advances a fast producer only when the consumer pulls", async () => {
    let advances = 0;
    const port: StreamPort = {
      async *stream() {
        await Promise.resolve();
        advances += 1;
        yield { data: "first", type: "data" };
        advances += 1;
        yield { data: "second", type: "data" };
      },
    };
    const reader = createStreamBody(
      request,
      principal,
      port,
      new AbortController().signal,
    ).getReader();
    await Promise.resolve();
    expect(advances).toBe(0);

    expect(new TextDecoder().decode((await reader.read()).value)).toContain("first");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(advances).toBe(1);

    expect(new TextDecoder().decode((await reader.read()).value)).toContain("second");
    expect(advances).toBe(2);
    await reader.cancel();
  });

  it("closes a pending iterator when the request aborts", async () => {
    const source = new AbortController();
    const gate = Promise.withResolvers<undefined>();
    let context: TransportContext | undefined;
    let iteratorClosed = false;
    const port: StreamPort = {
      async *stream(_request, receivedContext) {
        context = receivedContext;
        try {
          await gate.promise;
          yield { data: "ignored", type: "data" };
        } finally {
          iteratorClosed = true;
        }
      },
    };
    const enqueue = await abortPendingRead(source, port, () => context);
    expect(context?.signal.aborted).toBe(true);
    gate.resolve(undefined);
    await vi.waitFor(() => {
      expect(iteratorClosed).toBe(true);
    });
    expect(enqueue).not.toHaveBeenCalled();
    enqueue.mockRestore();
  });

  it("suppresses a pending iterator failure after an abort", async () => {
    const source = new AbortController();
    const next = Promise.withResolvers<IteratorResult<StreamEvent>>();
    let context: TransportContext | undefined;
    const port: StreamPort = {
      stream(_request, receivedContext) {
        context = receivedContext;
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                return next.promise;
              },
              return() {
                return Promise.resolve({ done: true as const, value: undefined });
              },
            };
          },
        };
      },
    };
    const enqueue = await abortPendingRead(source, port, () => context);
    next.reject(new Error("failure after abort"));
    await Promise.resolve();
    await Promise.resolve();
    expect(context?.signal.aborted).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    enqueue.mockRestore();
  });

  it("contains iterator cleanup failures", async () => {
    function portWithReturn(
      returnIterator: () => Promise<IteratorResult<StreamEvent>>,
    ): StreamPort {
      return {
        stream() {
          return {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  return Promise.resolve({ done: false as const, value: { type: "end" } as const });
                },
                return: returnIterator,
              };
            },
          };
        },
      };
    }

    const rejected = createStreamBody(
      request,
      principal,
      portWithReturn(() => Promise.reject(new Error("private rejection"))),
      new AbortController().signal,
    ).getReader();
    await rejected.read();
    await expect(rejected.cancel()).resolves.toBeUndefined();

    const thrown = createStreamBody(
      request,
      principal,
      portWithReturn(() => {
        throw new Error("private synchronous failure");
      }),
      new AbortController().signal,
    ).getReader();
    await thrown.read();
    await expect(thrown.cancel()).resolves.toBeUndefined();
  });

  it("cancels safely before creating an iterator", async () => {
    const stream = vi.fn<StreamPort["stream"]>();
    const body = createStreamBody(request, principal, { stream }, new AbortController().signal);
    await expect(body.cancel()).resolves.toBeUndefined();
    expect(stream).not.toHaveBeenCalled();
  });

  it("cancels an iterator without an explicit return method", async () => {
    const port: StreamPort = {
      stream() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                return Promise.resolve({ done: false as const, value: { type: "end" } as const });
              },
            };
          },
        };
      },
    };
    const reader = createStreamBody(
      request,
      principal,
      port,
      new AbortController().signal,
    ).getReader();
    await reader.read();
    await expect(reader.cancel()).resolves.toBeUndefined();
  });

  it("propagates a request abort while production is pending", async () => {
    const source = new AbortController();
    const observed = observedTwoEventStream();
    const reader = createStreamBody(request, principal, observed.port, source.signal).getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("first");
    source.abort();
    expect(observed.context?.signal.aborted).toBe(true);
    expect((await reader.read()).done).toBe(true);
    await vi.waitFor(() => {
      expect(observed.iteratorClosed).toBe(true);
    });
  });

  it("aborts execution when the response consumer cancels", async () => {
    const source = new AbortController();
    const addListener = vi.spyOn(source.signal, "addEventListener");
    const removeListener = vi.spyOn(source.signal, "removeEventListener");
    const observed = observedTwoEventStream();
    const reader = createStreamBody(request, principal, observed.port, source.signal).getReader();
    await reader.read();
    await reader.cancel();
    expect(observed.context?.signal.aborted).toBe(true);
    expect(removeListener).toHaveBeenCalledWith("abort", addListener.mock.calls[0]?.[1]);
    await vi.waitFor(() => {
      expect(observed.iteratorClosed).toBe(true);
    });
  });
});
