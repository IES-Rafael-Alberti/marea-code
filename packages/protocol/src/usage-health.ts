import * as z from "zod";
import { RequestIdSchema } from "./identifiers.js";
import { UtcTimestampSchema } from "./runs.js";
import { RevisionIdSchema } from "./technical.js";
import { CurrentProtocolVersionSchema } from "./version.js";

export const USAGE_QUERY_PATH = "/api/v1/dashboard/usage/query";
export const TEACHER_HEALTH_PATH = "/api/v1/dashboard/health/read";
export const MAX_USAGE_HEALTH_REQUEST_BYTES = 2_048;
export const MAX_USAGE_HEALTH_RESPONSE_BYTES = 131_072;
export const TEACHER_HEALTH_FRESHNESS_MS = 300_000;
const envelope = {
  protocolVersion: CurrentProtocolVersionSchema,
  requestId: RequestIdSchema,
  classId: RevisionIdSchema,
};
const QueryTimestamp = UtcTimestampSchema.max(24);
const Count = z.number().int().nonnegative();
export const UsageQuerySchema = z
  .object({
    ...envelope,
    kind: z.literal("class-usage-query"),
    from: QueryTimestamp,
    until: QueryTimestamp,
    limit: z.number().int().min(1).max(100),
    afterAttemptId: RevisionIdSchema.optional(),
  })
  .strict()
  .refine((value) => {
    const duration = Date.parse(value.until) - Date.parse(value.from);
    return duration > 0 && duration <= 31 * 86_400_000;
  }, "Usage windows must be positive and at most 31 days.")
  .readonly();
export const UsageCostSchema = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("unavailable") }).strict(),
    z
      .object({
        status: z.literal("priced"),
        unit: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
        units: Count,
      })
      .strict(),
  ])
  .readonly();
export const UsageEntrySchema = z
  .object({
    attemptId: RevisionIdSchema,
    purpose: z.enum(["tutoring", "evaluation"]),
    state: z.enum(["reserved", "settled", "unknown", "breached"]),
    createdAt: UtcTimestampSchema,
    settledAt: UtcTimestampSchema.nullable(),
    tokenBasis: z.enum(["reported", "reservation"]),
    inputTokens: Count,
    outputTokens: Count,
    cost: UsageCostSchema,
  })
  .strict()
  .readonly();
export const UsageResponseSchema = z
  .object({
    ...envelope,
    kind: z.literal("class-usage-result"),
    generatedAt: UtcTimestampSchema,
    from: UtcTimestampSchema,
    until: UtcTimestampSchema,
    scope: z.literal("page"),
    pricing: z.enum(["complete", "partial", "unavailable"]),
    entries: z.array(UsageEntrySchema).max(100).readonly(),
    nextAfterAttemptId: RevisionIdSchema.nullable(),
  })
  .strict()
  .readonly();
export const TeacherHealthRequestSchema = z
  .object({
    ...envelope,
    kind: z.literal("teacher-health-read"),
  })
  .strict()
  .readonly();
const HealthObservation = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("unknown"), observedAt: z.null() }).strict(),
    z.object({ status: z.enum(["available", "stale"]), observedAt: UtcTimestampSchema }).strict(),
  ])
  .readonly();
export const TeacherHealthResponseSchema = z
  .object({
    ...envelope,
    kind: z.literal("teacher-health-result"),
    generatedAt: UtcTimestampSchema,
    freshnessMs: z.literal(TEACHER_HEALTH_FRESHNESS_MS),
    storage: HealthObservation,
    usageLedger: HealthObservation,
    inference: HealthObservation,
    telemetryDelivery: HealthObservation,
  })
  .strict()
  .readonly();
export type UsageQuery = z.infer<typeof UsageQuerySchema>;
export type UsageResponse = z.infer<typeof UsageResponseSchema>;
export type UsageEntry = z.infer<typeof UsageEntrySchema>;
export type TeacherHealthRequest = z.infer<typeof TeacherHealthRequestSchema>;
export type TeacherHealthResponse = z.infer<typeof TeacherHealthResponseSchema>;

/** The browser supplies cookie credentials; cancellation belongs to the module lifecycle. */
export interface UsageHealthPort {
  queryUsage(request: UsageQuery, signal: AbortSignal): Promise<UsageResponse>;
  readHealth(request: TeacherHealthRequest, signal: AbortSignal): Promise<TeacherHealthResponse>;
}
