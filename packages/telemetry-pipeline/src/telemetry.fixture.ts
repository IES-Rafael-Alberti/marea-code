import type {
  TelemetryEnvelope,
  TelemetryEvent,
  TelemetryExporterPort,
  TelemetryPipelineOptions,
} from "./contracts.js";

export interface FakeExporter {
  readonly exported: TelemetryEnvelope[];
  readonly exportSignals: AbortSignal[];
  readonly port: TelemetryExporterPort;
  readonly shutdownSignals: AbortSignal[];
}

export interface FakeExporterBehaviors {
  readonly export?: TelemetryExporterPort["export"];
  readonly shutdown?: TelemetryExporterPort["shutdown"];
}

export function createFakeExporter(
  id: string,
  behaviors: FakeExporterBehaviors = {},
): FakeExporter {
  const exported: TelemetryEnvelope[] = [];
  const exportSignals: AbortSignal[] = [];
  const shutdownSignals: AbortSignal[] = [];
  return {
    exported,
    exportSignals,
    port: {
      export: async (envelope, signal) => {
        exported.push(envelope);
        exportSignals.push(signal);
        await behaviors.export?.(envelope, signal);
      },
      id,
      shutdown: async (signal) => {
        shutdownSignals.push(signal);
        await behaviors.shutdown?.(signal);
      },
    },
    shutdownSignals,
  };
}

export function createEvent(): TelemetryEvent {
  return {
    attributes: [{ classification: "operational", key: "course.id", value: "math" }],
    id: "event-1",
    kind: "trace",
    name: "run.started",
    occurredAt: "2026-09-03T10:00:00.000Z",
  };
}

export function createOptions(
  exporters: readonly TelemetryExporterPort[] = [],
): TelemetryPipelineOptions {
  return {
    exporters,
    operationTimeoutMs: 100,
    policy: {
      allowedAttributeKeys: ["course.id"],
      allowedDataClassifications: ["operational"],
      redactedAttributeKeys: [],
    },
    resource: { serviceName: "marea", serviceVersion: "0.0.0" },
  };
}
