import { TelemetryExporterError } from "./telemetry-factory.js";

/** Normalize transport failures without exposing vendor messages, while cancellation wins. */
export function telemetryExporterFailure(
  error: unknown,
  signal: AbortSignal,
): TelemetryExporterError {
  if (signal.aborted) return new TelemetryExporterError("cancelled");
  return error instanceof TelemetryExporterError
    ? error
    : new TelemetryExporterError("unavailable");
}
