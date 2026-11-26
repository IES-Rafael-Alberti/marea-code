import { ClassSessionItemSchema } from "@marea/protocol";
import type { SqliteRow } from "@marea/sqlite-storage";

import { rowNullableText, rowText } from "./row-parser.boundary.js";
import { activeGovernanceAccount, activeGovernanceMembership } from "./governance-access-sql.js";

/** Who may read a run: its student, or a teacher with current access to its class. */
export const HISTORY_ACCESS = `(${activeGovernanceAccount("?2")} AND ((?1 = 'student' AND runs.student_id = ?2)
  OR (?1 = 'teacher' AND EXISTS (SELECT 1 FROM marea_teacher_classes access
    WHERE access.teacher_id = ?2 AND access.class_id = runs.class_id
      AND ${activeGovernanceMembership("?2", "runs.class_id", "'teacher'")}))))`;
export const RUN_SELECT = `SELECT runs.*, users.display_name AS student_name,
  classes.display_name AS class_name FROM marea_runs runs
  JOIN marea_users users ON users.id = runs.student_id
  JOIN marea_classes classes ON classes.id = runs.class_id`;

const HistoryRunSchema = ClassSessionItemSchema.unwrap()
  .omit({ review: true, versionMismatch: true })
  .readonly();
/** The run fields every history listing shares, before any teacher-only review summary. */
export function historyItem(row: SqliteRow) {
  return HistoryRunSchema.parse({
    runId: rowText(row, "id"),
    classId: rowText(row, "class_id"),
    studentDisplayName: rowText(row, "student_name"),
    classDisplayName: rowText(row, "class_name"),
    projectDisplayName: rowText(row, "project_display_name"),
    state: rowText(row, "state"),
    openedAt: rowText(row, "opened_at"),
    closedAt: rowNullableText(row, "closed_at"),
  });
}
