import { CapabilitiesRequestSchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import { createHttpStudentServer, StudentHttpError } from "./http-client.boundary.js";
import type { StudentHttpTransportError } from "./http-transport-diagnostics.boundary.js";

const capabilitiesRequest = CapabilitiesRequestSchema.parse({
  requestId: "request:capabilities",
  clientVersion: "1.0.0",
  supportedProtocolVersions: ["0.1"],
});

async function capabilitiesTransportFailure(
  thrown: Error,
  baseUrl = "https://teacher.example:8443/private/base",
): Promise<StudentHttpTransportError> {
  const server = createHttpStudentServer({
    baseUrl,
    fetch: () => Promise.reject(thrown),
  });
  try {
    await server.capabilities(capabilitiesRequest);
  } catch (error) {
    expect(error).toBeInstanceOf(StudentHttpError);
    return error as StudentHttpTransportError;
  }
  throw new Error("Expected the capabilities request to fail.");
}

describe("HTTP transport diagnostics", () => {
  it.each(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN"])(
    "preserves the allowlisted system cause %s with safe request context",
    async (code) => {
      const error = await capabilitiesTransportFailure(
        Object.assign(new Error("secret socket address and credentials"), { code }),
      );
      expect(error.cause).toEqual({ name: "Error", code });
      expect(error.endpoint).toBe("/v1/capabilities");
      expect(error.serverOrigin).toBe("https://teacher.example:8443");
      expect(error.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(error.elapsedMs)).toBe(true);
      expect(error.message).not.toContain("secret");
      expect(error.cause).not.toHaveProperty("message");
    },
  );

  it("finds a nested TLS system code without retaining its private messages", async () => {
    const error = await capabilitiesTransportFailure(
      new TypeError("fetch failed with secret URL", {
        cause: Object.assign(new Error("secret certificate details"), {
          code: "CERT_HAS_EXPIRED",
        }),
      }),
    );
    expect(error.cause).toEqual({ name: "TypeError", code: "CERT_HAS_EXPIRED" });
  });

  it("classifies a rejected redirect without printing the redirect target", async () => {
    const error = await capabilitiesTransportFailure(
      new TypeError("fetch failed", {
        cause: new Error("unexpected redirect to https://credentials.example/private"),
      }),
    );
    expect(error.cause).toEqual({ name: "TypeError", code: "redirect-rejected" });
    expect(error.message).not.toContain("credentials.example");
  });

  it("falls back to other for unrecognized error names and system codes", async () => {
    const error = await capabilitiesTransportFailure(
      Object.assign(new Error("private network details"), {
        code: "PRIVATE_TOKEN",
        name: "PrivateError",
      }),
    );
    expect(error.cause).toEqual({ name: "other", code: "other" });
  });

  it("measures elapsed transport time without including request data", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(137);
    try {
      const error = await capabilitiesTransportFailure(new TypeError("secret fetch failure"));
      expect(error.elapsedMs).toBe(37);
      expect(error.cause).toEqual({ name: "TypeError", code: "other" });
    } finally {
      clock.mockRestore();
    }
  });
});
