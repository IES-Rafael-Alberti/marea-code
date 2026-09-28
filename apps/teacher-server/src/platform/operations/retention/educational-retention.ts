import type { ReadOnlySqliteApplicationDatabase } from "../contracts.js";
import type { DerivedQuery } from "./retention-rows.js";
export function hasEducationalStorage(database: ReadOnlySqliteApplicationDatabase): boolean {
  return (
    database.readOne(
      "SELECT 1 FROM sqlite_schema WHERE name = 'marea_learning_progress' AND type = 'table'",
    ) !== undefined
  );
}
export function educationalRunRows(
  database: ReadOnlySqliteApplicationDatabase,
): readonly DerivedQuery[] {
  return hasEducationalStorage(database)
    ? [
        [
          "learningHistory",
          "SELECT id,criterion_key,level,reason,1 AS rows,length(reason) AS bytes FROM marea_learning_history WHERE run_id = ?1 ORDER BY id",
        ],
        [
          "classReportSources",
          "SELECT s.report_id,r.state,r.completed,1 AS rows,length(r.input_json)+COALESCE(length(r.result_json),0) AS bytes FROM marea_class_report_sources s JOIN marea_class_reports r ON r.id=s.report_id WHERE s.run_id = ?1 ORDER BY s.report_id",
        ],
      ]
    : [];
}
export function educationalAccountRows(
  database: ReadOnlySqliteApplicationDatabase,
): readonly DerivedQuery[] {
  return hasEducationalStorage(database)
    ? [
        [
          "learningProgress",
          "SELECT criterion_key,revision,level,epoch,1 AS rows,length(definition_json)+length(memory) AS bytes FROM marea_learning_progress WHERE student_id = ?1 ORDER BY class_id,criterion_key",
        ],
        [
          "learningManualHistory",
          "SELECT id,criterion_key,level,reason,1 AS rows,length(reason) AS bytes FROM marea_learning_history WHERE student_id = ?1 AND run_id IS NULL ORDER BY id",
        ],
      ]
    : [];
}
