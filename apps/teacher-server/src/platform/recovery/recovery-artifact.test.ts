import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  copyVerifiedArtifactFile,
  ensureAbsentDirectory,
  publishArtifactDirectory,
  stageArtifactDirectory,
  verifyArtifactFiles,
  verifyFileBytes,
  verifyArtifactManifest,
  writeArtifactBytes,
} from "./artifact.boundary.js";
import { createFileRecord, parseManifest } from "./manifest.boundary.js";
import { expectRecoveryError } from "./recovery-assertions.fixture.js";
import { RecoveryBundleError, createRecoveryBundle, restoreRecoveryBundle } from "./index.js";
import { startRecoveryTest } from "./recovery-test-environment.fixture.js";
import {
  recoveryManifest,
  recoveryTestLimits,
  writeRecoveryArtifact,
} from "./recovery-test-artifact.fixture.js";
vi.mock(
  "@marea/sqlite-storage",
  async () => (await import("./recovery-sqlite-mocks.fixture.js")).default,
);

const environment = startRecoveryTest("marea-recovery-artifact-");
const root = environment.root;
const input = environment.input;
const writeState = environment.writeState;

describe("recovery bundle artifacts", () => {
  it("rejects malformed manifest values", () => {
    const release = { id: "release:one", schemaVersion: 1 };
    const database = { path: "database.sqlite", sha256: "0".repeat(64), sizeBytes: 1 };
    const files = [{ path: "file", sha256: "0".repeat(64), sizeBytes: 1 }] as const;
    const manifest = {
      database,
      files,
      format: "marea-recovery",
      release,
      schemaVersion: 1,
    };
    const encoded = JSON.stringify(manifest);
    expectRecoveryError(() => {
      parseManifest(new TextEncoder().encode(encoded), "release:other");
    }, "bundle-manifest-invalid");
    const changes: readonly [unknown][] = [
      [JSON.stringify([])],
      [JSON.stringify({ ...manifest, release: null })],
      [JSON.stringify({ ...manifest, database: { ...database, path: "other" } })],
      [JSON.stringify({ ...manifest, database: { ...database, sha256: "short" } })],
      [JSON.stringify({ ...manifest, database: { ...database, sizeBytes: 0 } })],
      [JSON.stringify({ ...manifest, database: { ...database, sizeBytes: 1.5 } })],
      [JSON.stringify({ ...manifest, release: { ...release, schemaVersion: 0 } })],
      [JSON.stringify({ ...manifest, release: { id: 1, schemaVersion: 1 } })],
      [JSON.stringify({ ...manifest, database: { ...database, path: 1 } })],
      [JSON.stringify({ ...manifest, files: "array" })],
      [JSON.stringify({ ...manifest, files: ["entry"] })],
      [
        JSON.stringify({
          ...manifest,
          files: [{ path: "database.sqlite", sha256: "0".repeat(64), sizeBytes: 1 }],
        }),
      ],
    ];
    for (const [value] of changes) {
      expectRecoveryError(
        () =>
          parseManifest(
            new TextEncoder().encode(typeof value === "string" ? value : encoded),
            "release:one",
          ),
        "bundle-manifest-invalid",
      );
    }
  });

  it("rejects invalid destination and artifact filesystem boundaries", () => {
    for (const destination of [
      join(root(), "missing-parent/bundle"),
      join(root(), "parent-file/bundle"),
      join(root(), "dangling"),
    ]) {
      expect(() => createRecoveryBundle(destination, input())).toThrow(RecoveryBundleError);
    }
    const parentFile = join(root(), "parent-as-file");
    writeFileSync(parentFile, "not-directory");
    expectRecoveryError(() => {
      ensureAbsentDirectory(join(parentFile, "bundle"));
    }, "bundle-destination-invalid");
    symlinkSync(join(root(), "missing"), join(root(), "dangling-destination"));
    expectRecoveryError(() => {
      ensureAbsentDirectory(join(root(), "dangling-destination"));
    }, "bundle-destination-invalid");
    const fileStaging = join(root(), "staging-file");
    writeFileSync(fileStaging, "occupied");
    expectRecoveryError(() => {
      stageArtifactDirectory(fileStaging);
    }, "bundle-filesystem-invalid");
    const sourceDirectory = join(root(), "artifact");
    mkdirSync(sourceDirectory);
    writeFileSync(join(sourceDirectory, "database.sqlite"), "database");
    expectRecoveryError(() => {
      publishArtifactDirectory(fileStaging, sourceDirectory);
    }, "bundle-destination-invalid");
    expectRecoveryError(() => {
      writeFileSync(join(sourceDirectory, "blocked"), "occupied");
      writeArtifactBytes(join(sourceDirectory, "blocked/child"), new Uint8Array(), {
        fileBytes: 16,
        fileCount: 1,
        totalBytes: 16,
      });
    }, "bundle-filesystem-invalid");
    expectRecoveryError(() => {
      writeArtifactBytes(join(sourceDirectory, "oversized"), new Uint8Array(17), {
        fileBytes: 16,
        fileCount: 1,
        totalBytes: 16,
      });
    }, "bundle-input-invalid");
    expectRecoveryError(
      () =>
        verifyFileBytes(
          join(sourceDirectory, "missing"),
          {
            sha256: "0".repeat(64),
            sizeBytes: 1,
          },
          { fileBytes: 16, fileCount: 1, totalBytes: 16 },
          "bundle-database-invalid",
        ),
      "bundle-database-invalid",
    );
    expectRecoveryError(() => {
      copyVerifiedArtifactFile(
        join(sourceDirectory, "database.sqlite"),
        join(sourceDirectory, "blocked/copy"),
        createFileRecord(
          "copy",
          new TextEncoder().encode("database"),
          64,
          "bundle-filesystem-invalid",
        ),
        { fileBytes: 64, fileCount: 1, totalBytes: 1024 },
      );
    }, "bundle-restore-failed");
    expectRecoveryError(
      () =>
        verifyArtifactManifest(
          join(sourceDirectory, "missing"),
          {
            fileBytes: 16,
            fileCount: 1,
            totalBytes: 16,
          },
          "release:one",
        ),
      "bundle-manifest-invalid",
    );
  });

  it("rejects an oversized declared inventory", () => {
    const artifactRoot = join(root(), "oversized-inventory");
    mkdirSync(artifactRoot);
    writeFileSync(
      join(artifactRoot, "manifest.json"),
      JSON.stringify({
        database: { path: "database.sqlite", sha256: "0".repeat(64), sizeBytes: 1 },
        files: [
          { path: "one", sha256: "0".repeat(64), sizeBytes: 2000 },
          { path: "two", sha256: "0".repeat(64), sizeBytes: 2000 },
        ],
        format: "marea-recovery",
        release: { id: "release:one", schemaVersion: 1 },
        schemaVersion: 1,
      }),
    );
    expect(() =>
      verifyArtifactManifest(
        artifactRoot,
        {
          fileBytes: 16,
          fileCount: 1,
          totalBytes: 16,
        },
        "release:one",
      ),
    ).toThrow(RecoveryBundleError);
  });

  it("rejects a manifest that exceeds its total byte limit", () => {
    const artifactRoot = join(root(), "oversized-total");
    mkdirSync(artifactRoot);
    writeFileSync(
      join(artifactRoot, "manifest.json"),
      JSON.stringify({
        database: { path: "database.sqlite", sha256: "0".repeat(64), sizeBytes: 16 },
        files: [{ path: "one", sha256: "0".repeat(64), sizeBytes: 2000 }],
        format: "marea-recovery",
        release: { id: "release:one", schemaVersion: 1 },
        schemaVersion: 1,
      }),
    );
    expect(() =>
      verifyArtifactManifest(
        artifactRoot,
        { fileBytes: 4096, fileCount: 1, totalBytes: 1024 },
        "release:one",
      ),
    ).toThrow(RecoveryBundleError);
  });

  it("rejects a manifest that is not valid UTF-8", () => {
    const artifactRoot = join(root(), "invalid-utf-8");
    mkdirSync(artifactRoot);
    writeFileSync(join(artifactRoot, "manifest.json"), new Uint8Array([0xff, 0xfe]));
    expect(() =>
      verifyArtifactManifest(
        artifactRoot,
        {
          fileBytes: 16,
          fileCount: 1,
          totalBytes: 16,
        },
        "release:one",
      ),
    ).toThrow(RecoveryBundleError);
  });

  it("rejects unknown, altered, missing and extra artifact components", () => {
    writeState();
    const artifacts: readonly [
      string,
      (artifactRoot: string) => void,
      RecoveryBundleError["code"],
    ][] = [
      [
        "manifest",
        (artifactRoot) => {
          writeFileSync(join(artifactRoot, "manifest.json"), "{}");
        },
        "bundle-manifest-invalid",
      ],
      [
        "manifest-format",
        (artifactRoot) => {
          writeFileSync(join(artifactRoot, "manifest.json"), JSON.stringify({ format: "other" }));
        },
        "bundle-manifest-invalid",
      ],
      [
        "manifest-release",
        (artifactRoot) => {
          writeFileSync(
            join(artifactRoot, "manifest.json"),
            JSON.stringify({ release: { id: "release:two", schemaVersion: 1 } }),
          );
        },
        "bundle-manifest-invalid",
      ],
      [
        "manifest-schema",
        (artifactRoot) => {
          writeFileSync(
            join(artifactRoot, "manifest.json"),
            JSON.stringify({ release: { id: "release:one", schemaVersion: 1 }, schemaVersion: 0 }),
          );
        },
        "bundle-manifest-invalid",
      ],
      [
        "manifest-database",
        (artifactRoot) => {
          writeFileSync(
            join(artifactRoot, "manifest.json"),
            JSON.stringify({ release: { id: "release:one", schemaVersion: 1 } }),
          );
        },
        "bundle-manifest-invalid",
      ],
      [
        "manifest-files",
        (artifactRoot) => {
          writeFileSync(
            join(artifactRoot, "manifest.json"),
            JSON.stringify({ release: { id: "release:one", schemaVersion: 1 }, files: [] }),
          );
        },
        "bundle-manifest-invalid",
      ],
      [
        "manifest-file-digest",
        (artifactRoot) => {
          writeFileSync(
            join(artifactRoot, "manifest.json"),
            JSON.stringify({
              release: { id: "release:one", schemaVersion: 1 },
              files: [{ path: "state/configuration.json", sha256: "x", sizeBytes: 12 }],
            }),
          );
        },
        "bundle-manifest-invalid",
      ],
      [
        "manifest-file-size",
        (artifactRoot) => {
          writeFileSync(
            join(artifactRoot, "manifest.json"),
            JSON.stringify({
              release: { id: "release:one", schemaVersion: 1 },
              files: [{ path: "state/configuration.json", sha256: "x".repeat(64), sizeBytes: 13 }],
            }),
          );
        },
        "bundle-manifest-invalid",
      ],
      [
        "manifest-extra-file",
        (artifactRoot) => {
          writeFileSync(
            join(artifactRoot, "manifest.json"),
            JSON.stringify({
              release: { id: "release:one", schemaVersion: 1 },
              files: [
                { path: "state/configuration.json", sha256: "x".repeat(64), sizeBytes: 12 },
                { path: "state/extra.json", sha256: "x".repeat(64), sizeBytes: 1 },
              ],
            }),
          );
        },
        "bundle-manifest-invalid",
      ],
      [
        "manifest-reserved-file",
        (artifactRoot) => {
          writeFileSync(
            join(artifactRoot, "manifest.json"),
            JSON.stringify({
              release: { id: "release:one", schemaVersion: 1 },
              database: { path: "database.sqlite", sha256: "x".repeat(64), sizeBytes: 16 },
              files: [{ path: "database.sqlite", sha256: "x".repeat(64), sizeBytes: 1 }],
            }),
          );
        },
        "bundle-manifest-invalid",
      ],
      [
        "manifest-traversal-file",
        (artifactRoot) => {
          writeFileSync(
            join(artifactRoot, "manifest.json"),
            JSON.stringify({
              release: { id: "release:one", schemaVersion: 1 },
              database: { path: "database.sqlite", sha256: "x".repeat(64), sizeBytes: 16 },
              files: [{ path: "../escape.json", sha256: "x".repeat(64), sizeBytes: 1 }],
            }),
          );
        },
        "bundle-manifest-invalid",
      ],
      [
        "manifest-total",
        (artifactRoot) => {
          writeFileSync(
            join(artifactRoot, "manifest.json"),
            JSON.stringify({
              release: { id: "release:one", schemaVersion: 1 },
              database: { path: "database.sqlite", sha256: "x".repeat(64), sizeBytes: 16 },
              files: [
                { path: "state/configuration.json", sha256: "x".repeat(64), sizeBytes: 2000 },
              ],
            }),
          );
        },
        "bundle-manifest-invalid",
      ],
      [
        "database",
        (artifactRoot) => {
          writeFileSync(join(artifactRoot, "database.sqlite"), "tampered");
        },
        "bundle-database-invalid",
      ],
      [
        "database-missing",
        (artifactRoot) => {
          rmSync(join(artifactRoot, "database.sqlite"));
        },
        "bundle-manifest-invalid",
      ],
      [
        "database-link",
        (artifactRoot) => {
          rmSync(join(artifactRoot, "database.sqlite"));
          symlinkSync("state/configuration.json", join(artifactRoot, "database.sqlite"));
        },
        "bundle-filesystem-invalid",
      ],
      [
        "state-altered",
        (artifactRoot) => {
          writeFileSync(join(artifactRoot, "state/configuration.json"), "Altered\n");
        },
        "bundle-filesystem-invalid",
      ],
      [
        "state-missing",
        (artifactRoot) => {
          rmSync(join(artifactRoot, "state/configuration.json"));
        },
        "bundle-manifest-invalid",
      ],
      [
        "state-extra",
        (artifactRoot) => {
          writeFileSync(join(artifactRoot, "state/extra.json"), "extra");
        },
        "bundle-manifest-invalid",
      ],
      [
        "state-link",
        (artifactRoot) => {
          rmSync(join(artifactRoot, "state/configuration.json"));
          symlinkSync("../database.sqlite", join(artifactRoot, "state/configuration.json"));
        },
        "bundle-filesystem-invalid",
      ],
    ];
    for (const [name, mutate, code] of artifacts) {
      const bundle = createRecoveryBundle(join(root(), `bundle-${name}`), input());
      mutate(bundle.path);
      let thrown: RecoveryBundleError | undefined;
      try {
        restoreRecoveryBundle(
          { destinationRoot: join(root(), `restore-${name}`), path: bundle.path },
          { id: "release:one", schemaVersion: 1 },
          { fileBytes: 64, fileCount: 2, totalBytes: 1024 },
        );
      } catch (error) {
        if (error instanceof RecoveryBundleError) thrown = error;
      }
      expect(thrown).toBeInstanceOf(RecoveryBundleError);
      expect(thrown?.code).toBe(code);
      expect(existsSync(join(root(), `restore-${name}`))).toBe(false);
    }

    const nestedSkippedRoot = join(root(), "nested-skipped-manifest");
    writeRecoveryArtifact(nestedSkippedRoot);
    writeFileSync(join(nestedSkippedRoot, "state/manifest.json"), "{}");
    expectRecoveryError(
      () =>
        verifyArtifactFiles(
          nestedSkippedRoot,
          {
            ...recoveryManifest(),
            files: [
              ...recoveryManifest().files,
              { path: "state/manifest.json", sha256: "0".repeat(64), sizeBytes: 2 },
            ],
          },
          recoveryTestLimits,
        ),
      "bundle-filesystem-invalid",
    );

    const traversalRoot = join(root(), "traversal-entry-bound");
    writeRecoveryArtifact(traversalRoot);
    mkdirSync(join(traversalRoot, "nested/a/b"), { recursive: true });
    expectRecoveryError(
      () => verifyArtifactFiles(traversalRoot, recoveryManifest(), recoveryTestLimits),
      "bundle-manifest-invalid",
    );

    const ownedStaged = join(root(), "owned-publication-staged");
    const existingDestination = join(root(), "existing-publication-destination");
    writeRecoveryArtifact(ownedStaged);
    mkdirSync(existingDestination);
    writeFileSync(join(existingDestination, "sentinel"), "preserve");
    expectRecoveryError(() => {
      publishArtifactDirectory(ownedStaged, existingDestination);
    }, "bundle-destination-invalid");
    expect(existsSync(join(existingDestination, "sentinel"))).toBe(true);
    expect(existsSync(ownedStaged)).toBe(false);

    const invalidParentStaged = join(root(), "invalid-parent-staged");
    const invalidParent = join(root(), "invalid-publication-parent");
    writeFileSync(invalidParent, "bytes");
    mkdirSync(invalidParentStaged);
    expectRecoveryError(() => {
      publishArtifactDirectory(invalidParentStaged, join(invalidParent, "child"));
    }, "bundle-filesystem-invalid");
    expect(existsSync(invalidParentStaged)).toBe(false);
  });
});
