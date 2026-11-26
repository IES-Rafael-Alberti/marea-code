import { ClassSessionItemSchema, RunIdSchema, type ClassSessionsQuery } from "@marea/protocol";
import type { SqliteApplicationDatabase, SqliteRow } from "@marea/sqlite-storage";

import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import { TeacherDomainError } from "../../identity/errors.js";
import type { ClassSessionsPage } from "../../sessions/history-service.js";
import { rowInteger, rowText } from "./row-parser.boundary.js";
import { HISTORY_ACCESS, historyItem } from "./sqlite-history-sql.js";

/** Progress an approval applied to the run; manual adjustments carry no run, so never count. */
const APPLIED_PROGRESS = `(SELECT COUNT(*) FROM marea_learning_history history
      WHERE history.run_id = runs.id) AS applied_count,
    (SELECT COUNT(*) FROM marea_learning_history history
      WHERE history.run_id = runs.id AND history.level > history.previous_level) AS raised_count`;
/** An installation without educational storage has no learning progress to apply. */
const NO_PROGRESS = "0 AS applied_count, 0 AS raised_count";

/** Accessible runs in the requested class and state, after the page cursor. */
const SCOPE = `${HISTORY_ACCESS} AND (?3 IS NULL OR runs.class_id = ?3)
    AND (?4 IS NULL OR runs.opened_at < ?4 OR (runs.opened_at = ?4 AND runs.id < ?5))
    AND (?6 IS NULL OR runs.state = ?6)`;

/** Only names, so a search folds every candidate without summarizing their evaluations. */
const CANDIDATES = `SELECT runs.id, users.display_name AS student_name, runs.project_display_name
  FROM marea_runs runs JOIN marea_users users ON users.id = runs.student_id WHERE ${SCOPE}`;

/** Each accessible run with a summary of its latest evaluation generation and its progress. */
const reviewedRuns = (progress: string) => `SELECT runs.*, users.display_name AS student_name,
    classes.display_name AS class_name,
    COALESCE(latest.state, 'none') AS evaluation_state,
    COALESCE(json_array_length(latest.draft_json, '$.criteria'), 0) AS criteria_count,
    (SELECT COUNT(*) FROM json_each(latest.draft_json, '$.criteria') item
      WHERE json_extract(item.value, '$.result') <> 'no-evidence') AS evidenced_count,
    ${progress}
  FROM marea_runs runs
  JOIN marea_users users ON users.id = runs.student_id
  JOIN marea_classes classes ON classes.id = runs.class_id
  LEFT JOIN marea_evaluations latest ON latest.run_id = runs.id
    AND latest.generation = (SELECT MAX(generation) FROM marea_evaluations WHERE run_id = runs.id)
  WHERE ${SCOPE}`;

/**
 * "Without evidence" needs criteria to judge: a draft that assessed none stays undetermined
 * rather than being reported as empty.
 */
const filteredRuns = (progress: string) => `SELECT * FROM (${reviewedRuns(progress)}) listed
  WHERE (?10 IS NULL OR listed.id IN (SELECT value FROM json_each(?10)))
    AND (?7 IS NULL OR listed.evaluation_state IN (SELECT value FROM json_each(?7)))
    AND (?8 IS NULL OR (?8 = 'with' AND listed.evidenced_count > 0)
      OR (?8 = 'without' AND listed.criteria_count > 0 AND listed.evidenced_count = 0))
  ORDER BY listed.opened_at DESC, listed.id DESC LIMIT ?9`;

/** Case- and accent-insensitive text, so "alvaro" finds "Álvaro". */
function folded(value: string): string {
  // Stryker disable next-line MethodExpression: both sides fold alike, so upper case matches the same.
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function listedItem(row: SqliteRow, includeReview: boolean) {
  if (!includeReview) return ClassSessionItemSchema.parse(historyItem(row));
  const review = {
    evaluation: rowText(row, "evaluation_state"),
    criteria: rowInteger(row, "criteria_count"),
    evidenced: rowInteger(row, "evidenced_count"),
    applied: rowInteger(row, "applied_count"),
    raised: rowInteger(row, "raised_count"),
  };
  return ClassSessionItemSchema.parse({ ...historyItem(row), review });
}

function anchorOf(
  database: SqliteApplicationDatabase,
  identity: AuthenticatedIdentity,
  query: ClassSessionsQuery,
): string | null {
  if (query.beforeRunId === undefined) return null;
  const anchor = database.readOne(
    `SELECT runs.opened_at FROM marea_runs runs
      WHERE ${HISTORY_ACCESS} AND runs.id = ?3 AND (?4 IS NULL OR runs.class_id = ?4)`,
    [identity.role, identity.userId, query.beforeRunId, query.classId ?? null],
  );
  if (anchor === undefined) throw new TeacherDomainError("run.unavailable");
  return rowText(anchor, "opened_at");
}

/** Ids of the scoped runs whose student or project name contains the folded search. */
function searchMatches(
  database: SqliteApplicationDatabase,
  scope: readonly (string | null)[],
  search: string,
): string {
  const needle = folded(search);
  return JSON.stringify(
    database
      .readAll(CANDIDATES, scope)
      .filter((row) =>
        folded(`${rowText(row, "student_name")} ${rowText(row, "project_display_name")}`).includes(
          needle,
        ),
      )
      .map((row) => rowText(row, "id")),
  );
}

/**
 * One page of the teacher's sessions after every filter, all applied before the page limit. A
 * search first folds only names in TypeScript, because SQLite folds ASCII case alone, and then
 * summarizes just the matching runs. Older dashboards omit `includeReview` and keep their shape.
 */
export function listClassSessions(
  database: SqliteApplicationDatabase,
  identity: AuthenticatedIdentity,
  query: ClassSessionsQuery,
): ClassSessionsPage {
  const scope = [
    identity.role,
    identity.userId,
    query.classId ?? null,
    anchorOf(database, identity, query),
    query.beforeRunId ?? null,
    query.runState ?? null,
  ];
  const educational =
    database.readOne(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'marea_learning_history'",
    ) !== undefined;
  const rows = database.readAll(filteredRuns(educational ? APPLIED_PROGRESS : NO_PROGRESS), [
    ...scope,
    query.evaluation === undefined ? null : JSON.stringify(query.evaluation),
    query.evidence ?? null,
    query.limit + 1,
    query.search === undefined ? null : searchMatches(database, scope, query.search),
  ]);
  const next = rows.length > query.limit ? rows.at(query.limit - 1) : undefined;
  return {
    runs: rows.slice(0, query.limit).map((row) => listedItem(row, query.includeReview === true)),
    nextBeforeRunId: next === undefined ? null : RunIdSchema.parse(rowText(next, "id")),
  };
}
