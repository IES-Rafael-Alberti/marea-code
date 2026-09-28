import { CriterionAssessmentSchema, type EvaluationDraft } from "@marea/protocol";

import type { EvaluationMessages } from "./evaluation-messages.js";

export function EvaluationEditor({
  draft,
  disabled,
  messages: m,
  edit,
}: {
  readonly draft: EvaluationDraft;
  readonly disabled: boolean;
  readonly messages: EvaluationMessages;
  readonly edit: (draft: EvaluationDraft) => void;
}) {
  const changeCriterion = (
    index: number,
    patch: { readonly evidence?: string; readonly result?: string; readonly confidence?: string },
  ) => {
    const criterion = CriterionAssessmentSchema.safeParse({ ...draft.criteria[index], ...patch });
    if (criterion.success)
      edit({
        ...draft,
        criteria: draft.criteria.map((item, offset) =>
          offset === index
            ? { ...criterion.data, evidence: patch.evidence ?? item.evidence }
            : item,
        ),
      });
  };
  return (
    <fieldset className="evaluation-editor" disabled={disabled}>
      <legend>{m.review}</legend>
      <p>{m.privacy}</p>
      <label>
        {m.public}
        <textarea
          rows={6}
          maxLength={16_384}
          value={draft.studentFeedback}
          onChange={(event) => {
            edit({ ...draft, studentFeedback: event.currentTarget.value });
          }}
        />
      </label>
      <label>
        {m.private}
        <textarea
          rows={4}
          maxLength={16_384}
          value={draft.teacherNote}
          onChange={(event) => {
            edit({ ...draft, teacherNote: event.currentTarget.value });
          }}
        />
      </label>
      <label>
        {m.difficulties}
        <textarea
          rows={4}
          value={draft.difficulties.join("\n")}
          onChange={(event) => {
            edit({ ...draft, difficulties: event.currentTarget.value.split("\n") });
          }}
        />
      </label>
      <details>
        <summary>
          {m.criteria} ({draft.criteria.length})
        </summary>
        {draft.criteria.map((criterion, index) => (
          <fieldset key={`${criterion.skillId}:${criterion.code}`}>
            <legend>
              {criterion.skillId} / {criterion.code}
            </legend>
            <label>
              {m.result}
              <select
                value={criterion.result}
                onChange={(event) => {
                  changeCriterion(index, { result: event.currentTarget.value });
                }}
              >
                <option value="passed">{m.results.passed}</option>
                <option value="not-passed">{m.results["not-passed"]}</option>
                <option value="no-evidence">{m.results["no-evidence"]}</option>
              </select>
            </label>
            <label>
              {m.confidence}
              <select
                value={criterion.confidence}
                onChange={(event) => {
                  changeCriterion(index, { confidence: event.currentTarget.value });
                }}
              >
                <option value="low">{m.confidences.low}</option>
                <option value="medium">{m.confidences.medium}</option>
                <option value="high">{m.confidences.high}</option>
              </select>
            </label>
            <label>
              {m.explanation}
              <textarea
                rows={3}
                maxLength={2_000}
                value={criterion.evidence}
                onChange={(event) => {
                  changeCriterion(index, { evidence: event.currentTarget.value });
                }}
              />
            </label>
          </fieldset>
        ))}
      </details>
    </fieldset>
  );
}
