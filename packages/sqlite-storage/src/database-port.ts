import type { SqliteParameter, SqliteRow } from "./contracts.js";

export type DatabaseRow = SqliteRow;
export type { SqliteParameter };

export interface SqliteDatabasePort {
  /** Writes a consistent, compacted copy to a new file (`VACUUM INTO`). */
  backupTo(destinationPath: string): void;
  close(): void;
  execute(sql: string, parameters?: readonly SqliteParameter[]): void;
  readAll(sql: string, parameters?: readonly SqliteParameter[]): readonly DatabaseRow[];
  readOne(sql: string, parameters?: readonly SqliteParameter[]): DatabaseRow | undefined;
  serialize(): Uint8Array;
  transactionImmediate<T>(operation: () => T): T;
}

export interface SqliteDriverPort {
  open(databasePath: string): SqliteDatabasePort;
}

export interface BackupFilePort {
  installNew(
    databasePath: string,
    bytes: Uint8Array,
    validateStagedFile: (stagedPath: string) => void,
  ): void;
}

export interface BackupFileCopyPort {
  /** Copies a file with the same guarantees as `installNew`, after checking its SHA-256 digest. */
  installFile(
    databasePath: string,
    sourcePath: string,
    expectedSha256: string,
    validateStagedFile: (stagedPath: string) => void,
  ): void;
}

export interface DiskSpacePort {
  /** Bytes available to this process on the volume of the directory, or undefined if unknown. */
  freeBytes(directory: string): number | undefined;
}

export interface InitializationLockPort {
  runExclusive<T>(databasePath: string, operation: () => T): T;
}
