import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  opendirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";

import type { RecoveryBundleLimits, RecoveryFileRecord } from "./contracts.js";
import { RECOVERY_MANIFEST_BYTES, RecoveryBundleError } from "./contracts.js";
import { failWithFile, safeArtifactPath } from "./safe-paths.boundary.js";
import { createFileRecord, parseManifest, sha256Bytes } from "./manifest.boundary.js";
import type { RecoveryBundleManifest } from "./contracts.js";

export function ensureAbsentDirectory(path: string): void {
  const parent = dirname(path);
  const parentDescriptor = lstatSync(parent, { throwIfNoEntry: false });
  if (!parentDescriptor?.isDirectory()) throw new RecoveryBundleError("bundle-destination-invalid");
  if (existsSync(path) || lstatSync(path, { throwIfNoEntry: false }) !== undefined)
    throw new RecoveryBundleError("bundle-destination-invalid");
}

export function stageArtifactDirectory(stagedPath: string): void {
  try {
    mkdirSync(stagedPath, { mode: 0o700 });
  } catch {
    throw new RecoveryBundleError("bundle-filesystem-invalid");
  }
}

export function writeArtifactBytes(
  path: string,
  bytes: Uint8Array,
  limits: RecoveryBundleLimits,
): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o600 });
  } catch {
    throw new RecoveryBundleError("bundle-filesystem-invalid");
  }
  if (!Number.isSafeInteger(limits.fileBytes) || bytes.byteLength > limits.fileBytes)
    throw new RecoveryBundleError("bundle-input-invalid");
}

export function removeArtifactTree(path: string): void {
  try {
    rmSync(path, { recursive: true });
  } catch {
    // The original failure remains the useful diagnostic.
  }
}

export function publishArtifactDirectory(stagedPath: string, destinationPath: string): void {
  let failure: unknown;
  try {
    if (lstatSync(destinationPath, { throwIfNoEntry: false }) !== undefined) {
      failure = new RecoveryBundleError("bundle-destination-invalid");
    } else {
      renameSync(stagedPath, destinationPath);
    }
  } catch (caught) {
    failure = caught;
  } finally {
    removeArtifactTree(stagedPath);
  }
  if (failure !== undefined) {
    if (failure instanceof RecoveryBundleError) throw failure;
    throw new RecoveryBundleError("bundle-filesystem-invalid");
  }
}

function changedReadMetadata(
  before: {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
  },
  after: {
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
  },
  totalBytes: number,
): boolean {
  return (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    totalBytes !== before.size
  );
}

export function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
  code: Parameters<typeof createFileRecord>[3],
  dependencies: {
    readonly closeSync?: typeof closeSync;
    readonly fstatSync?: (descriptor: number) => {
      isFile(): boolean;
      readonly nlink: number;
      readonly dev: number;
      readonly ino: number;
      readonly size: number;
      readonly mtimeMs: number;
      readonly ctimeMs: number;
    };
    readonly readSync?: (descriptor: number, buffer: Uint8Array) => number;
  } = {},
): Uint8Array {
  let descriptor: number | undefined;
  const closeFile = dependencies.closeSync ?? closeSync;
  const statFile =
    dependencies.fstatSync ??
    ((descriptor: number) => {
      const descriptorStats = fstatSync(descriptor);
      return Object.assign({}, descriptorStats, { isFile: () => descriptorStats.isFile() });
    });
  const readFile =
    dependencies.readSync ??
    ((descriptor: number, buffer: Uint8Array) => readSync(descriptor, buffer));
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = statFile(descriptor);
    const isFile = before.isFile();
    if (!isFile || before.nlink !== 1) failWithFile(code);
    if (!Number.isSafeInteger(maximumBytes)) failWithFile(code);
    if (before.size > maximumBytes) failWithFile(code);
    // One bounded allocation; a growing file cannot write beyond its initial size.
    const bytes = new Uint8Array(before.size);
    const chunk = new Uint8Array(65_536);
    let totalBytes = 0;
    for (;;) {
      const readBytes = readFile(descriptor, chunk);
      if (readBytes === 0) break;
      const offset = totalBytes;
      totalBytes += readBytes;
      bytes.set(chunk.subarray(0, readBytes), offset);
    }
    const after = statFile(descriptor);
    if (changedReadMetadata(before, after, totalBytes)) {
      failWithFile(code);
    }
    return bytes;
  } catch {
    throw new RecoveryBundleError(code);
  } finally {
    if (descriptor !== undefined) closeFile(descriptor);
  }
}

export function verifyArtifactManifest(
  path: string,
  limits: RecoveryBundleLimits,
  releaseId: string,
): RecoveryBundleManifest {
  const manifest = readBoundedRegularFile(
    join(path, "manifest.json"),
    RECOVERY_MANIFEST_BYTES,
    "bundle-manifest-invalid",
  );
  const parsed = parseManifest(manifest, releaseId);
  if (parsed.files.length > limits.fileCount) {
    throw new RecoveryBundleError("bundle-manifest-invalid");
  }
  let totalBytes = parsed.database.sizeBytes;
  for (const file of parsed.files) {
    totalBytes += file.sizeBytes;
  }
  if (totalBytes > limits.totalBytes) {
    throw new RecoveryBundleError("bundle-manifest-invalid");
  }
  return parsed;
}

