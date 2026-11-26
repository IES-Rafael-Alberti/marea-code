import { calculateMigrationChecksum, validateKnownMigrationCatalog } from "./migration-catalog.js";
import { createRunClosureMigrationCatalog } from "./run-closure-migration-catalog.js";

const MEMORY_TRIGGER = "marea_learning_memory_deleted";

/**
 * Schema 16 keeps a dated history of learning notes that survives the deletion of the runs it
 * came from. Deleting a run used to clear the stored note through a trigger; the trigger is
 * dropped and `memory_run_id` is still cleared by its foreign key. A stored note is dated
 * (`dd/mm/aaaa: `, server local time, as new notes are) with the opening day of its run when
 * that run still exists; otherwise it is kept without a date.
 */
export function createLearningNotesMigrationCatalog() {
  const base = createRunClosureMigrationCatalog();
  const previous = base.reduce((_, migration) => migration);
  const migration = {
    name: "learning_notes_history",
    version: 16,
    schemaAfter: previous.schemaAfter.filter((entry) => entry.name !== MEMORY_TRIGGER),
    statements: [
      `UPDATE marea_learning_progress SET memory = COALESCE((SELECT strftime('%d/%m/%Y', runs.opened_at, 'localtime') || ': ' FROM marea_runs runs WHERE runs.id = marea_learning_progress.memory_run_id), '') || memory WHERE memory <> ''`,
      `DROP TRIGGER ${MEMORY_TRIGGER}`,
    ],
  };
  return validateKnownMigrationCatalog([
    ...base,
    { ...migration, checksum: calculateMigrationChecksum(migration) },
  ]);
}
