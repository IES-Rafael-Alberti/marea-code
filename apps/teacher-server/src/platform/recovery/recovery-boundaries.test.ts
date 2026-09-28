import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  copyVerifiedArtifactFile,
  ensureAbsentDirectory,
  publishArtifactDirectory,
  removeArtifactTree,
  stageArtifactDirectory,
  verifyArtifactFiles,
  verifyArtifactManifest,
  verifyFileBytes,
  writeArtifactBytes,
} from "./artifact.boundary.js";
import { createFileRecord, sha256Bytes } from "./manifest.boundary.js";
import { expectRecoveryError } from "./recovery-assertions.fixture.js";
import { safeArtifactPath, validateBundleRelativePath } from "./safe-paths.boundary.js";
import { startRecoveryTest } from "./recovery-test-environment.fixture.js";
import {
  recoveryManifest,
  recoveryTestLimits,
  writeRecoveryArtifact,
} from "./recovery-test-artifact.fixture.js";

const environment = startRecoveryTest("marea-recovery-boundaries-");
const root = environment.root;
const limits = recoveryTestLimits;
const databaseBytes = new TextEncoder().encode("database-bytes");
const fileBytes = new TextEncoder().encode("required-bytes");

const manifest = () => recoveryManifest();
const makeArtifact = (base = join(root(), "valid-artifact")) => writeRecoveryArtifact(base);

