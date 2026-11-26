import * as z from "zod";
import { RequestIdSchema, RunIdSchema } from "./identifiers.js";
import { RevisionIdSchema } from "./technical.js";
import { CurrentProtocolVersionSchema } from "./version.js";
import { SessionHistoryItemSchema, SessionHistoryQuerySchema } from "./history.js";
import { MAX_EVALUATION_CRITERIA } from "./evaluation-draft.js";

/** The latest evaluation generation of a session, or `none` before any evaluation exists. */
export const SessionEvaluationStateSchema = z.enum([
  "none",
  "queued",
  "running",
  "failed",
  "draft",
  "approved",
]);
const count = z.number().int().min(0).max(MAX_EVALUATION_CRITERIA);
/**
 * Teacher-facing review summary. `criteria` and `evidenced` come from the latest evaluation;
 * `applied` counts criteria whose learning progress an approval of this session updated, and
 * `raised` those whose level went up.
 */
export const SessionReviewSchema = z
  .object({
    evaluation: SessionEvaluationStateSchema,
    criteria: count,
    evidenced: count,
    applied: count,
    raised: count,
  })
  .strict()
  .readonly();
/**
 * Dashboard-only projection; the existing student history wire shape stays unchanged. `review`
 * is present only when the request sets `includeReview`, so older strict dashboards keep theirs.
 */
export const ClassSessionItemSchema = SessionHistoryItemSchema.unwrap()
  .extend({ classId: RevisionIdSchema, review: SessionReviewSchema.optional() })
  .strict()
  .readonly();
/** Characters a session search may hold after trimming. */
export const MAX_SESSION_SEARCH_LENGTH = 80;
/** Dashboard-only listing filters, which the server applies before paginating. */
export const ClassSessionsQuerySchema = SessionHistoryQuerySchema.unwrap()
  .extend({
    includeReview: z.literal(true).optional(),
    runState: z.enum(["active", "closed"]).optional(),
    evaluation: z.array(SessionEvaluationStateSchema).min(1).max(6).readonly().optional(),
    evidence: z.enum(["with", "without"]).optional(),
    search: z.string().trim().min(1).max(MAX_SESSION_SEARCH_LENGTH).optional(),
  })
  .strict()
  .readonly();
export const ClassSessionsResponseSchema = z
  .object({
    protocolVersion: CurrentProtocolVersionSchema,
    requestId: RequestIdSchema,
    kind: z.literal("class-sessions-response"),
    runs: z.array(ClassSessionItemSchema).max(50).readonly(),
    nextBeforeRunId: RunIdSchema.nullable(),
  })
  .strict()
  .readonly();
export type SessionEvaluationState = z.infer<typeof SessionEvaluationStateSchema>;
export type SessionReview = z.infer<typeof SessionReviewSchema>;
export type ClassSessionItem = z.infer<typeof ClassSessionItemSchema>;
export type ClassSessionsQuery = z.infer<typeof ClassSessionsQuerySchema>;
export type ClassSessionsResponse = z.infer<typeof ClassSessionsResponseSchema>;
