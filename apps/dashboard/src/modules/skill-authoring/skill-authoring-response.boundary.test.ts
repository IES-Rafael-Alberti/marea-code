import { describe, expect, it, vi } from "vitest";

import {
  readSkillAuthoringResponse,
  serializeSkillAuthoringRequest,
} from "./skill-authoring-response.boundary.js";

describe("skill authoring response reader", () => {
  it("serializes requests within a UTF-8 byte bound", () => {
    expect(serializeSkillAuthoringRequest({ text: "é" }, 20)).toBe('{"text":"é"}');
    expect(() => serializeSkillAuthoringRequest({ text: "too long" }, 4)).toThrow(RangeError);
    const exact = JSON.stringify({ text: "é" });
    const exactBytes = new TextEncoder().encode(exact).byteLength;
    expect(serializeSkillAuthoringRequest({ text: "é" }, exactBytes)).toBe(exact);
    expect(() => serializeSkillAuthoringRequest({ text: "é" }, exactBytes - 1)).toThrow(
      "Skill authoring request byte limit exceeded.",
    );
  });

  it("handles an empty body and UTF-8 split across chunks", async () => {
    const empty = await readSkillAuthoringResponse(new Response(), 4, new AbortController().signal);
    expect(empty).toBe("");

    const chunks = [new Uint8Array([0xc3]), new Uint8Array([0xa9])];
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const splitResponse = new Response(stream);
    const splitSignal = new AbortController();
    const removeListener = vi.spyOn(splitSignal.signal, "removeEventListener");
    await expect(readSkillAuthoringResponse(splitResponse, 2, splitSignal.signal)).resolves.toBe(
      "é",
    );
    expect(splitResponse.body?.locked).toBe(false);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("enforces byte limits and fatal UTF-8", async () => {
    const cancel = vi.fn();
    const tooLarge = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel,
    });
    await expect(
      readSkillAuthoringResponse(new Response(tooLarge), 2, new AbortController().signal),
    ).rejects.toThrow("Skill authoring response byte limit exceeded.");
    expect(cancel).toHaveBeenCalledOnce();

    await expect(
      readSkillAuthoringResponse(
        new Response(new Uint8Array([0xff])),
        4,
        new AbortController().signal,
      ),
    ).rejects.toThrow(TypeError);

    const preAborted = new AbortController();
    preAborted.abort(new Error("already cancelled"));
    await expect(readSkillAuthoringResponse(new Response(), 4, preAborted.signal)).rejects.toEqual(
      preAborted.signal.reason,
    );
  });

  it("cancels an active reader when the signal aborts", async () => {
    const abort = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array());
      },
      pull() {
        return new Promise(() => undefined);
      },
    });
    const reading = readSkillAuthoringResponse(new Response(stream), 8, abort.signal);
    abort.abort(new Error("cancelled"));
    await expect(reading).rejects.toEqual(expect.any(Error));

    const rejectingAbort = new AbortController();
    const rejecting = new ReadableStream<Uint8Array>({
      cancel: () => Promise.reject(new Error("cancel failed")),
    });
    const rejectingRead = readSkillAuthoringResponse(
      new Response(rejecting),
      8,
      rejectingAbort.signal,
    );
    rejectingAbort.abort();
    await expect(rejectingRead).rejects.toEqual(expect.any(Error));
  });
});
