import { SqliteStorageError } from "./contracts.js";
import type { DiskSpacePort, SqliteDatabasePort } from "./database-port.js";

const MEBIBYTE = 1_048_576;
const MINIMUM_MARGIN_BYTES = 64 * MEBIBYTE;

function pragmaNumber(database: SqliteDatabasePort, name: "page_count" | "page_size"): number {
  return Number(database.readOne(`PRAGMA ${name}`)?.[name] ?? 0);
}

/** The compacted copy is never larger than the database; the margin covers temporary files. */
export function requiredBackupBytes(database: SqliteDatabasePort): number {
  const databaseBytes = pragmaNumber(database, "page_count") * pragmaNumber(database, "page_size");
  return databaseBytes + Math.max(MINIMUM_MARGIN_BYTES, Math.ceil(databaseBytes / 10));
}

/**
 * Fails before any byte is copied when the destination volume cannot hold the backup, naming both
 * figures. A volume whose free space cannot be read is left to the copy itself to fail.
 */
export function assertBackupSpace(
  database: SqliteDatabasePort,
  space: DiskSpacePort,
  directory: string,
): void {
  const available = space.freeBytes(directory);
  // Stryker disable next-line ConditionalExpression: comparing undefined with a number is false, so skipping the early return is equivalent.
  if (available === undefined) return;
  const required = requiredBackupBytes(database);
  if (available < required) {
    throw new SqliteStorageError(
      "insufficient-disk-space",
      `The SQLite backup needs ${String(Math.ceil(required / MEBIBYTE))} MiB of free disk space but only ${String(Math.floor(available / MEBIBYTE))} MiB is available.`,
    );
  }
}
