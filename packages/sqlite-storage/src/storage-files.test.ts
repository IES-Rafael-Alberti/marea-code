import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("./sqlite-driver.boundary.js", async (importOriginal) =>
  process.versions.bun
    ? await importOriginal()
    : {
        bunSqliteDriver: (await import("../test-support/node-sqlite-driver.fixture.js"))
          .nodeSqliteDriver,
      },
);

import { createAuditMigrationCatalog } from "./audit-migration-catalog.js";
import { createEducationalMigrationCatalog } from "./educational-migration-catalog.js";
import { createStudentIdentityMigrationCatalog } from "./student-identity-migration-catalog.js";
import { SqliteStorageError, type SqliteApplicationDatabase } from "./contracts.js";
import { createMigrationCatalog } from "./migration-catalog.js";
import {
  createDefaultDependencies,
  initializeSqliteStorage,
  openSqliteDatabaseFile,
  restoreSqliteBackup,
} from "./storage.js";

function directory(): string {
  return mkdtempSync(join(tmpdir(), "marea-storage-files-"));
}

function tables(database: SqliteApplicationDatabase) {
  return database
    .readAll("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .map((row) => row.name);
}

describe("SQLite storage files", () => {
  it("selects the retention audit catalog only when requested", () => {
    expect(createDefaultDependencies().migrations).toEqual(createMigrationCatalog());
    expect(createDefaultDependencies("application").migrations).toEqual(createMigrationCatalog());
    expect(createDefaultDependencies("retention-audit").migrations).toEqual(
      createAuditMigrationCatalog(),
    );
    expect(createDefaultDependencies("student-identities").migrations).toEqual(
      createStudentIdentityMigrationCatalog(),
    );
    expect(createDefaultDependencies("educational-insights").migrations).toEqual(
      createEducationalMigrationCatalog(),
    );
  });

  it("opens, reopens and restores activated installations with the retention audit catalog", () => {
    const root = directory();
    const databasePath = join(root, "application.sqlite");
    const activated = initializeSqliteStorage({ databasePath, schema: "retention-audit" });
    expect(activated.schema.version).toBe(createAuditMigrationCatalog().length);
    expect(tables(activated.database)).toContain("marea_retention_operations");
    const backup = activated.createBackup();
    activated.close();

    expect(() => initializeSqliteStorage({ databasePath })).toThrow(SqliteStorageError);
    const reopened = initializeSqliteStorage({ databasePath, schema: "retention-audit" });
    expect(reopened.schema.version).toBe(backup.schemaVersion);
    reopened.close();

    expect(() =>
      restoreSqliteBackup({ databasePath: join(root, "rejected.sqlite"), backup }),
    ).toThrow(SqliteStorageError);
    const restored = restoreSqliteBackup({
      databasePath: join(root, "restored.sqlite"),
      backup,
      schema: "retention-audit",
    });
    expect(restored.schema.version).toBe(backup.schemaVersion);
    restored.close();

    const application = initializeSqliteStorage({ databasePath: join(root, "plain.sqlite") });
    expect(application.schema.version).toBe(createMigrationCatalog().length);
    expect(tables(application.database)).not.toContain("marea_retention_operations");
    application.close();
  });

  it("opens an unmigrated file with durable settings for a deletion index", () => {
    const root = directory();
    const file = openSqliteDatabaseFile({ databasePath: join(root, "deletion-index.sqlite") });
    expect(tables(file.database)).toEqual([]);
    expect(file.database.readOne("PRAGMA journal_mode")).toEqual({ journal_mode: "wal" });
    expect(Number(file.database.readOne("PRAGMA foreign_keys")?.foreign_keys)).toBe(1);
    file.database.transaction(() => {
      file.database.execute("CREATE TABLE index_state (value TEXT NOT NULL)");
      file.database.execute("INSERT INTO index_state VALUES (?1)", ["active"]);
    });
    expect(file.database.readAll("SELECT value FROM index_state")).toEqual([{ value: "active" }]);
    file.close();
    file.close();
    expect(() => file.database.readAll("SELECT 1")).toThrow(
      expect.objectContaining({ code: "storage-closed" }),
    );
    const reopened = openSqliteDatabaseFile({ databasePath: join(root, "deletion-index.sqlite") });
    expect(tables(reopened.database)).toEqual(["index_state"]);
    reopened.close();
    expect(() => openSqliteDatabaseFile({ databasePath: "relative" })).toThrow(
      expect.objectContaining({ code: "invalid-database-path" }),
    );
  });
});
