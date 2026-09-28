import { expect, it } from "vitest";

import { readSseData } from "./sse.boundary.js";

function fragmentedBody(...chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function byteBody(...chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

async function collectData(body: ReadableStream<Uint8Array>): Promise<readonly string[]> {
  const values: string[] = [];
  for await (const value of readSseData(body)) {
    values.push(value);
  }
  return values;
}

it("parses fragmented CRLF data and ignores comments and other SSE fields", async () => {
  await expect(
    collectData(
      fragmentedBody(
        ": keep-alive\r\nevent: completion\r\nda",
        "ta: first\r\n\r\ndata:second\r\n",
        "data: trailing",
      ),
    ),
  ).resolves.toEqual(["first", "second", "trailing"]);
});

it("rejects an overlong unfinished SSE line", async () => {
  await expect(collectData(fragmentedBody(`data: ${"x".repeat(1_048_577)}`))).rejects.toMatchObject(
    {
      code: "invalid-response",
      message: "The inference provider returned an invalid stream.",
      retryable: false,
    },
  );
});

it("accepts the maximum unfinished line length and releases the reader lock", async () => {
  const body = fragmentedBody("x".repeat(1_048_576));

  await expect(collectData(body)).resolves.toEqual([]);
  expect(body.locked).toBe(false);
});

it("emits empty data and ignores an unterminated non-data field", async () => {
  await expect(collectData(fragmentedBody("data:\n", "event: ignored"))).resolves.toEqual([""]);
});

it("preserves a multibyte code point split across byte chunks", async () => {
  const encoded = new TextEncoder().encode("data: €\n");

  await expect(collectData(byteBody(encoded.slice(0, 7), encoded.slice(7)))).resolves.toEqual([
    "€",
  ]);
});
