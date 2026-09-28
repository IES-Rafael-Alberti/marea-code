import { telemetryExporterFailure } from "./telemetry-failure.boundary.js";
import { describe, expect, it } from "vitest";
import {
  createTelemetryExporterConfigurationSchema,
  parseTelemetryExporterConfiguration,
  TelemetryExporterError,
  type TelemetryExporterConfiguration,
  type TelemetryExporterFactory,
  type TelemetryExporterErrorCode,
} from "./index.js";

const configuration: TelemetryExporterConfiguration<"otlp"> = {
  destination: "otlp",
  schemaVersion: "1.0",
  operationTimeoutMs: 1000,
  maxRequestBytes: 262_144,
  maxResponseBytes: 65_536,
};

describe("exporter factory contracts", () => {
  const schema = createTelemetryExporterConfigurationSchema();
  it("parses safely without leaking validation details", () => {
    expect(parseTelemetryExporterConfiguration(configuration)).toEqual(configuration);
    expect(Object.isFrozen(parseTelemetryExporterConfiguration(configuration))).toBe(true);
    expect(() => parseTelemetryExporterConfiguration({ secretKey: "private-secret" })).toThrow(
      new TelemetryExporterError("invalid-configuration"),
    );
  });
  it.each(["otlp", "langfuse"])("accepts bounded public %s configuration", (destination) => {
    const parsed = schema.parse({ ...configuration, destination });
    expect(parsed).toEqual({ ...configuration, destination });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(schema.parse({ ...configuration, operationTimeoutMs: 30_000 })).toEqual({
      ...configuration,
      operationTimeoutMs: 30_000,
    });
    expect(
      schema.parse({
        ...configuration,
        operationTimeoutMs: 1,
        maxRequestBytes: 1,
        maxResponseBytes: 1,
      }),
    ).toEqual({
      ...configuration,
      operationTimeoutMs: 1,
      maxRequestBytes: 1,
      maxResponseBytes: 1,
    });
  });
  it.each([
    { destination: "langsmith" },
    { schemaVersion: "2.0" },
    { endpoint: "https://private.invalid" },
    { headers: { authorization: "secret" } },
    { secretKey: "secret" },
    { credentialReference: "secret-name" },
    ...["operationTimeoutMs", "maxRequestBytes", "maxResponseBytes"].flatMap((field) =>
      [0, -1, 1.5, Number.NaN, Infinity, "1", undefined].map((value) => ({ [field]: value })),
    ),
    { operationTimeoutMs: 30_001 },
    { maxRequestBytes: 262_145 },
    { maxResponseBytes: 65_537 },
  ])("rejects unsafe or out-of-bound fields %j", (override) => {
    expect(schema.safeParse({ ...configuration, ...override }).success).toBe(false);
  });
  it.each<TelemetryExporterErrorCode>([
    "invalid-configuration",
    "cancelled",
    "closed",
    "payload-too-large",
    "unavailable",
  ])("exposes only a fixed message and code for %s", (code) => {
    const error = new TelemetryExporterError(code);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("TelemetryExporterError");
    expect(error.message).toBe("Telemetry exporter operation failed.");
    expect(error.code).toBe(code);
    expect(error.cause).toBeUndefined();
    expect(JSON.parse(JSON.stringify(error))).toEqual({ code, name: "TelemetryExporterError" });
  });
  it("keeps the existing port shape and private connection out of the public configuration", async () => {
    const factory: TelemetryExporterFactory<"otlp"> = (settings, connection) => {
      expect(settings).toEqual(configuration);
      expect(connection).toEqual({
        endpoint: "https://private.invalid",
        headers: { authorization: "secret" },
      });
      return {
        id: settings.destination,
        export: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      };
    };
    const port = factory(configuration, {
      endpoint: "https://private.invalid",
      headers: { authorization: "secret" },
    });
    expect(port.id).toBe("otlp");
    await port.export(
      {
        attributes: [],
        eventId: "operation",
        eventName: "operation.completed",
        kind: "metric",
        occurredAt: "2026-09-22T10:00:00.000Z",
        resource: { serviceName: "marea", serviceVersion: "1.0" },
        schemaVersion: "1.0",
      },
      new AbortController().signal,
    );
    await port.shutdown(new AbortController().signal);
    expect(JSON.stringify(configuration)).not.toContain("secret");
  });
});

it("normalizes transport failures without leaking vendor details and prioritizes cancellation", () => {
  const pending = new AbortController();
  const vendor = new Error("https://secret:private@collector.invalid");
  expect(telemetryExporterFailure(vendor, pending.signal)).toEqual(
    new TelemetryExporterError("unavailable"),
  );
  const bounded = new TelemetryExporterError("payload-too-large");
  expect(telemetryExporterFailure(bounded, pending.signal)).toBe(bounded);
  pending.abort();
  for (const failure of [vendor, bounded]) {
    const safe = telemetryExporterFailure(failure, pending.signal);
    expect(safe.code).toBe("cancelled");
    expect(safe.message).toBe("Telemetry exporter operation failed.");
    expect(safe.cause).toBeUndefined();
  }
});
