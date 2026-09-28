import type { SqliteSchemaCatalog, SqliteStorage } from "@marea/sqlite-storage";

export const RECOVERY_BUNDLE_FORMAT = "marea-recovery" as const;
export const RECOVERY_BUNDLE_SCHEMA_VERSION = 1 as const;
export const RECOVERY_SQLITE_BACKUP_FORMAT = "sqlite3" as const;
export const RECOVERY_MANIFEST_BYTES = 1_048_576 as const;
export type RecoveryErrorCode =
  | "bundle-destination-invalid"
  | "bundle-database-invalid"
  | "bundle-filesystem-invalid"
  | "bundle-input-invalid"
  | "bundle-manifest-invalid"
  | "bundle-maintenance-failed"
  | "bundle-restore-failed";

export class RecoveryBundleError extends Error {
  public readonly code: RecoveryErrorCode;

  public constructor(code: RecoveryErrorCode, message: string = code) {
    super(message);
    this.name = "RecoveryBundleError";
    this.code = code;
  }
}

export function ensureRecoveryError(
  error: unknown,
  code: RecoveryErrorCode,
  message: string = code,
): RecoveryBundleError {
  if (error instanceof RecoveryBundleError) return error;
  return new RecoveryBundleError(code, message);
}

interface ReleaseIdentity {
  readonly id: string;
  readonly schemaVersion: number;
}

export type RecoveryBackupCapability = Pick<SqliteStorage, "createBackup">;

export interface RecoveryBundleLimits {
  readonly fileCount: number;
  readonly fileBytes: number;
  readonly totalBytes: number;
}

export interface RecoveryBundleInput {
  readonly release: ReleaseIdentity;
  readonly createBackup: RecoveryBackupCapability;
  readonly sourceRoot: string;
  readonly files: readonly string[];
  readonly createExclusive: <T>(operation: () => T) => T;
  readonly limits: RecoveryBundleLimits;
}

export interface RecoveryFileRecord {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

interface RecoveryDatabaseRecord extends RecoveryFileRecord {
  readonly format: typeof RECOVERY_SQLITE_BACKUP_FORMAT;
  readonly schemaVersion: number;
}

export interface RecoveryBundleManifest {
  readonly database: RecoveryDatabaseRecord;
  readonly files: readonly RecoveryFileRecord[];
  readonly format: typeof RECOVERY_BUNDLE_FORMAT;
  readonly release: ReleaseIdentity;
  readonly schemaVersion: typeof RECOVERY_BUNDLE_SCHEMA_VERSION;
}

export interface RecoveryBundle {
  readonly manifest: RecoveryBundleManifest;
  readonly path: string;
}

export interface RestoreRecoveryBundleOptions {
  readonly destinationRoot: string;
  readonly path: string;
  /** The destination installation's catalog; activated installations restore with `retention-audit`. */
  readonly schema?: SqliteSchemaCatalog;
}
