import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("bun:sqlite", () => ({
  Database: class DatabaseMock {
    public readonly mocked = true;
  },
}));

import {
  createDefaultDependencies,
  initializeSqliteStorage,
  initializeSqliteStorageWith,
  restoreSqliteBackup,
  restoreSqliteBackupWith,
  type StorageDependencies,
} from "./storage.js";
import {
  backup,
  appliedMigrations,
  dependencies,
  driverFor,
  expectCode,
  initialMigration,
  MIGRATIONS,
  ReadyDatabase,
} from "../test-support/storage-fakes.js";

describe("SQLite storage lifecycle", () => {
  it("constructs complete release defaults at runtime", () => {
    const defaults = createDefaultDependencies();

    expect(defaults.maxBackupBytes).toBe(268_435_456);
    expect(defaults.migrations).toEqual(MIGRATIONS);
    expect(defaults.backupFiles).toBeDefined();
    expect(defaults.driver).toBeDefined();
    expect(defaults.initializationLock).toBeDefined();
    expect(Object.isFrozen(defaults)).toBe(true);
  });

  it("initializes, exposes an immutable schema, backs up, and closes idempotently", () => {
    const database = new ReadyDatabase();
    const storage = initializeSqliteStorageWith(
      { databasePath: "/tmp/marea.sqlite" },
      dependencies(database),
    );

    const createdBackup = storage.createBackup();
    expect(storage.schema).toEqual({
      migrations: appliedMigrations(),
      version: MIGRATIONS.length,
    });
    expect(createdBackup).toEqual(backup());
    expect(createdBackup.bytes).not.toBe(database.serializedBytes);
    expect(database.executions).toEqual(
      expect.arrayContaining([
        "PRAGMA busy_timeout = 5000",
        "PRAGMA journal_mode = WAL",
        "PRAGMA foreign_keys = ON",
        "PRAGMA synchronous = FULL",
      ]),
    );
    expect(Object.isFrozen(createdBackup)).toBe(true);
    expect(Object.isFrozen(storage.database)).toBe(true);
    storage.close();
    storage.close();
    expect(database.closeCalls).toBe(1);
  });

  it("exposes parameterized application operations and immediate transactions", () => {
    const database = new ReadyDatabase();
    const storage = initializeSqliteStorageWith(
      { databasePath: "/tmp/application.sqlite" },
      dependencies(database),
    );
    const execute = vi.spyOn(database, "execute");
    const readAll = vi.spyOn(database, "readAll");
    const readOne = vi.spyOn(database, "readOne");
    const transaction = vi.spyOn(database, "transactionImmediate");

    storage.database.execute("INSERT INTO feature VALUES (?1)", ["value"]);
    expect(storage.database.readAll("SELECT feature WHERE id = ?1", [3])).toBe(database.applied);
    expect(storage.database.readOne("PRAGMA busy_timeout", [])).toEqual({ timeout: 5000n });
    expect(storage.database.transaction(() => "committed")).toBe("committed");

    expect(execute).toHaveBeenLastCalledWith("INSERT INTO feature VALUES (?1)", ["value"]);
    expect(readAll).toHaveBeenLastCalledWith("SELECT feature WHERE id = ?1", [3]);
    expect(readOne).toHaveBeenLastCalledWith("PRAGMA busy_timeout", []);
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("rejects invalid paths and storage limits before opening a database", () => {
    const invalidPaths = [
      "",
      "relative.sqlite",
      ":memory:",
      "/",
      "/tmp/bad\0name.sqlite",
      `/${"a".repeat(256)}`,
      `/${"a/".repeat(2048)}file.sqlite`,
    ];
    for (const databasePath of invalidPaths) {
      expectCode(
        () => initializeSqliteStorageWith({ databasePath }, dependencies(new ReadyDatabase())),
        "invalid-database-path",
      );
    }
    for (const maxBackupBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expectCode(
        () =>
          initializeSqliteStorageWith(
            { databasePath: "/tmp/marea.sqlite" },
            dependencies(new ReadyDatabase(), { maxBackupBytes }),
          ),
        "storage-configuration-invalid",
      );
    }
    expect(
      initializeSqliteStorageWith(
        { databasePath: "/tmp/marea.sqlite" },
        dependencies(new ReadyDatabase(), { maxBackupBytes: 1 }),
      ).schema.version,
    ).toBe(MIGRATIONS.length);

    const installNew = vi.fn();
    expectCode(
      () =>
        restoreSqliteBackupWith(
          { backup: backup(), databasePath: "/tmp/restored.sqlite" },
          dependencies(new ReadyDatabase(), {
            backupFiles: { installNew },
            maxBackupBytes: 0,
          }),
        ),
      "storage-configuration-invalid",
    );
    expect(installNew).not.toHaveBeenCalled();
  });

  it("maps private initialization failures and still attempts cleanup", () => {
    const database = new ReadyDatabase();
    database.integrity = "corrupt secret";
    database.closeError = true;

    expectCode(
      () =>
        initializeSqliteStorageWith(
          { databasePath: join(tmpdir(), "database.sqlite") },
          dependencies(database),
        ),
      "schema-mismatch",
    );
    expect(database.closeCalls).toBe(1);

    const throwingDriver = driverFor(() => {
      throw new Error("private open detail");
    });
    expectCode(
      () =>
        initializeSqliteStorageWith(
          { databasePath: join(tmpdir(), "database.sqlite") },
          dependencies(new ReadyDatabase(), { driver: throwingDriver }),
        ),
      "database-unavailable",
    );

    const configurationFailure = new ReadyDatabase();
    Object.defineProperty(configurationFailure, "execute", {
      value: () => {
        throw new Error("private configuration detail");
      },
    });
    expectCode(
      () =>
        initializeSqliteStorageWith(
          { databasePath: join(tmpdir(), "database.sqlite") },
          dependencies(configurationFailure),
        ),
      "database-unavailable",
    );
    expect(configurationFailure.closeCalls).toBe(1);
  });

  it("returns safe close, closed-storage, serialization, and backup-limit errors", () => {
    const closeFailure = new ReadyDatabase();
    const closeStorage = initializeSqliteStorageWith(
      { databasePath: "/tmp/close.sqlite" },
      dependencies(closeFailure),
    );
    closeFailure.closeError = true;
    expectCode(
      () => {
        closeStorage.close();
      },
      "database-unavailable",
      "The SQLite database could not be closed cleanly.",
    );

    const closedDatabase = new ReadyDatabase();
    const closedStorage = initializeSqliteStorageWith(
      { databasePath: "/tmp/closed.sqlite" },
      dependencies(closedDatabase),
    );
    closedStorage.close();
    expectCode(() => closedStorage.createBackup(), "storage-closed");
    expectCode(() => {
      closedStorage.database.execute("SELECT 1");
    }, "storage-closed");
    expectCode(() => closedStorage.database.readAll("SELECT 1"), "storage-closed");
    expectCode(() => closedStorage.database.readOne("SELECT 1"), "storage-closed");
    expectCode(() => closedStorage.database.transaction(() => true), "storage-closed");

    const serializationFailure = new ReadyDatabase();
    serializationFailure.serializeError = true;
    const failedBackupStorage = initializeSqliteStorageWith(
      { databasePath: "/tmp/failure.sqlite" },
      dependencies(serializationFailure),
    );
    expectCode(() => failedBackupStorage.createBackup(), "backup-failed");

    const oversized = new ReadyDatabase();
    oversized.serializedBytes = new Uint8Array(9);
    const limitedStorage = initializeSqliteStorageWith(
      { databasePath: "/tmp/large.sqlite" },
      dependencies(oversized),
    );
    expectCode(
      () => limitedStorage.createBackup(),
      "backup-failed",
      "The SQLite backup exceeds the configured size limit.",
    );

    const exactLimit = new ReadyDatabase();
    exactLimit.serializedBytes = new Uint8Array(8);
    const exactLimitStorage = initializeSqliteStorageWith(
      { databasePath: "/tmp/exact.sqlite" },
      dependencies(exactLimit),
    );
    expect(exactLimitStorage.createBackup().bytes).toHaveLength(8);
  });

  it("covers the public wrappers without opening Bun SQLite for invalid input", () => {
    expectCode(
      () => initializeSqliteStorage({ databasePath: "relative" }),
      "invalid-database-path",
    );
    expectCode(
      () => restoreSqliteBackup({ databasePath: "relative", backup: backup() }),
      "invalid-database-path",
    );
  });

  it("rejects malformed schema configuration before database or filesystem access", () => {
    const migration = initialMigration();
    const invalidMigrations = [
      {
        ...migration,
        schemaAfter: migration.schemaAfter.map((entry) => ({ ...entry })),
        statements: [...migration.statements],
      },
    ];
    Object.defineProperty(invalidMigrations[0]?.schemaAfter[0], "type", { value: "virtual" });
    const open = vi.fn(() => new ReadyDatabase());
    const installNew = vi.fn();
    const invalidDependencies: StorageDependencies = {
      backupFiles: { installNew },
      driver: driverFor(open),
      initializationLock: {
        runExclusive<T>(_databasePath: string, operation: () => T): T {
          return operation();
        },
      },
      maxBackupBytes: 8,
      migrations: invalidMigrations,
    };

    expectCode(
      () => initializeSqliteStorageWith({ databasePath: "/tmp/marea.sqlite" }, invalidDependencies),
      "migration-invalid",
    );
    expectCode(
      () =>
        restoreSqliteBackupWith(
          { backup: backup(), databasePath: "/tmp/restored.sqlite" },
          invalidDependencies,
        ),
      "migration-invalid",
    );
    expect(open).not.toHaveBeenCalled();
    expect(installNew).not.toHaveBeenCalled();
  });
});

it("selects the additive profile catalog explicitly without changing legacy defaults", () => {
  const selected = createDefaultDependencies("dashboard-profiles");
  expect(selected.migrations).toHaveLength(10);
  expect(selected.migrations.at(-1)?.name).toBe("create_dashboard_profiles");
  expect(selected.migrations.slice(0, 8)).toEqual(createDefaultDependencies().migrations);
});
