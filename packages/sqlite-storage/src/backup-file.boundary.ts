import { closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

import type { BackupFilePort } from "./database-port.js";

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
