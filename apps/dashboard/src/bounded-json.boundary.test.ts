import { expect, it, vi } from "vitest";
import { readBoundedJson } from "./bounded-json.boundary.js";

function stream(chunks: readonly Uint8Array[], cancel = vi.fn()) {
  return {
    cancel,
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = chunks[0];
        if (next === undefined) controller.close();
        else {
          controller.enqueue(next);
          chunks = chunks.slice(1);
        }
      },
      cancel,
    }),
  };
}

it("parses JSON at exactly the limit and releases the reader after completion", async () => {
  const bytes = new TextEncoder().encode('{"value":"é"}');
  const { body } = stream([bytes.slice(0, 11), bytes.slice(11)]);
  expect(await readBoundedJson(body, bytes.byteLength)).toEqual({ value: "é" });
  expect(body.locked).toBe(true);
});

it("stops at the first byte over the limit and cancels the source", async () => {
  const { body, cancel } = stream([new Uint8Array(3), new Uint8Array(1), new Uint8Array(9)]);
  await expect(readBoundedJson(body, 3)).rejects.toThrow("Dashboard response too large.");
  expect(cancel).toHaveBeenCalledOnce();
});

it("rejects truncated UTF-8 at the end of the stream", async () => {
  const { body } = stream([new TextEncoder().encode('"'), new Uint8Array([0xc3])]);
  await expect(readBoundedJson(body, 10)).rejects.toBeInstanceOf(TypeError);
});
