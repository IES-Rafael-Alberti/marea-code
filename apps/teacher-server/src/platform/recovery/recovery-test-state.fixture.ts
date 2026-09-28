import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RecoveryBundleInput } from "./contracts.js";

export function recoveryInput(root: string): RecoveryBundleInput {
  const bytes = new TextEncoder().encode("synthetic-sqlite");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const databasePath = join(root, "source.sqlite");
  return {
    createExclusive: (operation) => operation(),
    createBackup: {
      createBackup: () => {
        if (!existsSync(databasePath)) throw new Error("database unavailable");
        return { bytes, format: "sqlite3", schemaVersion: 1, sha256: digest };
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
