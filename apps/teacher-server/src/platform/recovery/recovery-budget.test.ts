import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SqliteStorageError } from "@marea/sqlite-storage";
import { describe, expect, it, vi } from "vitest";

import { createRecoveryBundle, restoreRecoveryBundle } from "./index.js";
import { lastRestoredBackup } from "./recovery-sqlite-mocks.fixture.js";
import { expectRecoveryError } from "./recovery-assertions.fixture.js";
import { startRecoveryTest } from "./recovery-test-environment.fixture.js";
import { fileBackup, recoveryInput } from "./recovery-test-state.fixture.js";
vi.mock(
  "@marea/sqlite-storage",
  async () => (await import("./recovery-sqlite-mocks.fixture.js")).default,
);

const environment = startRecoveryTest("marea-recovery-budget-");
const root = environment.root;
const writeState = environment.writeState;
const input = () => ({
  ...recoveryInput(root()),
  createExclusive<T>(operation: () => T) {
    return operation();
  },
});

describe("recovery capture and restore budgets", () => {
  it("does not count the database against the state-file budget", () => {
    writeState();
    const largeBytes = new TextEncoder().encode("s".repeat(6000));
    const bundle = createRecoveryBundle(join(root(), "database-over-budget"), {
      ...input(),
      createBackup: fileBackup(largeBytes),
      files: ["state/one"],
      limits: { fileBytes: 16, fileCount: 1, totalBytes: 12 },
    });
    expect(bundle.manifest.database.sizeBytes).toBe(6000);
    const restored = restoreRecoveryBundle(
      { destinationRoot: join(root(), "database-over-budget-restored"), path: bundle.path },
      { id: "release:one", schemaVersion: 1 },
      { fileBytes: 16, fileCount: 1, totalBytes: 12 },
    );
    restored.close();
    expect(
      readFileSync(join(root(), "database-over-budget-restored/database.sqlite")).byteLength,
    ).toBe(6000);
  });

  it("passes bounded verified database bytes and metadata to restore", () => {
    writeState();
    const bundle = createRecoveryBundle(join(root(), "bundle"), input());
    restoreRecoveryBundle(
      { destinationRoot: join(root(), "destination"), path: bundle.path },
      { id: "release:one", schemaVersion: 1 },
      { fileBytes: 64, fileCount: 2, totalBytes: 1024 },
    ).close();
    const restored = lastRestoredBackup();
    expect(new Uint8Array(restored?.bytes ?? [])).toEqual(
      new TextEncoder().encode("synthetic-sqlite"),
    );
    expect(restored?.backupPath).toBe(join(bundle.path, "database.sqlite"));
    expect(restored?.format).toBe("sqlite3");
    expect(restored?.schemaVersion).toBe(1);
    expect(restored?.sha256).toBe(bundle.manifest.database.sha256);
  });

  it("supports declared nested state with the exact technical inventory limit", () => {
    writeState();
    mkdirSync(join(root(), "nested/a/b"), { recursive: true });
    writeFileSync(join(root(), "nested/a/b/state.json"), "Nested state");
    const bundle = createRecoveryBundle(join(root(), "nested-bundle"), {
      ...input(),
      files: ["nested/a/b/state.json"],
      limits: { fileBytes: 64, fileCount: 1, totalBytes: 1024 },
    });
    expect(bundle.manifest.files.map(({ path }) => path)).toEqual(["nested/a/b/state.json"]);
    expect(bundle.manifest.files[0]?.sizeBytes).toBe(12);
    const restored = restoreRecoveryBundle(
      { destinationRoot: join(root(), "nested-destination"), path: bundle.path },
      { id: "release:one", schemaVersion: 1 },
      { fileBytes: 64, fileCount: 1, totalBytes: 1024 },
    );
    try {
      expect(
        readFileSync(join(root(), "nested-destination/nested/a/b/state.json")).toString(),
      ).toBe("Nested state");
    } finally {
      restored.close();
    }
  });

  it("enforces the aggregate capture budget while accumulating required files", () => {
    writeState();
    const overBudgetInput = () => ({
      ...input(),
      files: ["state/configuration.json", "state/snapshot.json"],
      limits: { fileBytes: 4096, fileCount: 2, totalBytes: 24 },
    });
    for (const name of ["over-budget", "callback-over-budget"]) {
      expectRecoveryError(
        () => createRecoveryBundle(join(root(), name), overBudgetInput()),
        "bundle-input-invalid",
      );
      expect(existsSync(join(root(), name))).toBe(false);
    }

    const exact = createRecoveryBundle(join(root(), "exact-budget"), {
      ...input(),
      files: ["state/one"],
      limits: { fileBytes: 4096, fileCount: 1, totalBytes: 11 },
    });
    expect(exact.manifest.files[0]?.sizeBytes).toBe(11);
  });
});

describe("recovery database capture failures", () => {
  it("reports missing disk space with the figures and without a path", () => {
    writeState();
    const failure = new SqliteStorageError(
      "insufficient-disk-space",
      "The SQLite backup needs 900 MiB of free disk space but only 12 MiB is available.",
    );
    expect(() =>
      createRecoveryBundle(join(root(), "no-space"), {
        ...input(),
        createBackup: {
          createBackupFile: () => {
            throw failure;
          },
        },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "bundle-insufficient-space",
        message: failure.message,
      }),
    );
    expect(existsSync(join(root(), "no-space"))).toBe(false);
    expect(readdirSync(root()).filter((entry) => entry.includes(".marea-recovery."))).toEqual([]);
  });

  it("rejects a captured database that cannot be hashed as a regular file", () => {
    writeState();
    expectRecoveryError(
      () =>
        createRecoveryBundle(join(root(), "linked-database"), {
          ...input(),
          createBackup: {
            createBackupFile: (destinationPath) => {
              const result = fileBackup(new TextEncoder().encode("db")).createBackupFile(
                destinationPath,
              );
              linkSync(destinationPath, `${destinationPath}.link`);
              return result;
            },
          },
        }),
      "bundle-database-invalid",
    );
  });

  it("reports any other storage failure as an unusable database", () => {
    writeState();
    expectRecoveryError(
      () =>
        createRecoveryBundle(join(root(), "storage-failure"), {
          ...input(),
          createBackup: {
            createBackupFile: () => {
              throw new SqliteStorageError("backup-failed", "private detail");
            },
          },
        }),
      "bundle-database-invalid",
    );
  });
});
