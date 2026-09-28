import { describe, expect, it } from "vitest";
import {
  MAX_TELEMETRY_PREVIEW_BYTES,
  TELEMETRY_PREVIEW_PATH,
  TelemetryPreviewRequestSchema,
  TelemetryPreviewResponseSchema,
} from "./index.js";

const request = {
  protocolVersion: "0.1",
  requestId: "request:preview",
  kind: "telemetry-preview",
  classId: "class:one",
};
const response = {
  protocolVersion: "0.1",
  requestId: "request:preview",
  kind: "telemetry-preview-result",
  mode: "operational-only",
  synthetic: true,
  enabled: false,
  destinationCount: 0,
  envelope: {
    schemaVersion: "1.0",
    eventId: "operation",
    eventName: "operation.completed",
    kind: "metric",
    occurredAt: "2000-01-01T00:00:00.000Z",
    resource: { serviceName: "marea-teacher", serviceVersion: "1.0" },
    attributes: [{ key: "operation.duration-ms", classification: "operational", value: 125 }],
  },
};

describe("telemetry preview wire contract", () => {
  it("pins a bounded additive path and strict request and response", () => {
    expect(MAX_TELEMETRY_PREVIEW_BYTES).toBe(2048);
    expect(TELEMETRY_PREVIEW_PATH).toBe("/api/v1/dashboard/telemetry/preview");
    expect(TelemetryPreviewRequestSchema.parse(request)).toEqual(request);
    const result = TelemetryPreviewResponseSchema.parse(response);
    expect(result).toEqual(response);
    for (const value of [
      result,
      result.envelope,
      result.envelope.resource,
      result.envelope.attributes,
      result.envelope.attributes[0],
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(TelemetryPreviewRequestSchema.parse(request))).toBe(true);
  });
  it.each(["actorId", "tenantId", "enabled", "destinations", "event", "consent"])(
    "rejects teacher authority field %s",
    (field) => {
      expect(
        TelemetryPreviewRequestSchema.safeParse({ ...request, [field]: "forged" }).success,
      ).toBe(false);
    },
  );
  it.each(["protocolVersion", "requestId", "kind", "classId"])("requires valid %s", (field) => {
    expect(TelemetryPreviewRequestSchema.safeParse({ ...request, [field]: "" }).success).toBe(
      false,
    );
    expect(
      TelemetryPreviewRequestSchema.safeParse({ ...request, [field]: undefined }).success,
    ).toBe(false);
  });
  it.each([-1, 3, 0.5])("rejects destination count %s", (destinationCount) => {
    expect(
      TelemetryPreviewResponseSchema.safeParse({ ...response, destinationCount }).success,
    ).toBe(false);
  });
  it.each([0, 2])("accepts destination count %s", (destinationCount) => {
    expect(
      TelemetryPreviewResponseSchema.parse({ ...response, destinationCount }).destinationCount,
    ).toBe(destinationCount);
  });
  it.each([true, false, 0, "[REDACTED]"])("accepts safe attribute %s", (value) => {
    expect(
      TelemetryPreviewResponseSchema.safeParse({
        ...response,
        envelope: {
          ...response.envelope,
          attributes: [{ key: "operation.succeeded", classification: "operational", value }],
        },
      }).success,
    ).toBe(true);
  });
  it("rejects endpoint leaks, content, unknown resource fields and oversized attribute arrays", () => {
    expect(
      TelemetryPreviewResponseSchema.safeParse({ ...response, endpoint: "secret" }).success,
    ).toBe(false);
    for (const envelope of [
      { ...response.envelope, secret: "secret" },
      { ...response.envelope, resource: { ...response.envelope.resource, endpoint: "secret" } },
      {
        ...response.envelope,
        attributes: Array.from({ length: 3 }, () => response.envelope.attributes[0]),
      },
      {
        ...response.envelope,
        attributes: [
          { key: "operation.succeeded", classification: "operational", value: "secret" },
        ],
      },
      {
        ...response.envelope,
        attributes: [
          { key: "operation.succeeded", classification: "student-content", value: true },
        ],
      },
      {
        ...response.envelope,
        attributes: [{ key: "student.id", classification: "operational", value: true }],
      },
      {
        ...response.envelope,
        attributes: [
          {
            key: "operation.succeeded",
            classification: "operational",
            value: true,
            secret: "secret",
          },
        ],
      },
    ])
      expect(TelemetryPreviewResponseSchema.safeParse({ ...response, envelope }).success).toBe(
        false,
      );
  });
});
