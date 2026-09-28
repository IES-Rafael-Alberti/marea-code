import { TelemetryConfigurationError } from "./errors.js";
import type { TelemetryExporterPort } from "./contracts.js";
import type {
  OperationalTelemetryAdapters,
  OperationalTelemetryConfiguration,
} from "./operational-policy-contracts.js";

const SUPPORTED_DESTINATIONS: ReadonlySet<string> = new Set(["otlp", "langfuse"]);

export const DISABLED_OPERATIONAL_TELEMETRY: OperationalTelemetryConfiguration = Object.freeze({
  enabled: false,
  destinations: Object.freeze([]),
  operationTimeoutMs: 1_000,
  maxInFlight: 8,
});

export function operationalExporters(
  configuration: OperationalTelemetryConfiguration,
  adapters: OperationalTelemetryAdapters,
): readonly TelemetryExporterPort[] {
  if (
    !Number.isInteger(configuration.maxInFlight) ||
    configuration.maxInFlight < 1 ||
    configuration.maxInFlight > 32 ||
    configuration.destinations.length > 2 ||
    new Set(configuration.destinations).size !== configuration.destinations.length
  ) {
    throw new TelemetryConfigurationError("Operational telemetry limits are invalid.");
  }
  const selected = configuration.destinations.map((destination) => {
    if (!SUPPORTED_DESTINATIONS.has(destination)) {
      throw new TelemetryConfigurationError("Operational telemetry destination is invalid.");
    }
    const adapter = adapters[destination];
    if (adapter === undefined) {
      throw new TelemetryConfigurationError("Operational telemetry adapter is unavailable.");
    }
    // Snapshot methods and bind their receiver without exposing the adapter's private ID.
    return Object.freeze({
      id: destination,
      export: adapter.export.bind(adapter),
      shutdown: adapter.shutdown.bind(adapter),
    });
  });
  return configuration.enabled ? selected : [];
}
