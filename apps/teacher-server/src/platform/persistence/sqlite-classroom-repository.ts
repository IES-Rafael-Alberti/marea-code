import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

import type { ClassroomRepository, StudentClassBootstrap } from "../../classes/contracts.js";
import type { AuthenticatedIdentity, StudentClassChoice } from "../../identity/contracts.js";
import { rowText } from "./row-parser.boundary.js";
import { activeStudentClass } from "./governance-access-sql.js";
import { readStudentClasses } from "./student-classes.js";

export class SqliteClassroomRepository implements ClassroomRepository {
  readonly #database: SqliteApplicationDatabase;

  public constructor(database: SqliteApplicationDatabase) {
    this.#database = database;
  }

  public loadStudentBootstrap(identity: AuthenticatedIdentity): StudentClassBootstrap | undefined {
    if (identity.classId === null) {
      return undefined;
    }
    const classroom = this.#database.readOne(
      `SELECT display_name FROM marea_classes WHERE id = ?1
        AND ${activeStudentClass("?2", "marea_classes.id")}`,
      [identity.classId, identity.userId],
    );
    if (classroom === undefined) {
      return undefined;
    }
    const run = this.#database.readOne(
      `SELECT id, project_display_name FROM marea_runs
        WHERE student_id = ?1 AND class_id = ?2 AND state = 'active'
        ORDER BY opened_at DESC, id DESC LIMIT 1`,
      [identity.userId, identity.classId],
    );
    return {
      activeRun:
        run === undefined
          ? null
          : {
              projectDisplayName: rowText(run, "project_display_name"),
              runId: rowText(run, "id"),
            },
      classDisplayName: rowText(classroom, "display_name"),
    };
  }

  public studentClasses(userId: string): readonly StudentClassChoice[] {
    return readStudentClasses(this.#database, userId);
  }
}
