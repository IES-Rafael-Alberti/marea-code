import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  linkSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { SqliteStorageError } from "./contracts.js";
import type { BackupFileCopyPort, BackupFilePort } from "./database-port.js";

function removeTemporaryFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // Cleanup is best effort after the restore result is already known.
  }
}

function removeTemporaryArtifacts(filePath: string): void {
  removeTemporaryFile(filePath);
  removeTemporaryFile(`${filePath}-shm`);
  removeTemporaryFile(`${filePath}-wal`);
}

function writeDurably(filePath: string, bytes: Uint8Array): void {
  const descriptor = openSync(filePath, "wx", 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch {
      // Preserve the write failure that made the restore fail.
    }
    throw error;
  }
  closeSync(descriptor);
}

/** Streams the file through the hash and flushes it, so a copy of any size stays out of memory. */
function digestAndSync(filePath: string): string {
  const descriptor = openSync(filePath, "r+");
  try {
    const hash = createHash("sha256");
    const chunk = new Uint8Array(1_048_576);
    for (;;) {
      const read = readSync(descriptor, chunk);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
    }
    fsyncSync(descriptor);
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}

export const backupFileInstaller: BackupFilePort = Object.freeze({
  installNew(
    databasePath: string,
    bytes: Uint8Array,
    validateStagedFile: (stagedPath: string) => void,
  ): void {
    const directory = dirname(databasePath);
    const temporaryPath = join(directory, `.${basename(databasePath)}.${randomUUID()}.restore`);
    try {
      writeDurably(temporaryPath, bytes);
      validateStagedFile(temporaryPath);
      linkSync(temporaryPath, databasePath);
    } finally {
      removeTemporaryArtifacts(temporaryPath);
    }
  },
});

export const backupFileCopier: BackupFileCopyPort = Object.freeze({
  installFile(
    databasePath: string,
    sourcePath: string,
    expectedSha256: string,
    validateStagedFile: (stagedPath: string) => void,
  ): void {
    const directory = dirname(databasePath);
    const temporaryPath = join(directory, `.${basename(databasePath)}.${randomUUID()}.restore`);
    try {
      copyFileSync(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
      chmodSync(temporaryPath, 0o600);
      if (digestAndSync(temporaryPath) !== expectedSha256) {
        throw new SqliteStorageError("backup-invalid", "The SQLite backup is invalid.");
      }
      validateStagedFile(temporaryPath);
      linkSync(temporaryPath, databasePath);
    } finally {
      removeTemporaryArtifacts(temporaryPath);
    }
  },
});
