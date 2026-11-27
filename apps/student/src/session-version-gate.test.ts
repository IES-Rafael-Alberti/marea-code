import { ProtocolVersionSchema, ServerCapabilitySchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import { createFixtureController } from "./student.fixture.js";

type Fixture = ReturnType<typeof createFixtureController>;

function withServerVersion(test: Fixture, serverVersion: string): void {
  const capabilities = test.server.capabilities.bind(test.server);
  test.server.capabilities = async (request) => ({
    ...(await capabilities(request)),
    serverVersion,
  });
}

describe("software version confirmation at startup", () => {
  it.each(["1.0.1", "0.9.9", "1.0.0-preview.2"])(
    "asks once with both versions when the server is %s and the client is 1.0.0",
    async (serverVersion) => {
      const versionGate = vi.fn(() => Promise.resolve());
      const test = createFixtureController({ versionGate });
      withServerVersion(test, serverVersion);
      await test.controller.start("Project One");
      expect(versionGate).toHaveBeenCalledExactlyOnceWith(serverVersion, "1.0.0");
      expect(test.server.openRequests).toHaveLength(1);
    },
  );

  it("does not ask when the versions are equal", async () => {
    const versionGate = vi.fn(() => Promise.resolve());
    const test = createFixtureController({ versionGate });
    await test.controller.start("Project One");
    expect(versionGate).not.toHaveBeenCalled();
  });

  it.each([
    ["0.0.0-dev", "0.1.0-preview.50"],
    ["0.1.0-preview.50", "0.0.0-dev"],
  ])("never asks when the client is %s and the server is %s", async (clientVersion, server) => {
    const versionGate = vi.fn(() => Promise.resolve());
    const test = createFixtureController({ clientVersion, versionGate });
    withServerVersion(test, server);
    await test.controller.start("Project One");
    expect(versionGate).not.toHaveBeenCalled();
  });

  it("starts without a gate even when the versions differ", async () => {
    const test = createFixtureController();
    withServerVersion(test, "2.0.0");
    await expect(test.controller.start("Project One")).resolves.toBeDefined();
  });

  it("stops before authentication, bootstrap or any run when the student declines", async () => {
    const versionGate = vi.fn(() => Promise.reject(new Error("Declined.")));
    const test = createFixtureController({ versionGate });
    withServerVersion(test, "2.0.0");
    await expect(test.controller.start("Project One")).rejects.toThrow("Declined.");
    expect(test.server.loggedIn + test.server.enrolled).toBe(0);
    expect(test.server.bootstrapCalls).toBe(0);
    expect(test.server.openRequests).toHaveLength(0);
  });

  it("keeps blocking an incompatible protocol without asking about versions", async () => {
    const versionGate = vi.fn(() => Promise.resolve());
    const test = createFixtureController({ versionGate });
    test.server.capabilities = (request) =>
      Promise.resolve({
        requestId: request.requestId,
        serverVersion: "2.0.0",
        supportedProtocolVersions: [ProtocolVersionSchema.parse("9.9")],
        capabilities: [],
      });
    await expect(test.controller.start("Project One")).rejects.toThrow("does not support");
    expect(versionGate).not.toHaveBeenCalled();
  });

  it("keeps blocking missing capabilities without asking about versions", async () => {
    const versionGate = vi.fn(() => Promise.resolve());
    const test = createFixtureController({ versionGate });
    test.server.capabilities = (request) =>
      Promise.resolve({
        requestId: request.requestId,
        serverVersion: "2.0.0",
        supportedProtocolVersions: [ProtocolVersionSchema.parse("0.1")],
        capabilities: [ServerCapabilitySchema.parse("marea.auth.student")],
      });
    await expect(test.controller.start("Project One")).rejects.toThrow("missing required");
    expect(versionGate).not.toHaveBeenCalled();
  });
});
