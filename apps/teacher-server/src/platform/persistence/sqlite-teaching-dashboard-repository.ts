import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

import { rowText } from "./row-parser.boundary.js";
import { activeGovernanceMembership } from "./governance-access-sql.js";
import type {
  TeachingClassDirectory,
  TeachingClassPageRequest,
  TeachingClassRow,
} from "../../teaching/configuration/dashboard-module.js";

/** Lists currently assigned classes from membership tables; never active runs. */
export class SqliteTeachingDashboardRepository implements TeachingClassDirectory {
  readonly #database: SqliteApplicationDatabase;

  constructor(database: SqliteApplicationDatabase) {
    this.#database = database;
  }

  listClasses(request: TeachingClassPageRequest): Promise<readonly TeachingClassRow[]> {
    const rows = this.#database.readAll(
      `SELECT classes.id, classes.display_name FROM marea_classes classes
        JOIN marea_teacher_classes membership ON membership.class_id = classes.id
        JOIN marea_users users ON users.id = membership.teacher_id
        WHERE users.id = ?1 AND users.role = 'teacher'
          AND ${activeGovernanceMembership("users.id", "classes.id", "'teacher'")}
          AND (?2 IS NULL OR classes.id > ?2)
        ORDER BY classes.id ASC
        LIMIT ?3`,
      [request.teacherId, request.afterClassId, request.limit + 1],
    );
    return Promise.resolve(
      Object.freeze(
        rows.map((row) => ({
          classId: rowText(row, "id"),
          displayName: rowText(row, "display_name"),
        })),
      ),
    );
  }
}