describe("recovery bundle boundaries", () => {
  it("enforces destination and publication boundaries", () => {
    const existingDirectory = join(root(), "existing-directory");
    mkdirSync(existingDirectory);
    const existingFile = join(root(), "existing-file");
    writeFileSync(existingFile, "bytes");
    const existingLink = join(root(), "existing-link");
    symlinkSync(existingFile, existingLink);
    const danglingLink = join(root(), "dangling-link");
    symlinkSync(join(root(), "missing"), danglingLink);
    const parentFile = join(root(), "parent-file");
    writeFileSync(parentFile, "bytes");
    for (const path of [existingDirectory, existingFile, existingLink, danglingLink])
      expectRecoveryError(() => {
        ensureAbsentDirectory(path);
      }, "bundle-destination-invalid");
    expectRecoveryError(() => {
      ensureAbsentDirectory(join(root(), "missing-parent/child"));
    }, "bundle-destination-invalid");
    expectRecoveryError(() => {
      ensureAbsentDirectory(join(parentFile, "child"));
    }, "bundle-destination-invalid");
    const staged = join(root(), "staged");
    stageArtifactDirectory(staged);
    expect(statSync(staged).mode & 0o777).toBe(0o700);
    expectRecoveryError(() => {
      stageArtifactDirectory(staged);
    }, "bundle-filesystem-invalid");
    const destination = join(root(), "published");
    publishArtifactDirectory(staged, destination);
    expect(existsSync(staged)).toBe(false);
    expect(existsSync(destination)).toBe(true);
    expectRecoveryError(() => {
      publishArtifactDirectory(join(root(), "missing-staged"), join(root(), "failed"));
    }, "bundle-filesystem-invalid");
    const failedStaged = join(root(), "failed-staged");
    mkdirSync(failedStaged);
    const failedDestinationParent = join(root(), "failed-destination-parent");
    writeFileSync(failedDestinationParent, "bytes");
    expectRecoveryError(() => {
      publishArtifactDirectory(failedStaged, join(failedDestinationParent, "destination"));
    }, "bundle-filesystem-invalid");
    expect(existsSync(failedStaged)).toBe(false);
    const tree = join(root(), "tree/inner");
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, "file"), "bytes");
    removeArtifactTree(join(root(), "tree"));
    expect(existsSync(join(root(), "tree"))).toBe(false);
  });

  it("writes and copies bounded artifact bytes", () => {
    const artifactRoot = join(root(), "artifact-bytes");
    const file = join(artifactRoot, "nested/file");
    writeArtifactBytes(file, fileBytes, limits);
    expect(new Uint8Array(readFileSync(file))).toEqual(fileBytes);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeArtifactBytes(join(artifactRoot, "exact"), new Uint8Array(limits.fileBytes), limits);
    expectRecoveryError(() => {
      writeArtifactBytes(join(artifactRoot, "invalid-limit"), fileBytes, {
        ...limits,
        fileBytes: 1.5,
      });
    }, "bundle-input-invalid");
    expectRecoveryError(() => {
      writeArtifactBytes(
        join(artifactRoot, "oversized"),
        new Uint8Array(limits.fileBytes + 1),
        limits,
      );
    }, "bundle-input-invalid");
    writeFileSync(join(artifactRoot, "blocked"), "bytes");
    expectRecoveryError(() => {
      writeArtifactBytes(join(artifactRoot, "blocked/child"), fileBytes, limits);
    }, "bundle-filesystem-invalid");
    const restoredRoot = join(root(), "restored-bytes");
    const copyRecord = createFileRecord(
      "nested/copy",
      fileBytes,
      limits.fileBytes,
      "bundle-filesystem-invalid",
    );
    copyVerifiedArtifactFile(file, restoredRoot, copyRecord, limits);
    expect(new Uint8Array(readFileSync(join(restoredRoot, "nested/copy")))).toEqual(fileBytes);
    expect(statSync(join(restoredRoot, "nested/copy")).mode & 0o777).toBe(0o600);
    symlinkSync(join(artifactRoot, "blocked"), join(restoredRoot, "symbolic-destination"));
    expectRecoveryError(() => {
      copyVerifiedArtifactFile(
        file,
        restoredRoot,
        { ...copyRecord, path: "symbolic-destination" },
        limits,
      );
    }, "bundle-filesystem-invalid");
    writeFileSync(file, new Uint8Array(limits.fileBytes + 1));
    expectRecoveryError(() => {
      copyVerifiedArtifactFile(
        file,
        restoredRoot,
        { ...copyRecord, path: "rejected-copy" },
        limits,
      );
    }, "bundle-filesystem-invalid");
    expect(existsSync(join(restoredRoot, "rejected-copy"))).toBe(false);
  });

  it("enforces manifest records and exact digests", () => {
    const record = manifest().database;
    expect(record.path).toBe("database.sqlite");
    expect(record.sizeBytes).toBe(databaseBytes.byteLength);
    expect(record.sha256).toBe(sha256Bytes(databaseBytes));
    createFileRecord(
      "exact",
      new Uint8Array(limits.fileBytes),
      limits.fileBytes,
      "bundle-input-invalid",
    );
    expectRecoveryError(
      () =>
        createFileRecord(
          "oversized",
          new Uint8Array(limits.fileBytes + 1),
          limits.fileBytes,
          "bundle-input-invalid",
        ),
      "bundle-input-invalid",
    );
    expectRecoveryError(
      () => verifyFileBytes(join(root(), "missing"), record, limits, "bundle-database-invalid"),
      "bundle-database-invalid",
    );
    const path = join(root(), "record");
    writeFileSync(path, databaseBytes);
    expect(
      new Uint8Array(verifyFileBytes(path, record, limits, "bundle-database-invalid")),
    ).toEqual(databaseBytes);
    expectRecoveryError(
      () =>
        verifyFileBytes(
          path,
          { ...record, sha256: "0".repeat(64) },
          limits,
          "bundle-database-invalid",
        ),
      "bundle-database-invalid",
    );
    expectRecoveryError(
      () =>
        verifyFileBytes(
          path,
          { ...record, sizeBytes: record.sizeBytes + 1 },
          limits,
          "bundle-database-invalid",
        ),
      "bundle-database-invalid",
    );
    const oversizedPath = join(root(), "oversized-record");
    writeFileSync(oversizedPath, new Uint8Array(limits.fileBytes + 1));
    expectRecoveryError(
      () =>
        verifyFileBytes(
          oversizedPath,
          {
            sha256: sha256Bytes(new Uint8Array(limits.fileBytes + 1)),
            sizeBytes: limits.fileBytes + 1,
          },
          limits,
          "bundle-database-invalid",
        ),
      "bundle-database-invalid",
    );
  });

  it("rejects unsafe and non-unique paths", () => {
    for (const path of [
      "",
      ".",
      "..",
      "../escape",
      "state/../escape",
      "/absolute",
      "state\\file",
      "state\0file",
      "state/./file",
      "state//file",
      "state/file/",
    ])
      expectRecoveryError(() => validateBundleRelativePath(path), "bundle-input-invalid");
    expect(validateBundleRelativePath("state/file")).toBe("state/file");
    expect(safeArtifactPath(root(), "missing", "bundle-filesystem-invalid")).toBe(
      join(root(), "missing"),
    );
    const regular = join(root(), "regular");
    writeFileSync(regular, "bytes");
    expect(safeArtifactPath(root(), "regular", "bundle-filesystem-invalid")).toBe(regular);
    mkdirSync(join(root(), "regular-directory"));
    expectRecoveryError(
      () => safeArtifactPath(root(), "regular-directory", "bundle-filesystem-invalid"),
      "bundle-filesystem-invalid",
    );
    const linked = join(root(), "hard-linked");
    linkSync(regular, linked);
    expectRecoveryError(
      () => safeArtifactPath(root(), "hard-linked", "bundle-filesystem-invalid"),
      "bundle-filesystem-invalid",
    );
    symlinkSync(regular, join(root(), "symbolic"));
    expectRecoveryError(
      () => safeArtifactPath(root(), "symbolic", "bundle-filesystem-invalid"),
      "bundle-filesystem-invalid",
    );
    mkdirSync(join(root(), "outside"));
    writeFileSync(join(root(), "outside/file"), "bytes");
    symlinkSync("outside", join(root(), "link"));
    expectRecoveryError(
      () => safeArtifactPath(root(), "link/file", "bundle-filesystem-invalid"),
      "bundle-filesystem-invalid",
    );
  });

  it("verifies the exact artifact inventory and bytes", () => {
    const base = makeArtifact();
    const paths = verifyArtifactFiles(join(root(), "valid-artifact"), base, limits);
    expect(paths).toEqual([
      join(root(), "valid-artifact/database.sqlite"),
      join(root(), "valid-artifact/state/file"),
    ]);
    expect(verifyArtifactManifest(join(root(), "valid-artifact"), limits, "release:one")).toEqual(
      base,
    );
    expectRecoveryError(
      () => verifyArtifactManifest(join(root(), "missing-artifact"), limits, "release:one"),
      "bundle-manifest-invalid",
    );
    const countRoot = join(root(), "count-artifact");
    makeArtifact(countRoot);
    expectRecoveryError(
      () => verifyArtifactManifest(countRoot, { ...limits, fileCount: 0 }, "release:one"),
      "bundle-manifest-invalid",
    );
    const totalRoot = join(root(), "total-artifact");
    makeArtifact(totalRoot);
    expectRecoveryError(
      () => verifyArtifactManifest(totalRoot, { ...limits, totalBytes: 1 }, "release:one"),
      "bundle-manifest-invalid",
    );
    const extraRoot = join(root(), "extra-artifact");
    makeArtifact(extraRoot);
    writeFileSync(join(extraRoot, "state/extra"), "extra");
    expectRecoveryError(
      () => verifyArtifactFiles(extraRoot, manifest(), limits),
      "bundle-manifest-invalid",
    );
    const missingRoot = join(root(), "missing-artifact-files");
    makeArtifact(missingRoot);
    rmSync(join(missingRoot, "state/file"));
    expectRecoveryError(
      () => verifyArtifactFiles(missingRoot, manifest(), limits),
      "bundle-manifest-invalid",
    );
    const tamperedRoot = join(root(), "tampered-artifact");
    makeArtifact(tamperedRoot);
    writeFileSync(join(tamperedRoot, "database.sqlite"), "tampered");
    expectRecoveryError(
      () => verifyArtifactFiles(tamperedRoot, manifest(), limits),
      "bundle-database-invalid",
    );
    const alteredRoot = join(root(), "altered-artifact");
    makeArtifact(alteredRoot);
    writeFileSync(join(alteredRoot, "state/file"), "altered");
    expectRecoveryError(
      () => verifyArtifactFiles(alteredRoot, manifest(), limits),
      "bundle-filesystem-invalid",
    );
    const missingDatabaseRoot = join(root(), "missing-database-artifact");
    makeArtifact(missingDatabaseRoot);
    rmSync(join(missingDatabaseRoot, "database.sqlite"));
    expectRecoveryError(
      () => verifyArtifactFiles(missingDatabaseRoot, manifest(), limits),
      "bundle-manifest-invalid",
    );
    const totalBoundaryRoot = join(root(), "total-boundary-artifact");
    makeArtifact(totalBoundaryRoot);
    expect(
      verifyArtifactManifest(totalBoundaryRoot, { ...limits, totalBytes: 28 }, "release:one"),
    ).toEqual(manifest());
    expectRecoveryError(
      () => verifyArtifactManifest(totalBoundaryRoot, { ...limits, totalBytes: 27 }, "release:one"),
      "bundle-manifest-invalid",
    );
    const mismatchedRoot = join(root(), "mismatched-artifact");
    makeArtifact(mismatchedRoot);
    writeFileSync(join(mismatchedRoot, "extra"), "extra");
    rmSync(join(mismatchedRoot, "state/file"));
    expectRecoveryError(
      () => verifyArtifactFiles(mismatchedRoot, manifest(), limits),
      "bundle-manifest-invalid",
    );
    const duplicateRoot = join(root(), "duplicate-manifest-artifact");
    makeArtifact(duplicateRoot);
    const duplicateManifest = {
      ...manifest(),
      files: [
        { path: "state/file", sha256: sha256Bytes(fileBytes), sizeBytes: 14 },
        { path: "state/file", sha256: sha256Bytes(fileBytes), sizeBytes: 14 },
      ],
    };
    expectRecoveryError(
      () => verifyArtifactFiles(duplicateRoot, duplicateManifest, limits),
      "bundle-manifest-invalid",
    );
    const databaseCodeRoot = join(root(), "database-code-artifact");
    makeArtifact(databaseCodeRoot);
    rmSync(join(databaseCodeRoot, "database.sqlite"));
    symlinkSync("state/file", join(databaseCodeRoot, "database.sqlite"));
    expectRecoveryError(
      () => verifyArtifactFiles(databaseCodeRoot, manifest(), limits),
      "bundle-filesystem-invalid",
    );
    const databaseHardLinkRoot = join(root(), "database-hard-link-artifact");
    makeArtifact(databaseHardLinkRoot);
    linkSync(
      join(databaseHardLinkRoot, "database.sqlite"),
      join(databaseHardLinkRoot, "database-copy"),
    );
    expectRecoveryError(
      () => verifyArtifactFiles(databaseHardLinkRoot, manifest(), limits),
      "bundle-filesystem-invalid",
    );
    const stateHardLinkRoot = join(root(), "state-hard-link-artifact");
    makeArtifact(stateHardLinkRoot);
    linkSync(join(stateHardLinkRoot, "state/file"), join(stateHardLinkRoot, "state/copy"));
    expectRecoveryError(
      () => verifyArtifactFiles(stateHardLinkRoot, manifest(), limits),
      "bundle-filesystem-invalid",
    );
    const nestedManifestRoot = join(root(), "nested-manifest-artifact");
    makeArtifact(nestedManifestRoot);
    writeFileSync(join(nestedManifestRoot, "state/manifest.json"), "{}");
    expectRecoveryError(
      () => verifyArtifactFiles(nestedManifestRoot, manifest(), limits),
      "bundle-manifest-invalid",
    );
    const sortedRoot = join(root(), "sorted-artifact");
    mkdirSync(join(sortedRoot, "state"), { recursive: true });
    writeFileSync(join(sortedRoot, "database.sqlite"), databaseBytes);
    writeFileSync(join(sortedRoot, "state/b"), fileBytes);
    writeFileSync(join(sortedRoot, "state/a"), fileBytes);
    expect(
      verifyArtifactFiles(
        sortedRoot,
        {
          ...manifest(),
          files: [
            { path: "state/b", sha256: sha256Bytes(fileBytes), sizeBytes: 14 },
            { path: "state/a", sha256: sha256Bytes(fileBytes), sizeBytes: 14 },
          ],
        },
        limits,
      ).slice(1),
    ).toEqual([join(sortedRoot, "state/b"), join(sortedRoot, "state/a")]);
    expect(safeArtifactPath(root(), "missing", "bundle-filesystem-invalid")).toBe(
      join(root(), "missing"),
    );
    expect(statSync(join(root(), "valid-artifact/database.sqlite")).isFile()).toBe(true);
  });
});
