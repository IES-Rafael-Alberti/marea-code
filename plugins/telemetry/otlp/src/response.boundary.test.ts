import { expect, it } from "vitest";
import { consumeResponse } from "./response.boundary.js";

const response = (body: string) =>
  new Response(body, { headers: { "content-type": "application/json" } });
it.each([
  "{}",
  '{"future":true}',
  '{"partialSuccess":null}',
  '{"partialSuccess":{}}',
  '{"partialSuccess":{"rejectedDataPoints":0,"errorMessage":"private"}}',
  '{"partialSuccess":{"rejectedDataPoints":"0"}}',
])("accepts OTLP success %s", async (body) => {
  await expect(consumeResponse(response(body), 100)).resolves.toBeUndefined();
});
it.each([
  "",
  "null",
  "[]",
  "1",
  '{"partialSuccess":[]}',
  '{"partialSuccess":{"rejectedDataPoints":"1"}}',
  '{"partialSuccess":{"rejectedDataPoints":false}}',
  '{"partialSuccess":{"rejectedDataPoints":2}}',
])("rejects invalid/partial responses %s", async (body) => {
  await expect(consumeResponse(response(body), 100)).rejects.toThrow();
});
it("rejects missing bodies, wrong status/content type and declared oversize", async () => {
  for (const reply of [
    new Response(null),
    new Response("{}"),
    new Response("{}", { status: 500 }),
    new Response("{}", { headers: { "content-type": "text/plain" } }),
  ]) {
    await expect(consumeResponse(reply, 100)).rejects.toMatchObject({ code: "unavailable" });
  }
  await expect(
    consumeResponse(new Response("{}", { headers: { "content-length": "101" } }), 100),
  ).rejects.toMatchObject({ code: "payload-too-large" });
});
it("bounds chunked decoded bytes and cancels/releases the reader", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(2));
      controller.enqueue(new Uint8Array(2));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    consumeResponse(new Response(stream, { headers: { "content-type": "application/json" } }), 3),
  ).rejects.toMatchObject({ code: "payload-too-large" });
  expect(cancelled).toBe(true);
  expect(stream.locked).toBe(false);
});
it("accepts an exact byte limit and rejects malformed UTF-8", async () => {
  await expect(consumeResponse(response("{}"), 2)).resolves.toBeUndefined();
  await expect(
    consumeResponse(
      new Response(new Uint8Array([255]), {
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
      2,
    ),
  ).rejects.toThrow();
});
it("checks status independently of media type and accepts declared exact length with whitespace parameters", async () => {
  await expect(
    consumeResponse(
      new Response("{}", { status: 503, headers: { "content-type": "application/json" } }),
      2,
    ),
  ).rejects.toMatchObject({ code: "unavailable" });
  await expect(
    consumeResponse(
      new Response("{}", {
        headers: { "content-length": "2", "content-type": "application/json ; charset=utf-8" },
      }),
      2,
    ),
  ).resolves.toBeUndefined();
  const missing = response("{}");
  missing.headers.delete("content-type");
  await expect(consumeResponse(missing, 2)).rejects.toMatchObject({ code: "unavailable" });
});
it("rejects malformed UTF-8 inside otherwise valid JSON strings", async () => {
  const bytes = new Uint8Array([
    ...new TextEncoder().encode('{"future":"'),
    255,
    ...new TextEncoder().encode('"}'),
  ]);
  await expect(
    consumeResponse(new Response(bytes, { headers: { "content-type": "application/json" } }), 100),
  ).rejects.toThrow();
});
it.each(["null", '{"partialSuccess":{"rejectedDataPoints":"1"}}'])(
  "returns safe error codes for invalid acknowledgement %s",
  async (text) => {
    await expect(consumeResponse(response(text), 100)).rejects.toMatchObject({
      code: "unavailable",
    });
  },
);
it("handles case-insensitive media types and rejects malformed prefixes", async () => {
  await expect(
    consumeResponse(
      new Response("{}", { headers: { "content-type": "Application/JSON;charset=utf-8" } }),
      2,
    ),
  ).resolves.toBeUndefined();
  for (const type of [
    ";application/json",
    "application/jsonx",
    "text/plain;application/json",
    "",
  ]) {
    await expect(
      consumeResponse(new Response("{}", { headers: { "content-type": type } }), 2),
    ).rejects.toMatchObject({ code: "unavailable" });
  }
});
it("releases an errored stream even when cancelling its reader rejects", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(control) {
      control.error(new Error("synthetic stream failure"));
    },
  });
  await expect(
    consumeResponse(new Response(stream, { headers: { "content-type": "application/json" } }), 100),
  ).rejects.toThrow("synthetic stream failure");
  expect(stream.locked).toBe(false);
});
