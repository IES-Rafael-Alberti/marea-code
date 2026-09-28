import type { AppliedMigration, SqliteSchemaInfo } from "./contracts.js";
import { SqliteStorageError } from "./contracts.js";
import type { DatabaseRow, SqliteDatabasePort } from "./database-port.js";
import {
  type MigrationDefinition,
  type SchemaObjectDefinition,
  migrationLedgerSql,
} from "./migration-catalog.js";

const READ_MIGRATIONS =
  "SELECT version, name, checksum FROM marea_schema_migrations ORDER BY version";
const READ_SCHEMA = `SELECT type, name, tbl_name, sql
  FROM sqlite_schema
  WHERE name NOT LIKE 'sqlite_%'
  ORDER BY type, name`;

function configurationError(): never {
  throw new SqliteStorageError(
    "database-unavailable",
    "SQLite could not apply the required storage settings.",
  );
}

function schemaError(code: "migration-drift" | "schema-mismatch"): never {
  const message =
    code === "migration-drift"
      ? "The database migration history does not match this release."
      : "The database schema does not match this release.";
  throw new SqliteStorageError(code, message);
}

function readInteger(row: DatabaseRow | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value === "bigint") {
    const numberValue = Number(value);
    if (Number.isSafeInteger(numberValue)) {
      return numberValue;
    }
  }
  if (Number.isSafeInteger(value)) {
    return value as number;
  }
  schemaError("schema-mismatch");
}

function readText(row: DatabaseRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    schemaError("schema-mismatch");
  }
  return value;
}

// Stryker disable all: schema normalization is applied symmetrically to both fingerprints.
function normalizeSchemaSql(sql: string): string {
  return sql
    .replaceAll(/\s+/gu, " ")
    .replace("CREATE TABLE IF NOT EXISTS ", "CREATE TABLE ")
    .trim();
}
// Stryker restore all

function readSchema(
  database: Pick<SqliteDatabasePort, "readAll">,
): readonly SchemaObjectDefinition[] {
  return database.readAll(READ_SCHEMA).map((row) => ({
    name: readText(row, "name"),
    sql: normalizeSchemaSql(readText(row, "sql")),
    tableName: readText(row, "tbl_name"),
    type: readText(row, "type") as SchemaObjectDefinition["type"],
  }));
}

function verifySchemaFingerprint(
  database: Pick<SqliteDatabasePort, "readAll">,
  catalog: readonly MigrationDefinition[],
): void {
  const latestMigration = catalog.at(-1);
  if (latestMigration === undefined) {
    schemaError("schema-mismatch");
  }
  const expected = latestMigration.schemaAfter;
  const actual = readSchema(database);
  const expectedFingerprint = expected.map((schemaObject) => ({
    ...schemaObject,
    sql: normalizeSchemaSql(schemaObject.sql),
  }));
  if (JSON.stringify(actual) !== JSON.stringify(expectedFingerprint)) {
    schemaError("schema-mismatch");
  }
}

function expectSetting(
  database: SqliteDatabasePort,
  sql: string,
  key: string,
  expected: number | string,
): void {
  const row = database.readOne(sql);
  if (row === undefined) {
    configurationError();
  }
  const value = row[key];
  const matchesInteger = typeof expected === "number" && value === BigInt(expected);
  if (value !== expected && !matchesInteger) {
    configurationError();
  }
}

export function configureDatabase(database: SqliteDatabasePort): void {
  database.execute("PRAGMA busy_timeout = 5000");
  database.execute("PRAGMA journal_mode = WAL");
  database.execute("PRAGMA foreign_keys = ON");
  database.execute("PRAGMA synchronous = FULL");
  expectSetting(database, "PRAGMA busy_timeout", "timeout", 5000);
  expectSetting(database, "PRAGMA journal_mode", "journal_mode", "wal");
  expectSetting(database, "PRAGMA foreign_keys", "foreign_keys", 1);
  expectSetting(database, "PRAGMA synchronous", "synchronous", 2);
}

function readAppliedMigrations(
  database: Pick<SqliteDatabasePort, "readAll">,
): readonly AppliedMigration[] {
  return database.readAll(READ_MIGRATIONS).map((row) => ({
    checksum: readText(row, "checksum"),
    name: readText(row, "name"),
    version: readInteger(row, "version"),
  }));
}

function verifyHistory(
  applied: readonly AppliedMigration[],
  catalog: readonly MigrationDefinition[],
): void {
  if (applied.length > catalog.length) {
    schemaError("schema-mismatch");
  }
  const expected = catalog.slice(0, applied.length).map(({ checksum, name, version }) => ({
    checksum,
    name,
    version,
  }));
  if (JSON.stringify(applied) !== JSON.stringify(expected)) {
    schemaError("migration-drift");
  }
}

function readUserVersion(database: Pick<SqliteDatabasePort, "readOne">): number {
  return readInteger(database.readOne("PRAGMA user_version"), "user_version");
}

function expectedAppliedVersion(applied: readonly AppliedMigration[]): number {
  return applied.at(-1)?.version ?? 0;
}

export function applyPendingMigrations(
  database: Pick<SqliteDatabasePort, "execute">,
  appliedCount: number,
  catalog: readonly MigrationDefinition[],
): void {
  for (const migration of catalog.slice(appliedCount)) {
    for (const statement of migration.statements) {
      database.execute(statement);
    }
    database.execute(
      "INSERT INTO marea_schema_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
      [migration.version, migration.name, migration.checksum],
    );
    database.execute(`PRAGMA user_version = ${String(migration.version)}`);
  }
}

export function migrateDatabase(
  database: SqliteDatabasePort,
  catalog: readonly MigrationDefinition[],
): SqliteSchemaInfo {
  database.execute(migrationLedgerSql());
  database.transactionImmediate(() => {
    const applied = readAppliedMigrations(database);
    verifyHistory(applied, catalog);
    if (readUserVersion(database) !== expectedAppliedVersion(applied)) {
      schemaError("schema-mismatch");
    }
    applyPendingMigrations(database, applied.length, catalog);
  });
  return verifyDatabase(database, catalog);
}

export function verifyDatabase(
  database: Pick<SqliteDatabasePort, "readAll" | "readOne">,
  catalog: readonly MigrationDefinition[],
): SqliteSchemaInfo {
  const integrity = database.readOne("PRAGMA quick_check");
  if (integrity?.quick_check !== "ok") {
    schemaError("schema-mismatch");
  }
  const applied = readAppliedMigrations(database);
  verifyHistory(applied, catalog);
  verifySchemaFingerprint(database, catalog);
  const expectedVersion = catalog.length;
  if (applied.length !== catalog.length || readUserVersion(database) !== expectedVersion) {
    schemaError("schema-mismatch");
  }
  return Object.freeze({
    migrations: Object.freeze(applied.map((migration) => Object.freeze({ ...migration }))),
    version: expectedVersion,
  });
}
