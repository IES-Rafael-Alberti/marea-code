import {
  CanonicalRunEventSchema,
  RunIdSchema,
  ClassSessionItemSchema,
  StudentRunSnapshotSchema,
  type RunHistoryQuery,
  type SessionHistoryQuery,
} from "@marea/protocol";
import type { SqliteApplicationDatabase, SqliteRow } from "@marea/sqlite-storage";

import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import { TeacherDomainError } from "../../identity/errors.js";
import type {
  HistoryRepository,
  RunHistoryPage,
  SessionHistoryPage,
} from "../../sessions/history-service.js";
import { rowInteger, rowJson, rowNullableText, rowText } from "./row-parser.boundary.js";
import { activeGovernanceAccount, activeGovernanceMembership } from "./governance-access-sql.js";

const ACCESS = `(${activeGovernanceAccount("?2")} AND ((?1 = 'student' AND runs.student_id = ?2)
  OR (?1 = 'teacher' AND EXISTS (SELECT 1 FROM marea_teacher_classes access
    WHERE access.teacher_id = ?2 AND access.class_id = runs.class_id
      AND ${activeGovernanceMembership("?2", "runs.class_id", "'teacher'")}))))`;
const RUN_SELECT = `SELECT runs.*, users.display_name AS student_name,
  classes.display_name AS class_name FROM marea_runs runs
  JOIN marea_users users ON users.id = runs.student_id
  JOIN marea_classes classes ON classes.id = runs.class_id`;

function historyItem(row: SqliteRow) {
  return ClassSessionItemSchema.parse({
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

export class SqliteHistoryRepository implements HistoryRepository {
  readonly #database: SqliteApplicationDatabase;

  public constructor(database: SqliteApplicationDatabase) {
    this.#database = database;
  }

  public readRun(identity: AuthenticatedIdentity, query: RunHistoryQuery): RunHistoryPage {
    return this.#database.transaction(() => {
      const row = this.#database.readOne(
        `SELECT runs.state, snapshots.public_snapshot_json,
          (SELECT COALESCE(MAX(sequence), 0) FROM marea_run_events WHERE run_id = runs.id) AS highest
          FROM marea_runs runs
          JOIN marea_run_snapshots snapshots ON snapshots.id = runs.snapshot_id
          WHERE ${ACCESS} AND runs.id = ?3`,
        [identity.role, identity.userId, query.runId],
      );
      if (row === undefined) throw new TeacherDomainError("run.unavailable");
      const highest = rowInteger(row, "highest");
      const throughSequence = query.throughSequence ?? highest;
      if (throughSequence > highest || query.afterSequence > throughSequence)
        throw new TeacherDomainError("request.conflict");
      const events = this.#database
        .readAll(
          `SELECT payload_json FROM marea_run_events
          WHERE run_id = ?1 AND sequence > ?2 AND sequence <= ?3
          ORDER BY sequence ASC LIMIT ?4`,
          [query.runId, query.afterSequence, throughSequence, query.limit],
        )
        .map((event) => rowJson(event, "payload_json", CanonicalRunEventSchema));
      const lastSequence = query.afterSequence + events.length;
      const state = rowText(row, "state");
      if (state !== "active" && state !== "closed") throw new Error("Stored run state is invalid.");
      return {
        runId: query.runId,
        state,
        snapshot: rowJson(row, "public_snapshot_json", StudentRunSnapshotSchema),
        afterSequence: query.afterSequence,
        throughSequence,
        nextSequence: lastSequence < throughSequence ? lastSequence : null,
        events,
      };
    });
  }

  public listSessions(
    identity: AuthenticatedIdentity,
    query: SessionHistoryQuery,
  ): SessionHistoryPage {
    return this.#database.transaction(() => {
      const rows = this.sessionRows(identity, query);
      const runs = rows.slice(0, query.limit).map(historyItem);
      const next = rows.length > query.limit ? rows.at(query.limit - 1) : undefined;
      return {
        runs,
        nextBeforeRunId: next === undefined ? null : RunIdSchema.parse(rowText(next, "id")),
      };
    });
  }

  private sessionRows(
    identity: AuthenticatedIdentity,
    query: SessionHistoryQuery,
  ): readonly SqliteRow[] {
    if (query.beforeRunId === undefined) {
      return this.#database.readAll(
        `${RUN_SELECT} WHERE ${ACCESS} AND (?3 IS NULL OR runs.class_id = ?3)
          ORDER BY runs.opened_at DESC, runs.id DESC LIMIT ?4`,
        [identity.role, identity.userId, query.classId ?? null, query.limit + 1],
      );
    }
    const anchor = this.#database.readOne(
      `SELECT runs.opened_at FROM marea_runs runs WHERE ${ACCESS} AND runs.id = ?3 AND (?4 IS NULL OR runs.class_id = ?4)`,
      [identity.role, identity.userId, query.beforeRunId, query.classId ?? null],
    );
    if (anchor === undefined) throw new TeacherDomainError("run.unavailable");
    return this.#database.readAll(
      `${RUN_SELECT} WHERE ${ACCESS} AND (?6 IS NULL OR runs.class_id = ?6) AND (runs.opened_at < ?3
        OR (runs.opened_at = ?3 AND runs.id < ?4))
        ORDER BY runs.opened_at DESC, runs.id DESC LIMIT ?5`,
      [
        identity.role,
        identity.userId,
        rowText(anchor, "opened_at"),
        query.beforeRunId,
        query.limit + 1,
        query.classId ?? null,
      ],
    );
  }
}
