import type { SqliteApplicationDatabase, SqliteRow } from "./contracts.js";

export interface StoredDashboardProfile {
  readonly schemaVersion: number;
  readonly revision: string;
  readonly updatedAt: string;
  readonly serializedValue: string | null;
}

function parseProfile(row: SqliteRow): StoredDashboardProfile {
  if (typeof row.schema_version !== "number" && typeof row.schema_version !== "bigint")
    throw new Error("Invalid profile version.");
  if (
    typeof row.revision !== "string" ||
    typeof row.updated_at !== "string" ||
    (row.value_json !== null && typeof row.value_json !== "string")
  )
    throw new Error("Invalid profile record.");
  return {
    schemaVersion: Number(row.schema_version),
    revision: row.revision,
    updatedAt: row.updated_at,
    serializedValue: row.value_json,
  };
}

/** Runs the caller's authorization and revision checks inside the same immediate transaction. */
export function createDashboardProfileStore(database: SqliteApplicationDatabase) {
  return {
    transaction: <T>(operation: () => T): T => database.transaction(operation),
    authorized: (ownerId: string, classId: string | null): boolean =>
      database.readOne(
        `SELECT id FROM marea_users WHERE id = ?1 AND role = 'teacher'
       AND (?2 IS NULL OR EXISTS (SELECT 1 FROM marea_teacher_classes
         WHERE teacher_id = ?1 AND class_id = ?2))`,
        [ownerId, classId],
      ) !== undefined,
    read: (ownerId: string, classId: string | null): StoredDashboardProfile | null => {
      const row = database.readOne(
        "SELECT schema_version, revision, updated_at, value_json FROM marea_dashboard_profiles WHERE owner_id = ?1 AND class_id IS ?2",
        [ownerId, classId],
      );
      return row === undefined ? null : parseProfile(row);
    },
    write: (ownerId: string, classId: string | null, record: StoredDashboardProfile): void => {
      database.execute(
        "DELETE FROM marea_dashboard_profiles WHERE owner_id = ?1 AND class_id IS ?2",
        [ownerId, classId],
      );
      database.execute(
        "INSERT INTO marea_dashboard_profiles(owner_id, class_id, schema_version, revision, updated_at, value_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        [
          ownerId,
          classId,
          record.schemaVersion,
          record.revision,
          record.updatedAt,
          record.serializedValue,
        ],
      );
    },
  };
}
