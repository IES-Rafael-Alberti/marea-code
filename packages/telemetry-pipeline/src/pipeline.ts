import { validateTelemetryPipelineOptions } from "./configuration.js";
import type {
  TelemetryDeliveryReport,
  TelemetryEnvelope,
  TelemetryEvent,
  TelemetryExporterOutcome,
  TelemetryExporterPort,
  TelemetryPipeline,
  TelemetryPipelineOptions,
  TelemetryShutdownReport,
} from "./contracts.js";
import { runBoundedOperation } from "./deadline.js";
import { TelemetryPipelineClosedError } from "./errors.js";
import { sanitizeTelemetryEvent } from "./sanitize.js";

type ExporterOperation = (exporter: TelemetryExporterPort, signal: AbortSignal) => Promise<void>;

async function fanOut(
  exporters: readonly TelemetryExporterPort[],
  signal: AbortSignal,
  timeoutMs: number,
  operation: ExporterOperation,
): Promise<readonly TelemetryExporterOutcome[]> {
  const outcomes = await Promise.all(
    exporters.map(async (exporter) =>
      Object.freeze({
        exporterId: exporter.id,
        status: await runBoundedOperation(
          (operationSignal) => operation(exporter, operationSignal),
          signal,
          timeoutMs,
        ),
      }),
    ),
  );
  return Object.freeze(outcomes);
}

function exportEnvelope(envelope: TelemetryEnvelope): ExporterOperation {
  return (exporter, signal) => exporter.export(envelope, signal);
}

const SHUTDOWN_EXPORTER: ExporterOperation = (exporter, signal) => exporter.shutdown(signal);

export function createTelemetryPipeline(options: TelemetryPipelineOptions): TelemetryPipeline {
  validateTelemetryPipelineOptions(options);
  const exporters = Object.freeze([...options.exporters]);
  const operationTimeoutMs = options.operationTimeoutMs;
  const resource = Object.freeze({ ...options.resource });
  const policy = Object.freeze({
    allowedAttributeKeys: Object.freeze([...options.policy.allowedAttributeKeys]),
    allowedDataClassifications: Object.freeze([...options.policy.allowedDataClassifications]),
    redactedAttributeKeys: Object.freeze([...options.policy.redactedAttributeKeys]),
  });
  let pendingDeliveries: Promise<void> = Promise.resolve();
  let acceptingEvents = true;
  let shutdown: Promise<TelemetryShutdownReport> | undefined;

  const emit = async (
    event: TelemetryEvent,
    signal: AbortSignal,
  ): Promise<TelemetryDeliveryReport> => {
    if (!acceptingEvents) {
      throw new TelemetryPipelineClosedError();
    }
    const envelope = sanitizeTelemetryEvent(event, policy, resource);
    const delivery = fanOut(exporters, signal, operationTimeoutMs, exportEnvelope(envelope));
    pendingDeliveries = Promise.all([pendingDeliveries, delivery]).then(() => undefined);
    const outcomes = await delivery;
    return Object.freeze({ envelope, outcomes });
  };

  const close = (signal: AbortSignal): Promise<TelemetryShutdownReport> => {
    acceptingEvents = false;
    shutdown ??= pendingDeliveries
      .then(() => fanOut(exporters, signal, operationTimeoutMs, SHUTDOWN_EXPORTER))
      .then((outcomes) => Object.freeze({ outcomes }));
    return shutdown;
  };

  return Object.freeze({ close, emit });
}
