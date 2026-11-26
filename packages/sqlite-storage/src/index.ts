export {
  SQLITE_BACKUP_FORMAT,
  SqliteStorageError,
  type AppliedMigration,
  type RestoreSqliteBackupFileOptions,
  type RestoreSqliteBackupOptions,
  type SqliteBackup,
  type SqliteBackupFile,
  type SqliteDatabaseFile,
  type SqliteDatabaseFileOptions,
  type SqliteSchemaCatalog,
  type SqliteApplicationDatabase,
  type SqliteParameter,
  type SqliteRow,
  type SqliteSchemaInfo,
  type SqliteStorage,
  type SqliteStorageErrorCode,
  type SqliteStorageOptions,
} from "./contracts.js";
export {
  createDefaultDependencies,
  currentSqliteSchema,
  initializeSqliteStorage,
  initializeSqliteStorageWith,
  openSqliteDatabaseFile,
  restoreSqliteBackup,
  restoreSqliteBackupFile,
} from "./storage.js";
export {
  activateRetentionAuditSchema,
  createSqliteAuditStore,
  type AuditDisposition,
  type AuditDispositionInput,
  type AuditOperationInput,
  type AuditOperationRecord,
  type AuditOperationState,
  type SqliteAuditStore,
} from "./audit-storage.js";
export { inspectSqliteSchemaVersion } from "./schema-inspection.boundary.js";
export {
  createMigrationCatalog,
  type MigrationDefinition,
  type SchemaObjectDefinition,
} from "./migration-catalog.js";
export { createDashboardProfileStore, type StoredDashboardProfile } from "./profile-storage.js";
// Every release migration catalog, as the lighter `./catalogs` entry point publishes them.
export * from "./catalogs.js";

export { createDashboardLanguageStore } from "./dashboard-language-store.js";
