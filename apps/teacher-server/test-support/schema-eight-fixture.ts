import { createMigrationCatalog, migrationLedgerSql } from "@marea/sqlite-storage/migrations";

import { NodeSqliteTestDatabase } from "./node-sqlite-database.boundary.js";

/** An in-memory application database with every base migration applied at schema 8. */
export function schemaEightDatabase(): NodeSqliteTestDatabase {
  const database = new NodeSqliteTestDatabase();
  database.executeScript(migrationLedgerSql());
  for (const migration of createMigrationCatalog()) {
    for (const statement of migration.statements) database.executeScript(statement);
    database.execute(
      "INSERT INTO marea_schema_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
      [migration.version, migration.name, migration.checksum],
    );
  }
  database.execute("PRAGMA user_version = 8");
  return database;
}
