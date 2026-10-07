import { CanonicalRunEventSchema, type SessionExportQuery } from "@marea/protocol";
import type { SqliteApplicationDatabase, SqliteRow } from "@marea/sqlite-storage";
import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import {
  SessionExportError,
  type ExportSession,
  type ExportUsage,
  type SessionExportRepository,
} from "../../session-export/contracts.js";
import { activeGovernanceMembership } from "./governance-access-sql.js";
import { rowInteger, rowJson, rowNullableText, rowText } from "./row-parser.boundary.js";

const ACCESS = `EXISTS (SELECT 1 FROM marea_teacher_classes access
  WHERE access.teacher_id = ?1 AND access.class_id = runs.class_id
    AND ${activeGovernanceMembership("?1", "runs.class_id", "'teacher'")})`;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_EVENTS = 20_000;

export function exportUsage(row: SqliteRow): ExportUsage {
  const settled = ["settled", "breached"].includes(rowText(row, "state"));
  return {
    requestId: rowText(row, "request_id"),
    attempt: rowInteger(row, "attempt"),
    purpose: rowText(row, "purpose"),
    state: rowText(row, "state"),
    inputTokens: settled ? rowInteger(row, "input_tokens") : null,
    outputTokens: settled ? rowInteger(row, "output_tokens") : null,
    costUnits: settled ? rowInteger(row, "cost_units") : null,
    costUnit: rowText(row, "cost_unit"),
    startedAt: rowText(row, "created_at"),
    endedAt: rowNullableText(row, "settled_at"),
  };
}

function readExportSession(database: SqliteApplicationDatabase, row: SqliteRow): ExportSession {
  const runId = rowText(row, "id");
  return {
    runId,
    classId: rowText(row, "class_id"),
    studentId: rowText(row, "student_id"),
    studentName: rowText(row, "student_name"),
    className: rowText(row, "class_name"),
    projectName: rowText(row, "project_display_name"),
    openedAt: rowText(row, "opened_at"),
    closedAt: rowNullableText(row, "closed_at"),
    events: database
      .readAll("SELECT payload_json FROM marea_run_events WHERE run_id = ?1 ORDER BY sequence", [
        runId,
      ])
      .map((event) => rowJson(event, "payload_json", CanonicalRunEventSchema)),
    usage: database
      .readAll(
        "SELECT attempts.*, json_extract(accounts.policy_json,'$.costUnit') AS cost_unit FROM marea_usage_attempts attempts JOIN marea_usage_accounts accounts USING(run_id,purpose) WHERE run_id = ?1 ORDER BY attempts.created_at, attempts.id",
        [runId],
      )
      .map(exportUsage),
  };
}

export class SqliteSessionExportRepository implements SessionExportRepository {
  constructor(readonly database: SqliteApplicationDatabase) {}
  students(identity: AuthenticatedIdentity) {
    this.authorize(identity);
    const rows = this.database.readAll(
      `SELECT DISTINCT runs.student_id, runs.class_id, users.display_name
      FROM marea_runs runs JOIN marea_users users ON users.id = runs.student_id
      WHERE ${ACCESS} ORDER BY users.display_name, runs.student_id, runs.class_id LIMIT 2001`,
      [identity.userId],
    );
    if (rows.length > 2000) throw new SessionExportError(413);
    return rows.map((row) => ({
      id: rowText(row, "student_id"),
      name: rowText(row, "display_name"),
      classId: rowText(row, "class_id"),
    }));
  }
  read(identity: AuthenticatedIdentity, query: SessionExportQuery): readonly ExportSession[] {
    this.authorize(identity);
    return this.database.transaction(() => {
      const rows = this.database.readAll(
        `SELECT runs.*, users.display_name AS student_name,
        classes.display_name AS class_name FROM marea_runs runs
        JOIN marea_users users ON users.id = runs.student_id
        JOIN marea_classes classes ON classes.id = runs.class_id
        WHERE ${ACCESS} AND (?2 IS NULL OR runs.id = ?2) AND (?3 IS NULL OR runs.class_id = ?3)
          AND (?4 IS NULL OR runs.student_id = ?4) AND (?5 IS NULL OR runs.opened_at >= ?5)
          AND (?6 IS NULL OR runs.opened_at < ?6)
        ORDER BY runs.opened_at, runs.id LIMIT 101`,
        [
          identity.userId,
          query.runId ?? null,
          query.classId ?? null,
          query.studentId ?? null,
          query.from ?? null,
          query.until ?? null,
        ],
      );
      if (rows.length > 100) throw new SessionExportError(413);
      if (query.runId !== undefined && rows.length === 0) throw new SessionExportError(404);
      let bytes = 0;
      let events = 0;
      let attempts = 0;
      for (const row of rows) {
        const count = this.database.readAll(
          `SELECT COUNT(*) AS events, COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))), 0) AS bytes
          FROM marea_run_events WHERE run_id = ?1`,
          [rowText(row, "id")],
        )[0];
        if (count === undefined) throw new SessionExportError(503);
        bytes += rowInteger(count, "bytes");
        events += rowInteger(count, "events");
        const usage = this.database.readOne(
          "SELECT COUNT(*) AS attempts FROM marea_usage_attempts WHERE run_id=?1",
          [rowText(row, "id")],
        );
        if (usage === undefined) throw new SessionExportError(503);
        attempts += rowInteger(usage, "attempts");
      }
      if (bytes > MAX_BYTES || events > MAX_EVENTS || attempts > MAX_EVENTS)
        throw new SessionExportError(413);
      return rows.map((row) => readExportSession(this.database, row));
    });
  }
  private authorize(identity: AuthenticatedIdentity) {
    if (identity.role !== "teacher") throw new SessionExportError(403);
  }
}
