import { existsSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RecoveryBackupCapability, RecoveryBundleInput } from "./contracts.js";

/** A capability that writes synthetic bytes to the requested file, as SQLite does. */
export function fileBackup(bytes: Uint8Array, schemaVersion = 1): RecoveryBackupCapability {
  return {
    createBackupFile: (destinationPath) => {
      writeFileSync(destinationPath, bytes, { flag: "wx" });
      return { format: "sqlite3", schemaVersion };
    },
  };
}

export function recoveryInput(root: string): RecoveryBundleInput {
  const bytes = new TextEncoder().encode("synthetic-sqlite");
  const databasePath = join(root, "source.sqlite");
  return {
    createExclusive: (operation) => operation(),
    createBackup: {
      createBackupFile: (destinationPath) => {
        if (!existsSync(databasePath)) throw new Error("database unavailable");
        return fileBackup(bytes).createBackupFile(destinationPath);
      },
    },
    files: ["state/configuration.json", "state/snapshot.json"],
    limits: { fileBytes: 64, fileCount: 2, totalBytes: 1024 },
    release: { id: "release:one", schemaVersion: 1 },
    sourceRoot: root,
  };
}

export function writeRecoveryState(root: string): void {
  writeFileSync(join(root, "source.sqlite"), "source");
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state/configuration.json"), "Class state");
  writeFileSync(join(root, "state/snapshot.json"), "Snapshot state");
  writeFileSync(join(root, "state/one"), "one-byte-ok");
}
