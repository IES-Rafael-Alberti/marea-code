import { CanonicalRunEventSchema, ServerCloseReasonSchema } from "@marea/protocol";
import type { CanonicalRunEvent, RunClosedReason } from "@marea/protocol";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

import { RunClosedError, TeacherDomainError } from "../../identity/errors.js";
import { rowInteger, rowNullableText } from "./row-parser.boundary.js";
import { validateStartupEvent } from "./sqlite-run-startup.js";

export interface RunClosing {
  readonly closedAt: string;
  readonly closingEventId: string;
  readonly reason: RunClosedReason;
  /** The teacher who ended the run; absent for the student and for the server itself. */
  readonly closedBy?: string;
}

export function insertRunEvent(
  database: SqliteApplicationDatabase,
  runId: string,
  event: CanonicalRunEvent,
): void {
  validateStartupEvent(database, runId, event);
  database.execute(
    `INSERT INTO marea_run_events
        (event_id, run_id, sequence, occurred_at, event_type, payload_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    [
      event.eventId,
      runId,
      event.sequence,
      event.occurredAt,
      event.eventType,
      JSON.stringify(event),
    ],
  );
}

/**
 * The single close primitive for every actor. Callers decide who may close the run and have
 * already confirmed it is active; this appends the closing event, closes the run, removes the
 * live projection and revokes its leases, all inside the caller's transaction.
 */
export function closeActiveRun(
  database: SqliteApplicationDatabase,
  runId: string,
  closing: RunClosing,
): void {
  const projection = database.readOne(
    "SELECT highest_durable_sequence FROM marea_active_runs WHERE run_id = ?1",
    [runId],
  );
  if (projection === undefined) throw new TeacherDomainError("run.unavailable");
  insertRunEvent(
    database,
    runId,
    CanonicalRunEventSchema.parse({
      eventId: closing.closingEventId,
      eventType: "run-closed",
      occurredAt: closing.closedAt,
      reason: closing.reason,
      sequence: rowInteger(projection, "highest_durable_sequence") + 1,
    }),
  );
  database.execute(
    `UPDATE marea_runs SET state = 'closed', closed_at = ?2, close_reason = ?3 WHERE id = ?1`,
    [runId, closing.closedAt, closing.reason],
  );
  // Only a teacher closure names an actor, so older schemas stay valid for every other close.
  if (closing.closedBy !== undefined) {
    database.execute("UPDATE marea_runs SET closed_by = ?2 WHERE id = ?1", [
      runId,
      closing.closedBy,
    ]);
  }
  database.execute("DELETE FROM marea_active_runs WHERE run_id = ?1", [runId]);
  database.execute(
    "UPDATE marea_run_leases SET revoked_at = ?2 WHERE run_id = ?1 AND revoked_at IS NULL",
    [runId, closing.closedAt],
  );
}

/** The refusal for a run: it names the reason only when the server closed it. */
export function refusalForRun(
  database: SqliteApplicationDatabase,
  select: { readonly sql: string; readonly parameters: readonly string[] },
): TeacherDomainError {
  const row = database.readOne(select.sql, select.parameters);
  const reason = ServerCloseReasonSchema.safeParse(
    row === undefined ? null : rowNullableText(row, "close_reason"),
  );
  return reason.success
    ? new RunClosedError(reason.data)
    : new TeacherDomainError("run.unavailable");
}
