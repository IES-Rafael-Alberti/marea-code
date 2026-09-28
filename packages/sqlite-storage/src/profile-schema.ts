import type { SchemaObjectDefinition } from "./migration-catalog.js";

/** Reset rows retain their revision; separate partial keys avoid SQLite NULL uniqueness. */
export function profileSchema(): readonly SchemaObjectDefinition[] {
  const tableName = "marea_dashboard_profiles";
  return [
    {
      name: tableName,
      sql: `CREATE TABLE marea_dashboard_profiles (
      owner_id TEXT NOT NULL REFERENCES marea_users(id) ON DELETE CASCADE,
      class_id TEXT REFERENCES marea_classes(id) ON DELETE CASCADE,
      schema_version INTEGER NOT NULL,
      revision TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      value_json TEXT CHECK (value_json IS NULL OR length(CAST(value_json AS BLOB)) <= 65536)
    ) STRICT`,
      tableName,
      type: "table",
    },
    {
      name: "marea_dashboard_profiles_personal",
      sql: "CREATE UNIQUE INDEX marea_dashboard_profiles_personal ON marea_dashboard_profiles(owner_id) WHERE class_id IS NULL",
      tableName,
      type: "index",
    },
    {
      name: "marea_dashboard_profiles_class",
      sql: "CREATE UNIQUE INDEX marea_dashboard_profiles_class ON marea_dashboard_profiles(owner_id, class_id) WHERE class_id IS NOT NULL",
      tableName,
      type: "index",
    },
  ];
}
