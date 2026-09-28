import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import { TeacherDomainError } from "../../identity/errors.js";
import {
  StoredTeachingConfigurationSchema,
  type StoredTeachingConfiguration,
} from "../../teaching/configuration/configuration-schema.js";
import type {
  SaveTeachingRevision,
  TeachingConfigurationRepository,
} from "../../teaching/configuration/contracts.js";
import { rowJson } from "./row-parser.boundary.js";
import { activeGovernanceMembership } from "./governance-access-sql.js";
import { commitTeachingRevision } from "./teaching-revision-commit.js";

export class SqliteTeachingConfigurationRepository implements TeachingConfigurationRepository {
  readonly #database: SqliteApplicationDatabase;

  constructor(database: SqliteApplicationDatabase) {
    this.#database = database;
  }

  requireTeacherClass(teacherId: string, classId: string): void {
    const membership = this.#database.readOne(
      `SELECT users.id FROM marea_users users
        JOIN marea_teacher_classes membership ON membership.teacher_id = users.id
        WHERE users.id = ?1 AND membership.class_id = ?2 AND users.role = 'teacher'
          AND ${activeGovernanceMembership("users.id", "membership.class_id", "'teacher'")}`,
      [teacherId, classId],
    );
    if (membership === undefined) throw new TeacherDomainError("dashboard.forbidden");
  }

  loadForTeacher(teacherId: string, classId: string): StoredTeachingConfiguration | null {
    this.requireTeacherClass(teacherId, classId);
    const row = this.#database.readOne(
      `SELECT revisions.configuration_json FROM marea_current_class_teaching current
        JOIN marea_class_teaching_revisions revisions ON revisions.id = current.revision_id
        WHERE current.class_id = ?1`,
      [classId],
    );
    return row === undefined
      ? null
      : rowJson(row, "configuration_json", StoredTeachingConfigurationSchema);
  }

  loadForStudent(identity: AuthenticatedIdentity): StoredTeachingConfiguration | null {
    if (identity.role !== "student" || identity.classId === null)
      throw new TeacherDomainError("run.unavailable");
    const row = this.#database.readOne(
      `SELECT revisions.configuration_json FROM marea_users users
        JOIN marea_current_class_teaching current ON current.class_id = users.class_id
        JOIN marea_class_teaching_revisions revisions ON revisions.id = current.revision_id
        WHERE users.id = ?1 AND users.class_id = ?2 AND users.role = 'student'
          AND ${activeGovernanceMembership("users.id", "users.class_id", "'student'")}`,
      [identity.userId, identity.classId],
    );
    return row === undefined
      ? null
      : rowJson(row, "configuration_json", StoredTeachingConfigurationSchema);
  }

  saveRevision(input: SaveTeachingRevision): StoredTeachingConfiguration {
    const configuration = StoredTeachingConfigurationSchema.parse(input.configuration);
    return this.#database.transaction(() => {
      this.requireTeacherClass(input.teacherId, input.classId);
      return commitTeachingRevision(this.#database, {
        ...input,
        configuration,
        author: { kind: "teacher", userId: input.teacherId },
      });
    });
  }
}
