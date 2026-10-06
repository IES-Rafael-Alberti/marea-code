import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SqliteBackup } from "@marea/sqlite-storage";
import {
  RECOVERY_BUNDLE_FORMAT,
  RECOVERY_BUNDLE_SCHEMA_VERSION,
  type RecoveryBundle,
  type RecoveryBundleInput,
  RecoveryBundleError,
  createRecoveryBundle,
  restoreRecoveryBundle,
} from "./index.js";
import { ensureRecoveryError } from "./contracts.js";
import { lastReopenPath, sqliteCloseCount } from "./recovery-sqlite-mocks.fixture.js";
import { recoveryInput } from "./recovery-test-state.fixture.js";
import { expectRecoveryError } from "./recovery-assertions.fixture.js";
import { startRecoveryTest } from "./recovery-test-environment.fixture.js";
vi.mock(
  "@marea/sqlite-storage",
  async () => (await import("./recovery-sqlite-mocks.fixture.js")).default,
);

const environment = startRecoveryTest("marea-recovery-");
const root = environment.root;
const writeState = environment.writeState;

const exclusive = { calls: 0 as number, open: false as boolean, fail: false as boolean };

function maintenance<T>(operation: () => T): T {
  expect(exclusive.open).toBe(false);
  exclusive.open = true;
  exclusive.calls += 1;
  try {
    if (exclusive.fail) throw new Error("maintenance failed");
    return operation();
  } finally {
    exclusive.open = false;
  }
}

function resetMaintenance(): void {
  exclusive.calls = 0;
  exclusive.open = false;
  exclusive.fail = false;
}

const input = () => ({ ...recoveryInput(root()), createExclusive: maintenance });

function expectBundle(bundle: RecoveryBundle): void {
  expect(bundle.path).toBe(join(root(), "bundle"));
  expect(bundle.manifest).toEqual({
    database: {
      path: "database.sqlite",
      sha256: expect.any(String) as string,
      sizeBytes: expect.any(Number) as number,
      format: "sqlite3",
      schemaVersion: 1,
    },
    files: [
      { path: "state/configuration.json", sha256: expect.any(String) as string, sizeBytes: 11 },
      { path: "state/snapshot.json", sha256: expect.any(String) as string, sizeBytes: 14 },
    ],
    format: RECOVERY_BUNDLE_FORMAT,
    release: { id: "release:one", schemaVersion: 1 },
    schemaVersion: RECOVERY_BUNDLE_SCHEMA_VERSION,
  });
  expect(readFileSync(join(bundle.path, "manifest.json")).toString()).toContain(
    "state/configuration.json",
  );
  expect(readFileSync(join(bundle.path, "database.sqlite")).toString()).toBe("synthetic-sqlite");
}

function restoreAndRead(
  bundle: RecoveryBundle,
  release: { readonly id: string; readonly schemaVersion: number } = {
    id: "release:one",
    schemaVersion: 1,
  },
): void {
  const restored = restoreRecoveryBundle(
    { destinationRoot: join(root(), "destination"), path: bundle.path },
    release,
    { fileBytes: 64, fileCount: 2, totalBytes: 1024 },
  );
  try {
    expect(lastReopenPath()).toBe(join(root(), "destination", "database.sqlite"));
    expect(restored.schema.version).toBe(1);
    expect(statSync(join(root(), "destination")).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(root(), "destination/state/configuration.json")).toString()).toBe(
      "Class state",
    );
    expect(readFileSync(join(root(), "destination/state/snapshot.json")).toString()).toBe(
      "Snapshot state",
    );
  } finally {
    restored.close();
  }
  expect(existsSync(join(root(), "destination"))).toBe(true);
  expect(existsSync(join(root(), "destination", "state"))).toBe(true);
}

