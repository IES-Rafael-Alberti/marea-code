import type { ReadOnlySqliteApplicationDatabase } from "../contracts.js";
import type { DerivedQuery } from "./retention-rows.js";

/** Legacy installations remain readable before the explicit profile migration. */
export function hasProfileStorage(database: ReadOnlySqliteApplicationDatabase): boolean {
  return (
    database.readOne(
      "SELECT 1 FROM sqlite_schema WHERE name = 'marea_dashboard_profiles' AND type = 'table'",
    ) !== undefined
  );
}
export function profileRetentionRows(
  database: ReadOnlySqliteApplicationDatabase,
): readonly DerivedQuery[] {
  return hasProfileStorage(database)
    ? [
        [
          "dashboardProfiles",
          "SELECT class_id, schema_version, revision, updated_at, value_json, 1 AS rows, COALESCE(length(CAST(value_json AS BLOB)), 0) AS bytes FROM marea_dashboard_profiles WHERE owner_id = ?1 ORDER BY class_id",
        ],
      ]
    : [];
}
