import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOperationalTelemetry,
  DISABLED_OPERATIONAL_TELEMETRY,
  previewOperationalTelemetry,
} from "./index.js";
import { createFakeExporter } from "./telemetry.fixture.js";
import { enabledConfiguration, operationalSample } from "./operational-policy.fixture.js";
import type {
  OperationalTelemetryConfiguration,
  OperationalTelemetryDestination,
} from "./operational-policy-contracts.js";

const signal = () => new AbortController().signal;
afterEach(() => vi.useRealTimers());

describe("operational telemetry policy", () => {
  it("defaults to immutable disabled configuration and never invokes supplied ports", async () => {
    const fake = createFakeExporter("private-destination");
    const runtime = createOperationalTelemetry();
    expect(runtime.configuration).toEqual({ enabled: false, destinationCount: 0 });
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime.configuration)).toBe(true);
    expect(Object.isFrozen(DISABLED_OPERATIONAL_TELEMETRY)).toBe(true);
    expect(Object.isFrozen(DISABLED_OPERATIONAL_TELEMETRY.destinations)).toBe(true);
    const disabled = createOperationalTelemetry(
      { ...enabledConfiguration, enabled: false },
      { otlp: fake.port, langfuse: fake.port },
    );
    const report = await disabled.emit(operationalSample(), signal());
    expect(report).toEqual({ status: "disabled", outcomes: [] });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.outcomes)).toBe(true);
    expect(await disabled.close(signal())).toEqual({ outcomes: [] });
    expect(fake.exported).toEqual([]);
    expect(fake.shutdownSignals).toEqual([]);
  });

  it("supports enabled zero destinations without inferring a destination", async () => {
    const runtime = createOperationalTelemetry({ ...enabledConfiguration, destinations: [] });
    expect(runtime.configuration).toEqual({ enabled: true, destinationCount: 0 });
    expect(await runtime.emit(operationalSample(), signal())).toEqual({
      status: "delivered",
      outcomes: [],
    });
  });

  it.each(["otlp", "langfuse"] as const)(
    "applies the common envelope contract to %s",
    async (destination) => {
      const fake = createFakeExporter("https-private-credentials");
      const runtime = createOperationalTelemetry(
        { ...enabledConfiguration, destinations: [destination] },
        { [destination]: fake.port },
      );
      const sample = operationalSample();
      const preview = runtime.preview(sample);
      expect(fake.exported).toEqual([]);
      expect(fake.shutdownSignals).toEqual([]);
      expect(preview).toEqual({
        schemaVersion: "1.0",
        eventId: "operation",
        eventName: "operation.completed",
        kind: "metric",
        occurredAt: sample.occurredAt,
        resource: { serviceName: "marea-teacher", serviceVersion: "1.0" },
        attributes: [
          { key: "operation.duration-ms", classification: "operational", value: 125 },
          { key: "operation.succeeded", classification: "operational", value: true },
        ],
      });
      for (const value of [preview, preview.attributes, preview.attributes[0], preview.resource])
        expect(Object.isFrozen(value)).toBe(true);
      const report = await runtime.emit(sample, signal());
      expect(report).toEqual({
        status: "delivered",
        outcomes: [{ exporterId: destination, status: "succeeded" }],
      });
      expect(fake.exported).toEqual([preview]);
      expect(JSON.stringify(report)).not.toContain("private");
    },
  );

  it("denies classifications even on allowed keys and redacts operational strings", () => {
    const sample = operationalSample();
    expect(
      previewOperationalTelemetry({
        ...sample,
        attributes: [
          { key: "operation.duration-ms", classification: "student-content", value: 10 },
          { key: "operation.succeeded", classification: "pseudonymous", value: true },
        ],
      }).attributes,
    ).toEqual([]);
    expect(
      previewOperationalTelemetry({
        ...sample,
        attributes: [
          { key: "operation.succeeded", classification: "operational", value: "private-content" },
        ],
      }).attributes,
    ).toEqual([{ key: "operation.succeeded", classification: "operational", value: "[REDACTED]" }]);
  });

  it("isolates optional failure and snapshots administrator selection and adapter methods", async () => {
    const otlp = createFakeExporter("private-otlp", {
      export: () => Promise.reject(new Error("private endpoint and secret")),
    });
    const langfuse = createFakeExporter("private-langfuse");
    const config = {
      ...enabledConfiguration,
      destinations: ["otlp", "langfuse"] as OperationalTelemetryDestination[],
    };
    const adapters = { otlp: otlp.port, langfuse: langfuse.port };
    const runtime = createOperationalTelemetry(config, adapters);
    config.enabled = false;
    config.maxInFlight = 0;
    config.destinations.length = 0;
    adapters.otlp = langfuse.port;
    const report = await runtime.emit(operationalSample(), signal());
    expect(report).toEqual({
      status: "delivered",
      outcomes: [
        { exporterId: "otlp", status: "failed" },
        { exporterId: "langfuse", status: "succeeded" },
      ],
    });
    expect(otlp.exported[0]).toBe(langfuse.exported[0]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(runtime.configuration).toEqual({ enabled: true, destinationCount: 2 });
    expect((await runtime.emit(operationalSample(), signal())).status).toBe("delivered");
  });

  it("returns safe invalid outcomes and releases admission after validation failure", async () => {
    const runtime = createOperationalTelemetry({
      ...enabledConfiguration,
      destinations: [],
      maxInFlight: 1,
    });
    expect(await runtime.emit({ ...operationalSample(), occurredAt: "secret" }, signal())).toEqual({
      status: "invalid",
      outcomes: [],
    });
    expect((await runtime.emit(operationalSample(), signal())).status).toBe("delivered");
  });

  it("bounds admission without queueing and releases slots on completion", async () => {
    const pending = Promise.withResolvers<undefined>();
    const fake = createFakeExporter("otlp", { export: () => pending.promise });
    const runtime = createOperationalTelemetry(
      { ...enabledConfiguration, destinations: ["otlp"], maxInFlight: 1 },
      { otlp: fake.port },
    );
    const first = runtime.emit(operationalSample(), signal());
    expect(await runtime.emit(operationalSample(), signal())).toEqual({
      status: "busy",
      outcomes: [],
    });
    expect(fake.exported).toHaveLength(1);
    runtime.preview(operationalSample());
    expect(fake.exported).toHaveLength(1);
    pending.resolve(undefined);
    await first;
    expect((await runtime.emit(operationalSample(), signal())).status).toBe("delivered");
    const closing = runtime.close(signal());
    expect(runtime.close(signal())).toBe(closing);
    expect(await runtime.emit(operationalSample(), signal())).toEqual({
      status: "closed",
      outcomes: [],
    });
    expect(await closing).toEqual({ outcomes: [{ exporterId: "otlp", status: "succeeded" }] });
    expect(fake.shutdownSignals).toHaveLength(1);
    expect(runtime.preview(operationalSample())).toEqual(
      previewOperationalTelemetry(operationalSample()),
    );
  });

  it.each(["timeout", "cancel"])(
    "trips the circuit after %s, isolating an uncooperative exporter",
    async (mode) => {
      vi.useFakeTimers();
      const fake = createFakeExporter("otlp", { export: () => new Promise<void>(() => undefined) });
      const healthy = createFakeExporter("langfuse");
      const runtime = createOperationalTelemetry(
        { ...enabledConfiguration, operationTimeoutMs: 10 },
        { otlp: fake.port, langfuse: healthy.port },
      );
      const controller = new AbortController();
      const delivery = runtime.emit(operationalSample(), controller.signal);
      await vi.advanceTimersByTimeAsync(0);
      if (mode === "cancel") controller.abort();
      else await vi.advanceTimersByTimeAsync(10);
      const report = await delivery;
      expect(report.outcomes).toEqual([
        { exporterId: "otlp", status: mode === "cancel" ? "cancelled" : "timed-out" },
        { exporterId: "langfuse", status: "succeeded" },
      ]);
      expect(fake.exportSignals[0]?.aborted).toBe(true);
      expect(await runtime.emit(operationalSample(), signal())).toEqual({
        status: "unavailable",
        outcomes: [],
      });
      expect(fake.exported).toHaveLength(1);
      await runtime.close(signal());
      expect(fake.shutdownSignals).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([0, 33, 1.5, Number.NaN])("rejects invalid concurrency %s", (maxInFlight) => {
    expect(() =>
      createOperationalTelemetry({ ...DISABLED_OPERATIONAL_TELEMETRY, maxInFlight }),
    ).toThrow("Operational telemetry limits are invalid.");
  });
  it.each([1, 32])("accepts concurrency boundary %s", (maxInFlight) => {
    expect(
      createOperationalTelemetry({ ...DISABLED_OPERATIONAL_TELEMETRY, maxInFlight }).configuration
        .enabled,
    ).toBe(false);
  });
  it.each([{ destinations: ["otlp", "otlp"] }, { destinations: ["otlp", "langfuse", "other"] }])(
    "rejects duplicate or excess selection $destinations",
    ({ destinations }) => {
      expect(() =>
        createOperationalTelemetry({
          ...enabledConfiguration,
          destinations: destinations as OperationalTelemetryConfiguration["destinations"],
        }),
      ).toThrow("Operational telemetry limits are invalid.");
    },
  );
  it("rejects missing adapters, unsupported destinations and invalid timeouts without leaking input", () => {
    expect(() => createOperationalTelemetry(enabledConfiguration)).toThrow(
      "Operational telemetry adapter is unavailable.",
    );
    expect(() =>
      createOperationalTelemetry({
        ...enabledConfiguration,
        destinations: ["secret" as OperationalTelemetryDestination],
      }),
    ).toThrow("Operational telemetry destination is invalid.");
    expect(() =>
      createOperationalTelemetry({ ...DISABLED_OPERATIONAL_TELEMETRY, operationTimeoutMs: 0 }),
    ).toThrow("Operation timeout is invalid.");
  });
});