describe("recovery bundle service", () => {
  beforeEach(resetMaintenance);

  it("reserves a private staging directory before entering maintenance", () => {
    writeState();
    createRecoveryBundle(join(root(), "staged-before-lock"), {
      ...input(),
      createExclusive: (operation) => {
        const staging = readdirSync(root()).filter((name) => name.endsWith(".staging"));
        expect(staging).toHaveLength(1);
        const staged = join(root(), String(staging[0]));
        expect(statSync(staged).isDirectory()).toBe(true);
        expect(statSync(staged).mode & 0o777).toBe(0o700);
        return maintenance(operation);
      },
    });
    expect(exclusive.calls).toBe(1);
    expect(readdirSync(root()).filter((name) => name.endsWith(".staging"))).toEqual([]);
  });

  it("rejects an occupied destination before taking the maintenance lock or capturing data", () => {
    writeState();
    const destination = join(root(), "already-present");
    mkdirSync(destination);
    expectRecoveryError(() => {
      createRecoveryBundle(destination, input());
    }, "bundle-destination-invalid");
    expect(exclusive.calls).toBe(0);
    expect(readdirSync(destination)).toEqual([]);
  });

  it("preserves recovery errors and maps unknown failures", () => {
    const recovery = new RecoveryBundleError("bundle-input-invalid", "known");
    expect(ensureRecoveryError(recovery, "bundle-restore-failed", "mapped")).toBe(recovery);
    expect(
      ensureRecoveryError(new Error("unknown"), "bundle-restore-failed", "mapped"),
    ).toMatchObject({
      code: "bundle-restore-failed",
      message: "mapped",
    });
  });

  it("creates and restores a complete artifact under exclusive maintenance", () => {
    writeState();
    const closeCountBefore = sqliteCloseCount();
    const bundle = createRecoveryBundle(join(root(), "bundle"), input());
    expectBundle(bundle);
    expect(exclusive.calls).toBe(1);
    expect(sqliteCloseCount()).toBe(closeCountBefore);
    expect(statSync(bundle.path).mode & 0o777).toBe(0o700);
    const restoreCloseBefore = sqliteCloseCount();
    restoreAndRead(bundle);
    expect(sqliteCloseCount()).toBe(restoreCloseBefore + 2);
  });

  it("invokes the injected backup capability only inside maintenance", () => {
    writeState();
    const calls: string[] = [];
    const backupInput = input();
    createRecoveryBundle(join(root(), "ordered"), {
      ...backupInput,
      createBackup: {
        createBackup: () => {
          calls.push("backup");
          return backupInput.createBackup.createBackup();
        },
      },
      createExclusive: (operation) => {
        calls.push("exclusive");
        return operation();
      },
    });
    expect(calls).toEqual(["exclusive", "backup"]);
  });

  it("accepts an empty state file and preserves a destination created during capture", () => {
    writeState();
    writeFileSync(join(root(), "state/empty"), "");
    const empty = createRecoveryBundle(join(root(), "empty-state"), {
      ...input(),
      files: ["state/empty"],
    });
    expect(empty.manifest.files[0]?.sizeBytes).toBe(0);

    const destination = join(root(), "created-during-capture");
    const captureInput = input();
    expectRecoveryError(
      () =>
        createRecoveryBundle(destination, {
          ...captureInput,
          createBackup: {
            createBackup: () => {
              const backup = captureInput.createBackup.createBackup();
              mkdirSync(destination, { recursive: true });
              writeFileSync(join(destination, "sentinel"), "untouched");
              return backup;
            },
          },
        }),
      "bundle-destination-invalid",
    );
    expect(readFileSync(join(destination, "sentinel")).toString()).toBe("untouched");
    expect(readdirSync(root()).filter((entry) => entry.includes(".marea-recovery."))).toEqual([]);
  });

  it("passes captured old-schema metadata to restore and migrates it", () => {
    writeState();
    const bytes = new TextEncoder().encode("synthetic-sqlite");
    const legacy = createRecoveryBundle(join(root(), "legacy"), {
      ...input(),
      createBackup: {
        createBackup: () => ({
          bytes,
          format: "sqlite3",
          schemaVersion: 2,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      },
      release: { id: "release:legacy", schemaVersion: 2 },
    });
    expect(legacy.manifest.database.schemaVersion).toBe(2);
    const restored = restoreRecoveryBundle(
      { destinationRoot: join(root(), "legacy-destination"), path: legacy.path },
      { id: "release:legacy", schemaVersion: 2 },
      { fileBytes: 64, fileCount: 2, totalBytes: 1024 },
    );
    try {
      expect(restored.schema.version).toBe(6);
    } finally {
      restored.close();
    }
  });

  it("rejects invalid input before opening the database or staging the artifact", () => {
    writeState();
    const cases: readonly RecoveryBundleInput[] = [
      { ...input(), release: { id: "", schemaVersion: 1 } },
      { ...input(), release: { id: "release:one", schemaVersion: 0 } },
      { ...input(), createBackup: undefined as unknown as RecoveryBundleInput["createBackup"] },
      { ...input(), limits: { ...input().limits, fileBytes: 0 } },
      { ...input(), limits: { ...input().limits, fileCount: 1.5 } },
      { ...input(), sourceRoot: "relative" },
      { ...input(), files: ["database.sqlite"] },
      { ...input(), files: ["manifest.json"] },
      { ...input(), files: ["state/one.json", "state/one.json"] },
      { ...input(), files: ["/absolute"] },
      { ...input(), files: ["../escape"] },
      { ...input(), files: ["state/./one.json"] },
      { ...input(), files: ["state\\one.json"] },
      { ...input(), files: ["state/one.json\0"] },
      { ...input(), files: ["state/one.json/"] },
      { ...input(), files: ["one.json", "two.json", "three.json"] },
    ];
    for (const [index, testInput] of cases.entries()) {
      const artifactPath = join(root(), `bundle-${String(index)}`);
      expectRecoveryError(
        () => createRecoveryBundle(artifactPath, testInput),
        "bundle-input-invalid",
      );
      expect(existsSync(artifactPath)).toBe(false);
    }
    expect(exclusive.calls).toBe(0);
    expectRecoveryError(
      () =>
        createRecoveryBundle(join(root(), "bundle-database"), {
          ...input(),
          createBackup: {
            createBackup: () => {
              throw new Error("database unavailable");
            },
          },
        }),
      "bundle-database-invalid",
    );
    expect(existsSync(join(root(), "bundle-database"))).toBe(false);
    expect(exclusive.calls).toBe(1);
    expectRecoveryError(
      () =>
        createRecoveryBundle(join(root(), "bundle-no-callback"), {
          ...input(),
          createExclusive: undefined as unknown as RecoveryBundleInput["createExclusive"],
        }),
      "bundle-input-invalid",
    );
  });

  it("accepts exact technical limits and rejects one-safe-integer-invalid limits", () => {
    writeState();
    const exact = createRecoveryBundle(join(root(), "exact-limits"), {
      ...input(),
      files: ["state/one"],
      limits: { fileBytes: 16, fileCount: 1, totalBytes: 1024 },
    });
    expect(exact.manifest.files[0]?.sizeBytes).toBe(11);
    expectRecoveryError(
      () =>
        createRecoveryBundle(join(root(), "invalid-limits"), {
          ...input(),
          files: ["state/one"],
          limits: { fileBytes: 64, fileCount: 1.5, totalBytes: 1024 },
        }),
      "bundle-input-invalid",
    );
  });

  it("sorts the required file inventory in the manifest", () => {
    writeState();
    const bundle = createRecoveryBundle(join(root(), "sorted"), {
      ...input(),
      files: ["state/snapshot.json", "state/configuration.json"],
    });
    expect(bundle.manifest.files.map(({ path }) => path)).toEqual([
      "state/configuration.json",
      "state/snapshot.json",
    ]);
  });

  it("rejects a destination that already exists", () => {
    writeState();
    mkdirSync(join(root(), "existing"));
    expectRecoveryError(
      () => createRecoveryBundle(join(root(), "existing"), input()),
      "bundle-destination-invalid",
    );
    expect(existsSync(join(root(), "existing"))).toBe(true);
    expect(exclusive.calls).toBe(0);
  });

  it("reports unavailable databases without claiming success", () => {
    const closeCountBefore = sqliteCloseCount();
    expectRecoveryError(
      () => createRecoveryBundle(join(root(), "bundle"), input()),
      "bundle-database-invalid",
    );
    expect(exclusive.calls).toBe(1);
    expect(sqliteCloseCount()).toBe(closeCountBefore);
    expect(existsSync(join(root(), "bundle"))).toBe(false);
  });

  it("reports a database that cannot be captured", () => {
    const closeCountBefore = sqliteCloseCount();
    writeFileSync(join(root(), "backup-failure"), "database");
    expectRecoveryError(
      () =>
        createRecoveryBundle(join(root(), "bundle"), {
          ...input(),
          createBackup: {
            createBackup: () => {
              throw new Error("backup failed");
            },
          },
        }),
      "bundle-database-invalid",
    );
    expect(sqliteCloseCount()).toBe(closeCountBefore);
    expect(existsSync(join(root(), "bundle"))).toBe(false);
  });

  it("verifies staged files after the capture callback returns them", () => {
    writeState();
    expectRecoveryError(
      () =>
        createRecoveryBundle(join(root(), "bundle"), {
          ...input(),
          createExclusive: (operation) => {
            operation();
            const staged = readdirSync(root()).find((entry) => entry.includes(".marea-recovery."));
            if (staged === undefined) {
              throw new Error("staging missing");
            }
            writeFileSync(join(root(), staged, "state/config.json"), "corrupted");
            return undefined as never;
          },
        }),
      "bundle-manifest-invalid",
    );
    expect(existsSync(join(root(), "bundle"))).toBe(false);
  });

  it("rejects inconsistent captured backup metadata", () => {
    writeState();
    const cases = [
      { format: "not-sqlite" },
      { schemaVersion: 2 },
      { sha256: "0".repeat(64) },
    ] as const;
    for (const [index, change] of cases.entries()) {
      const bytes = new TextEncoder().encode("synthetic-sqlite");
      const backup = {
        bytes,
        format: "sqlite3" as const,
        schemaVersion: 1,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ...change,
      } as unknown as SqliteBackup;
      expectRecoveryError(
        () =>
          createRecoveryBundle(join(root(), `invalid-backup-${String(index)}`), {
            ...input(),
            createBackup: { createBackup: () => backup },
          }),
        "bundle-database-invalid",
      );
      expect(existsSync(join(root(), `invalid-backup-${String(index)}`))).toBe(false);
    }
  });

  it("rejects a callback that does not capture the manifest", () => {
    writeState();
    expectRecoveryError(
      () =>
        createRecoveryBundle(join(root(), "bundle"), {
          ...input(),
          createExclusive: (() => undefined) as RecoveryBundleInput["createExclusive"],
        }),
      "bundle-maintenance-failed",
    );
    expect(existsSync(join(root(), "bundle"))).toBe(false);
  });

  it("reports missing, oversized, non-regular and linked state files", () => {
    writeState();
    const cases = [
      () => {
        rmSync(join(root(), "state/configuration.json"));
      },
      () => {
        writeFileSync(join(root(), "state/configuration.json"), "x".repeat(65));
      },
      () => {
        rmSync(join(root(), "state/configuration.json"));
        symlinkSync("../outside", join(root(), "state/configuration.json"));
      },
      () => {
        writeFileSync(join(root(), "configuration.json"), "x");
        rmSync(join(root(), "state/configuration.json"));
        symlinkSync("../configuration.json", join(root(), "state/configuration.json"));
      },
      () => {
        rmSync(join(root(), "state/configuration.json"));
        mkdirSync(join(root(), "state/configuration.json"));
      },
      () => {
        rmSync(join(root(), "state"), { recursive: true });
      },
    ] as readonly (() => void)[];
    cases.forEach((prepare, index) => {
      rmSync(join(root(), "state"), { force: true, recursive: true });
      writeState();
      prepare();
      const artifactPath = join(root(), `bundle-${String(index)}`);
      expectRecoveryError(
        () => createRecoveryBundle(artifactPath, input()),
        "bundle-filesystem-invalid",
      );
      expect(existsSync(artifactPath)).toBe(false);
      const stagedArtifacts = readdirSync(root()).filter((entry) =>
        entry.includes(".marea-recovery."),
      );
      expect(stagedArtifacts).toEqual([]);
    });
    expect(exclusive.calls).toBe(6);
  });

  it("removes staging after a post-capture maintenance failure", () => {
    writeState();
    expectRecoveryError(
      () =>
        createRecoveryBundle(join(root(), "bundle"), {
          ...input(),
          createExclusive: (operation) => {
            operation();
            throw new Error("post-capture failure");
          },
        }),
      "bundle-maintenance-failed",
    );
    expect(existsSync(join(root(), "bundle"))).toBe(false);
    expect(readdirSync(root()).filter((entry) => entry.includes(".marea-recovery."))).toEqual([]);
  });

  it("propagates maintenance failure and leaves the destination absent", () => {
    writeState();
    exclusive.fail = true;
    expectRecoveryError(
      () => createRecoveryBundle(join(root(), "bundle"), input()),
      "bundle-maintenance-failed",
    );
    expect(exclusive.open).toBe(false);
    expect(readdirSync(root()).filter((entry) => entry.includes(".marea-recovery."))).toEqual([]);
    expect(existsSync(join(root(), "bundle"))).toBe(false);
  });
});
