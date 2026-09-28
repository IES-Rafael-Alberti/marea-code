import * as z from "zod";

import { SkillIdSchema } from "./identifiers.js";
import { NoticeTextSchema } from "./notices.js";

export const MAX_EVALUATION_DRAFT_BYTES = 2 * 1_024 * 1_024;

export const CriterionAssessmentSchema = z
  .object({
    skillId: SkillIdSchema,
    code: z.string().min(1).max(64),
    result: z.enum(["passed", "not-passed", "no-evidence"]),
    confidence: z.enum(["low", "medium", "high"]),
    evidence: z.string().trim().max(2_000),
  })
  .strict()
  .readonly();

/** Private teacher-facing content. Only reviewed studentFeedback may become a notice. */
export const EvaluationDraftSchema = z
  .object({
    studentFeedback: NoticeTextSchema,
    teacherNote: z.string().trim().max(16_384),
    difficulties: z.array(z.string().trim().min(1).max(2_000)).max(64).readonly(),
    criteria: z.array(CriterionAssessmentSchema).max(4_096).readonly(),
  })
  .strict()
  .refine(
    (draft) =>
      new TextEncoder().encode(JSON.stringify(draft)).byteLength <= MAX_EVALUATION_DRAFT_BYTES,
    "The evaluation draft exceeds its serialized byte limit.",
  )
  .readonly();

export type CriterionAssessment = z.infer<typeof CriterionAssessmentSchema>;
export type EvaluationDraft = z.infer<typeof EvaluationDraftSchema>;
