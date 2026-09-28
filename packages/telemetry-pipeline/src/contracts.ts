import type {
  TelemetryAttributeValue,
  TelemetryDataClassification,
  TelemetryEnvelope,
  TelemetryEventKind,
  TelemetryExporterPort,
  TelemetryResource,
} from "@marea/plugin-api";
export type {
  ExportedTelemetryAttribute,
  TelemetryAttributeValue,
  TelemetryDataClassification,
  TelemetryEnvelope,
  TelemetryEventKind,
  TelemetryExporterPort,
  TelemetryResource,
} from "@marea/plugin-api";

export const MAX_ATTRIBUTE_COUNT = 64;
export const MAX_ATTRIBUTE_KEY_LENGTH = 64;
export const MAX_ATTRIBUTE_VALUE_LENGTH = 512;
export const MAX_EVENT_ID_LENGTH = 128;
export const MAX_EVENT_NAME_LENGTH = 128;
export const MAX_EXPORTER_COUNT = 16;
export const MAX_EXPORTER_ID_LENGTH = 64;
export const MAX_OPERATION_TIMEOUT_MS = 30_000;
export const MAX_SERVICE_NAME_LENGTH = 64;
export const MAX_SERVICE_VERSION_LENGTH = 32;
export const REDACTED_VALUE = "[REDACTED]";
export const TRUNCATED_VALUE = "[VALUE_TOO_LONG]";

export type TelemetryExporterOutcomeStatus = "cancelled" | "failed" | "succeeded" | "timed-out";

export interface TelemetryAttribute {
  readonly classification: TelemetryDataClassification;
  readonly key: string;
  readonly value: TelemetryAttributeValue;
}

export interface TelemetryEvent {
  readonly attributes: readonly TelemetryAttribute[];
  readonly id: string;
  readonly kind: TelemetryEventKind;
  readonly name: string;
  readonly occurredAt: string;
}

export interface TelemetryRedactionPolicy {
  readonly allowedAttributeKeys: readonly string[];
  readonly allowedDataClassifications: readonly TelemetryDataClassification[];
  readonly redactedAttributeKeys: readonly string[];
}

export interface TelemetryExporterOutcome {
  readonly exporterId: string;
  readonly status: TelemetryExporterOutcomeStatus;
}

export interface TelemetryDeliveryReport {
  readonly envelope: TelemetryEnvelope;
  readonly outcomes: readonly TelemetryExporterOutcome[];
}

export interface TelemetryShutdownReport {
  readonly outcomes: readonly TelemetryExporterOutcome[];
}

export interface TelemetryPipeline {
  readonly close: (signal: AbortSignal) => Promise<TelemetryShutdownReport>;
  readonly emit: (event: TelemetryEvent, signal: AbortSignal) => Promise<TelemetryDeliveryReport>;
}

export interface TelemetryPipelineOptions {
  readonly exporters: readonly TelemetryExporterPort[];
  readonly operationTimeoutMs: number;
  readonly policy: TelemetryRedactionPolicy;
  readonly resource: TelemetryResource;
}
