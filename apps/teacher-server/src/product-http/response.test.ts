import { describe, expect, it } from "vitest";
import { RequestIdSchema } from "@marea/protocol";

import { jsonResponse, protocolError } from "./response.js";

describe("product HTTP responses", () => {
  it("sets bounded JSON headers and merges explicit response headers", async () => {
    const response = jsonResponse({ safe: true }, 201, { "x-extra": "value" });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ safe: true });
    expect(Object.fromEntries(response.headers)).toEqual({
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "x-extra": "value",
    });
  });

  it("omits an absent request identifier and preserves a supplied one", async () => {
    const absent = protocolError(403, "request.invalid", false);
    const supplied = protocolError(
      409,
      "run.unavailable",
      true,
      RequestIdSchema.parse("request:one"),
    );

    expect(await absent.json()).toEqual({
      error: { code: "request.invalid", retryable: false },
      protocolVersion: "0.1",
    });
    expect(await supplied.json()).toEqual({
      error: { code: "run.unavailable", retryable: true },
      protocolVersion: "0.1",
      requestId: "request:one",
    });
  });
});
