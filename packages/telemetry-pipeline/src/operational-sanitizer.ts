import {
  REDACTED_VALUE,
  type TelemetryEvent,
  type TelemetryEnvelope,
  type TelemetryRedactionPolicy,
} from "./contracts.js";
import { sanitizeTelemetryEvent } from "./sanitize.js";

export const OPERATIONAL_POLICY: TelemetryRedactionPolicy = Object.freeze({
  allowedAttributeKeys: Object.freeze(["operation.duration-ms", "operation.succeeded"]),
  allowedDataClassifications: Object.freeze(["operational"] as const),
  redactedAttributeKeys: Object.freeze([]),
});

export const OPERATIONAL_RESOURCE = Object.freeze({
  serviceName: "marea-teacher",
  serviceVersion: "1.0",
});

/** No identity, free-form labels or string values cross this operational boundary. */
export function operationalEvent(event: TelemetryEvent): TelemetryEvent {
  return {
    id: "operation",
    name: "operation.completed",
    kind: "metric",
    occurredAt: event.occurredAt,
    attributes: event.attributes.map((attribute) => ({
      ...attribute,
      value: typeof attribute.value === "string" ? REDACTED_VALUE : attribute.value,
    })),
  };
}

/** Pure: no exporters, clock, configuration writes or health state are reachable. */
export function previewOperationalTelemetry(event: TelemetryEvent): TelemetryEnvelope {
  return sanitizeTelemetryEvent(operationalEvent(event), OPERATIONAL_POLICY, OPERATIONAL_RESOURCE);
}
