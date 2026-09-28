import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import { TeacherDomainError } from "../../identity/errors.js";
import type { StoredTeachingConfiguration } from "../../teaching/configuration/configuration-schema.js";
import { rowText } from "./row-parser.boundary.js";

export type TeachingRevisionAuthor =
  | { readonly kind: "teacher" | "administrator"; readonly userId: string }
  | { readonly kind: "operator" };

/** The caller owns the immediate transaction and its distinct live authority gate.
 * This private persistence helper does not confer teacher or administrator access.
 */
export function commitTeachingRevision(
  database: SqliteApplicationDatabase,
  input: {
    readonly classId: string;
    readonly author: TeachingRevisionAuthor;
    readonly expectedVersion: string | null;
    readonly createdAt: string;
    readonly configuration: StoredTeachingConfiguration;
  },
): StoredTeachingConfiguration {
  const current = database.readOne(
    "SELECT revision_id FROM marea_current_class_teaching WHERE class_id = ?1",
    [input.classId],
  );
  const currentVersion = current === undefined ? null : rowText(current, "revision_id");
  if (currentVersion !== input.expectedVersion) throw new TeacherDomainError("request.conflict");
  const revision = input.configuration.content.configurationVersion;
  database.execute(
    `INSERT INTO marea_class_teaching_revisions (id, class_id, created_by, created_at, configuration_json, authority)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    [
      revision,
      input.classId,
      input.author.kind === "operator" ? null : input.author.userId,
      input.createdAt,
      JSON.stringify(input.configuration),
      input.author.kind,
    ],
  );
  database.execute(
    `INSERT INTO marea_current_class_teaching (class_id, revision_id) VALUES (?1, ?2)
      ON CONFLICT(class_id) DO UPDATE SET revision_id = excluded.revision_id`,
    [input.classId, revision],
  );
  return input.configuration;
}
