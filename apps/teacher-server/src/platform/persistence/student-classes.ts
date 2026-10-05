import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

import { activeStudentClass } from "./governance-access-sql.js";
import { rowText } from "./row-parser.boundary.js";

export interface StudentClass {
  readonly classId: string;
  readonly displayName: string;
}

/** Bounded so that a selection list always fits the protocol. */
const MAX_STUDENT_CLASSES = 64;

/** Every class this student may act for now, in a stable presentation order. */
export function readStudentClasses(
  database: Pick<SqliteApplicationDatabase, "readAll">,
  userId: string,
): readonly StudentClass[] {
  return database
    .readAll(
      `SELECT classes.id, classes.display_name FROM marea_classes classes
        WHERE EXISTS (SELECT 1 FROM marea_users users WHERE users.id = ?1 AND users.role = 'student')
          AND ${activeStudentClass("?1", "classes.id")}
        ORDER BY classes.display_name, classes.id LIMIT ?2`,
      [userId, MAX_STUDENT_CLASSES],
    )
    .map((row) => ({ classId: rowText(row, "id"), displayName: rowText(row, "display_name") }));
}

/** Schema 12 records the class each auth session acts for. */
export function hasClassScopedSessions(
  database: Pick<SqliteApplicationDatabase, "readOne">,
): boolean {
  return (
    database.readOne(
      "SELECT 1 FROM pragma_table_info('marea_auth_sessions') WHERE name = 'class_id'",
    ) !== undefined
  );
}

/** Schema 12: ends a student's sessions and run leases for one class only. */
export function revokeStudentClassAccess(
  database: Pick<SqliteApplicationDatabase, "execute">,
  userId: string,
  classId: string,
  now: string,
): void {
  database.execute(
    `UPDATE marea_auth_sessions SET revoked_at = ?3
      WHERE user_id = ?1 AND class_id = ?2 AND revoked_at IS NULL`,
    [userId, classId, now],
  );
  database.execute(
    `UPDATE marea_run_leases SET revoked_at = ?3 WHERE student_id = ?1 AND revoked_at IS NULL
      AND run_id IN (SELECT id FROM marea_runs WHERE class_id = ?2)`,
    [userId, classId, now],
  );
}
