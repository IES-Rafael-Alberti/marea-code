import { closeSync, existsSync, openSync, readSync } from "node:fs";

import { Database } from "bun:sqlite";
import { SqliteStorageError, type SqliteStorageOptions } from "./contracts.js";
import { canonicalizeDatabasePath } from "./database-path.boundary.js";

const HEADER_BYTES = 100;
const USER_VERSION_OFFSET = 60;
const MAGIC = "SQLite format 3\0";

function openedVersion(path: string): number | undefined {
  const database = new Database(path, { readonly: true, strict: true });
  try {
    const statement = database.prepare<{ user_version: number }, []>("PRAGMA user_version");
    try {
      return statement.get()?.user_version;
    } finally {
      statement.finalize();
    }
  } finally {
    database.close(true);
  }
}

/**
 * Without a WAL or rollback journal the main file header is the committed state. A read-only
 * connection cannot open a WAL-mode file whose sidecars are gone, as after a restore or transfer.
 */
function headerVersion(path: string): number {
  const header = Buffer.alloc(HEADER_BYTES);
  const descriptor = openSync(path, "r");
  let read: number;
  try {
    read = readSync(descriptor, header, 0, HEADER_BYTES, 0);
  } finally {
    closeSync(descriptor);
  }
  // SQLite treats an empty file as an empty database.
  if (read === 0) return 0;
  if (read !== HEADER_BYTES || header.toString("latin1", 0, MAGIC.length) !== MAGIC)
    throw new TypeError();
  return header.readInt32BE(USER_VERSION_OFFSET);
}

/** Inspect an existing database, including its WAL, without creating, configuring or migrating it. */
export function inspectSqliteSchemaVersion(options: SqliteStorageOptions): number {
  const path = canonicalizeDatabasePath(options.databasePath);
  let version: number | undefined;
  try {
    version =
      existsSync(`${path}-wal`) || existsSync(`${path}-journal`)
        ? openedVersion(path)
        : headerVersion(path);
  } catch {
    throw new SqliteStorageError(
      "database-unavailable",
      "The SQLite schema could not be inspected.",
    );
  }
  if (version === undefined)
    throw new SqliteStorageError("schema-mismatch", "The SQLite schema version is unavailable.");
  return version;
}
