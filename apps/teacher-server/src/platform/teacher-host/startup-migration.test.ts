import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));

import {
  createSkillAssignmentMigrationCatalog,
  currentSqliteSchema,
  initializeSqliteStorage,
  inspectSqliteSchemaVersion,
  openSqliteDatabaseFile,
  type SqliteSchemaCatalog,
} from "@marea/sqlite-storage";

import { RecoveryBundleError } from "../recovery/contracts.js";
import { HostOperationError } from "../operations/host/contracts.js";
import { migrateSchemaOnStartup, type StartupMigrationEvent } from "./startup-migration.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function database(schema: SqliteSchemaCatalog): string {
  const root = mkdtempSync(join(tmpdir(), "marea-startup-migration-"));
  roots.push(root);
  const databasePath = join(root, "marea.sqlite");
  initializeSqliteStorage({ databasePath, schema }).close();
  return databasePath;
}

function harness(databasePath: string, backup = () => Promise.resolve("/backups/startup")) {
  const events: StartupMigrationEvent[] = [];
  const backupSpy = vi.fn(backup);
  return {
    events,
    backup: backupSpy,
    run: (migrate?: (path: string, catalog: SqliteSchemaCatalog) => void) =>
      migrateSchemaOnStartup({
        databasePath,
        backup: backupSpy,
        report: (event) => events.push(event),
        ...(migrate === undefined ? {} : { migrate }),
      }),
  };
}

const previous = createSkillAssignmentMigrationCatalog().length;

describe("startup schema migration", () => {
  it("backs up and migrates an older activated schema to the current one", async () => {
    const path = database("skill-assignments");
    const subject = harness(path);
    const current = currentSqliteSchema().version;
    await expect(subject.run()).resolves.toBe(current);
    expect(subject.backup).toHaveBeenCalledOnce();
    expect(inspectSqliteSchemaVersion({ databasePath: path })).toBe(current);
    expect(subject.events).toEqual([
      {
        event: "schema-migration",
        outcome: "migrated",
        detectedSchema: previous,
        finalSchema: current,
        backupPath: "/backups/startup",
      },
    ]);
  });

  it("does nothing on a database already at the current schema", async () => {
    const path = database(currentSqliteSchema().catalog);
    const before = readFileSync(path);
    const subject = harness(path);
    await expect(subject.run()).resolves.toBe(currentSqliteSchema().version);
    expect(subject.backup).not.toHaveBeenCalled();
    expect(subject.events).toEqual([]);
    expect(readFileSync(path)).toEqual(before);
  });

  it("leaves installations before dashboard profiles to their offline upgrade", async () => {
    const path = database("retention-audit");
    const subject = harness(path);
    await expect(subject.run()).resolves.toBe(9);
    expect(subject.backup).not.toHaveBeenCalled();
    expect(subject.events).toEqual([]);
  });

  it("does not migrate and refuses to start when the backup fails", async () => {
    const path = database("skill-assignments");
    const subject = harness(path, () => Promise.reject(new TypeError("disk full")));
    const migrate = vi.fn();
    const failure = await subject.run(migrate).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HostOperationError);
    expect(failure).toMatchObject({
      code: "not-ready",
      message: "the pre-migration backup could not be created",
    });
    expect(migrate).not.toHaveBeenCalled();
    expect(inspectSqliteSchemaVersion({ databasePath: path })).toBe(previous);
    expect(subject.events).toEqual([
      {
        event: "schema-migration",
        outcome: "backup-failed",
        detectedSchema: previous,
        targetSchema: currentSqliteSchema().version,
        error: "TypeError: disk full",
      },
    ]);
  });

  it("tells the teacher how much free disk space the pre-migration backup needs", async () => {
    const path = database("skill-assignments");
    const detail =
      "The SQLite backup needs 900 MiB of free disk space but only 12 MiB is available.";
    const subject = harness(path, () =>
      Promise.reject(new RecoveryBundleError("bundle-insufficient-space", detail)),
    );
    const migrate = vi.fn();
    const failure = await subject.run(migrate).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "not-ready",
      message: `the pre-migration backup needs more free disk space: ${detail}`,
    });
    expect(migrate).not.toHaveBeenCalled();
    expect(subject.events).toEqual([
      {
        event: "schema-migration",
        outcome: "backup-failed",
        detectedSchema: previous,
        targetSchema: currentSqliteSchema().version,
        error: `RecoveryBundleError bundle-insufficient-space: ${detail}`,
      },
    ]);
  });

  it("keeps other recovery failures generic", async () => {
    const path = database("skill-assignments");
    const subject = harness(path, () =>
      Promise.reject(new RecoveryBundleError("bundle-database-invalid")),
    );
    const failure = await subject.run(vi.fn()).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      message: "the pre-migration backup could not be created",
    });
    expect(subject.events[0]).toMatchObject({
      error: "RecoveryBundleError bundle-database-invalid: bundle-database-invalid",
    });
  });

  it("reports a failed migration and refuses to start", async () => {
    const path = database("skill-assignments");
    const subject = harness(path);
    const failure = await subject
      .run(() => {
        throw new RangeError("synthetic");
      })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "not-ready",
      message: "the database schema migration failed",
    });
    expect(subject.events).toEqual([
      {
        event: "schema-migration",
        outcome: "migration-failed",
        detectedSchema: previous,
        targetSchema: currentSqliteSchema().version,
        error: "RangeError: synthetic",
      },
    ]);
  });

  it("names the error code of a system failure and bounds the text", async () => {
    const path = database("skill-assignments");
    const systemFailure = Object.assign(new Error("EEXIST: file already exists"), {
      code: "EEXIST",
    });
    const subject = harness(path);
    await subject
      .run(() => {
        throw systemFailure;
      })
      .catch(() => undefined);
    expect(subject.events[0]).toMatchObject({ error: "Error EEXIST: EEXIST: file already exists" });
    const long = harness(path, () => Promise.reject(new Error("x".repeat(1000))));
    await long.run().catch(() => undefined);
    expect((long.events[0] as { error: string }).error).toHaveLength(300);
  });

  it("names a non-error rejection by its type", async () => {
    const path = database("skill-assignments");
    const subject = harness(path, () => Promise.reject(new Error("x")));
    await subject.run().catch(() => undefined);
    expect(subject.events[0]).toMatchObject({ error: "Error: x" });
    // A rejected non-error value is still named by its type.
    const other = harness(path, vi.fn<() => Promise<string>>().mockRejectedValue("text"));
    await other.run().catch(() => undefined);
    expect(other.events[0]).toMatchObject({ error: "string" });
  });

  it("refuses a schema newer than this binary without touching it", async () => {
    const path = database(currentSqliteSchema().catalog);
    const newer = currentSqliteSchema().version + 1;
    const file = openSqliteDatabaseFile({ databasePath: path });
    file.database.execute(`PRAGMA user_version = ${String(newer)}`);
    file.close();
    const subject = harness(path);
    const migrate = vi.fn();
    const failure = await subject.run(migrate).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "not-ready",
      message: "the database schema is newer than this release",
    });
    expect(subject.backup).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
    expect(inspectSqliteSchemaVersion({ databasePath: path })).toBe(newer);
    expect(subject.events).toEqual([
      {
        event: "schema-migration",
        outcome: "newer-schema",
        detectedSchema: newer,
        targetSchema: currentSqliteSchema().version,
      },
    ]);
  });
});
