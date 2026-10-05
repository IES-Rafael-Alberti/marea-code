import { createEducationalMigrationCatalog } from "./educational-migration-catalog.js";
import { createStudentIdentityMigrationCatalog } from "./student-identity-migration-catalog.js";
import { createProfileMigrationCatalog } from "./profile-migration-catalog.js";
import { backupFileInstaller } from "./backup-file.boundary.js";
import { calculateBackupDigest, parseBackup } from "./backup-parser.boundary.js";
import {
  SQLITE_BACKUP_FORMAT,
  type RestoreSqliteBackupOptions,
  type SqliteApplicationDatabase,
  type SqliteBackup,
  type SqliteDatabaseFile,
  type SqliteDatabaseFileOptions,
  type SqliteSchemaCatalog,
  type SqliteParameter,
  type SqliteRow,
  type SqliteSchemaInfo,
  type SqliteStorage,
  SqliteStorageError,
  type SqliteStorageOptions,
} from "./contracts.js";
import type {
  BackupFilePort,
  InitializationLockPort,
  SqliteDatabasePort,
  SqliteDriverPort,
} from "./database-port.js";
import { canonicalizeDatabasePath } from "./database-path.boundary.js";
import { configureDatabase, migrateDatabase, verifyDatabase } from "./database-schema.js";
import { fileInitializationLock } from "./initialization-lock.boundary.js";
import { createAuditMigrationCatalog } from "./audit-migration-catalog.js";
import { createMigrationCatalog, type MigrationDefinition } from "./migration-catalog.js";
import { parseMigrationCatalog } from "./migration-catalog.boundary.js";
import { bunSqliteDriver } from "./sqlite-driver.boundary.js";

export interface StorageDependencies {
  readonly backupFiles: BackupFilePort;
  readonly driver: SqliteDriverPort;
  readonly initializationLock: InitializationLockPort;
  readonly migrations: readonly MigrationDefinition[];
  readonly maxBackupBytes: number;
}

/** Selects the explicitly requested release catalog; omission retains the legacy application catalog. */
export function createDefaultDependencies(schema?: SqliteSchemaCatalog): StorageDependencies {
  return Object.freeze({
    backupFiles: backupFileInstaller,
    driver: bunSqliteDriver,
    initializationLock: fileInitializationLock,
    migrations:
      schema === "student-identities"
        ? createStudentIdentityMigrationCatalog()
        : schema === "educational-insights"
          ? createEducationalMigrationCatalog()
          : schema === "dashboard-profiles"
            ? createProfileMigrationCatalog()
            : schema === "retention-audit"
              ? createAuditMigrationCatalog()
              : createMigrationCatalog(),
    maxBackupBytes: 268_435_456,
  });
}

function closeQuietly(database: SqliteDatabasePort): void {
  try {
    database.close();
  } catch {
    // The original failure remains the useful diagnostic at this boundary.
  }
}

function withCleanupOnFailure<T>(
  driver: SqliteDriverPort,
  databasePath: string,
  operation: (database: SqliteDatabasePort) => T,
): T {
  const database = driver.open(databasePath);
  try {
    return operation(database);
  } catch (error) {
    closeQuietly(database);
    throw error;
  }
}

class ManagedSqliteStorage implements SqliteStorage {
  readonly #database: SqliteDatabasePort;
  readonly #maxBackupBytes: number;
  #isClosed = false;
  public readonly database: SqliteApplicationDatabase;
  public readonly schema: SqliteSchemaInfo;

  public constructor(
    database: SqliteDatabasePort,
    schema: SqliteSchemaInfo,
    maxBackupBytes: number,
  ) {
    this.#database = database;
    this.#maxBackupBytes = maxBackupBytes;
    this.database = Object.freeze({
      execute: (sql: string, parameters?: readonly SqliteParameter[]): void => {
        this.assertOpen();
        this.#database.execute(sql, parameters);
      },
      readAll: (sql: string, parameters?: readonly SqliteParameter[]): readonly SqliteRow[] => {
        this.assertOpen();
        return this.#database.readAll(sql, parameters);
      },
      readOne: (sql: string, parameters?: readonly SqliteParameter[]): SqliteRow | undefined => {
        this.assertOpen();
        return this.#database.readOne(sql, parameters);
      },
      transaction: <T>(operation: () => T): T => {
        this.assertOpen();
        return this.#database.transactionImmediate(operation);
      },
    });
    this.schema = schema;
  }

  private assertOpen(): void {
    if (this.#isClosed) {
      throw new SqliteStorageError("storage-closed", "The SQLite storage is closed.");
    }
  }

  public close(): void {
    if (this.#isClosed) {
      return;
    }
    this.#isClosed = true;
    try {
      this.#database.close();
    } catch {
      throw new SqliteStorageError(
        "database-unavailable",
        "The SQLite database could not be closed cleanly.",
      );
    }
  }

