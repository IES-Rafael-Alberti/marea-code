import type { TelemetryEvent } from "./contracts.js";
import { createTelemetryPipeline } from "./pipeline.js";
import {
  DISABLED_OPERATIONAL_TELEMETRY,
  operationalExporters,
} from "./operational-configuration.js";
import type {
  OperationalTelemetryAdapters,
  OperationalTelemetryConfiguration,
  OperationalTelemetryReport,
  OperationalTelemetryRuntime,
} from "./operational-policy-contracts.js";
import {
  OPERATIONAL_POLICY,
  OPERATIONAL_RESOURCE,
  operationalEvent,
  previewOperationalTelemetry,
} from "./operational-sanitizer.js";

const noDelivery = (status: OperationalTelemetryReport["status"]): OperationalTelemetryReport =>
  Object.freeze({ status, outcomes: Object.freeze([]) });

export function createOperationalTelemetry(
  configuration: OperationalTelemetryConfiguration = DISABLED_OPERATIONAL_TELEMETRY,
  adapters: OperationalTelemetryAdapters = {},
): OperationalTelemetryRuntime {
  const exporters = operationalExporters(configuration, adapters);
  const maxInFlight = configuration.maxInFlight;
  const enabled = configuration.enabled;
  const pipeline = createTelemetryPipeline({
    exporters,
    operationTimeoutMs: configuration.operationTimeoutMs,
    policy: OPERATIONAL_POLICY,
    resource: OPERATIONAL_RESOURCE,
  });
  let inFlight = 0;
  let closed = false;
  let interrupted = false;
  const emit = async (
    event: TelemetryEvent,
    signal: AbortSignal,
  ): Promise<OperationalTelemetryReport> => {
    if (closed) return noDelivery("closed");
    if (!enabled) return noDelivery("disabled");
    if (interrupted) return noDelivery("unavailable");
    if (inFlight >= maxInFlight) return noDelivery("busy");
    inFlight += 1;
    try {
      const report = await pipeline.emit(operationalEvent(event), signal);
      if (report.outcomes.some(({ status }) => status === "timed-out" || status === "cancelled")) {
        interrupted = true;
      }
      return Object.freeze({ status: "delivered", outcomes: report.outcomes });
    } catch {
      return noDelivery("invalid");
    } finally {
      inFlight -= 1;
    }
  };
  return Object.freeze({
    configuration: Object.freeze({ enabled, destinationCount: exporters.length }),
    preview: previewOperationalTelemetry,
    emit,
    close: (signal: AbortSignal) => {
      closed = true;
      return pipeline.close(signal);
    },
  });
}
