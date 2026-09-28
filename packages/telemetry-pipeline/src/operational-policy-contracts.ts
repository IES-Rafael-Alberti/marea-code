import type { TelemetryExporterDestination } from "@marea/plugin-api";
import type {
  TelemetryEnvelope,
  TelemetryEvent,
  TelemetryExporterOutcome,
  TelemetryExporterPort,
  TelemetryPipeline,
} from "./contracts.js";

export type OperationalTelemetryDestination = TelemetryExporterDestination;

/** Administrator-owned immutable deployment settings; never a teacher preference. */
export interface OperationalTelemetryConfiguration {
  readonly enabled: boolean;
  readonly destinations: readonly OperationalTelemetryDestination[];
  readonly operationTimeoutMs: number;
  readonly maxInFlight: number;
}

export interface OperationalTelemetryReport {
  readonly status: "disabled" | "busy" | "closed" | "invalid" | "delivered" | "unavailable";
  readonly outcomes: readonly TelemetryExporterOutcome[];
}

export interface OperationalTelemetryRuntime {
  readonly preview: (event: TelemetryEvent) => TelemetryEnvelope;
  readonly configuration: Readonly<{ enabled: boolean; destinationCount: number }>;
  readonly emit: (
    event: TelemetryEvent,
    signal: AbortSignal,
  ) => Promise<OperationalTelemetryReport>;
  readonly close: TelemetryPipeline["close"];
}

/** Only these prepared ports can be selected. Credentials remain inside their closures. */
export type OperationalTelemetryAdapters = Readonly<
  Partial<Record<OperationalTelemetryDestination, TelemetryExporterPort>>
>;
