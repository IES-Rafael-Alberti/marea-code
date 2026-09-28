import { describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => ({
  Database: class DatabaseMock {
    public readonly mocked = true;
  },
}));

import type { SqliteBackup } from "./contracts.js";
import { SqliteStorageError } from "./contracts.js";
import type { BackupFilePort } from "./database-port.js";
import { restoreSqliteBackupWith } from "./storage.js";
import {
  backup,
  appliedMigrations,
  dependencies,
  driverFor,
  expectCode,
  MIGRATIONS,
  ReadyDatabase,
  schemaRow,
} from "../test-support/storage-fakes.js";

function stagedDatabase(version: number): ReadyDatabase {
  const migration = MIGRATIONS[version - 1];
  if (migration === undefined) throw new Error("Missing fixture migration.");
  const staged = new ReadyDatabase();
  staged.applied = [...appliedMigrations().slice(0, version)];
  staged.schema = migration.schemaAfter.map(schemaRow);
  staged.userVersion = version;
  return staged;
}

describe("SQLite backup restore", () => {
  it("validates the staged SQLite file before installation and reopens the destination", () => {
    const staged = stagedDatabase(MIGRATIONS.length);
    const restored = new ReadyDatabase();
    const open = vi.fn((databasePath: string) =>
      databasePath === "/tmp/staged.sqlite" ? staged : restored,
    );
    const installNew = vi.fn(
      (_databasePath: string, _bytes: Uint8Array, validate: (path: string) => void) => {
        validate("/tmp/staged.sqlite");
      },
    );

    const artifact = backup();
    const storage = restoreSqliteBackupWith(
      { backup: artifact, databasePath: "/tmp/restored.sqlite" },
      dependencies(restored, { backupFiles: { installNew }, driver: driverFor(open) }),
    );

    expect(storage.schema.version).toBe(MIGRATIONS.length);
    const openedPaths = open.mock.calls.map(([path]) => path);
    expect(openedPaths[0]).toBe("/tmp/staged.sqlite");
    expect(openedPaths[1]).toMatch(/\/restored\.sqlite$/u);
    expect(staged.closeCalls).toBe(1);
    expect(installNew.mock.calls[0]?.[1]).not.toBe(artifact.bytes);
  });

  it.each([1, 2, 3, 4, 5, 6])(
    "verifies a version %s backup before restoring and migrating it",
    (schemaVersion) => {
      const staged = stagedDatabase(schemaVersion);
      const restored = new ReadyDatabase();
      const storage = restoreSqliteBackupWith(
        { backup: { ...backup(), schemaVersion }, databasePath: "/tmp/recovered.sqlite" },
        dependencies(restored, {
          driver: driverFor((path) => (path === "/tmp/staged.sqlite" ? staged : restored)),
        }),
      );
      expect(storage.schema.version).toBe(MIGRATIONS.length);
      expect(staged.userVersion).toBe(schemaVersion);
      expect(staged.closeCalls).toBe(1);
    },
  );

  it("rejects a backup whose declared old version disagrees with its SQLite contents", () => {
    const staged = stagedDatabase(3);
    expectCode(
      () =>
        restoreSqliteBackupWith(
          { backup: { ...backup(), schemaVersion: 2 }, databasePath: "/tmp/recovered.sqlite" },
          dependencies(staged),
        ),
      "backup-invalid",
    );
  });

  it("rejects altered backup metadata, bytes, format, size, and digest", () => {
    const changes: readonly ((candidate: SqliteBackup) => void)[] = [
      (candidate) => Object.defineProperty(candidate, "format", { value: "zip" }),
      (candidate) => Object.defineProperty(candidate, "bytes", { value: {} }),
      (candidate) =>
        Object.defineProperty(candidate, "schemaVersion", { value: MIGRATIONS.length + 1 }),
      (candidate) => Object.defineProperty(candidate, "bytes", { value: new Uint8Array(9) }),
      (candidate) => Object.defineProperty(candidate, "sha256", { value: "A".repeat(64) }),
      (candidate) => Object.defineProperty(candidate, "sha256", { value: "0".repeat(64) }),
    ];

    for (const change of changes) {
      const candidate = backup();
      change(candidate);
      const installNew = vi.fn();
      expectCode(
        () =>
          restoreSqliteBackupWith(
            { backup: candidate, databasePath: "/tmp/restored.sqlite" },
            dependencies(new ReadyDatabase(), { backupFiles: { installNew } }),
          ),
        "backup-invalid",
      );
      expect(installNew).not.toHaveBeenCalled();
    }

    for (const malformedBackup of [null, [], "backup"]) {
      const options = { backup: backup(), databasePath: "/tmp/restored.sqlite" };
      Object.defineProperty(options, "backup", { value: malformedBackup });
      const installNew = vi.fn();
      expectCode(
        () =>
          restoreSqliteBackupWith(
            options,
            dependencies(new ReadyDatabase(), { backupFiles: { installNew } }),
          ),
        "backup-invalid",
      );
      expect(installNew).not.toHaveBeenCalled();
    }
  });

  it("accepts a backup exactly at the configured byte limit", () => {
    const bytes = new Uint8Array(8);
    const storage = restoreSqliteBackupWith(
      { backup: backup(bytes), databasePath: "/tmp/restored.sqlite" },
      dependencies(new ReadyDatabase(), { backupFiles: { installNew: vi.fn() } }),
    );

    expect(storage.schema.version).toBe(MIGRATIONS.length);
    storage.close();
  });

  it("maps invalid staged SQLite and filesystem failures without leaking details", () => {
    const invalidStaged = new ReadyDatabase();
    invalidStaged.integrity = "private corruption detail";
    invalidStaged.closeError = true;
    expectCode(
      () =>
        restoreSqliteBackupWith(
          { backup: backup(), databasePath: "/tmp/restored.sqlite" },
          dependencies(invalidStaged),
        ),
      "backup-invalid",
    );
    expect(invalidStaged.closeCalls).toBe(1);

    const throwingDriver = driverFor(() => {
      throw new Error("private SQLite detail");
    });
    expectCode(
      () =>
        restoreSqliteBackupWith(
          { backup: backup(), databasePath: "/tmp/restored.sqlite" },
          dependencies(new ReadyDatabase(), { driver: throwingDriver }),
        ),
      "backup-invalid",
    );

    const failedFiles: BackupFilePort = {
      installNew(): void {
        throw new Error("private filesystem detail");
      },
    };
    expectCode(
      () =>
        restoreSqliteBackupWith(
          { backup: backup(), databasePath: "/tmp/restored.sqlite" },
          dependencies(new ReadyDatabase(), { backupFiles: failedFiles }),
        ),
      "restore-failed",
    );
  });

  it("preserves only a boundary-classified invalid backup error", () => {
    const invalidFiles: BackupFilePort = {
      installNew(): void {
        throw new SqliteStorageError("backup-invalid", "The SQLite backup is invalid.");
      },
    };
    expectCode(
      () =>
        restoreSqliteBackupWith(
          { backup: backup(), databasePath: "/tmp/restored.sqlite" },
          dependencies(new ReadyDatabase(), { backupFiles: invalidFiles }),
        ),
      "backup-invalid",
    );

    const otherFiles: BackupFilePort = {
      installNew(): void {
        throw new SqliteStorageError("schema-mismatch", "private classification");
      },
    };
    expectCode(
      () =>
        restoreSqliteBackupWith(
          { backup: backup(), databasePath: "/tmp/restored.sqlite" },
          dependencies(new ReadyDatabase(), { backupFiles: otherFiles }),
        ),
      "restore-failed",
    );
  });
});
