import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

import { SqliteStorageError } from "./contracts.js";

function invalidDatabasePath(): never {
  throw new SqliteStorageError(
    "invalid-database-path",
    "The SQLite database path must be an absolute persistent file path.",
  );
}

function validateText(databasePath: string): void {
  const maxBasenameBytes = 255;
  const maxPathBytes = 4096;
  if (
    typeof databasePath !== "string" ||
    databasePath.length > maxPathBytes ||
    databasePath.includes("\0") ||
    !isAbsolute(databasePath)
  ) {
    invalidDatabasePath();
  }
  const encodedPathLength = new TextEncoder().encode(databasePath).byteLength;
  const encodedBasenameLength = new TextEncoder().encode(basename(databasePath)).byteLength;
  if (encodedPathLength > maxPathBytes || encodedBasenameLength > maxBasenameBytes) {
    invalidDatabasePath();
  }
}

function inspectPath(databasePath: string) {
  try {
    const canonicalPath = join(realpathSync.native(dirname(databasePath)), basename(databasePath));
    return {
      canonicalPath,
      existing: lstatSync(canonicalPath, { throwIfNoEntry: false }),
    };
  } catch {
    invalidDatabasePath();
  }
}

export function canonicalizeDatabasePath(databasePath: string): string {
  validateText(databasePath);
  const { canonicalPath, existing } = inspectPath(databasePath);
  if (
    existing !== undefined &&
    (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
  ) {
    invalidDatabasePath();
  }
  return canonicalPath;
}
