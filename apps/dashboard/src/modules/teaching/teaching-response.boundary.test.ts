import { describe, expect, it, vi } from "vitest";

import { readTeachingResponse } from "./teaching-response.boundary.js";

describe("bounded teaching response reader", () => {
  it("handles empty bodies and UTF-8 split across chunks at the exact byte limit", async () => {
    const signal = new AbortController().signal;
    const add = vi.spyOn(signal, "addEventListener");
    const remove = vi.spyOn(signal, "removeEventListener");
    expect(await readTeachingResponse(new Response(), 0, signal)).toBe("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xc3]));
        controller.enqueue(new Uint8Array([0xa9]));
        controller.close();
      },
    });
    expect(await readTeachingResponse(new Response(stream), 2, signal)).toBe("é");
    expect(stream.locked).toBe(false);
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
  });

  it("counts bytes, cancels overflow and releases the stream without draining it", async () => {
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(new TextEncoder().encode("é"));
    });
    const stream = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
    await expect(
      readTeachingResponse(new Response(stream), 3, new AbortController().signal),
    ).rejects.toThrow(new RangeError("Teaching response byte limit exceeded."));
    expect(pull).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });

  it.each([[0xff], [0xc3]])("rejects malformed or incomplete UTF-8 %j", async (...bytes) => {
    await expect(
      readTeachingResponse(new Response(new Uint8Array(bytes)), 4, new AbortController().signal),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("cancels a pending read on abort and preserves the abort reason", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const abort = new AbortController();
    const reading = readTeachingResponse(new Response(stream), 8, abort.signal);
    const reason = new Error("cancelled");
    abort.abort(reason);
    await expect(reading).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });

  it("preserves abort even when cancelling the transport rejects", async () => {
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        return Promise.reject(new Error("transport closed"));
      },
    });
    const abort = new AbortController();
    const reading = readTeachingResponse(new Response(stream), 8, abort.signal);
    abort.abort();
    await expect(reading).rejects.toBe(abort.signal.reason);
  });
});
