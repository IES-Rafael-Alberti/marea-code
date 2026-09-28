import { createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const bytes = new TextEncoder().encode("synthetic-sqlite");
const digest = createHash("sha256").update(bytes).digest("hex");
let capturedPath = "";
const capturedSchemas: unknown[] = [];
let closeCount = 0;
let restoredSchemaVersion = 1;
let capturedRestoreBackup:
  | {
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
    createBackup: () => {
      if (capturedPath.endsWith("backup-failure")) throw new Error("backup failed");
      return { bytes, format: "sqlite3", schemaVersion: 1, sha256: digest };
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
  restoreSqliteBackup: (options: {
    backup: {
      bytes: Uint8Array;
      format: string;
      schemaVersion: number;
      sha256: string;
    };
    databasePath: string;
    schema?: string;
  }) => {
    capturedSchemas.push(options.schema);
    capturedRestoreBackup = options.backup;
    if (
      (options.backup.schemaVersion !== 1 && options.backup.schemaVersion !== 2) ||
      options.backup.format !== "sqlite3" ||
      createHash("sha256").update(options.backup.bytes).digest("hex") !== options.backup.sha256
    )
      throw new Error("restore rejected");
    writeFileSync(options.databasePath, options.backup.bytes, { flag: "wx" });
    restoredSchemaVersion = options.backup.schemaVersion === 2 ? 6 : 1;
    return storage(restoredSchemaVersion);
  },
};
