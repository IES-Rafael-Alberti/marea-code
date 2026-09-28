import type { TelemetryExporterPort } from "./telemetry-contracts.js";

export type TelemetryExporterDestination = "otlp" | "langfuse";

/** Safe to describe publicly. Contains no endpoint, header, credential or secret reference. */
export interface TelemetryExporterConfiguration<
  D extends TelemetryExporterDestination = TelemetryExporterDestination,
> {
  readonly destination: D;
  readonly schemaVersion: "1.0";
  readonly operationTimeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
}

/** Private server-only inputs. Never put these objects in a catalog, report or log. */
export interface TelemetryExporterConnections {
  readonly otlp: {
    /** Collector base URL; wire adapter owns the signal-specific HTTP paths. */
    readonly endpoint: string;
    readonly headers: Readonly<Record<string, string>>;
  };
  readonly langfuse: {
    /** Deployment base URL; wire adapter owns the ingestion path. */
    readonly endpoint: string;
    readonly publicKey: string;
    readonly secretKey: string;
  };
}

/** Called only by the operator runtime after explicit enablement, under a deadline. */
export interface TelemetryExporterCredentialResolver {
  readonly resolve: <D extends TelemetryExporterDestination>(
    destination: D,
    signal: AbortSignal,
  ) => Promise<TelemetryExporterConnections[D]>;
}

/** Synchronous construction with no I/O, queues, timers or credential lookup. */
export type TelemetryExporterFactory<D extends TelemetryExporterDestination> = (
  configuration: TelemetryExporterConfiguration<D>,
  connection: TelemetryExporterConnections[D],
) => TelemetryExporterPort;

export type TelemetryExporterErrorCode =
  "invalid-configuration" | "cancelled" | "closed" | "payload-too-large" | "unavailable";

/** No vendor messages, response bodies, URLs, headers or nested causes. */
export class TelemetryExporterError extends Error {
  public constructor(public readonly code: TelemetryExporterErrorCode) {
    super("Telemetry exporter operation failed.");
    this.name = "TelemetryExporterError";
  }
}
