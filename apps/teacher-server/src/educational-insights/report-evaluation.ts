import * as z from "zod";
import { EvaluationDraftSchema } from "@marea/protocol";
import { validateEvaluationDraft } from "../evaluation/validate-draft.js";
import type { EducationalInference } from "./inference.js";
import { classifyFailure, type InsightsFailure } from "./model-output.boundary.js";
import { EVALUATE, type Evidence, type InputSchema, type SourceSchema } from "./reports-model.js";

type Source = z.infer<typeof SourceSchema>;

const clamp = (max: number) => z.string().transform((value) => value.trim().slice(0, max));
const LenientCriterionSchema = z.object({
  skillId: z.string(),
  code: clamp(64),
  result: z.enum(["passed", "not-passed", "no-evidence"]),
  confidence: z.enum(["low", "medium", "high"]).catch("low"),
  evidence: clamp(2000).catch(""),
  learningNote: clamp(1000).optional().catch(undefined),
  levelAttempted: z.number().int().min(1).max(4).optional().catch(undefined),
});
const LenientDraftSchema = z.object({
  studentFeedback: clamp(16_384).catch(""),
  teacherNote: clamp(16_384).catch(""),
  difficulties: z
    .array(z.string())
    .transform((items) =>
      items
        .map((item) => item.trim().slice(0, 2000))
        .filter((item) => item.length > 0)
        .slice(0, 64),
    )
    .catch([]),
  criteria: z.array(z.unknown()).catch([]),
});

/**
 * Tolerant model-facing evaluation contract: unknown keys are stripped, long text is clamped and
 * criteria that cannot be read are omitted. The result must still match the frozen assessment
 * method exactly, otherwise the model is asked once to correct it.
 */
export function evaluationSchema(source: Source) {
  return LenientDraftSchema.transform((draft, context) => {
    const criteria = draft.criteria.flatMap((item) => {
      const parsed = LenientCriterionSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
    try {
      return validateEvaluationDraft(
        EvaluationDraftSchema.parse({
          ...draft,
          studentFeedback: draft.studentFeedback === "" ? "-" : draft.studentFeedback,
          criteria: source.mode === "free" ? [] : criteria,
        }),
        source.mode,
        source.teaching.didacticSkills,
      );
    } catch {
      context.addIssue({
        code: "custom",
        message:
          "criteria must contain exactly one assessment per listed criterion, with evidence for every passed or not-passed result",
      });
      return z.NEVER;
    }
  });
}

/** A run that could not be evaluated, with its content-free cause. */
export interface Evaluated {
  readonly evidence: Evidence;
  readonly failure: InsightsFailure | undefined;
  /** Set exactly when the run is unavailable. */
  readonly reason: string | undefined;
}

export async function evaluateSource(
  inference: Pick<EducationalInference, "generate">,
  source: Source,
  input: z.infer<typeof InputSchema>,
  accountId: string,
  signal: AbortSignal,
): Promise<Evaluated> {
  const base = {
    runId: source.runId,
    alias: source.alias,
    mode: source.mode,
    skills: source.skills,
  };
  if (source.approved !== null)
    return {
      evidence: { ...base, status: "approved", evaluation: source.approved },
      failure: undefined,
      reason: undefined,
    };
  const unavailable = (reason: string, failure?: InsightsFailure): Evaluated => ({
    evidence: { ...base, status: "unavailable", reason, evaluation: null },
    failure,
    reason,
  });
  if (source.material === "") return unavailable(source.skip ?? "no-material");
  if (source.teaching.evaluationSkills.length === 0) return unavailable("no-criteria");
  try {
    const evaluation = await inference.generate(
      input.route,
      accountId,
      EVALUATE,
      {
        mode: source.mode,
        locale: input.locale,
        teaching: source.teaching,
        session: z.json().parse(JSON.parse(source.material)),
      },
      evaluationSchema(source),
      signal,
      EvaluationDraftSchema,
    );
    return {
      evidence: { ...base, status: "provisional", evaluation },
      failure: undefined,
      reason: undefined,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    const { failure } = classifyFailure(error);
    return unavailable(failure.code, failure);
  }
}
