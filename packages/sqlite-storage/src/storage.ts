import { dirname } from "node:path";

import { createRunClosureMigrationCatalog } from "./run-closure-migration-catalog.js";
import { createSkillAssignmentMigrationCatalog } from "./skill-assignment-migration-catalog.js";
import { createEducationalMigrationCatalog } from "./educational-migration-catalog.js";
import { createObservabilityMigrationCatalog } from "./observability-migration-catalog.js";
import { createStudentIdentityMigrationCatalog } from "./student-identity-migration-catalog.js";
import { createProfileMigrationCatalog } from "./profile-migration-catalog.js";
import { backupFileCopier, backupFileInstaller } from "./backup-file.boundary.js";
import { calculateBackupDigest, parseBackup } from "./backup-parser.boundary.js";
import {
  SQLITE_BACKUP_FORMAT,
  type RestoreSqliteBackupFileOptions,
  type RestoreSqliteBackupOptions,
  type SqliteApplicationDatabase,
  type SqliteBackup,
  type SqliteBackupFile,
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
  BackupFileCopyPort,
  BackupFilePort,
  DiskSpacePort,
  InitializationLockPort,
  SqliteDatabasePort,
  SqliteDriverPort,
} from "./database-port.js";
import { canonicalizeDatabasePath } from "./database-path.boundary.js";
import { assertBackupSpace } from "./backup-space.js";
import { diskSpace } from "./disk-space.boundary.js";
import { configureDatabase, migrateDatabase, verifyDatabase } from "./database-schema.js";
import { fileInitializationLock } from "./initialization-lock.boundary.js";
import { createAuditMigrationCatalog } from "./audit-migration-catalog.js";
import { createMigrationCatalog, type MigrationDefinition } from "./migration-catalog.js";
import { parseMigrationCatalog } from "./migration-catalog.boundary.js";
import { bunSqliteDriver } from "./sqlite-driver.boundary.js";

export interface StorageDependencies {
  readonly backupFileCopier: BackupFileCopyPort;
  readonly backupFiles: BackupFilePort;
  readonly diskSpace: DiskSpacePort;
  readonly driver: SqliteDriverPort;
  readonly initializationLock: InitializationLockPort;
  readonly migrations: readonly MigrationDefinition[];
  readonly maxBackupBytes: number;
}

type ReleaseSchemaCatalogKey = Exclude<SqliteSchemaCatalog, "application">;

const RELEASE_CATALOGS = {
  "retention-audit": createAuditMigrationCatalog,
  "dashboard-profiles": createProfileMigrationCatalog,
  "educational-insights": createEducationalMigrationCatalog,
  "student-identities": createStudentIdentityMigrationCatalog,
  observability: createObservabilityMigrationCatalog,
  "skill-assignments": createSkillAssignmentMigrationCatalog,
  "run-closure": createRunClosureMigrationCatalog,
} as const satisfies Record<ReleaseSchemaCatalogKey, () => readonly MigrationDefinition[]>;

/**
 * The release catalog a current binary runs on: always the longest one, so adding a migration
 * catalog moves the startup target without another hand-maintained constant.
 */
export function currentSqliteSchema(): {
  readonly catalog: ReleaseSchemaCatalogKey;
  readonly version: number;
} {
  const [current] = (Object.keys(RELEASE_CATALOGS) as ReleaseSchemaCatalogKey[])
    .map((catalog) => ({ catalog, version: RELEASE_CATALOGS[catalog]().length }))
    .toSorted((left, right) => right.version - left.version);
  return current as { readonly catalog: ReleaseSchemaCatalogKey; readonly version: number };
}

