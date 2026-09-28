import { describe, expect, it } from "vitest";

import {
  CapabilitiesRequestSchema,
  CapabilitiesResponseSchema,
  missingCapabilities,
  ServerCapabilitySchema,
} from "./capabilities.js";

describe("capability negotiation", () => {
  it.each(["a.b", "ab.cd", "a.b.c", "events.atomic-batches"])(
    "accepts portable namespaced capability %s",
    (capability) => {
      expect(ServerCapabilitySchema.parse(capability)).toBe(capability);
    },
  );

  it.each(["A.b", "a.B", "!a.b", "a.b!", "a", "a."])(
    "rejects malformed capability %s",
    (capability) => {
      expect(() => ServerCapabilitySchema.parse(capability)).toThrow();
    },
  );

  it("enforces the capability length boundary", () => {
    const maximum = `a.${"b".repeat(126)}`;

    expect(ServerCapabilitySchema.parse(maximum)).toBe(maximum);
    expect(() => ServerCapabilitySchema.parse(`${maximum}b`)).toThrow();
  });

  it("returns a stable diagnostic for a malformed capability", () => {
    expect(ServerCapabilitySchema.safeParse("not-namespaced")).toMatchObject({
      success: false,
      error: { issues: [{ message: "Use a portable namespaced capability." }] },
    });
  });

  it("parses bounded client and server offers", () => {
    const request = CapabilitiesRequestSchema.parse({
      requestId: "request-1",
      clientVersion: "0.1.0",
      supportedProtocolVersions: ["0.1"],
    });
    const response = CapabilitiesResponseSchema.parse({
      requestId: "request-1",
      serverVersion: "0.1.0",
      supportedProtocolVersions: ["0.1", "1.0"],
      capabilities: ["events.atomic-batches", "future.optional-feature"],
      futureOptionalField: true,
    });

    expect(request.supportedProtocolVersions).toEqual(["0.1"]);
    expect(response.capabilities).toContain("future.optional-feature");
  });

  it("allows a future server to advertise an incompatible version", () => {
    const response = CapabilitiesResponseSchema.parse({
      requestId: "request-2",
      serverVersion: "2.0.0",
      supportedProtocolVersions: ["2.0"],
      capabilities: [],
    });

    expect(response.supportedProtocolVersions).toEqual(["2.0"]);
  });

  it.each([
    { supportedProtocolVersions: ["0.1", "0.1"], capabilities: [] },
    { supportedProtocolVersions: ["0.1"], capabilities: ["invalid"] },
    {
      supportedProtocolVersions: ["0.1"],
      capabilities: ["skills.resources", "skills.resources"],
    },
  ])("rejects malformed or duplicate lists", (fields) => {
    expect(() =>
      CapabilitiesResponseSchema.parse({
        requestId: "request-1",
        serverVersion: "0.1.0",
        ...fields,
      }),
    ).toThrow();
  });

  it("returns stable diagnostics for duplicate negotiation entries", () => {
    const duplicateVersions = CapabilitiesResponseSchema.safeParse({
      requestId: "request-1",
      serverVersion: "0.1.0",
      supportedProtocolVersions: ["0.1", "0.1"],
      capabilities: [],
    });
    const duplicateCapabilities = CapabilitiesResponseSchema.safeParse({
      requestId: "request-1",
      serverVersion: "0.1.0",
      supportedProtocolVersions: ["0.1"],
      capabilities: ["skills.resources", "skills.resources"],
    });

    expect(duplicateVersions).toMatchObject({
      success: false,
      error: { issues: [{ message: "Protocol versions must be unique." }] },
    });
    expect(duplicateCapabilities).toMatchObject({
      success: false,
      error: { issues: [{ message: "Server capabilities must be unique." }] },
    });
  });

  it("rejects injected software-version controls", () => {
    expect(() =>
      CapabilitiesRequestSchema.parse({
        requestId: "request-1",
        clientVersion: "0.1.0\nforged",
        supportedProtocolVersions: ["0.1"],
      }),
    ).toThrow();
  });

  it("reports each required capability that is absent", () => {
    const atomicEvents = ServerCapabilitySchema.parse("events.atomic-batches");
    const skillResources = ServerCapabilitySchema.parse("skills.resources");

    expect(missingCapabilities([atomicEvents], [atomicEvents, skillResources])).toEqual([
      "skills.resources",
    ]);
  });
});
