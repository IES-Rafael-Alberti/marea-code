import type { SqliteApplicationDatabase } from "./contracts.js";

/** Account-scoped UI metadata is included in ordinary database backups. No schema upgrade needed. */
export function createDashboardLanguageStore(
  database: Pick<SqliteApplicationDatabase, "readOne" | "execute">,
) {
  const key = (ownerId: string) => `dashboard-language:${ownerId}`;
  return {
    read(ownerId: string): string | null {
      const row = database.readOne("SELECT value FROM marea_metadata WHERE key = ?1", [
        key(ownerId),
      ]);
      if (row === undefined) return null;
      if (typeof row.value !== "string") throw new Error("Invalid dashboard language record.");
      return row.value;
    },
    write(ownerId: string, preference: string): void {
      database.execute(
        "INSERT INTO marea_metadata(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key(ownerId), preference],
      );
    },
  };
}
