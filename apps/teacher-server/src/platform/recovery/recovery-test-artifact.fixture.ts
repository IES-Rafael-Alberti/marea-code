import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  RECOVERY_BUNDLE_FORMAT,
  RECOVERY_BUNDLE_SCHEMA_VERSION,
  type RecoveryBundleLimits,
  type RecoveryBundleManifest,
} from "./contracts.js";
import { createFileRecord, serializeManifest } from "./manifest.boundary.js";

export const recoveryTestLimits: RecoveryBundleLimits = {
  fileBytes: 64,
  fileCount: 4,
  totalBytes: 1_024,
};

export function recoveryManifest(): RecoveryBundleManifest {
  const databaseBytes = new TextEncoder().encode("database-bytes");
  const fileBytes = new TextEncoder().encode("required-bytes");
  return Object.freeze({
    database: Object.freeze({
      ...createFileRecord(
        "database.sqlite",
        databaseBytes,
        recoveryTestLimits.fileBytes,
        "bundle-database-invalid",
      ),
      format: "sqlite3",
      schemaVersion: 1,
    }),
    files: Object.freeze([
      createFileRecord(
        "state/file",
        fileBytes,
        recoveryTestLimits.fileBytes,
        "bundle-filesystem-invalid",
      ),
    ]),
    format: RECOVERY_BUNDLE_FORMAT,
    release: Object.freeze({ id: "release:one", schemaVersion: 1 }),
    schemaVersion: RECOVERY_BUNDLE_SCHEMA_VERSION,
  });
}

export function writeRecoveryArtifact(
  base: string,
  manifest: RecoveryBundleManifest = recoveryManifest(),
): RecoveryBundleManifest {
  mkdirSync(join(base, "state"), { recursive: true });
  writeFileSync(join(base, "database.sqlite"), "database-bytes");
  writeFileSync(join(base, "state/file"), "required-bytes");
  writeFileSync(join(base, "manifest.json"), serializeManifest(manifest));
  return manifest;
}
