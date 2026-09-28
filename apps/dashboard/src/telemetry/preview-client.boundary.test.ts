import { expect, it, vi } from "vitest";
import { MAX_TELEMETRY_PREVIEW_BYTES, TELEMETRY_PREVIEW_PATH } from "@marea/protocol";
import { createPreviewClient, PreviewRequestError } from "./preview-client.boundary.js";
import { request, sample } from "./preview.fixture.js";
const signal = new AbortController().signal;
it("uses the authenticated no-store port and validates the matching synthetic response", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(sample)));
  expect(await createPreviewClient(fetch).preview(request, signal)).toEqual(sample);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(TELEMETRY_PREVIEW_PATH, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  await expect(
    createPreviewClient(fetch).preview({ ...request, classId: "" }, signal),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it.each([401, 403, 500])(
  "returns a safe status for HTTP %s without reading error bodies",
  async (status) => {
    const response = new Response("private credential", { status });
    await expect(
      createPreviewClient(vi.fn().mockResolvedValue(response)).preview(request, signal),
    ).rejects.toEqual(new PreviewRequestError(status));
    expect(response.bodyUsed).toBe(false);
  },
);
it.each([
  new Response(null),
  new Response("not json"),
  new Response(JSON.stringify({ ...sample, synthetic: false })),
  new Response(JSON.stringify({ ...sample, requestId: "other" })),
  new Response(new Uint8Array([255])),
  new Response(new Uint8Array([0xc3])),
])("rejects missing, malformed, non-synthetic and mismatched responses", async (response) => {
  await expect(
    createPreviewClient(vi.fn().mockResolvedValue(response)).preview(request, signal),
  ).rejects.toThrow();
});
it("bounds streamed UTF-8 bytes and cancels the reader on overflow", async () => {
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_TELEMETRY_PREVIEW_BYTES));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel,
    }),
  );
  await expect(
    createPreviewClient(vi.fn().mockResolvedValue(response)).preview(request, signal),
  ).rejects.toThrow("too large");
  expect(cancel).toHaveBeenCalledOnce();
});
it("accepts exactly the byte limit across chunks", async () => {
  const json = JSON.stringify(sample);
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(json));
        controller.enqueue(
          new TextEncoder().encode(" ".repeat(MAX_TELEMETRY_PREVIEW_BYTES - json.length)),
        );
        controller.close();
      },
    }),
  );
  expect(
    await createPreviewClient(vi.fn().mockResolvedValue(response)).preview(request, signal),
  ).toEqual(sample);
});
it("propagates transport and stream failures", async () => {
  const failure = new Error("offline");
  await expect(
    createPreviewClient(vi.fn().mockRejectedValue(failure)).preview(request, signal),
  ).rejects.toBe(failure);
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(failure);
      },
    }),
  );
  await expect(
    createPreviewClient(vi.fn().mockResolvedValue(response)).preview(request, signal),
  ).rejects.toBe(failure);
});

it("decodes split UTF-8 before schema validation and rejects invalid encoding", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ ...sample, unexpected: "é" }));
  const split = bytes.indexOf(0xc3) + 1;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    }),
  );
  await expect(
    createPreviewClient(vi.fn().mockResolvedValue(response)).preview(request, signal),
  ).rejects.toMatchObject({ name: "ZodError" });
  await expect(
    createPreviewClient(vi.fn().mockResolvedValue(new Response(new Uint8Array([255])))).preview(
      request,
      signal,
    ),
  ).rejects.toBeInstanceOf(TypeError);
});

it("retains fixed safe errors for missing bodies, request mismatch and HTTP failures", async () => {
  expect(new PreviewRequestError(403).message).toBe("Telemetry preview unavailable.");
  await expect(
    createPreviewClient(vi.fn().mockResolvedValue(new Response(null))).preview(request, signal),
  ).rejects.toThrow("Missing telemetry preview.");
  await expect(
    createPreviewClient(
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ ...sample, requestId: "different" }))),
    ).preview(request, signal),
  ).rejects.toThrow("Telemetry preview mismatch.");
});
