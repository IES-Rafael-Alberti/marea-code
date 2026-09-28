import { TeacherNoticeSchema, type TeacherNotice } from "@marea/protocol";
import type { SqliteApplicationDatabase, SqliteRow } from "@marea/sqlite-storage";

import { TeacherDomainError } from "../../identity/errors.js";
import type { NoticeRepository, PublishNoticeInput } from "../../sessions/notice-service.js";
import { rowNullableText, rowText } from "./row-parser.boundary.js";
import { activeGovernanceAccount, activeGovernanceMembership } from "./governance-access-sql.js";

function noticeFromRow(row: SqliteRow): TeacherNotice {
  return TeacherNoticeSchema.parse({
    noticeId: rowText(row, "id"),
    runId: rowText(row, "run_id"),
    source: rowText(row, "source"),
    teacherDisplayName: rowText(row, "teacher_display_name"),
    text: rowText(row, "text"),
    createdAt: rowText(row, "created_at"),
  });
}

export class SqliteNoticeRepository implements NoticeRepository {
  public constructor(private readonly database: SqliteApplicationDatabase) {}

  public publish(input: PublishNoticeInput): TeacherNotice {
    return this.database.transaction(() => publishNoticeInTransaction(this.database, input));
  }

  public lookup(teacherId: string, runId: string, key: string) {
    return this.database.transaction(() => {
      const access = this.database.readOne(
        `SELECT runs.id FROM marea_runs runs
         JOIN marea_teacher_classes access ON access.class_id = runs.class_id
         WHERE runs.id = ?1 AND access.teacher_id = ?2
           AND ${activeGovernanceAccount("?2")}
           AND ${activeGovernanceMembership("?2", "runs.class_id", "'teacher'")}`,
        [runId, teacherId],
      );
      if (access === undefined) throw new TeacherDomainError("run.unavailable");
      const row = this.database.readOne(
        "SELECT * FROM marea_teacher_notices WHERE run_id = ?1 AND teacher_id = ?2 AND idempotency_key = ?3",
        [runId, teacherId, key],
      );
      return row === undefined
        ? null
        : {
            notice: noticeFromRow(row),
            acknowledgedAt: rowNullableText(row, "acknowledged_at"),
          };
    });
  }

  public pending(studentId: string, limit: number): readonly TeacherNotice[] {
    return this.database
      .readAll(
        `SELECT * FROM marea_teacher_notices WHERE student_id = ?1 AND acknowledged_at IS NULL
        AND ${activeGovernanceAccount("?1")}
        ORDER BY created_at ASC, id ASC LIMIT ?2`,
        [studentId, limit],
      )
      .map(noticeFromRow);
  }

  public acknowledge(studentId: string, noticeId: string, now: string): string {
    return this.database.transaction(() => {
      const row = this.database.readOne(
        `SELECT acknowledged_at FROM marea_teacher_notices WHERE student_id = ?1 AND id = ?2
          AND ${activeGovernanceAccount("?1")}`,
        [studentId, noticeId],
      );
      if (row === undefined) throw new TeacherDomainError("run.unavailable");
      const previous = rowNullableText(row, "acknowledged_at");
      if (previous !== null) return previous;
      this.database.execute(
        "UPDATE marea_teacher_notices SET acknowledged_at = ?3 WHERE student_id = ?1 AND id = ?2",
        [studentId, noticeId, now],
      );
      return now;
    });
  }
}

/** Used by approval delivery so the notice and approval commit together. */
export function publishNoticeInTransaction(
  database: SqliteApplicationDatabase,
  input: PublishNoticeInput,
): TeacherNotice {
  const run = database.readOne(
    `SELECT runs.student_id, runs.class_id FROM marea_runs runs
          JOIN marea_teacher_classes access ON access.class_id = runs.class_id
          WHERE access.teacher_id = ?1 AND runs.id = ?2
            AND ${activeGovernanceMembership("?1", "runs.class_id", "'teacher'")}`,
    [input.teacherId, input.runId],
  );
  if (run === undefined) throw new TeacherDomainError("run.unavailable");
  const previous = database.readOne(
    "SELECT * FROM marea_teacher_notices WHERE teacher_id = ?1 AND idempotency_key = ?2",
    [input.teacherId, input.idempotencyKey],
  );
  if (previous !== undefined) {
    if (rowText(previous, "fingerprint") !== input.fingerprint)
      throw new TeacherDomainError("request.conflict");
    return noticeFromRow(previous);
  }
  const notice = TeacherNoticeSchema.parse({
    noticeId: input.noticeId,
    runId: input.runId,
    source: input.source,
    teacherDisplayName: input.teacherDisplayName,
    text: input.text,
    createdAt: input.createdAt,
  });
  database.execute(
    `INSERT INTO marea_teacher_notices
          (id, run_id, student_id, class_id, teacher_id, teacher_display_name, source,
            text, created_at, idempotency_key, fingerprint)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    [
      notice.noticeId,
      notice.runId,
      rowText(run, "student_id"),
      rowText(run, "class_id"),
      input.teacherId,
      notice.teacherDisplayName,
      notice.source,
      notice.text,
      notice.createdAt,
      input.idempotencyKey,
      input.fingerprint,
    ],
  );
  return notice;
}
