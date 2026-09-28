import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

export const smokeState = {
  closeCalls: [] as readonly string[],
  executes: [] as readonly string[],
  readCalls: 0,
  restoreCalls: [] as readonly {
    readonly backupSchemaVersion: number;
    readonly databasePath: string;
  }[],
  queries: [] as readonly unknown[][],
  initializeCalls: [] as readonly string[],
  sourceDatabasePath: "",
  invalidRead: "" as string,
};

export function resetSmokeState(): void {
  smokeState.closeCalls = [];
  smokeState.executes = [];
  smokeState.readCalls = 0;
  smokeState.restoreCalls = [];
  smokeState.queries = [];
  smokeState.initializeCalls = [];
  smokeState.sourceDatabasePath = "";
  smokeState.invalidRead = "";
}

function storage(phase: string) {
  return {
    close: () => {
      smokeState.closeCalls = [...smokeState.closeCalls, phase];
    },
    createBackup: () => {
      const bytes = new TextEncoder().encode("synthetic-sqlite");
      return {
        bytes,
        format: "sqlite3",
        schemaVersion: 6,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    },
    database: {
      execute: (sql: string, parameters?: readonly unknown[]) => {
        smokeState.executes = [...smokeState.executes, JSON.stringify({ sql, parameters })];
      },
      readOne: (sql: string, parameters?: readonly unknown[]) => {
        smokeState.queries = [...smokeState.queries, Array.from(parameters ?? [])];
        if (!sql.includes("marea_classes")) return undefined;
        if (
          smokeState.readCalls === 0 &&
          JSON.stringify(parameters) !== JSON.stringify(["class:smoke"])
        ) {
          return undefined;
        }
        if (
          smokeState.readCalls === 1 &&
          JSON.stringify(parameters) !== JSON.stringify(["class:restored"])
        ) {
          return undefined;
        }
        smokeState.readCalls += 1;
        const source = { id: "class:smoke", display_name: "Recovery smoke class" };
        const persisted = { id: "class:restored", display_name: "Restored persistence class" };
        if (smokeState.invalidRead !== "") {
          const first = smokeState.readCalls === 1;
          const row = first ? source : persisted;
          if (smokeState.invalidRead === "id") return { ...row, id: "wrong" };
          if (smokeState.invalidRead === "display-name") return { ...row, display_name: "wrong" };
          return undefined;
        }
        return smokeState.readCalls === 1 ? source : persisted;
      },
    },
    schema: { version: 6 },
  };
}

export default {
  SQLITE_BACKUP_FORMAT: "sqlite3",
  initializeSqliteStorage: (options: { databasePath: string }) => {
    smokeState.initializeCalls = [...smokeState.initializeCalls, options.databasePath];
    if (smokeState.sourceDatabasePath === "") {
      smokeState.sourceDatabasePath = options.databasePath;
      return storage("source");
    }
    return storage("reopened");
  },
  restoreSqliteBackup: (options: { backup: { schemaVersion: number }; databasePath: string }) => {
    smokeState.restoreCalls = [
      ...smokeState.restoreCalls,
      { backupSchemaVersion: options.backup.schemaVersion, databasePath: options.databasePath },
    ];
    writeFileSync(options.databasePath, "synthetic-sqlite", { flag: "wx" });
    return storage("restored");
  },
};
