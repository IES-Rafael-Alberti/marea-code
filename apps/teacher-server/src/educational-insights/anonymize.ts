import type { EvaluationDraft } from "@marea/protocol";
/** Keep assessment identifiers intact while pseudonymizing natural-language fields. */
export function anonymizeDraft(
  draft: EvaluationDraft,
  identifiers: readonly string[],
  alias: string,
): EvaluationDraft {
  const text = (value: string) =>
    identifiers.reduce(
      (result, id) => (id.length > 1 ? result.replaceAll(id, alias) : result),
      value,
    );
  return {
    ...draft,
    studentFeedback: text(draft.studentFeedback),
    teacherNote: text(draft.teacherNote),
    difficulties: draft.difficulties.map(text),
    criteria: draft.criteria.map((c) => ({
      ...c,
      evidence: text(c.evidence),
      ...(c.learningNote === undefined ? {} : { learningNote: text(c.learningNote) }),
    })),
  };
}
