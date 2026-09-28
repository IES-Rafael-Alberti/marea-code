import * as z from "zod";
import { CurrentProtocolVersionSchema } from "./version.js";
import { RequestIdSchema, SkillIdSchema } from "./identifiers.js";
import { UtcTimestampSchema } from "./runs.js";

export const EDUCATIONAL_INSIGHTS_PATH = "/api/v1/dashboard/educational-insights";
export const MAX_INSIGHTS_BYTES = 4 * 1024 * 1024;
const id = z.string().min(1).max(256);
const level = z.number().int().min(0).max(4);
export const LearningTargetSchema = z
  .object({
    key: id,
    skillId: SkillIdSchema,
    code: z.string().min(1).max(64),
    statement: z.string().max(1024),
    levels: z.array(z.string().max(1024)).length(4),
    achieved: level,
    target: z.number().int().min(1).max(4),
    epoch: z.number().int().nonnegative(),
  })
  .strict();
export const AdaptiveContextSchema = z
  .object({
    targets: z.array(LearningTargetSchema).max(4096),
  })
  .strict();
export const InsightsSettingsSchema = z
  .object({ map: z.boolean(), adaptive: z.boolean() })
  .strict();
const scope = {
  protocolVersion: CurrentProtocolVersionSchema,
  requestId: RequestIdSchema,
  classId: id,
};
export const InsightsRequestSchema = z.discriminatedUnion("kind", [
  z.object({ ...scope, kind: z.literal("settings") }).strict(),
  z
    .object({
      ...scope,
      kind: z.literal("configure"),
      settings: InsightsSettingsSchema,
      expectedRevision: id,
    })
    .strict(),
  z.object({ ...scope, kind: z.literal("map"), viewerId: id, visible: z.boolean() }).strict(),
  z
    .object({
      ...scope,
      kind: z.literal("progress"),
      studentId: id.nullable(),
      after: id.nullable().default(null),
    })
    .strict(),
  z
    .object({
      ...scope,
      kind: z.literal("adjust"),
      studentId: id,
      keys: z.array(id).min(1).max(64),
      level,
      reason: z.string().trim().min(1).max(1000),
      expectedRevision: id,
    })
    .strict(),
  z
    .object({
      ...scope,
      kind: z.literal("history"),
      studentId: id,
      key: id,
      after: z.number().int().nonnegative().default(0),
    })
    .strict(),
  z.object({ ...scope, kind: z.literal("reports"), after: id.nullable().default(null) }).strict(),
  z
    .object({
      ...scope,
      kind: z.literal("generate"),
      from: UtcTimestampSchema,
      to: UtcTimestampSchema,
      locale: z.enum(["es", "en", "eu"]),
    })
    .strict(),
  z
    .object({ ...scope, kind: z.enum(["report", "cancel", "retry", "download"]), reportId: id })
    .strict(),
]);
export const AttentionSchema = z
  .object({
    state: z.enum(["green", "yellow", "red"]),
    reason: z.string().min(1).max(320),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .strict();
export const ReportFindingSchema = z
  .object({
    title: z.string().min(1).max(200),
    mode: z.enum(["tutoring", "free"]),
    skillIds: z.array(id).max(64),
    evaluable: z.array(id).max(1000),
    affected: z.array(id).max(1000),
    evidence: z.array(id).max(1000),
    explanation: z.string().max(4000),
    recommendation: z.string().max(2000),
  })
  .strict();
export const ReportSynthesisSchema = z
  .object({
    summary: z.string().max(4000),
    findings: z.array(ReportFindingSchema).max(100),
    recommendation: z.string().max(3000),
  })
  .strict();
export type LearningTarget = z.infer<typeof LearningTargetSchema>;
export type InsightsRequest = z.infer<typeof InsightsRequestSchema>;
export type InsightsSettings = z.infer<typeof InsightsSettingsSchema>;
export type Attention = z.infer<typeof AttentionSchema>;
export type ReportSynthesis = z.infer<typeof ReportSynthesisSchema>;
