import type { ReadOnlySqliteApplicationDatabase } from "../contracts.js";
import type { DerivedQuery } from "./retention-rows.js";
export function hasObservabilityStorage(database: ReadOnlySqliteApplicationDatabase): boolean {
  return (
    database.readOne(
      "SELECT 1 FROM sqlite_schema WHERE name = 'marea_trace_outbox' AND type = 'table'",
    ) !== undefined
  );
}
export function observabilityRunRows(
  database: ReadOnlySqliteApplicationDatabase,
): readonly DerivedQuery[] {
  return hasObservabilityStorage(database)
    ? [
        [
          "traceProgress",
          "SELECT through_sequence, 1 AS rows, 0 AS bytes FROM marea_trace_progress WHERE run_id = ?1",
        ],
        [
          "traceOutbox",
          "SELECT through_sequence, attempts, next_at, last_error, 1 AS rows, 0 AS bytes FROM marea_trace_outbox WHERE run_id = ?1 ORDER BY through_sequence",
        ],
      ]
    : [];
}
