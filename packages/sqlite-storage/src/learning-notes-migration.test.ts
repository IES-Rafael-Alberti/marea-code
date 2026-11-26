import { afterEach, describe, expect, it } from "vitest";

import { governanceDatabase } from "../test-support/governance-database.fixture.js";
import { migrateDatabase, verifyDatabase } from "./database-schema.js";
import { createLearningNotesMigrationCatalog } from "./learning-notes-migration-catalog.js";
import { parseMigrationCatalog } from "./migration-catalog.boundary.js";
import { createRunClosureMigrationCatalog } from "./run-closure-migration-catalog.js";

const opened: ReturnType<typeof governanceDatabase>[] = [];
afterEach(() => {
  for (const f of opened.splice(0)) f.close();
});

/** Midday UTC is the same calendar day in every time zone the server may run in. */
const OPENED = "2026-09-08T12:00:00.000Z";

/** A schema 15 database with one synthetic student, two runs and reviewed notes. */
function schema15() {
  const f = governanceDatabase(8);
  opened.push(f);
  migrateDatabase(f.port, createRunClosureMigrationCatalog());
  f.database.exec(`
    INSERT INTO marea_classes VALUES ('class-1', 'seed-1', 'One');
    INSERT INTO marea_users VALUES ('student-1', 'student-1', 'hash', 'student', 'Student', 'class-1');
    INSERT INTO marea_run_snapshots VALUES ('snapshot-1', '{}', '{}', '${OPENED}');
    INSERT INTO marea_runs (id, student_id, class_id, snapshot_id, client_session_id, project_display_name, state, opened_at)
      VALUES ('run-1', 'student-1', 'class-1', 'snapshot-1', 'c1', 'P', 'closed', '${OPENED}'),
        ('run-2', 'student-1', 'class-1', 'snapshot-1', 'c2', 'P', 'closed', '${OPENED}');
    INSERT INTO marea_learning_progress (class_id, student_id, criterion_key, definition_json, level, epoch, revision, memory, memory_run_id) VALUES
      ('class-1', 'student-1', 'with-run', '{}', 1, 0, 'r1', 'Separates find from forEach.', 'run-1'),
      ('class-1', 'student-1', 'without-run', '{}', 1, 0, 'r2', 'Kept after a deletion.', NULL),
      ('class-1', 'student-1', 'empty', '{}', 0, 0, 'r3', '', 'run-2');
  `);
  return f;
}

const notes = (f: ReturnType<typeof schema15>) =>
  f.port.readAll(
    "SELECT criterion_key, memory, memory_run_id FROM marea_learning_progress ORDER BY criterion_key",
  );

describe("learning notes schema 16", () => {
  it("drops only the run deletion trigger and round-trips through the boundary", () => {
    const catalog = createLearningNotesMigrationCatalog();
    const previous = createRunClosureMigrationCatalog();
    expect(catalog).toHaveLength(16);
    expect(catalog.slice(0, 15)).toEqual(previous);
    expect(catalog[15]).toMatchObject({ version: 16, name: "learning_notes_history" });
    const before = previous[14]?.schemaAfter ?? [];
    expect(catalog[15]?.schemaAfter).toEqual(
      before.filter((object) => object.name !== "marea_learning_memory_deleted"),
    );
    expect(catalog[15]?.schemaAfter).toHaveLength(before.length - 1);
    expect(parseMigrationCatalog(catalog)).toEqual(catalog);
  });

  it("dates stored notes from their run, keeps the rest and verifies the new schema", () => {
    const f = schema15();
    const ledger = f.port.readAll("SELECT * FROM marea_schema_migrations");
    const catalog = createLearningNotesMigrationCatalog();
    expect(migrateDatabase(f.port, catalog).version).toBe(16);
    expect(f.port.readAll("SELECT * FROM marea_schema_migrations WHERE version <= 15")).toEqual(
      ledger,
    );
    expect(verifyDatabase(f.port, catalog).version).toBe(16);
    expect(notes(f)).toEqual([
      { criterion_key: "empty", memory: "", memory_run_id: "run-2" },
      {
        criterion_key: "with-run",
        memory: "08/09/2026: Separates find from forEach.",
        memory_run_id: "run-1",
      },
      { criterion_key: "without-run", memory: "Kept after a deletion.", memory_run_id: null },
    ]);
    expect(
      f.port.readOne("SELECT 1 FROM sqlite_schema WHERE name = 'marea_learning_memory_deleted'"),
    ).toBeUndefined();
  });

  it("keeps notes when their source run is deleted and only clears the run reference", () => {
    const f = schema15();
    migrateDatabase(f.port, createLearningNotesMigrationCatalog());
    f.port.execute("DELETE FROM marea_runs WHERE id = 'run-1'");
    expect(notes(f)[1]).toEqual({
      criterion_key: "with-run",
      memory: "08/09/2026: Separates find from forEach.",
      memory_run_id: null,
    });
  });

  it("starts fresh databases on schema 16 without the trigger", () => {
    const f = governanceDatabase(8);
    opened.push(f);
    expect(migrateDatabase(f.port, createLearningNotesMigrationCatalog()).version).toBe(16);
    expect(
      f.port.readOne("SELECT 1 FROM sqlite_schema WHERE name = 'marea_learning_memory_deleted'"),
    ).toBeUndefined();
    expect(
      f.port.readOne("SELECT 1 FROM sqlite_schema WHERE name = 'marea_learning_progress'"),
    ).toBeDefined();
  });
});
