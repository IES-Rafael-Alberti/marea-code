import type { SessionTrace } from "./session-traces.js";
import type { TelemetryEnvelope } from "./telemetry-contracts.js";
import { TelemetryExporterError } from "./telemetry-factory.js";

/** Dedicated full-content entry; never passed through the operational-only sanitizer. */
export function sessionTraceEnvelope(trace: SessionTrace): TelemetryEnvelope {
  const first = trace.spans[0];
  if (first === undefined) throw new TelemetryExporterError("invalid-configuration");
  return {
    trace,
    schemaVersion: "1.0",
    eventId: trace.id,
    eventName: "session.turn",
    kind: "trace",
    occurredAt: first.startedAt,
    resource: { serviceName: "marea-teacher", serviceVersion: trace.release },
    attributes: [],
  };
}
