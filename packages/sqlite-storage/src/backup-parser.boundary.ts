import { createHash } from "node:crypto";

import { SQLITE_BACKUP_FORMAT, SqliteStorageError } from "./contracts.js";

type BoundaryRecord = Readonly<Record<string, unknown>>;

export interface ParsedSqliteBackup {
  readonly bytes: Uint8Array;
  readonly schemaVersion: number;
}

export function calculateBackupDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function invalidBackup(): never {
  throw new SqliteStorageError("backup-invalid", "The SQLite backup is invalid.");
}

function parseSchemaVersion(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value)) invalidBackup();
  // Number.isSafeInteger is non-coercing, but TypeScript does not narrow its input.
  const version = value as number;
  if (version < 1 || version > maximum) invalidBackup();
  return version;
}

export function parseBackup(
  value: unknown,
  expectedVersion: number,
  maxBackupBytes: number,
): ParsedSqliteBackup {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidBackup();
  }
  const record = value as BoundaryRecord;
  const bytes = record.bytes;
  const schemaVersion = parseSchemaVersion(record.schemaVersion, expectedVersion);
  if (record.format !== SQLITE_BACKUP_FORMAT || !(bytes instanceof Uint8Array)) {
    invalidBackup();
  }
  const ownedBytes = Uint8Array.from(bytes);
  if (
    ownedBytes.byteLength > maxBackupBytes ||
    calculateBackupDigest(ownedBytes) !== record.sha256
  ) {
    invalidBackup();
  }
  return Object.freeze({ bytes: ownedBytes, schemaVersion });
}
