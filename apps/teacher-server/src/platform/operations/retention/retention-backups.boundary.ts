import { lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { readBoundedRegularFile, verifyArtifactFiles } from "../../recovery/artifact.boundary.js";
import {
  ensureRecoveryError,
  RECOVERY_MANIFEST_BYTES,
  type RecoveryBundleLimits,
  type RecoveryBundleManifest,
  type RecoveryErrorCode,
} from "../../recovery/contracts.js";
import { parseManifest, sha256Bytes } from "../../recovery/manifest.boundary.js";
import { TargetRefSchema, type TargetRef } from "../schemas.js";

/** A single path segment that cannot name the backup root or a parent directory. */
function isBundleName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name);
}

export type BackupTarget = Extract<TargetRef, { kind: "backup" }>;

export type InventoriedBackup =
  | {
      readonly state: "verified";
      readonly name: string;
      readonly target: BackupTarget;
      readonly bytes: number;
    }
  | { readonly state: "unverifiable"; readonly name: string; readonly reason: RecoveryErrorCode };

/** Recovery bundles kept directly below one explicitly configured backup directory. */
export interface BackupInventory {
  list(): readonly InventoriedBackup[];
  dispose(name: string): void;
}

function releaseIdOf(manifest: Uint8Array): string {
  const value = JSON.parse(new TextDecoder().decode(manifest)) as {
    readonly release: { readonly id: unknown };
  };
  return String(value.release.id);
}

export interface VerifiedBundle {
  readonly manifest: RecoveryBundleManifest;
  readonly target: BackupTarget;
  readonly bytes: number;
}

/** Fully verifies one bundle directory of any release; throws a recovery error otherwise. */
export function readVerifiedBundle(path: string, limits: RecoveryBundleLimits): VerifiedBundle {
  const bytes = readBoundedRegularFile(
    join(path, "manifest.json"),
    RECOVERY_MANIFEST_BYTES,
    "bundle-manifest-invalid",
  );
  // Bundles from earlier releases stay inventoried: the release is read, then fully validated.
  const manifest = parseManifest(bytes, releaseIdOf(bytes));
  verifyArtifactFiles(path, manifest, limits);
  const manifestDigest = sha256Bytes(bytes);
  const target = TargetRefSchema.parse({
    kind: "backup",
    key: { manifestDigest },
    observed: { kind: "backup", manifestDigest, databaseDigest: manifest.database.sha256 },
  }) as BackupTarget;
  const fileBytes = manifest.files.reduce((total, file) => total + file.sizeBytes, 0);
  return { manifest, target, bytes: manifest.database.sizeBytes + fileBytes };
}

function verify(root: string, name: string, limits: RecoveryBundleLimits): InventoriedBackup {
  const path = join(root, name);
  try {
    if (!isBundleName(name) || !lstatSync(path).isDirectory())
      return { state: "unverifiable", name, reason: "bundle-filesystem-invalid" };
    const { target, bytes } = readVerifiedBundle(path, limits);
    return { state: "verified", name, target, bytes };
  } catch (error) {
    return {
      state: "unverifiable",
      name,
      reason: ensureRecoveryError(error, "bundle-manifest-invalid").code,
    };
  }
}

export function createBackupInventory(options: {
  readonly backupRoot: string;
  readonly limits: RecoveryBundleLimits;
}): BackupInventory {
  return Object.freeze({
    list(): readonly InventoriedBackup[] {
      return readdirSync(options.backupRoot)
        .sort()
        .map((name) => verify(options.backupRoot, name, options.limits));
    },
    dispose(name: string): void {
      const path = join(options.backupRoot, name);
      if (!isBundleName(name) || !lstatSync(path).isDirectory())
        throw new Error("Backup disposal target is not a bundle directory.");
      rmSync(path, { recursive: true });
      if (lstatSync(path, { throwIfNoEntry: false }) !== undefined)
        throw new Error("Backup disposal did not remove the bundle.");
    },
  });
}
