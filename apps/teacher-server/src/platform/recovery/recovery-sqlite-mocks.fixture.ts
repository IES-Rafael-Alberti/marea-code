import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, readFileSync } from "node:fs";

let capturedPath = "";
const capturedSchemas: unknown[] = [];
let closeCount = 0;
let restoredSchemaVersion = 1;
let capturedRestoreBackup:
  | {
      readonly backupPath: string;
      readonly bytes: Uint8Array;
      readonly format: string;
      readonly schemaVersion: number;
      readonly sha256: string;
    }
  | undefined;

function storage(schemaVersion = 1) {
  return {
    close: () => {
      closeCount += 1;
    },
    schema: { version: schemaVersion },
  };
}

export function sqliteCloseCount(): number {
  return closeCount;
}

/** Catalog names passed to restore and reopen, in call order. */
export function restoreSchemas(): readonly unknown[] {
  return capturedSchemas;
}

export function lastReopenPath(): string {
  return capturedPath;
}

export function lastRestoredBackup(): typeof capturedRestoreBackup {
  return capturedRestoreBackup;
}

export default {
  SQLITE_BACKUP_FORMAT: "sqlite3",
  initializeSqliteStorage: (options: { databasePath: string; schema?: string }) => {
    capturedSchemas.push(options.schema);
    if (options.databasePath.includes("reopen-failure")) throw new Error("reopen failed");
    if (!existsSync(options.databasePath)) throw new Error("database unavailable");
    capturedPath = options.databasePath;
    return storage(restoredSchemaVersion);
  },
  restoreSqliteBackupFile: (options: {
    backupPath: string;
    databasePath: string;
    format: string;
    schemaVersion: number;
    schema?: string;
    sha256: string;
  }) => {
    capturedSchemas.push(options.schema);
    const restoredBytes = readFileSync(options.backupPath);
    capturedRestoreBackup = { ...options, bytes: restoredBytes };
    if (
      (options.schemaVersion !== 1 && options.schemaVersion !== 2) ||
      options.format !== "sqlite3" ||
      createHash("sha256").update(restoredBytes).digest("hex") !== options.sha256
    )
      throw new Error("restore rejected");
    copyFileSync(options.backupPath, options.databasePath, constants.COPYFILE_EXCL);
    restoredSchemaVersion = options.schemaVersion === 2 ? 6 : 1;
    return storage(restoredSchemaVersion);
  },
  SqliteStorageError: class SqliteStorageError extends Error {
    public readonly code: string;

    public constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
};
