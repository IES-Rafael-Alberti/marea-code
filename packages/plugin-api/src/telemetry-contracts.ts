export type TelemetryAttributeValue = boolean | number | string;
export type TelemetryDataClassification = "operational" | "pseudonymous" | "student-content";
export type TelemetryEventKind = "metric" | "trace";

export interface ExportedTelemetryAttribute {
  readonly classification: TelemetryDataClassification;
  readonly key: string;
  readonly value: TelemetryAttributeValue;
}

export interface TelemetryResource {
  readonly serviceName: string;
  readonly serviceVersion: string;
}

/** Centrally sanitized, deeply frozen API 1.0 envelope; adapters must not enrich it. */
export interface TelemetryEnvelope {
  /** Present only on the explicit full-content session-export path. */
  readonly trace?: import("./session-traces.js").SessionTrace;
  readonly attributes: readonly ExportedTelemetryAttribute[];
  readonly eventId: string;
  readonly eventName: string;
  readonly kind: TelemetryEventKind;
  readonly occurredAt: string;
  readonly resource: TelemetryResource;
  readonly schemaVersion: "1.0";
}

/** No internal queue/retries. Honor cancellation; shutdown is terminal and idempotent. */
export interface TelemetryExporterPort {
  readonly export: (envelope: TelemetryEnvelope, signal: AbortSignal) => Promise<void>;
  readonly id: string;
  readonly shutdown: (signal: AbortSignal) => Promise<void>;
}
