import type { SchemaObjectDefinition } from "./migration-catalog.js";

const revision: SchemaObjectDefinition = {
  name: "marea_class_teaching_revisions",
  sql: `CREATE TABLE marea_class_teaching_revisions (
    id TEXT PRIMARY KEY,
    class_id TEXT NOT NULL REFERENCES marea_classes(id),
    created_by TEXT REFERENCES marea_users(id),
    created_at TEXT NOT NULL,
    configuration_json TEXT NOT NULL CHECK (json_valid(configuration_json)),
    authority TEXT NOT NULL DEFAULT 'teacher' CHECK (authority IN ('teacher', 'administrator', 'operator')),
    CHECK ((authority = 'operator' AND created_by IS NULL)
      OR (authority IN ('teacher', 'administrator') AND created_by IS NOT NULL)),
    UNIQUE (class_id, id)
  ) STRICT`,
  tableName: "marea_class_teaching_revisions",
  type: "table",
};

/** Rebuild the parent and its two children together, with foreign_keys left ON.
 * Temporary copies have no inbound foreign keys and disappear before commit.
 * Existing rows retain their original author and are explicitly teacher-authored.
 */
export function teachingAuthorshipMigration(schema: readonly SchemaObjectDefinition[]) {
  const children = schema.filter(
    ({ name }) =>
      name === "marea_current_class_teaching" || name === "marea_class_exchange_previews",
  );
  const childIndexes = schema.filter(
    ({ type, tableName }) => type === "index" && tableName === "marea_class_exchange_previews",
  );
  const tables = [revision.name, ...children.map(({ name }) => name)];
  return {
    name: "explicit_teaching_revision_authorship",
    version: 8,
    schemaAfter: schema.map((entry) => (entry.name === revision.name ? revision : entry)),
    statements: [
      ...tables.map((name) => `CREATE TEMP TABLE authorship_copy_${name} AS SELECT * FROM ${name}`),
      ...children.map(({ name }) => `DROP TABLE ${name}`),
      `DROP TABLE ${revision.name}`,
      revision.sql,
      `INSERT INTO marea_class_teaching_revisions (id, class_id, created_by, created_at, configuration_json, authority)
        SELECT id, class_id, created_by, created_at, configuration_json, 'teacher'
        FROM authorship_copy_marea_class_teaching_revisions`,
      ...children.map(({ sql }) => sql),
      ...children.map(({ name }) => `INSERT INTO ${name} SELECT * FROM authorship_copy_${name}`),
      ...childIndexes.map(({ sql }) => sql),
      ...tables.map((name) => `DROP TABLE authorship_copy_${name}`),
    ],
  };
}