/** Selects the explicitly requested release catalog; omission retains the legacy application catalog. */
export function createDefaultDependencies(schema?: SqliteSchemaCatalog): StorageDependencies {
  return Object.freeze({
    backupFileCopier,
    backupFiles: backupFileInstaller,
    diskSpace,
    driver: bunSqliteDriver,
    initializationLock: fileInitializationLock,
    migrations:
      schema === undefined || schema === "application"
        ? createMigrationCatalog()
        : RELEASE_CATALOGS[schema](),
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
  readonly #diskSpace: DiskSpacePort;
  #isClosed = false;
  public readonly database: SqliteApplicationDatabase;
  public readonly schema: SqliteSchemaInfo;

  public constructor(
    database: SqliteDatabasePort,
    schema: SqliteSchemaInfo,
    maxBackupBytes: number,
    space: DiskSpacePort,
  ) {
    this.#database = database;
    this.#diskSpace = space;
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

  public createBackupFile(destinationPath: string): SqliteBackupFile {
    this.assertOpen();
    assertBackupSpace(this.#database, this.#diskSpace, dirname(destinationPath));
    try {
      this.#database.backupTo(destinationPath);
    } catch {
      throw new SqliteStorageError("backup-failed", "The SQLite backup could not be created.");
    }
    return Object.freeze({ format: SQLITE_BACKUP_FORMAT, schemaVersion: this.schema.version });
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
      return new ManagedSqliteStorage(
        database,
        schema,
        dependencies.maxBackupBytes,
        dependencies.diskSpace,
      );
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
  dependencies: Pick<
    StorageDependencies,
    "diskSpace" | "driver" | "initializationLock" | "maxBackupBytes"
  >,
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
          dependencies.diskSpace,
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

type InstallBackup = (
  databasePath: string,
  validateStagedFile: (stagedPath: string) => void,
) => void;

function installAndOpen(
  options: SqliteStorageOptions,
  dependencies: StorageDependencies,
  migrations: readonly MigrationDefinition[],
  schemaVersion: number,
  install: InstallBackup,
): SqliteStorage {
  const canonicalOptions = {
    databasePath: canonicalizeDatabasePath(options.databasePath),
  };
  try {
    install(canonicalOptions.databasePath, (stagedPath) => {
      verifyStagedBackup(stagedPath, dependencies, migrations.slice(0, schemaVersion));
    });
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

export function restoreSqliteBackupWith(
  options: RestoreSqliteBackupOptions,
  dependencies: StorageDependencies,
): SqliteStorage {
  const migrations = validateStorageDependencies(dependencies);
  const backup = parseBackup(options.backup, migrations.length, dependencies.maxBackupBytes);
  return installAndOpen(
    options,
    dependencies,
    migrations,
    backup.schemaVersion,
    (path, validate) => {
      dependencies.backupFiles.installNew(path, backup.bytes, validate);
    },
  );
}

const SHA256_DIGEST = /^[0-9a-f]{64}$/u;

/** Restores a backup file by copying it, so a database of any size never loads into memory. */
export function restoreSqliteBackupFileWith(
  options: RestoreSqliteBackupFileOptions,
  dependencies: StorageDependencies,
): SqliteStorage {
  const migrations = validateStorageDependencies(dependencies);
  if (
    (options.format as string) !== SQLITE_BACKUP_FORMAT ||
    !Number.isSafeInteger(options.schemaVersion) ||
    options.schemaVersion < 1 ||
    options.schemaVersion > migrations.length ||
    !SHA256_DIGEST.test(options.sha256)
  ) {
    throw new SqliteStorageError("backup-invalid", "The SQLite backup is invalid.");
  }
  return installAndOpen(
    options,
    dependencies,
    migrations,
    options.schemaVersion,
    (path, validate) => {
      dependencies.backupFileCopier.installFile(path, options.backupPath, options.sha256, validate);
    },
  );
}

export function initializeSqliteStorage(options: SqliteStorageOptions): SqliteStorage {
  return initializeSqliteStorageWith(options, createDefaultDependencies(options.schema));
}

export function restoreSqliteBackup(options: RestoreSqliteBackupOptions): SqliteStorage {
  return restoreSqliteBackupWith(options, createDefaultDependencies(options.schema));
}

export function restoreSqliteBackupFile(options: RestoreSqliteBackupFileOptions): SqliteStorage {
  return restoreSqliteBackupFileWith(options, createDefaultDependencies(options.schema));
}

export function openSqliteDatabaseFile(options: SqliteDatabaseFileOptions): SqliteDatabaseFile {
  return openSqliteDatabaseFileWith(options, createDefaultDependencies());
}
