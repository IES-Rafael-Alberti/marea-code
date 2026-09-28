import * as z from "zod";
import { CriterionAssessmentSchema } from "./evaluation-draft.js";
import { EvaluationIdSchema, RequestIdSchema, RunIdSchema, SkillIdSchema } from "./identifiers.js";
import { Sha256DigestSchema, UtcTimestampSchema } from "./runs.js";
import { RevisionIdSchema } from "./technical.js";
import { CurrentProtocolVersionSchema } from "./version.js";

export const REVIEWED_EVIDENCE_PATH = "/api/v1/dashboard/reviewed-evidence/";
export const MAX_REVIEWED_EVIDENCE_REQUEST_BYTES = 4_096;
export const MAX_REVIEWED_EVIDENCE_RESPONSE_BYTES = 1_048_576;
export const ReviewedCriterionKeySchema = z
  .object({
    skillId: SkillIdSchema,
    digest: Sha256DigestSchema,
    code: z.string().min(1).max(64),
  })
  .strict()
  .readonly();
const scope = {
  protocolVersion: CurrentProtocolVersionSchema,
  requestId: RequestIdSchema,
  classId: RevisionIdSchema,
  limit: z.number().int().min(1).max(50).default(25),
};
export const ReviewedStudentSchema = z
  .object({
    studentId: RevisionIdSchema,
    displayName: z.string().min(1).max(256),
  })
  .strict()
  .readonly();
export const ReviewedCriterionSchema = ReviewedCriterionKeySchema.unwrap()
  .extend({
    statement: z.string().max(1_024),
  })
  .strict()
  .readonly();
export const ReviewedHistoryCursorSchema = z
  .object({
    approvedAt: UtcTimestampSchema,
    evaluationId: EvaluationIdSchema,
  })
  .strict()
  .readonly();
const studentsQuery = z
  .object({ ...scope, kind: z.literal("students"), after: RevisionIdSchema.optional() })
  .strict();
const criteriaQuery = z
  .object({
    ...scope,
    kind: z.literal("criteria"),
    studentId: RevisionIdSchema,
    after: ReviewedCriterionKeySchema.optional(),
  })
  .strict();
const historyQuery = z
  .object({
    ...scope,
    kind: z.literal("history"),
    studentId: RevisionIdSchema,
    criterion: ReviewedCriterionKeySchema,
    after: ReviewedHistoryCursorSchema.optional(),
  })
  .strict();
export const ReviewedEvidenceQuerySchema = z
  .discriminatedUnion("kind", [studentsQuery, criteriaQuery, historyQuery])
  .readonly();
export const ReviewedEvidenceEntrySchema = CriterionAssessmentSchema.unwrap()
  .extend({
    evaluationId: EvaluationIdSchema,
    runId: RunIdSchema,
    generation: z.number().int().min(1),
    approvedAt: UtcTimestampSchema,
    hasLaterApproval: z.boolean(),
  })
  .strict()
  .readonly();
export const ReviewedEvidenceResponseSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("students"),
        query: studentsQuery,
        entries: z.array(ReviewedStudentSchema).max(50),
        next: RevisionIdSchema.nullable(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("criteria"),
        query: criteriaQuery,
        entries: z.array(ReviewedCriterionSchema).max(50),
        next: ReviewedCriterionKeySchema.nullable(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("history"),
        query: historyQuery,
        entries: z.array(ReviewedEvidenceEntrySchema).max(50),
        next: ReviewedHistoryCursorSchema.nullable(),
      })
      .strict(),
  ])
  .readonly();
export type ReviewedEvidenceQuery = z.infer<typeof ReviewedEvidenceQuerySchema>;
export type ReviewedEvidenceResponse = z.infer<typeof ReviewedEvidenceResponseSchema>;
export type ReviewedCriterionKey = z.infer<typeof ReviewedCriterionKeySchema>;
export interface ReviewedEvidencePort {
  read(query: ReviewedEvidenceQuery, signal: AbortSignal): Promise<ReviewedEvidenceResponse>;
}