  public createBackup(): SqliteBackup {
    this.assertOpen();
    let bytes: Uint8Array;
    try {
      bytes = this.#database.serialize();
    } catch {
      throw new SqliteStorageError("backup-failed", "The SQLite backup could not be created.");
    }
    if (bytes.byteLength > this.#maxBackupBytes) {
      throw new SqliteStorageError(
        "backup-failed",
        "The SQLite backup exceeds the configured size limit.",
      );
    }
    const ownedBytes = Uint8Array.from(bytes);
    return Object.freeze({
      bytes: ownedBytes,
      format: SQLITE_BACKUP_FORMAT,
      schemaVersion: this.schema.version,
      sha256: calculateBackupDigest(ownedBytes),
    });
  }
}

export function initializeSqliteStorageWith(
  options: SqliteStorageOptions,
  dependencies: StorageDependencies,
): SqliteStorage {
  const canonicalOptions = {
    databasePath: canonicalizeDatabasePath(options.databasePath),
  };
  const migrations = validateStorageDependencies(dependencies);
  return initializeCanonical(canonicalOptions, dependencies, migrations);
}

function initializeCanonical(
  options: SqliteStorageOptions,
  dependencies: StorageDependencies,
  migrations: readonly MigrationDefinition[],
): SqliteStorage {
  return dependencies.initializationLock.runExclusive(options.databasePath, () =>
    initializeLocked(options, dependencies, migrations),
  );
}

function unavailableOnFailure<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof SqliteStorageError) {
      throw error;
    }
    throw new SqliteStorageError(
      "database-unavailable",
      "The SQLite database could not be initialized.",
    );
  }
}

function initializeLocked(
  options: SqliteStorageOptions,
  dependencies: StorageDependencies,
  migrations: readonly MigrationDefinition[],
): SqliteStorage {
  return unavailableOnFailure(() =>
    withCleanupOnFailure(dependencies.driver, options.databasePath, (database) => {
      configureDatabase(database);
      const schema = migrateDatabase(database, migrations);
      return new ManagedSqliteStorage(database, schema, dependencies.maxBackupBytes);
    }),
  );
}

const UNMIGRATED_SCHEMA: SqliteSchemaInfo = Object.freeze({
  migrations: Object.freeze([]),
  version: 0,
});

/** Opens a SQLite file with the storage durability settings and no migration ledger. */
function openSqliteDatabaseFileWith(
  options: SqliteDatabaseFileOptions,
  dependencies: Pick<StorageDependencies, "driver" | "initializationLock" | "maxBackupBytes">,
): SqliteDatabaseFile {
  const databasePath = canonicalizeDatabasePath(options.databasePath);
  return dependencies.initializationLock.runExclusive(databasePath, () =>
    unavailableOnFailure(() =>
      withCleanupOnFailure(dependencies.driver, databasePath, (database) => {
        configureDatabase(database);
        const storage = new ManagedSqliteStorage(
          database,
          UNMIGRATED_SCHEMA,
          dependencies.maxBackupBytes,
        );
        return Object.freeze({
          database: storage.database,
          close: () => {
            storage.close();
          },
        });
      }),
    ),
  );
}

function validateStorageDependencies(
  dependencies: StorageDependencies,
): readonly MigrationDefinition[] {
  if (!Number.isSafeInteger(dependencies.maxBackupBytes) || dependencies.maxBackupBytes < 1) {
    throw new SqliteStorageError(
      "storage-configuration-invalid",
      "The SQLite storage configuration is invalid.",
    );
  }
  return parseMigrationCatalog(dependencies.migrations);
}

function verifyStagedBackup(
  stagedPath: string,
  dependencies: StorageDependencies,
  migrations: readonly MigrationDefinition[],
): void {
  try {
    withCleanupOnFailure(dependencies.driver, stagedPath, (database) => {
      verifyDatabase(database, migrations);
      database.close();
    });
  } catch {
    throw new SqliteStorageError("backup-invalid", "The SQLite backup is invalid.");
  }
}

export function restoreSqliteBackupWith(
  options: RestoreSqliteBackupOptions,
  dependencies: StorageDependencies,
): SqliteStorage {
  const canonicalOptions = {
    databasePath: canonicalizeDatabasePath(options.databasePath),
  };
  const migrations = validateStorageDependencies(dependencies);
  const expectedVersion = migrations.length;
  const backup = parseBackup(options.backup, expectedVersion, dependencies.maxBackupBytes);
  try {
    dependencies.backupFiles.installNew(
      canonicalOptions.databasePath,
      backup.bytes,
      (stagedPath) => {
        verifyStagedBackup(stagedPath, dependencies, migrations.slice(0, backup.schemaVersion));
      },
    );
  } catch (error) {
    if (error instanceof SqliteStorageError && error.code === "backup-invalid") {
      throw error;
    }
    throw new SqliteStorageError(
      "restore-failed",
      "The SQLite backup could not be restored to a new database file.",
    );
  }
  return initializeCanonical(canonicalOptions, dependencies, migrations);
}

export function initializeSqliteStorage(options: SqliteStorageOptions): SqliteStorage {
  return initializeSqliteStorageWith(options, createDefaultDependencies(options.schema));
}

export function restoreSqliteBackup(options: RestoreSqliteBackupOptions): SqliteStorage {
  return restoreSqliteBackupWith(options, createDefaultDependencies(options.schema));
}

export function openSqliteDatabaseFile(options: SqliteDatabaseFileOptions): SqliteDatabaseFile {
  return openSqliteDatabaseFileWith(options, createDefaultDependencies());
}
