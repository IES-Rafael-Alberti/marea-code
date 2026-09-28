import * as z from "zod";
import { RequestIdSchema } from "./identifiers.js";
import { RevisionIdSchema } from "./technical.js";
import { CurrentProtocolVersionSchema } from "./version.js";

export const MAX_TELEMETRY_PREVIEW_BYTES = 2_048;
export const TELEMETRY_PREVIEW_PATH = "/api/v1/dashboard/telemetry/preview";

export const TelemetryPreviewRequestSchema = z
  .object({
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    kind: z.literal("telemetry-preview"),
    classId: RevisionIdSchema,
  })
  .strict()
  .readonly();

export const TelemetryPreviewResponseSchema = z
  .object({
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    kind: z.literal("telemetry-preview-result"),
    mode: z.literal("operational-only"),
    synthetic: z.literal(true),
    enabled: z.boolean(),
    destinationCount: z.number().int().min(0).max(2),
    envelope: z
      .object({
        schemaVersion: z.literal("1.0"),
        eventId: z.literal("operation"),
        eventName: z.literal("operation.completed"),
        kind: z.literal("metric"),
        occurredAt: z.literal("2000-01-01T00:00:00.000Z"),
        resource: z
          .object({
            serviceName: z.literal("marea-teacher"),
            serviceVersion: z.literal("1.0"),
          })
          .strict()
          .readonly(),
        attributes: z
          .array(
            z
              .object({
                key: z.enum(["operation.duration-ms", "operation.succeeded"]),
                classification: z.literal("operational"),
                value: z.union([z.number(), z.boolean(), z.literal("[REDACTED]")]),
              })
              .strict()
              .readonly(),
          )
          .max(2)
          .readonly(),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export type TelemetryPreviewRequest = z.infer<typeof TelemetryPreviewRequestSchema>;
export type TelemetryPreviewResponse = z.infer<typeof TelemetryPreviewResponseSchema>;

/** Browser integration supplies cookie credentials and cancels with the module lifecycle. */
export interface TelemetryPreviewPort {
  preview(request: TelemetryPreviewRequest, signal: AbortSignal): Promise<TelemetryPreviewResponse>;
}
