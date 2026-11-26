export const SQLITE_BACKUP_FORMAT = "sqlite3" as const;

export type SqliteStorageErrorCode =
  | "backup-failed"
  | "backup-invalid"
  | "database-unavailable"
  | "insufficient-disk-space"
  | "invalid-database-path"
  | "migration-drift"
  | "migration-invalid"
  | "restore-failed"
  | "schema-mismatch"
  | "storage-configuration-invalid"
  | "storage-closed";

export class SqliteStorageError extends Error {
  public readonly code: SqliteStorageErrorCode;

  public constructor(code: SqliteStorageErrorCode, message: string) {
    super(message);
    this.name = "SqliteStorageError";
    this.code = code;
  }
}

export interface AppliedMigration {
  readonly checksum: string;
  readonly name: string;
  readonly version: number;
}

export interface SqliteSchemaInfo {
  readonly migrations: readonly AppliedMigration[];
  readonly version: number;
}

export interface SqliteBackup {
  readonly bytes: Uint8Array;
  readonly format: typeof SQLITE_BACKUP_FORMAT;
  readonly schemaVersion: number;
  readonly sha256: string;
}

/** A backup written to a file on disk; its bytes never pass through memory. */
export interface SqliteBackupFile {
  readonly format: typeof SQLITE_BACKUP_FORMAT;
  readonly schemaVersion: number;
}

export interface SqliteStorage {
  readonly database: SqliteApplicationDatabase;
  readonly schema: SqliteSchemaInfo;
  close(): void;
  createBackup(): SqliteBackup;
  /**
   * Writes a consistent copy of the database to a new file with SQLite itself, so a database of
   * any size is backed up without loading it. The free space of the destination volume is checked
   * first and `insufficient-disk-space` names what is needed and what is available.
   */
  createBackupFile(destinationPath: string): SqliteBackupFile;
}

type SqliteValue = bigint | number | string | Uint8Array | null;
export type SqliteRow = Readonly<Record<string, SqliteValue>>;
export type SqliteParameter = SqliteValue | boolean;

export interface SqliteApplicationDatabase {
  execute(sql: string, parameters?: readonly SqliteParameter[]): void;
  readAll(sql: string, parameters?: readonly SqliteParameter[]): readonly SqliteRow[];
  readOne(sql: string, parameters?: readonly SqliteParameter[]): SqliteRow | undefined;
  transaction<T>(operation: () => T): T;
}

/**
 * `application` is the accepted base catalog. `retention-audit` adds the explicit
 * retention audit migration; opening an application database with it activates that schema.
 */
export type SqliteSchemaCatalog =
  | "application"
  | "retention-audit"
  | "dashboard-profiles"
  | "educational-insights"
  | "student-identities"
  | "observability"
  | "skill-assignments"
  | "run-closure";

export interface SqliteDatabaseFileOptions {
  readonly databasePath: string;
}

export interface SqliteStorageOptions extends SqliteDatabaseFileOptions {
  readonly schema?: SqliteSchemaCatalog;
}

/** A configured SQLite file without the application migration ledger, such as a deletion index. */
export interface SqliteDatabaseFile {
  readonly database: SqliteApplicationDatabase;
  close(): void;
}

export interface RestoreSqliteBackupOptions extends SqliteStorageOptions {
  readonly backup: SqliteBackup;
}

export interface RestoreSqliteBackupFileOptions extends SqliteStorageOptions {
  /** A backup file written by `createBackupFile`; it is copied, never read into memory. */
  readonly backupPath: string;
  readonly format: typeof SQLITE_BACKUP_FORMAT;
  readonly schemaVersion: number;
  readonly sha256: string;
}
