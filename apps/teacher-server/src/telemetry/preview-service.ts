import {
  CURRENT_PROTOCOL_VERSION,
  TelemetryPreviewResponseSchema,
  type TelemetryPreviewRequest,
  type TelemetryPreviewResponse,
} from "@marea/protocol";
import type { OperationalTelemetryRuntime, TelemetryEvent } from "@marea/telemetry-pipeline";
import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";

const sample: TelemetryEvent = {
  id: "synthetic-preview",
  name: "synthetic.preview",
  kind: "trace",
  occurredAt: "2000-01-01T00:00:00.000Z",
  attributes: [
    { key: "operation.duration-ms", value: 125, classification: "operational" },
    {
      key: "operation.succeeded",
      value: "synthetic-sensitive-value",
      classification: "operational",
    },
    {
      key: "student.message",
      value: "synthetic-student-content",
      classification: "student-content",
    },
    { key: "actor.id", value: "synthetic-actor", classification: "pseudonymous" },
  ],
};

export interface TelemetryPreviewService {
  preview(
    identity: AuthenticatedIdentity,
    request: TelemetryPreviewRequest,
  ): TelemetryPreviewResponse;
}

export interface TelemetryPreviewDependencies {
  readonly membership: { requireTeacherClass(teacherId: string, classId: string): void };
  readonly telemetry: Pick<OperationalTelemetryRuntime, "preview" | "configuration">;
}

export function createTelemetryPreviewService(
  dependencies: TelemetryPreviewDependencies,
): TelemetryPreviewService {
  return {
    preview(identity, request) {
      if (identity.role !== "teacher") throw new TeacherDomainError("dashboard.forbidden");
      dependencies.membership.requireTeacherClass(identity.userId, request.classId);
      return TelemetryPreviewResponseSchema.parse({
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        requestId: request.requestId,
        kind: "telemetry-preview-result",
        mode: "operational-only",
        synthetic: true,
        ...dependencies.telemetry.configuration,
        envelope: dependencies.telemetry.preview(sample),
      });
    },
  };
}
