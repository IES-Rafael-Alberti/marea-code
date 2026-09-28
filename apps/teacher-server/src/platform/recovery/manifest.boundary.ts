import { createHash } from "node:crypto";

import {
  RECOVERY_BUNDLE_FORMAT,
  RECOVERY_SQLITE_BACKUP_FORMAT,
  RECOVERY_BUNDLE_SCHEMA_VERSION,
  type RecoveryBundleManifest,
  type RecoveryErrorCode,
  type RecoveryFileRecord,
  RecoveryBundleError,
} from "./contracts.js";
import { validateBundleRelativePath } from "./safe-paths.boundary.js";

type ManifestRecord = Readonly<Record<string, unknown>>;

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createFileRecord(
  path: string,
  bytes: Uint8Array,
  maximumBytes: number,
  code: RecoveryErrorCode,
): RecoveryFileRecord {
  const sizeBytes = bytes.byteLength;
  if (!Number.isSafeInteger(maximumBytes) || sizeBytes > maximumBytes) {
    throw new RecoveryBundleError(code);
  }
  return Object.freeze({ path, sha256: sha256Bytes(bytes), sizeBytes });
}

function manifestFailure(): never {
  throw new RecoveryBundleError("bundle-manifest-invalid");
}

function object(value: unknown): ManifestRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) manifestFailure();
  return value as ManifestRecord;
}

function strictObject(value: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  const record = object(value);
  const allowed = new Set(allowedKeys);
  if (!Object.keys(record).every((key) => allowed.has(key))) manifestFailure();
  return record;
}

function text(value: unknown): string {
  if (typeof value !== "string") manifestFailure();
  return value;
}

function boundedInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) manifestFailure();
  return value as number;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) manifestFailure();
  return value as number;
}

function digest(value: unknown): string {
  const parsed = text(value);
  if (parsed.length !== 64) manifestFailure();
  for (const character of parsed) if (!"0123456789abcdef".includes(character)) manifestFailure();
  return parsed;
}

function fileRecord(value: unknown): RecoveryFileRecord {
  const record = strictObject(value, ["path", "sha256", "sizeBytes"]);
  const path = validateBundleRelativePath(text(record.path));
  if (path === "database.sqlite" || path === "manifest.json") manifestFailure();
  return Object.freeze({
    path,
    sha256: digest(record.sha256),
    sizeBytes: nonNegativeInteger(record.sizeBytes),
  });
}

function databaseRecord(value: unknown): RecoveryBundleManifest["database"] {
  const record = strictObject(value, ["path", "sha256", "sizeBytes", "format", "schemaVersion"]);
  const path = validateBundleRelativePath(text(record.path));
  if (path !== "database.sqlite") manifestFailure();
  if (record.format !== RECOVERY_SQLITE_BACKUP_FORMAT) manifestFailure();
  return Object.freeze({
    path,
    sha256: digest(record.sha256),
    sizeBytes: boundedInteger(record.sizeBytes),
    format: record.format,
    schemaVersion: boundedInteger(record.schemaVersion),
  });
}

export function serializeManifest(manifest: RecoveryBundleManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

export function parseManifest(bytes: Uint8Array, releaseId: string): RecoveryBundleManifest {
  let value: unknown;
  const decoded = new TextDecoder().decode(bytes);
  if (decoded.includes("�")) manifestFailure();
  try {
    value = JSON.parse(decoded);
  } catch {
    throw new RecoveryBundleError("bundle-manifest-invalid", "manifest JSON is invalid");
  }
  const record = strictObject(value, ["database", "files", "format", "release", "schemaVersion"]);
  const release = strictObject(record.release, ["id", "schemaVersion"]);
  if (
    record.format !== RECOVERY_BUNDLE_FORMAT ||
    record.schemaVersion !== RECOVERY_BUNDLE_SCHEMA_VERSION ||
    !Array.isArray(record.files) ||
    text(release.id) !== releaseId
  ) {
    manifestFailure();
  }
  const manifest = Object.freeze({
    database: databaseRecord(record.database),
    files: Object.freeze(record.files.map((entry) => fileRecord(entry))),
    format: RECOVERY_BUNDLE_FORMAT,
    release: Object.freeze({
      id: text(release.id),
      schemaVersion: boundedInteger(release.schemaVersion),
    }),
    schemaVersion: RECOVERY_BUNDLE_SCHEMA_VERSION,
  } satisfies RecoveryBundleManifest);
  if (manifest.database.schemaVersion !== manifest.release.schemaVersion) manifestFailure();
  const paths = new Set<string>();
  for (const file of manifest.files) {
    if (paths.has(file.path) || paths.has(manifest.database.path)) manifestFailure();
    paths.add(file.path);
  }
  return manifest;
}
