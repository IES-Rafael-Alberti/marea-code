import type { TelemetryEnvelope, TelemetryExporterConfiguration } from "@marea/plugin-api";

export const settings: TelemetryExporterConfiguration<"otlp"> = {
  destination: "otlp",
  schemaVersion: "1.0",
  operationTimeoutMs: 1000,
  maxRequestBytes: 262144,
  maxResponseBytes: 65536,
};
export const sample: TelemetryEnvelope = {
  schemaVersion: "1.0",
  eventId: "operation",
  eventName: "operation.completed",
  kind: "metric",
  occurredAt: "2026-09-22T10:00:00.123Z",
  resource: { serviceName: "marea-teacher", serviceVersion: "1.0" },
  attributes: [
    { key: "operation.duration-ms", classification: "operational", value: 125.5 },
    { key: "operation.succeeded", classification: "operational", value: true },
  ],
};
export const connection = () => ({
  endpoint: "http://127.0.0.1:4318/base",
  headers: { authorization: "Bearer synthetic" },
});
export const signal = () => new AbortController().signal;
export const success = () =>
  new Response("{}", { headers: { "content-type": "application/json" } });
