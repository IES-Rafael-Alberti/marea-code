import type { TelemetryEvent } from "./contracts.js";
import { DISABLED_OPERATIONAL_TELEMETRY } from "./operational-configuration.js";
import type { OperationalTelemetryConfiguration } from "./operational-policy-contracts.js";

export const enabledConfiguration: OperationalTelemetryConfiguration = {
  ...DISABLED_OPERATIONAL_TELEMETRY,
  enabled: true,
  destinations: ["otlp", "langfuse"],
};

export function operationalSample(): TelemetryEvent {
  return {
    id: "private-student-id",
    name: "private.student.label",
    kind: "trace",
    occurredAt: "2026-09-22T10:00:00.000Z",
    attributes: [
      { key: "operation.duration-ms", classification: "operational", value: 125 },
      { key: "operation.succeeded", classification: "operational", value: true },
      { key: "student.message", classification: "student-content", value: "private-content" },
      { key: "actor.id", classification: "pseudonymous", value: "private-id" },
      { key: "secret", classification: "operational", value: "private-secret" },
    ],
  };
}
