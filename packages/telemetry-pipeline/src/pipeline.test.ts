import { describe, expect, it } from "vitest";

import type { TelemetryEnvelope, TelemetryExporterPort } from "./contracts.js";
import { TelemetryPipelineClosedError } from "./errors.js";
import { createTelemetryPipeline } from "./pipeline.js";
import { createEvent, createFakeExporter, createOptions } from "./telemetry.fixture.js";

describe("telemetry exporter fan-out", () => {
  it("delivers one sanitized envelope to two exporters in configured result order", async () => {
    const first = createFakeExporter("first");
    const second = createFakeExporter("second");
    const pipeline = createTelemetryPipeline(createOptions([first.port, second.port]));

    const report = await pipeline.emit(createEvent(), new AbortController().signal);

    expect(report.outcomes).toEqual([
      { exporterId: "first", status: "succeeded" },
      { exporterId: "second", status: "succeeded" },
    ]);
    expect(first.exported).toEqual([report.envelope]);
    expect(second.exported).toEqual([report.envelope]);
    expect(first.exported[0]).toBe(second.exported[0]);
    expect(Object.isFrozen(report.outcomes)).toBe(true);
    expect(Object.isFrozen(report.outcomes[0])).toBe(true);
  });

  it("isolates one exporter failure from the other exporter", async () => {
    const failing = createFakeExporter("failing", {
      export: () => Promise.reject(new Error("destination rejected event")),
    });
    const healthy = createFakeExporter("healthy");
    const pipeline = createTelemetryPipeline(createOptions([failing.port, healthy.port]));

    const report = await pipeline.emit(createEvent(), new AbortController().signal);

    expect(report.outcomes).toEqual([
      { exporterId: "failing", status: "failed" },
      { exporterId: "healthy", status: "succeeded" },
    ]);
    expect(healthy.exported).toHaveLength(1);
  });

  it("returns immediately with an empty exporter catalog", async () => {
    const pipeline = createTelemetryPipeline(createOptions());

    const report = await pipeline.emit(createEvent(), new AbortController().signal);

    expect(report.outcomes).toEqual([]);
  });

  it("copies configuration before processing events", async () => {
    const configured = createFakeExporter("configured");
    const addedLater = createFakeExporter("added-later");
    const exporters: TelemetryExporterPort[] = [configured.port];
    const allowedAttributeKeys = ["course.id"];
    const allowedDataClassifications = ["operational"] as const;
    const redactedAttributeKeys: string[] = [];
    const resource = { serviceName: "marea", serviceVersion: "0.0.0" };
    const pipeline = createTelemetryPipeline({
      exporters,
      operationTimeoutMs: 100,
      policy: {
        allowedAttributeKeys,
        allowedDataClassifications,
        redactedAttributeKeys,
      },
      resource,
    });

    exporters.push(addedLater.port);
    allowedAttributeKeys.length = 0;
    redactedAttributeKeys.push("course.id");
    resource.serviceName = "changed";

    const report = await pipeline.emit(createEvent(), new AbortController().signal);

    expect(report.envelope.attributes).toHaveLength(1);
    expect(report.envelope.resource.serviceName).toBe("marea");
    expect(configured.exported).toHaveLength(1);
    expect(addedLater.exported).toHaveLength(0);
  });
});

describe("telemetry pipeline lifecycle", () => {
  it("waits for accepted deliveries before shutting exporters down", async () => {
    const pendingExport = Promise.withResolvers<undefined>();
    const order: string[] = [];
    const exporter = createFakeExporter("exporter", {
      export: async () => {
        order.push("export-started");
        await pendingExport.promise;
        order.push("export-completed");
      },
      shutdown: () => {
        order.push("shutdown");
        return Promise.resolve();
      },
    });
    const pipeline = createTelemetryPipeline(createOptions([exporter.port]));

    const delivery = pipeline.emit(createEvent(), new AbortController().signal);
    const shutdown = pipeline.close(new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["export-started"]);

    pendingExport.resolve(undefined);
    await Promise.all([delivery, shutdown]);

    expect(order).toEqual(["export-started", "export-completed", "shutdown"]);
  });

  it("shuts down two exporters once and returns the same report", async () => {
    const first = createFakeExporter("first");
    const second = createFakeExporter("second");
    const pipeline = createTelemetryPipeline(createOptions([first.port, second.port]));
    const signal = new AbortController().signal;

    const firstClose = pipeline.close(signal);
    const secondClose = pipeline.close(signal);
    const [firstReport, secondReport] = await Promise.all([firstClose, secondClose]);

    expect(firstReport).toBe(secondReport);
    expect(firstReport.outcomes).toEqual([
      { exporterId: "first", status: "succeeded" },
      { exporterId: "second", status: "succeeded" },
    ]);
    expect(first.shutdownSignals).toHaveLength(1);
    expect(second.shutdownSignals).toHaveLength(1);
    expect(Object.isFrozen(firstReport)).toBe(true);
  });

  it("isolates shutdown failures", async () => {
    const failing = createFakeExporter("failing", {
      shutdown: () => Promise.reject(new Error("shutdown failed")),
    });
    const healthy = createFakeExporter("healthy");
    const pipeline = createTelemetryPipeline(createOptions([failing.port, healthy.port]));

    const report = await pipeline.close(new AbortController().signal);

    expect(report.outcomes).toEqual([
      { exporterId: "failing", status: "failed" },
      { exporterId: "healthy", status: "succeeded" },
    ]);
  });

  it("prevents new events as soon as shutdown starts", async () => {
    const exporter = createFakeExporter("exporter", {
      shutdown: () => new Promise<void>(() => undefined),
    });
    const options = createOptions([exporter.port]);
    const pipeline = createTelemetryPipeline({ ...options, operationTimeoutMs: 1 });

    const shutdown = pipeline.close(new AbortController().signal);

    await expect(pipeline.emit(createEvent(), new AbortController().signal)).rejects.toEqual(
      new TelemetryPipelineClosedError(),
    );
    await expect(shutdown).resolves.toEqual({
      outcomes: [{ exporterId: "exporter", status: "timed-out" }],
    });
  });

  it("passes a derived cancellation signal instead of the caller signal", async () => {
    let receivedEnvelope: TelemetryEnvelope | undefined;
    const exporter = createFakeExporter("exporter", {
      export: (envelope) => {
        receivedEnvelope = envelope;
        return Promise.resolve();
      },
    });
    const controller = new AbortController();
    const pipeline = createTelemetryPipeline(createOptions([exporter.port]));

    await pipeline.emit(createEvent(), controller.signal);

    expect(receivedEnvelope?.eventId).toBe("event-1");
    expect(exporter.exportSignals[0]).not.toBe(controller.signal);
  });
});
