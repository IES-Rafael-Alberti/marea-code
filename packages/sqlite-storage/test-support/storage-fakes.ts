import { createHash } from "node:crypto";

import { expect } from "vitest";

import type { SqliteBackup } from "../src/contracts.js";
import { SQLITE_BACKUP_FORMAT, SqliteStorageError } from "../src/contracts.js";
import type {
  DatabaseRow,
  SqliteDatabasePort,
  SqliteDriverPort,
  SqliteParameter,
} from "../src/database-port.js";
import {
  createMigrationCatalog,
  migrationLedgerSql,
  type SchemaObjectDefinition,
} from "../src/migration-catalog.js";
import type { StorageDependencies } from "../src/storage.js";

export const MIGRATIONS = createMigrationCatalog();
const MIGRATION_LEDGER_SQL = migrationLedgerSql();

export function applyFakeMigrationStatement(
  sql: string,
  parameters: readonly SqliteParameter[],
  applied: DatabaseRow[],
  addSchema: (name: string) => void,
  setUserVersion: (version: number) => void,
): void {
  if (sql === MIGRATION_LEDGER_SQL) {
    addSchema("marea_schema_migrations");
  } else if (sql.startsWith("INSERT INTO marea_schema_migrations")) {
    applied.push({
      checksum: String(parameters[2]),
      name: String(parameters[1]),
      version: Number(parameters[0]),
    });
  } else if (sql.startsWith("PRAGMA user_version = ")) {
    setUserVersion(Number(sql.slice("PRAGMA user_version = ".length)));
  } else {
    const schemaObject = latestMigration().schemaAfter.find((entry) => entry.sql === sql);
    if (schemaObject !== undefined) {
      addSchema(schemaObject.name);
    }
  }
}

export function initialMigration(): (typeof MIGRATIONS)[number] {
  const migration = MIGRATIONS[0];
  if (migration === undefined) {
    throw new Error("Expected the initial migration");
  }
  return migration;
}

export function latestMigration(): (typeof MIGRATIONS)[number] {
  const migration = MIGRATIONS.at(-1);
  if (migration === undefined) {
    throw new Error("Expected the latest migration");
  }
  return migration;
}

export function appliedMigrations(): readonly DatabaseRow[] {
  return MIGRATIONS.map(({ checksum, name, version }) => ({ checksum, name, version }));
}

export function schemaRow(definition: SchemaObjectDefinition): DatabaseRow {
  return {
    name: definition.name,
    sql: definition.sql,
    tbl_name: definition.tableName,
    type: definition.type,
  };
}

export function sortSchemaRows(rows: DatabaseRow[]): void {
  rows.sort((left, right) =>
    `${String(left.type)}:${String(left.name)}`.localeCompare(
      `${String(right.type)}:${String(right.name)}`,
    ),
  );
}

export class ReadyDatabase implements SqliteDatabasePort {
  public applied: DatabaseRow[] = [];
  public closeError = false;
  public closeCalls = 0;
  public readonly executions: string[] = [];
  public integrity = "ok";
  public schema: DatabaseRow[] = [];
  public serializeError = false;
  public serializedBytes = Uint8Array.from([1, 2, 3]);
  public userVersion = 0;

  public close(): void {
    this.closeCalls += 1;
    if (this.closeError) {
      throw new Error("private close detail");
    }
  }

  public execute(sql: string, parameters: readonly SqliteParameter[] = []): void {
    this.executions.push(sql);
    applyFakeMigrationStatement(
      sql,
      parameters,
      this.applied,
      (name) => {
        this.addSchema(name);
      },
      (version) => {
        this.userVersion = version;
      },
    );
  }

  public readAll(sql: string): readonly DatabaseRow[] {
    return sql.includes("sqlite_schema") ? this.schema : this.applied;
  }

  public readOne(sql: string): DatabaseRow | undefined {
    const rows = new Map<string, DatabaseRow>([
      ["PRAGMA busy_timeout", { timeout: 5000n }],
      ["PRAGMA journal_mode", { journal_mode: "wal" }],
      ["PRAGMA foreign_keys", { foreign_keys: 1n }],
      ["PRAGMA synchronous", { synchronous: 2n }],
      ["PRAGMA quick_check", { quick_check: this.integrity }],
      ["PRAGMA user_version", { user_version: BigInt(this.userVersion) }],
    ]);
    return rows.get(sql);
  }

  public serialize(): Uint8Array {
    if (this.serializeError) {
      throw new Error("private serialization detail");
    }
    return this.serializedBytes;
  }

  public transactionImmediate<T>(operation: () => T): T {
    return operation();
  }

  private addSchema(name: string): void {
    if (this.schema.some((row) => row.name === name)) {
      return;
    }
    const definition = latestMigration().schemaAfter.find((entry) => entry.name === name);
    if (definition === undefined) {
      throw new Error("Expected a schema definition");
    }
    this.schema.push(schemaRow(definition));
    sortSchemaRows(this.schema);
  }
}

export function driverFor(open: (databasePath: string) => SqliteDatabasePort): SqliteDriverPort {
  return { open };
}

export function dependencies(
  database: ReadyDatabase,
  change: Partial<StorageDependencies> = {},
): StorageDependencies {
  return {
    backupFiles: {
      installNew(_databasePath, _bytes, validateStagedFile): void {
        validateStagedFile("/tmp/staged.sqlite");
      },
    },
    driver: driverFor(() => database),
    initializationLock: {
      runExclusive<T>(_databasePath: string, operation: () => T): T {
        return operation();
      },
    },
    maxBackupBytes: 8,
    migrations: MIGRATIONS,
    ...change,
  };
}

export function backup(bytes = Uint8Array.from([1, 2, 3])): SqliteBackup {
  return {
    bytes,
    format: SQLITE_BACKUP_FORMAT,
    schemaVersion: MIGRATIONS.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function expectCode(
  operation: () => void,
  code: SqliteStorageError["code"],
  expectedMessage?: string,
): void {
  const messages: Record<SqliteStorageError["code"], string> = {
    "backup-failed": "The SQLite backup could not be created.",
    "backup-invalid": "The SQLite backup is invalid.",
    "database-unavailable": "The SQLite database could not be initialized.",
    "invalid-database-path": "The SQLite database path must be an absolute persistent file path.",
    "migration-drift": "The database migration history does not match this release.",
    "migration-invalid": "The migration catalog is invalid.",
    "restore-failed": "The SQLite backup could not be restored to a new database file.",
    "schema-mismatch": "The database schema does not match this release.",
    "storage-closed": "The SQLite storage is closed.",
    "storage-configuration-invalid": "The SQLite storage configuration is invalid.",
  };
  expect(operation).toThrow(
    expect.objectContaining<Partial<SqliteStorageError>>({
      code,
      message: expectedMessage ?? messages[code],
      name: "SqliteStorageError",
    }),
  );
}
