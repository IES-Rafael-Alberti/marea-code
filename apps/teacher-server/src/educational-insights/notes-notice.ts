import * as z from "zod";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

/**
 * A dashboard-only notice that a student's notes did not fit a session's tutor prompt. It is
 * account-scoped metadata, like the dashboard language: one per student, replaced by the next,
 * cleared when a teacher saves that student's notes and deleted with the account.
 */
const NoticeSchema = z.object({
  classId: z.string(),
  sessionDate: z.string(),
  shortened: z.enum(["summarized", "trimmed"]),
});
export type NotesNotice = Omit<z.infer<typeof NoticeSchema>, "classId">;
const notesNoticeKey = (studentId: string) => `learning-notes-notice:${studentId}`;

export function recordNotesNotice(
  database: SqliteApplicationDatabase,
  studentId: string,
  notice: z.infer<typeof NoticeSchema>,
): void {
  database.execute(
    "INSERT INTO marea_metadata(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [notesNoticeKey(studentId), JSON.stringify(notice)],
  );
}

export function clearNotesNotice(database: SqliteApplicationDatabase, studentId: string): void {
  database.execute("DELETE FROM marea_metadata WHERE key = ?1", [notesNoticeKey(studentId)]);
}

/** The notice of a student in this class, or null; a record of another shape is ignored. */
export function readNotesNotice(
  database: SqliteApplicationDatabase,
  classId: string,
  studentId: string,
): NotesNotice | null {
  const row = database.readOne("SELECT value FROM marea_metadata WHERE key = ?1", [
    notesNoticeKey(studentId),
  ]);
  if (row === undefined) return null;
  // Only this module writes the record, always as JSON.
  const parsed = NoticeSchema.safeParse(JSON.parse(String(row.value)));
  return parsed.success && parsed.data.classId === classId
    ? { sessionDate: parsed.data.sessionDate, shortened: parsed.data.shortened }
    : null;
}
