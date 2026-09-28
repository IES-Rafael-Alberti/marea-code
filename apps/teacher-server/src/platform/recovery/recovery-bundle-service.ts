import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  initializeSqliteStorage,
  restoreSqliteBackup,
  type SqliteSchemaCatalog,
} from "@marea/sqlite-storage";
import type { SqliteStorage } from "@marea/sqlite-storage";

import {
  RECOVERY_BUNDLE_SCHEMA_VERSION,
  ensureRecoveryError,
  type RecoveryBundle,
  type RecoveryBundleInput,
  type RecoveryBundleManifest,
  type RecoveryBackupCapability,
  RecoveryBundleError,
  RECOVERY_SQLITE_BACKUP_FORMAT,
  type RestoreRecoveryBundleOptions,
} from "./contracts.js";
import {
  copyVerifiedArtifactFile,
  ensureAbsentDirectory,
  publishArtifactDirectory,
  readBoundedRegularFile,
  removeArtifactTree,
  stageArtifactDirectory,
  verifyArtifactFiles,
  verifyArtifactFilesWithDatabase,
  verifyArtifactManifest,
  verifyFileBytes,
  writeArtifactBytes,
} from "./artifact.boundary.js";
import { serializeManifest, sha256Bytes } from "./manifest.boundary.js";
import { safeArtifactPath, validateBundleRelativePath } from "./safe-paths.boundary.js";

function validateLimits(input: RecoveryBundleInput): void {
  const limits = input.limits;
  const values = [limits.fileCount, limits.fileBytes, limits.totalBytes];
  if (!values.every(Number.isSafeInteger) || values.some((value) => value < 1)) {
    throw new RecoveryBundleError("bundle-input-invalid");
  }
}

function validateIdentity(input: RecoveryBundleInput): void {
  if (
    input.release.id.length === 0 ||
    !Number.isSafeInteger(input.release.schemaVersion) ||
    input.release.schemaVersion < 1
  ) {
    throw new RecoveryBundleError("bundle-input-invalid");
  }
}

function validateSourceRoot(input: RecoveryBundleInput): void {
  if (!isAbsolute(input.sourceRoot)) {
    throw new RecoveryBundleError("bundle-input-invalid");
  }
}

function validateRequiredPaths(input: RecoveryBundleInput): readonly string[] {
  const paths = new Set<string>();
  for (const value of input.files) {
    const path = validateBundleRelativePath(value);
    if (path === "database.sqlite" || path === "manifest.json") {
      throw new RecoveryBundleError("bundle-input-invalid");
    }
    paths.add(path);
  }
  if (paths.size !== input.files.length || paths.size > input.limits.fileCount) {
    throw new RecoveryBundleError("bundle-input-invalid");
  }
  return [...paths].toSorted((left, right) => left.localeCompare(right));
}

function captureDatabase(input: RecoveryBundleInput): {
  readonly bytes: Uint8Array;
  readonly schemaVersion: number;
} {
  try {
    const backup = input.createBackup.createBackup();
    const untrustedBackup = backup as {
      readonly format?: unknown;
      readonly schemaVersion?: unknown;
      readonly sha256?: unknown;
    };
    if (
      untrustedBackup.format !== RECOVERY_SQLITE_BACKUP_FORMAT ||
      untrustedBackup.schemaVersion !== input.release.schemaVersion ||
      sha256Bytes(backup.bytes) !== untrustedBackup.sha256
    ) {
      throw new RecoveryBundleError("bundle-database-invalid");
    }
    if (backup.bytes.byteLength > input.limits.totalBytes) {
      throw new RecoveryBundleError("bundle-input-invalid");
    }
    return Object.freeze({ bytes: backup.bytes, schemaVersion: backup.schemaVersion });
  } catch (error) {
    throw ensureRecoveryError(error, "bundle-database-invalid");
  }
}

function captureFile(
  sourceRoot: string,
  relativePath: string,
  limits: RecoveryBundleInput["limits"],
): { readonly bytes: Uint8Array; readonly path: string } {
  const path = safeArtifactPath(sourceRoot, relativePath, "bundle-filesystem-invalid");
  const bytes = readBoundedRegularFile(path, limits.fileBytes, "bundle-filesystem-invalid");
  return { bytes, path: relativePath };
}

function validateInput(input: RecoveryBundleInput): readonly string[] {
  validateLimits(input);
  validateIdentity(input);
  validateSourceRoot(input);
  const paths = validateRequiredPaths(input);
  if (
    typeof (input.createBackup as RecoveryBackupCapability | undefined)?.createBackup !== "function"
  ) {
    throw new RecoveryBundleError("bundle-input-invalid");
  }
  return paths;
}

function buildManifest(
  input: RecoveryBundleInput,
  database: ReturnType<typeof captureDatabase>,
  files: readonly { readonly bytes: Uint8Array; readonly path: string }[],
): RecoveryBundleManifest {
  return Object.freeze({
    database: Object.freeze({
      path: "database.sqlite",
      sha256: sha256Bytes(database.bytes),
      sizeBytes: database.bytes.byteLength,
      format: "sqlite3",
      schemaVersion: database.schemaVersion,
    }),
    files: Object.freeze(
      files.map(({ bytes, path }) =>
        Object.freeze({ path, sha256: sha256Bytes(bytes), sizeBytes: bytes.byteLength }),
      ),
    ),
    format: "marea-recovery",
    release: Object.freeze({ ...input.release }),
    schemaVersion: RECOVERY_BUNDLE_SCHEMA_VERSION,
  });
}

function stagingPathFor(destinationPath: string): string {
  return `${destinationPath}.marea-recovery.${randomUUID()}.staging`;
}

