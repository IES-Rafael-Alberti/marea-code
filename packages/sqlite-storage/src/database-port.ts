import type { SqliteParameter, SqliteRow } from "./contracts.js";

export type DatabaseRow = SqliteRow;
export type { SqliteParameter };

export interface SqliteDatabasePort {
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

export interface InitializationLockPort {
  runExclusive<T>(databasePath: string, operation: () => T): T;
}
