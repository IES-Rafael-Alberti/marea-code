import { describe, expect, it } from "vitest";
import { DISABLED_OPERATIONAL_TELEMETRY } from "@marea/telemetry-pipeline";
import { parseOperationalTelemetryConfiguration } from "./operational-configuration.boundary.js";

const valid = {
  enabled: true,
  destinations: ["otlp", "langfuse"],
  operationTimeoutMs: 1000,
  maxInFlight: 8,
};

describe("administrator deployment telemetry parser", () => {
  it("keeps missing configuration disabled and freezes parsed values", () => {
    expect(parseOperationalTelemetryConfiguration(undefined)).toBe(DISABLED_OPERATIONAL_TELEMETRY);
    const result = parseOperationalTelemetryConfiguration(valid);
    expect(result).toEqual(valid);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.destinations)).toBe(true);
  });
  it.each([
    null,
    {},
    { ...valid, enabled: "true" },
    { ...valid, destinations: ["langsmith"] },
    { ...valid, destinations: ["otlp", "langfuse", "otlp"] },
    { ...valid, operationTimeoutMs: 0 },
    { ...valid, operationTimeoutMs: 30001 },
    { ...valid, operationTimeoutMs: 0.5 },
    { ...valid, maxInFlight: 0 },
    { ...valid, maxInFlight: 33 },
    { ...valid, maxInFlight: 1.5 },
    { ...valid, endpoint: "secret-endpoint" },
    { ...valid, consent: true },
  ])("rejects unsafe configuration with a constant safe message", (input) => {
    expect(() => parseOperationalTelemetryConfiguration(input)).toThrow(
      "Operational telemetry configuration is invalid.",
    );
  });
  it.each([1, 30000])("accepts timeout boundary %s", (operationTimeoutMs) => {
    expect(
      parseOperationalTelemetryConfiguration({ ...valid, operationTimeoutMs }).operationTimeoutMs,
    ).toBe(operationTimeoutMs);
  });
  it.each([1, 32])("accepts concurrency boundary %s", (maxInFlight) => {
    expect(parseOperationalTelemetryConfiguration({ ...valid, maxInFlight }).maxInFlight).toBe(
      maxInFlight,
    );
  });
});
