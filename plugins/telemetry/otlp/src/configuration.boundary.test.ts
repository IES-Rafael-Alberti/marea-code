import { expect, it } from "vitest";
import type {
  TelemetryExporterConnections,
  TelemetryExporterConfiguration,
} from "@marea/plugin-api";
import { createOtlpExporter } from "./exporter.js";
import { connection, settings } from "./otlp.fixture.js";

it.each([
  "garbage",
  "ftp://localhost",
  "https://user:secret@localhost",
  "https://user@localhost",
  "https://localhost?token=secret",
  "https://localhost#secret",
])("rejects unsafe endpoint %s", (endpoint) => {
  expect(() => createOtlpExporter(settings, { ...connection(), endpoint })).toThrow(
    expect.objectContaining({ code: "invalid-configuration" }),
  );
});
it.each([
  { host: "other" },
  { "Content-Type": "text/plain" },
  { "bad\nname": "value" },
  { authorization: "secret\r\ninjected: value" },
  { a: "one", A: "two" },
  { a: 1 },
  null,
  [],
  "bad",
])("rejects invalid private headers", (headers) => {
  const input = { ...connection(), headers } as TelemetryExporterConnections["otlp"];
  expect(() => createOtlpExporter(settings, input)).toThrow(
    expect.objectContaining({ code: "invalid-configuration" }),
  );
});
it.each([
  { destination: "langfuse" },
  { operationTimeoutMs: 0 },
  { maxRequestBytes: 262145 },
  { maxResponseBytes: 65537 },
  { schemaVersion: "2" },
])("validates configuration", (override) => {
  expect(() =>
    createOtlpExporter(
      { ...settings, ...override } as TelemetryExporterConfiguration<"otlp">,
      connection(),
    ),
  ).toThrow(expect.objectContaining({ code: "invalid-configuration" }));
});
it("rejects non-string endpoints, password-only userinfo and leading/trailing header newlines", () => {
  for (const input of [
    { endpoint: new URL("https://collector.invalid"), headers: {} },
    { endpoint: "https://:secret@collector.invalid", headers: {} },
    { ...connection(), headers: { authorization: "\rsynthetic" } },
    { ...connection(), headers: { authorization: "synthetic\n" } },
  ])
    expect(() =>
      createOtlpExporter(settings, input as TelemetryExporterConnections["otlp"]),
    ).toThrow(expect.objectContaining({ code: "invalid-configuration" }));
});
