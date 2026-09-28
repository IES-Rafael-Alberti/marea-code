import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createRecoveryBundle, restoreRecoveryBundle } from "./index.js";
import { lastRestoredBackup } from "./recovery-sqlite-mocks.fixture.js";
import { expectRecoveryError } from "./recovery-assertions.fixture.js";
import { startRecoveryTest } from "./recovery-test-environment.fixture.js";
import { recoveryInput } from "./recovery-test-state.fixture.js";
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
  it("rejects a captured database larger than the total budget", () => {
    writeState();
    const largeBytes = new TextEncoder().encode(`${"s".repeat(6000)}\n`);
    expectRecoveryError(
      () =>
        createRecoveryBundle(join(root(), "database-over-budget"), {
          ...input(),
          createBackup: {
            createBackup: () => ({
              bytes: largeBytes,
              format: "sqlite3",
              schemaVersion: 1,
              sha256: createHash("sha256").update(largeBytes).digest("hex"),
            }),
          },
          files: [],
          limits: { fileBytes: 8192, fileCount: 1, totalBytes: 5_000 },
        }),
      "bundle-input-invalid",
    );
    expect(existsSync(join(root(), "database-over-budget"))).toBe(false);

    const exactBytes = new TextEncoder().encode("s".repeat(5_000));
    const exactDatabase = createRecoveryBundle(join(root(), "database-exact-budget"), {
      ...input(),
      createBackup: {
        createBackup: () => ({
          bytes: exactBytes,
          format: "sqlite3",
          schemaVersion: 1,
          sha256: createHash("sha256").update(exactBytes).digest("hex"),
        }),
      },
      files: [],
      limits: { fileBytes: 8192, fileCount: 1, totalBytes: exactBytes.byteLength },
    });
    expect(exactDatabase.manifest.database.sizeBytes).toBe(5_000);
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
    expect(restored?.bytes).toEqual(new TextEncoder().encode("synthetic-sqlite"));
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
    const bytes = new TextEncoder().encode(`${"s".repeat(4095)}\n`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const overBudgetInput = () => ({
      ...input(),
      createBackup: {
        createBackup: () => ({
          bytes,
          format: "sqlite3" as const,
          schemaVersion: 1,
          sha256,
        }),
      },
      files: ["state/configuration.json", "state/snapshot.json"],
      limits: { fileBytes: 4096, fileCount: 2, totalBytes: bytes.byteLength + 24 },
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
      createBackup: {
        createBackup: () => ({ bytes, format: "sqlite3", schemaVersion: 1, sha256 }),
      },
      files: ["state/one"],
      limits: { fileBytes: 4096, fileCount: 1, totalBytes: bytes.byteLength + 11 },
    });
    expect(exact.manifest.database.sizeBytes).toBe(bytes.byteLength);
    expect(exact.manifest.files[0]?.sizeBytes).toBe(11);
  });
});
