import {
  createProfileMigrationCatalog,
  currentSqliteSchema,
  initializeSqliteStorage,
  inspectSqliteSchemaVersion,
  type SqliteSchemaCatalog,
} from "@marea/sqlite-storage";

import { HostOperationError } from "../operations/host/contracts.js";

/** One operator-private stderr line per startup schema decision that changed or refused data. */
export type StartupMigrationEvent =
  | {
      readonly event: "schema-migration";
      readonly outcome: "migrated";
      readonly detectedSchema: number;
      readonly finalSchema: number;
      readonly backupPath: string;
    }
  | {
      readonly event: "schema-migration";
      readonly outcome: "backup-failed" | "migration-failed" | "newer-schema";
      readonly detectedSchema: number;
      readonly targetSchema: number;
      readonly error?: string;
    };

export interface StartupMigrationDependencies {
  readonly databasePath: string;
  /** Publishes a verified recovery bundle of the unchanged database and returns its path. */
  readonly backup: () => Promise<string>;
  readonly report: (event: StartupMigrationEvent) => void;
  readonly migrate?: (databasePath: string, catalog: SqliteSchemaCatalog) => void;
}

function migrateWithCatalog(databasePath: string, schema: SqliteSchemaCatalog): void {
  initializeSqliteStorage({ databasePath, schema }).close();
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Brings an older activated database to the schema this binary runs on, under the installation
 * lock and before any request is served. A backup always precedes the migration; without one the
 * database is left untouched and startup fails. Installations older than dashboard profiles keep
 * their explicit offline upgrade, and a newer schema than this binary knows is refused.
 */
export async function migrateSchemaOnStartup(
  dependencies: StartupMigrationDependencies,
): Promise<number> {
  const { databasePath, report } = dependencies;
  const detectedSchema = inspectSqliteSchemaVersion({ databasePath });
  const target = currentSqliteSchema();
  if (detectedSchema > target.version) {
    report({
      event: "schema-migration",
      outcome: "newer-schema",
      detectedSchema,
      targetSchema: target.version,
    });
    throw new HostOperationError("not-ready", "the database schema is newer than this release");
  }
  if (detectedSchema === target.version || detectedSchema < createProfileMigrationCatalog().length)
    return detectedSchema;
  let backupPath: string;
  try {
    backupPath = await dependencies.backup();
  } catch (error) {
    report({
      event: "schema-migration",
      outcome: "backup-failed",
      detectedSchema,
      targetSchema: target.version,
      error: errorName(error),
    });
    throw new HostOperationError("not-ready", "the pre-migration backup could not be created");
  }
  try {
    (dependencies.migrate ?? migrateWithCatalog)(databasePath, target.catalog);
  } catch (error) {
    report({
      event: "schema-migration",
      outcome: "migration-failed",
      detectedSchema,
      targetSchema: target.version,
      error: errorName(error),
    });
    throw new HostOperationError("not-ready", "the database schema migration failed");
  }
  const finalSchema = inspectSqliteSchemaVersion({ databasePath });
  report({
    event: "schema-migration",
    outcome: "migrated",
    detectedSchema,
    finalSchema,
    backupPath,
  });
  return finalSchema;
}
