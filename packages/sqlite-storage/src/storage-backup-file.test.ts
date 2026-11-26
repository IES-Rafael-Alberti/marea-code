import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock(
  "./sqlite-driver.boundary.js",
  () => import("../test-support/node-sqlite-driver-mock.fixture.js"),
);

import { SQLITE_BACKUP_FORMAT, SqliteStorageError } from "./contracts.js";
import {
  createDefaultDependencies,
  initializeSqliteStorage,
  initializeSqliteStorageWith,
  restoreSqliteBackupFile,
  restoreSqliteBackupFileWith,
} from "./storage.js";
import {
  appliedMigrations,
  dependencies,
  driverFor,
  expectCode,
  MIGRATIONS,
  ReadyDatabase,
  schemaRow,
} from "../test-support/storage-fakes.js";
import { calculateBackupDigest } from "./backup-parser.boundary.js";

const MEBIBYTE = 1_048_576;

function directory(): string {
  return mkdtempSync(join(tmpdir(), "marea-storage-backup-file-"));
}

describe("SQLite backup to a file", () => {
  it("backs up and restores a real database through files without serializing it", () => {
    const root = directory();
    const storage = initializeSqliteStorage({ databasePath: join(root, "source.sqlite") });
    const serialize = vi.spyOn(storage, "createBackup");

    const backupPath = join(root, "backup.sqlite");
    const created = storage.createBackupFile(backupPath);
    storage.close();

    expect(created).toEqual({ format: SQLITE_BACKUP_FORMAT, schemaVersion: MIGRATIONS.length });
    expect(serialize).not.toHaveBeenCalled();
    expect(existsSync(backupPath)).toBe(true);
    expect(statSync(backupPath).size).toBeGreaterThan(0);

    const restored = restoreSqliteBackupFile({
      backupPath,
      databasePath: join(root, "restored.sqlite"),
      format: created.format,
      schemaVersion: created.schemaVersion,
      sha256: calculateBackupDigest(readFileSync(backupPath)),
    });
    expect(restored.schema.version).toBe(MIGRATIONS.length);
    expect(restored.database.readAll("SELECT version FROM marea_schema_migrations")).toHaveLength(
      MIGRATIONS.length,
    );
    restored.close();
  });

  it("refuses to overwrite an existing backup file", () => {
    const root = directory();
    const storage = initializeSqliteStorage({ databasePath: join(root, "source.sqlite") });
    const backupPath = join(root, "backup.sqlite");
    writeFileSync(backupPath, "occupied");
    expectCode(() => storage.createBackupFile(backupPath), "backup-failed");
    expect(readFileSync(backupPath, "utf8")).toBe("occupied");
    storage.close();
  });

  it("fails before copying when the destination volume is too small", () => {
    const database = new ReadyDatabase();
    database.pageCount = 1000;
    const storage = initializeSqliteStorageWith(
      { databasePath: "/tmp/marea.sqlite" },
      dependencies(database, { diskSpace: { freeBytes: () => 60 * MEBIBYTE } }),
    );
    expectCode(
      () => storage.createBackupFile("/tmp/backups/database.sqlite"),
      "insufficient-disk-space",
      "The SQLite backup needs 68 MiB of free disk space but only 60 MiB is available.",
    );
    expect(database.backups).toEqual([]);
    storage.close();
  });

  it("checks the space of the destination directory and then writes there", () => {
    const database = new ReadyDatabase();
    const freeBytes = vi.fn(() => 1000 * MEBIBYTE);
    const storage = initializeSqliteStorageWith(
      { databasePath: "/tmp/marea.sqlite" },
      dependencies(database, { diskSpace: { freeBytes } }),
    );
    storage.createBackupFile("/tmp/backups/database.sqlite");
    expect(freeBytes).toHaveBeenCalledWith("/tmp/backups");
    expect(database.backups).toEqual(["/tmp/backups/database.sqlite"]);
    storage.close();
  });

  it("maps a failing copy to a generic backup failure and refuses a closed storage", () => {
    const database = new ReadyDatabase();
    database.backupError = true;
    const storage = initializeSqliteStorageWith(
      { databasePath: "/tmp/marea.sqlite" },
      dependencies(database),
    );
    expectCode(() => storage.createBackupFile("/tmp/backups/database.sqlite"), "backup-failed");
    storage.close();
    expectCode(() => storage.createBackupFile("/tmp/backups/database.sqlite"), "storage-closed");
  });

  it("uses the real disk space probe by default", () => {
    expect(createDefaultDependencies().diskSpace.freeBytes(tmpdir())).toBeGreaterThan(0);
  });
});

