import { EvaluationDraftSchema, type LearningTarget, type EvaluationDraft } from "@marea/protocol";

import { TeacherDomainError } from "../identity/errors.js";
import type { SkillBundle } from "../teaching/skills/skill-source.js";

/** Model output is untrusted even when it matches the transport schema. */
export function validateEvaluationDraft(
  input: EvaluationDraft,
  mode: "tutoring" | "free",
  didacticSkills: readonly SkillBundle[],
  adaptiveTargets?: readonly LearningTarget[],
): EvaluationDraft {
  const draft = EvaluationDraftSchema.parse(input);
  const targets = new Set(
    (mode === "free" ? [] : didacticSkills).flatMap((skill) =>
      skill.criteria.map((criterion) => JSON.stringify([skill.id, criterion.code])),
    ),
  );
  for (const assessment of draft.criteria) {
    const key = JSON.stringify([assessment.skillId, assessment.code]);
    if (!targets.delete(key)) throw new TeacherDomainError("request.conflict");
    if (assessment.result !== "no-evidence" && assessment.evidence.length === 0)
      throw new TeacherDomainError("request.conflict");
  }
  if (targets.size !== 0) throw new TeacherDomainError("request.conflict");
  for (const target of adaptiveTargets ?? []) {
    const assessment = draft.criteria.find(
      (c) => c.skillId === target.skillId && c.code === target.code,
    );
    if (assessment?.levelAttempted !== target.target)
      throw new TeacherDomainError("request.conflict");
  }
  return draft;
}
