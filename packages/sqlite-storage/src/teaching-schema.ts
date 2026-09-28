import type { SchemaObjectDefinition } from "./migration-catalog.js";

/** Additive teaching storage; never changes the checksummed base schemas. */
export function teachingSchema(): readonly SchemaObjectDefinition[] {
  return [
    {
      name: "marea_class_teaching_revisions",
      sql: `CREATE TABLE marea_class_teaching_revisions (
        id TEXT PRIMARY KEY,
        class_id TEXT NOT NULL REFERENCES marea_classes(id),
        created_by TEXT NOT NULL REFERENCES marea_users(id),
        created_at TEXT NOT NULL,
        configuration_json TEXT NOT NULL CHECK (json_valid(configuration_json)),
        UNIQUE (class_id, id)
      ) STRICT`,
      tableName: "marea_class_teaching_revisions",
      type: "table",
    },
    {
      name: "marea_current_class_teaching",
      sql: `CREATE TABLE marea_current_class_teaching (
        class_id TEXT PRIMARY KEY REFERENCES marea_classes(id),
        revision_id TEXT NOT NULL UNIQUE,
        FOREIGN KEY (class_id, revision_id)
          REFERENCES marea_class_teaching_revisions(class_id, id)
      ) STRICT`,
      tableName: "marea_current_class_teaching",
      type: "table",
    },
    {
      name: "marea_run_teaching_snapshots",
      sql: `CREATE TABLE marea_run_teaching_snapshots (
        snapshot_id TEXT PRIMARY KEY REFERENCES marea_run_snapshots(id) ON DELETE CASCADE,
        teaching_json TEXT NOT NULL CHECK (json_valid(teaching_json))
      ) STRICT`,
      tableName: "marea_run_teaching_snapshots",
      type: "table",
    },
  ];
}
