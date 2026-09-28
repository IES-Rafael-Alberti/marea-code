import * as z from "zod";

import { EvaluationDraftSchema } from "./evaluation-draft.js";
import {
  EvaluationIdSchema,
  EventIdSchema,
  IdempotencyKeySchema,
  RequestIdSchema,
  RunIdSchema,
  SkillIdSchema,
  SnapshotIdSchema,
} from "./identifiers.js";
import { Sha256DigestSchema, UtcTimestampSchema } from "./runs.js";
import { CurrentProtocolVersionSchema } from "./version.js";

const envelope = { protocolVersion: CurrentProtocolVersionSchema, requestId: RequestIdSchema };
const versionedSkill = z
  .object({ id: SkillIdSchema, digest: Sha256DigestSchema })
  .strict()
  .readonly();
const record = {
  evaluationId: EvaluationIdSchema,
  runId: RunIdSchema,
  generation: z.number().int().min(1),
  snapshotId: SnapshotIdSchema,
  inputDigest: Sha256DigestSchema,
  evaluator: versionedSkill,
  didacticSkills: z.array(versionedSkill).max(64).readonly(),
  createdAt: UtcTimestampSchema,
  updatedAt: UtcTimestampSchema,
};

export const EvaluationFailureSchema = z.enum([
  "interrupted",
  "inference-failed",
  "invalid-draft",
  "input-too-large",
  "unconfigured",
]);

/** Accessible only to currently authorized teachers, never the student history endpoint. */
export const TeacherEvaluationSchema = z.discriminatedUnion("state", [
  z
    .object({ ...record, state: z.literal("queued") })
    .strict()
    .readonly(),
  z
    .object({ ...record, state: z.literal("running") })
    .strict()
    .readonly(),
  z
    .object({ ...record, state: z.literal("failed"), failure: EvaluationFailureSchema })
    .strict()
    .readonly(),
  z
    .object({ ...record, state: z.literal("draft"), draft: EvaluationDraftSchema })
    .strict()
    .readonly(),
  z
    .object({
      ...record,
      state: z.literal("approved"),
      draft: EvaluationDraftSchema,
      noticeId: EventIdSchema,
      approvedAt: UtcTimestampSchema,
    })
    .strict()
    .readonly(),
]);

export const EvaluationQuerySchema = z
  .object({
    ...envelope,
    kind: z.literal("evaluation-query"),
    runId: RunIdSchema,
  })
  .strict()
  .readonly();

export const GenerateEvaluationRequestSchema = z
  .object({
    ...envelope,
    kind: z.literal("evaluation-generate"),
    runId: RunIdSchema,
    expectedEvaluationId: EvaluationIdSchema.nullable(),
    idempotencyKey: IdempotencyKeySchema,
  })
  .strict()
  .readonly();

export const ApproveEvaluationRequestSchema = z
  .object({
    ...envelope,
    kind: z.literal("evaluation-approve-send"),
    runId: RunIdSchema,
    evaluationId: EvaluationIdSchema,
    idempotencyKey: IdempotencyKeySchema,
    draft: EvaluationDraftSchema,
  })
  .strict()
  .readonly();

export const EvaluationResponseSchema = z
  .object({
    ...envelope,
    kind: z.literal("evaluation-response"),
    evaluation: TeacherEvaluationSchema.nullable(),
  })
  .strict()
  .readonly();

export type TeacherEvaluation = z.infer<typeof TeacherEvaluationSchema>;
export type EvaluationFailure = z.infer<typeof EvaluationFailureSchema>;
export type EvaluationQuery = z.infer<typeof EvaluationQuerySchema>;
export type GenerateEvaluationRequest = z.infer<typeof GenerateEvaluationRequestSchema>;
export type ApproveEvaluationRequest = z.infer<typeof ApproveEvaluationRequestSchema>;
export type EvaluationResponse = z.infer<typeof EvaluationResponseSchema>;
