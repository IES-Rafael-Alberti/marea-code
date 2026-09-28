import { SqliteStorageError } from "./contracts.js";
import {
  type MigrationDefinition,
  type SchemaObjectDefinition,
  validateKnownMigrationCatalog,
} from "./migration-catalog.js";

type BoundaryRecord = Readonly<Record<string, unknown>>;

function invalidMigration(): never {
  throw new SqliteStorageError("migration-invalid", "The migration catalog is invalid.");
}

function parseRecord(value: unknown): BoundaryRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidMigration();
  }
  return value as BoundaryRecord;
}

function parseArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    invalidMigration();
  }
  return value;
}

function parseSchemaObject(value: unknown): SchemaObjectDefinition {
  const record = parseRecord(value);
  return {
    name: record.name as string,
    sql: record.sql as string,
    tableName: record.tableName as string,
    type: record.type as SchemaObjectDefinition["type"],
  };
}

function parseSchema(value: unknown): readonly SchemaObjectDefinition[] {
  return parseArray(value).map((entry) => parseSchemaObject(entry));
}

function parseMigration(value: unknown): MigrationDefinition {
  const record = parseRecord(value);
  return {
    checksum: record.checksum as string,
    name: record.name as string,
    schemaAfter: parseSchema(record.schemaAfter),
    statements: parseArray(record.statements) as readonly string[],
    version: record.version as number,
  };
}

export function parseMigrationCatalog(value: unknown): readonly MigrationDefinition[] {
  return validateKnownMigrationCatalog(parseArray(value).map((entry) => parseMigration(entry)));
}