describe("SQLite backup file restore", () => {
  const sha256 = "a".repeat(64);
  const valid = {
    backupPath: "/tmp/backups/database.sqlite",
    databasePath: "/tmp/restored.sqlite",
    format: SQLITE_BACKUP_FORMAT,
    schemaVersion: 1,
    sha256,
  };

  it.each([
    ["format", { format: "zip" }],
    ["version zero", { schemaVersion: 0 }],
    ["fractional version", { schemaVersion: 1.5 }],
    ["version above the catalog", { schemaVersion: MIGRATIONS.length + 1 }],
    ["short digest", { sha256: "a".repeat(63) }],
    ["upper case digest", { sha256: "A".repeat(64) }],
  ])("rejects an invalid %s before copying anything", (_name, change) => {
    const installFile = vi.fn();
    expectCode(
      () =>
        restoreSqliteBackupFileWith(
          { ...valid, ...change } as typeof valid,
          dependencies(new ReadyDatabase(), { backupFileCopier: { installFile } }),
        ),
      "backup-invalid",
    );
    expect(installFile).not.toHaveBeenCalled();
  });

  it("accepts the lowest and the highest schema version", () => {
    for (const schemaVersion of [1, MIGRATIONS.length]) {
      const installFile = vi.fn();
      restoreSqliteBackupFileWith(
        { ...valid, schemaVersion },
        dependencies(new ReadyDatabase(), { backupFileCopier: { installFile } }),
      ).close();
      expect(installFile).toHaveBeenCalledOnce();
    }
  });

  it("copies the expected digest and maps a failing copy to a restore failure", () => {
    const installFile = vi.fn(() => {
      throw new Error("private filesystem detail");
    });
    expectCode(
      () =>
        restoreSqliteBackupFileWith(
          valid,
          dependencies(new ReadyDatabase(), { backupFileCopier: { installFile } }),
        ),
      "restore-failed",
    );
    expect(installFile).toHaveBeenCalledWith(
      expect.stringMatching(/restored\.sqlite$/u),
      "/tmp/backups/database.sqlite",
      sha256,
      expect.any(Function),
    );
  });

  it("keeps a digest mismatch reported by the copy as an invalid backup", () => {
    const installFile = vi.fn(() => {
      throw new SqliteStorageError("backup-invalid", "The SQLite backup is invalid.");
    });
    expectCode(
      () =>
        restoreSqliteBackupFileWith(
          valid,
          dependencies(new ReadyDatabase(), { backupFileCopier: { installFile } }),
        ),
      "backup-invalid",
    );
  });

  it("verifies the staged file against the declared schema version only", () => {
    const staged = new ReadyDatabase();
    staged.applied = [...appliedMigrations().slice(0, 3)];
    expectCode(
      () =>
        restoreSqliteBackupFileWith(
          { ...valid, schemaVersion: 2 },
          dependencies(staged, { driver: driverFor(() => staged) }),
        ),
      "backup-invalid",
    );
  });

  it("maps a storage error of another class to a restore failure", () => {
    const installFile = vi.fn(() => {
      throw new SqliteStorageError("schema-mismatch", "private classification");
    });
    expectCode(
      () =>
        restoreSqliteBackupFileWith(
          valid,
          dependencies(new ReadyDatabase(), { backupFileCopier: { installFile } }),
        ),
      "restore-failed",
    );
  });

  it("accepts a staged file that matches exactly the declared older version", () => {
    const staged = new ReadyDatabase();
    staged.applied = [...appliedMigrations().slice(0, 2)];
    staged.schema = (MIGRATIONS[1]?.schemaAfter ?? []).map(schemaRow);
    staged.userVersion = 2;
    const restored = new ReadyDatabase();
    const storage = restoreSqliteBackupFileWith(
      { ...valid, schemaVersion: 2 },
      dependencies(restored, {
        driver: driverFor((path) => (path === "/tmp/staged.sqlite" ? staged : restored)),
      }),
    );
    expect(storage.schema.version).toBe(MIGRATIONS.length);
    expect(staged.closeCalls).toBe(1);
  });
});