export function verifyArtifactFiles(
  root: string,
  manifest: RecoveryBundleManifest,
  limits: RecoveryBundleLimits,
): readonly string[] {
  listArtifactFiles(root, manifest, limits);
  const databasePath = join(root, "database.sqlite");
  verifyFileBytes(databasePath, manifest.database, limits, "bundle-database-invalid");
  for (const file of manifest.files) {
    const path = join(root, file.path);
    verifyFileBytes(path, file, limits, "bundle-filesystem-invalid");
  }
  return [databasePath, ...manifest.files.map((file) => join(root, file.path))];
}

export interface VerifiedArtifactFiles {
  readonly database: {
    readonly bytes: Uint8Array;
    readonly record: RecoveryBundleManifest["database"];
  };
}

export function verifyArtifactFilesWithDatabase(
  root: string,
  manifest: RecoveryBundleManifest,
  limits: RecoveryBundleLimits,
): VerifiedArtifactFiles {
  listArtifactFiles(root, manifest, limits);
  const databasePath = join(root, "database.sqlite");
  const databaseBytes = verifyFileBytes(
    databasePath,
    manifest.database,
    limits,
    "bundle-database-invalid",
  );
  return Object.freeze({
    database: Object.freeze({ bytes: databaseBytes, record: manifest.database }),
  });
}

export function verifyFileBytes(
  path: string,
  record: { readonly sha256: string; readonly sizeBytes: number },
  limits: RecoveryBundleLimits,
  code: Parameters<typeof createFileRecord>[3],
): Uint8Array {
  const bytes = readBoundedRegularFile(path, limits.fileBytes, code);
  if (bytes.byteLength !== record.sizeBytes || sha256Bytes(bytes) !== record.sha256) {
    failWithFile(code);
  }
  return bytes;
}

function listArtifactFiles(
  root: string,
  manifest: RecoveryBundleManifest,
  limits: RecoveryBundleLimits,
): void {
  const inventory = createInventory(manifest);
  const state: InventoryState = {
    observedFiles: 0,
    ...inventory,
    root,
    fileCount: limits.fileCount,
  };
  visitDirectory(state, root);
  const expectedStateAndDatabaseFiles = manifest.files.length + 1;
  if (state.observedFiles !== expectedStateAndDatabaseFiles) {
    throw new RecoveryBundleError("bundle-manifest-invalid");
  }
}

interface InventoryState {
  readonly declaredPaths: Set<string>;
  readonly declaredDirectories: Set<string>;
  observedFiles: number;
  readonly root: string;
  readonly fileCount: number;
}

function createInventory(
  manifest: RecoveryBundleManifest,
): Omit<InventoryState, "observedFiles" | "root" | "fileCount"> {
  const declaredPaths = new Set<string>();
  const declaredDirectories = new Set<string>();
  for (const file of manifest.files) {
    declaredPaths.add(file.path);
    let directory = posix.dirname(file.path);
    while (directory !== ".") {
      declaredDirectories.add(directory);
      directory = posix.dirname(directory);
    }
  }
  return { declaredDirectories, declaredPaths };
}

function assertRegularArtifactFile(entry: { isFile(): boolean }, path: string): void {
  if (!entry.isFile() || lstatSync(path).nlink !== 1) failWithFile("bundle-filesystem-invalid");
}

function observeDirectoryEntry(
  state: InventoryState,
  directory: string,
  entry: { isFile(): boolean; name: string },
): void {
  const entryName = entry.name;
  const child = join(directory, entryName);
  const childPath = relative(state.root, child).split(sep).join("/");
  if (childPath === "manifest.json") {
    if (!entry.isFile() || lstatSync(child).nlink !== 1) failWithFile("bundle-manifest-invalid");
    return;
  }
  if (childPath === "database.sqlite" || state.declaredPaths.has(childPath)) {
    assertRegularArtifactFile(entry, child);
    state.observedFiles += 1;
    if (state.observedFiles > state.fileCount + 1) failWithFile("bundle-manifest-invalid");
  } else if (state.declaredDirectories.has(childPath)) {
    if (!isDeclaredDirectory(child)) failWithFile("bundle-filesystem-invalid");
    visitDirectory(state, child);
  } else {
    failWithFile("bundle-manifest-invalid");
  }
}

function isDeclaredDirectory(path: string): boolean {
  return lstatSync(path).isDirectory();
}

function visitDirectory(state: InventoryState, directory: string): void {
  let directoryDescriptor: ReturnType<typeof opendirSync> | undefined;
  try {
    directoryDescriptor = opendirSync(directory);
    for (;;) {
      const entry = directoryDescriptor.readSync();
      if (entry === null) break;
      observeDirectoryEntry(state, directory, entry);
    }
  } catch (error) {
    if (error instanceof RecoveryBundleError) throw error;
    failWithFile("bundle-filesystem-invalid");
  } finally {
    directoryDescriptor?.closeSync();
  }
}

export function copyVerifiedArtifactFile(
  sourcePath: string,
  destinationRoot: string,
  record: RecoveryFileRecord,
  limits: RecoveryBundleLimits,
): void {
  const destination = safeArtifactPath(destinationRoot, record.path, "bundle-filesystem-invalid");
  const bytes = verifyFileBytes(sourcePath, record, limits, "bundle-filesystem-invalid");
  try {
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, bytes, { mode: 0o600 });
  } catch {
    throw new RecoveryBundleError("bundle-restore-failed");
  }
}
