import { TelemetryPreviewRequestSchema, TelemetryPreviewResponseSchema } from "@marea/protocol";
// Keep the public response wrapper distinct from the fixed operational sample.
const envelope = {
  attributes: [
    { key: "operation.duration-ms", classification: "operational", value: 125 },
    { key: "operation.succeeded", classification: "operational", value: "[REDACTED]" },
  ],
  resource: { serviceName: "marea-teacher", serviceVersion: "1.0" },
  occurredAt: "2000-01-01T00:00:00.000Z",
  schemaVersion: "1.0",
  eventId: "operation",
  eventName: "operation.completed",
  kind: "metric",
};
export const sample = TelemetryPreviewResponseSchema.parse({
  envelope,
  protocolVersion: "0.1",
  requestId: "preview:test",
  kind: "telemetry-preview-result",
  synthetic: true,
  mode: "operational-only",
  enabled: false,
  destinationCount: 0,
});
export const request = TelemetryPreviewRequestSchema.parse({
  protocolVersion: "0.1",
  requestId: sample.requestId,
  kind: "telemetry-preview",
  classId: "class:a",
});
