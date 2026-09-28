import { EvaluationDraftSchema, TeacherEvaluationSchema } from "@marea/protocol";
import type { SqliteRow } from "@marea/sqlite-storage";

import { EvaluationInputSchema, evaluationDigest } from "../../evaluation/evaluation-input.js";
import { TeacherDomainError } from "../../identity/errors.js";
import { rowInteger, rowJson, rowText } from "./row-parser.boundary.js";

export function storedEvaluationInput(row: SqliteRow) {
  if (evaluationDigest(rowText(row, "input_json")) !== rowText(row, "input_digest"))
    throw new TeacherDomainError("request.conflict");
  return rowJson(row, "input_json", EvaluationInputSchema);
}

export function evaluationRecord(row: SqliteRow) {
  const input = storedEvaluationInput(row);
  const state = rowText(row, "state");
  return TeacherEvaluationSchema.parse({
    evaluationId: rowText(row, "id"),
    runId: rowText(row, "run_id"),
    generation: rowInteger(row, "generation"),
    snapshotId: input.snapshotId,
    inputDigest: rowText(row, "input_digest"),
    evaluator: input.evaluator,
    didacticSkills: input.didacticSkills,
    state,
    createdAt: rowText(row, "created_at"),
    updatedAt: rowText(row, "updated_at"),
    ...(state === "failed" ? { failure: rowText(row, "failure_code") } : {}),
    ...(state === "draft" || state === "approved"
      ? { draft: rowJson(row, "draft_json", EvaluationDraftSchema) }
      : {}),
    ...(state === "approved"
      ? { noticeId: rowText(row, "notice_id"), approvedAt: rowText(row, "approved_at") }
      : {}),
  });
}
