import { describe, expect, it, vi } from "vitest";

import { parseBearerCredential } from "./authentication.js";
import type { SessionPort } from "./contracts.js";
import {
  isJson,
  MAX_CONFIGURABLE_REQUEST_BYTES,
  MAX_REQUEST_CHUNKS,
  readRequest,
  upgradeSession,
} from "./server.boundary.js";

const endpoint = "http://example.test:8443/stream";
const sessions: SessionPort = {
  handle() {
    return Promise.resolve();
  },
};

describe("transport server internals", () => {
  it("parses bearer credentials at the header boundary", () => {
    expect(parseBearerCredential("Bearer token")).toBe("token");
    expect(parseBearerCredential("Bearer ")).toBeUndefined();
  });

  it("classifies JSON media types directly", () => {
    expect(isJson(undefined)).toBe(false);
    expect(isJson("text/plain")).toBe(false);
    expect(isJson("Application/JSON; charset=utf-8")).toBe(true);
  });

  it("handles absent bodies consistently with Content-Length", async () => {
    expect(await readRequest(new Request(endpoint, { method: "POST" }))).toBe("");
    expect(
      await readRequest(
        new Request(endpoint, { headers: { "content-length": "0" }, method: "POST" }),
      ),
    ).toBe("");
    const result = await readRequest(
      new Request(endpoint, { headers: { "content-length": "1" }, method: "POST" }),
    );
    expect(result).toBeInstanceOf(Response);
  });

  it("returns an error response for invalid UTF-8", async () => {
    const result = await readRequest(
      new Request(endpoint, {
        body: new Uint8Array([255]),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      expect(result.status).toBe(400);
    }
  });

  it("supports a bounded product-specific request limit", async () => {
    const exact = new Request(endpoint, { body: "abcd", method: "POST" });
    const oversized = new Request(endpoint, { body: "abcd", method: "POST" });

    await expect(readRequest(exact, 4)).resolves.toBe("abcd");
    const result = await readRequest(oversized, 3);
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) expect(result.status).toBe(413);
  });

  it.each([0, 1.5, MAX_CONFIGURABLE_REQUEST_BYTES + 1])(
    "rejects invalid configurable byte limit %s",
    async (limit) => {
      await expect(readRequest(new Request(endpoint), limit)).rejects.toThrow(
        "The request byte limit is invalid.",
      );
    },
  );

  it.each([1, MAX_CONFIGURABLE_REQUEST_BYTES])(
    "accepts configurable byte limit boundary %s",
    async (limit) => {
      await expect(readRequest(new Request(endpoint), limit)).resolves.toBe("");
    },
  );

  it("bounds the number of request-body reads", async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const body = new ReadableStream<Uint8Array>({
      cancel,
      start(controller) {
        for (let index = 0; index <= MAX_REQUEST_CHUNKS; index += 1) {
          controller.enqueue(new Uint8Array());
        }
      },
    });
    const result = await readRequest(
      new Request(endpoint, { body, method: "POST", ...{ duplex: "half" as const } }),
    );
    expect(result).toBeInstanceOf(Response);
    if (result instanceof Response) {
      expect(result.status).toBe(413);
      expect(await result.text()).toBe(JSON.stringify({ error: { code: "request_too_large" } }));
    }
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("refuses an upgrade without a Bun server environment", () => {
    expect(
      upgradeSession(
        new Request("http://example.test:8443/session"),
        undefined,
        { id: "teacher-1" },
        sessions,
      ),
    ).toBeInstanceOf(Response);
  });
});