export function createRecoveryBundle(
  destinationPath: string,
  input: RecoveryBundleInput,
): RecoveryBundle {
  const requiredPaths = validateInput(input);
  if (typeof input.createExclusive !== "function") {
    throw new RecoveryBundleError("bundle-input-invalid");
  }
  const stagingPath = stagingPathFor(destinationPath);
  ensureAbsentDirectory(destinationPath);
  let manifestBytes: Uint8Array | undefined;
  stageArtifactDirectory(stagingPath);
  try {
    const operation = (): void => {
      const database = captureDatabase(input);
      let aggregateBytes = database.bytes.byteLength;
      const files = requiredPaths.map((path) => {
        const file = captureFile(input.sourceRoot, path, input.limits);
        aggregateBytes += file.bytes.byteLength;
        checkCaptureBudget(aggregateBytes, input.limits);
        return file;
      });
      const manifest = buildManifest(input, database, files);
      writeArtifactBytes(join(stagingPath, "database.sqlite"), database.bytes, input.limits);
      for (const file of files)
        writeArtifactBytes(join(stagingPath, file.path), file.bytes, input.limits);
      manifestBytes = serializeManifest(manifest);
      writeArtifactBytes(join(stagingPath, "manifest.json"), manifestBytes, {
        ...input.limits,
        fileBytes: input.limits.totalBytes,
      });
    };
    input.createExclusive(operation);
    if (manifestBytes === undefined) {
      throw new RecoveryBundleError("bundle-maintenance-failed");
    }
    const stagedManifest = verifyArtifactManifest(stagingPath, input.limits, input.release.id);
    verifyArtifactFiles(stagingPath, stagedManifest, input.limits);
    publishArtifactDirectory(stagingPath, destinationPath);
    return Object.freeze({ manifest: stagedManifest, path: destinationPath });
  } catch (error) {
    throw ensureRecoveryError(error, "bundle-maintenance-failed");
  } finally {
    removeArtifactTree(stagingPath);
  }
}

function checkCaptureBudget(aggregateBytes: number, limits: RecoveryBundleInput["limits"]): void {
  if (aggregateBytes > limits.totalBytes) throw new RecoveryBundleError("bundle-input-invalid");
}

function verifyReleaseArtifact(
  artifactPath: string,
  release: { readonly id: string; readonly schemaVersion: number },
  limits: { readonly fileCount: number; readonly fileBytes: number; readonly totalBytes: number },
): RecoveryBundleManifest {
  const manifest = verifyArtifactManifest(artifactPath, limits, release.id);
  if (manifest.release.schemaVersion !== release.schemaVersion) {
    throw new RecoveryBundleError("bundle-manifest-invalid");
  }
  return manifest;
}

function restoreDatabase(
  manifest: RecoveryBundleManifest,
  databaseBytes: Uint8Array,
  destinationRoot: string,
  schema: SqliteSchemaCatalog,
): string {
  const stagedPath = join(destinationRoot, `.database.sqlite.${randomUUID()}.restore`);
  let restored: SqliteStorage | undefined;
  try {
    restored = restoreSqliteBackup({
      backup: {
        bytes: databaseBytes,
        format: manifest.database.format,
        schemaVersion: manifest.database.schemaVersion,
        sha256: manifest.database.sha256,
      },
      databasePath: stagedPath,
      schema,
    });
    restored.close();
  } catch (error) {
    restored?.close();
    throw ensureRecoveryError(error, "bundle-database-invalid");
  }
  const finalPath = join(destinationRoot, "database.sqlite");
  renameSync(stagedPath, finalPath);
  return finalPath;
}

function verifyCopiedFiles(
  stagingPath: string,
  manifest: RecoveryBundleManifest,
  limits: { readonly fileBytes: number; readonly totalBytes: number; readonly fileCount: number },
): void {
  for (const file of manifest.files) {
    verifyFileBytes(join(stagingPath, file.path), file, limits, "bundle-filesystem-invalid");
  }
}

export function restoreRecoveryBundle(
  options: RestoreRecoveryBundleOptions,
  release: { readonly id: string; readonly schemaVersion: number },
  limits: {
    readonly fileBytes: number;
    readonly totalBytes: number;
    readonly fileCount: number;
  },
): SqliteStorage {
  if (release.id.length === 0) {
    throw new RecoveryBundleError("bundle-input-invalid");
  }
  if (!Number.isSafeInteger(release.schemaVersion) || release.schemaVersion < 1) {
    throw new RecoveryBundleError("bundle-input-invalid");
  }
  ensureAbsentDirectory(options.destinationRoot);
  const manifest = verifyReleaseArtifact(options.path, release, limits);
  const verifiedArtifact = verifyArtifactFilesWithDatabase(options.path, manifest, limits);
  const stagingPath = stagingPathFor(options.destinationRoot);
  stageArtifactDirectory(stagingPath);
  try {
    for (const file of manifest.files)
      copyVerifiedArtifactFile(join(options.path, file.path), stagingPath, file, limits);
    verifyCopiedFiles(stagingPath, manifest, limits);
    const schema = options.schema ?? "application";
    restoreDatabase(manifest, verifiedArtifact.database.bytes, stagingPath, schema);
    publishArtifactDirectory(stagingPath, options.destinationRoot);
    try {
      return initializeSqliteStorage({
        databasePath: join(options.destinationRoot, "database.sqlite"),
        schema,
      });
    } catch (error) {
      removeArtifactTree(options.destinationRoot);
      throw error;
    }
  } catch (error) {
    throw ensureRecoveryError(error, "bundle-restore-failed");
  } finally {
    removeArtifactTree(stagingPath);
  }
}
