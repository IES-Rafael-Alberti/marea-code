import { describe, expect, it } from "vitest";

import { ProtocolErrorCodeSchema, ProtocolErrorResponseSchema } from "./errors.js";

describe("protocol errors", () => {
  it.each([
    "auth.invalid",
    "protocol.incompatible",
    "request.invalid",
    "run.unavailable",
    "server.error",
  ])("accepts documented error code %s", (code) => {
    expect(ProtocolErrorCodeSchema.parse(code)).toBe(code);
  });

  it("rejects an empty error code", () => {
    expect(() => ProtocolErrorCodeSchema.parse("")).toThrow();
  });

  it("parses a future-version safe error without localization data", () => {
    const response = ProtocolErrorResponseSchema.parse({
      protocolVersion: "2.0",
      requestId: "request-1",
      error: {
        code: "protocol.incompatible",
        retryable: false,
      },
    });

    expect(response.protocolVersion).toBe("2.0");
  });

  it("parses an error emitted before version or request correlation is known", () => {
    const response = ProtocolErrorResponseSchema.parse({
      error: { code: "request.invalid", retryable: false },
    });

    expect(response.requestId).toBeUndefined();
  });

  it("rejects private diagnostic and localization fields", () => {
    expect(() =>
      ProtocolErrorResponseSchema.parse({
        protocolVersion: "0.1",
        error: {
          code: "server.error",
          retryable: true,
          messageKey: "errors.server.internal-path",
          stack: "secret internal path",
        },
      }),
    ).toThrow();
  });
});
