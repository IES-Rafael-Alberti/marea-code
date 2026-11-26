import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { inspectSqliteSchemaVersion } from "@marea/sqlite-storage";
import { readOperationsConfig } from "../../apps/teacher-server/src/platform/operations-cli/operations-config.js";
import { readTeacherHostConfig } from "../../apps/teacher-server/src/platform/teacher-host/teacher-host-config.js";

/**
 * What an update must remember to undo itself. `schemaVersion` is the database schema when the
 * update began: the new binary migrates at startup, so an unchanged schema proves it never ran.
 */
export const updateJournalSchema = z.object({
  format: z.literal(2),
  version: z.string().min(1),
  destination: z.string().min(1),
  backup: z.string().min(1),
  previousHost: z.record(z.string(), z.unknown()),
  schemaVersion: z.number().int().nonnegative(),
  /** Raw `active.json` of the programs directory before the update, or null when absent. */
  previousActive: z.string().nullable(),
  destinationExisted: z.boolean(),
});
export type UpdateJournal = z.infer<typeof updateJournalSchema>;

export function currentDatabaseSchema(installation: string): number {
  return inspectSqliteSchemaVersion({
    databasePath: readOperationsConfig(installation).databasePath,
  });
}

function replaceFile(path: string, content: string): void {
  const next = `${path}.${randomUUID()}.tmp`;
  // Stryker disable next-line StringLiteral: a unique temporary name already prevents clobbering.
  writeFileSync(next, content, { flag: "wx", mode: 0o600 });
  renameSync(next, path);
}

function restore(installation: string, journalPath: string, journal: UpdateJournal): void {
  const pointer = join(dirname(journal.destination), "active.json");
  if (journal.previousActive === null) rmSync(pointer, { force: true });
  else replaceFile(pointer, journal.previousActive);
  replaceFile(
    join(installation, "config", "teacher-host.json"),
    JSON.stringify(journal.previousHost, null, 2),
  );
  if (!journal.destinationExisted && /^server-[0-9A-Za-z.-]+$/u.test(basename(journal.destination)))
    rmSync(journal.destination, { recursive: true, force: true });
  // The restored files must parse before the update is declared undone.
  readTeacherHostConfig(installation);
  rmSync(journalPath);
}

/**
 * Returns to the release recorded in the journal when the database is provably unchanged: the
 * activation pointer, the host configuration and the unpublished program directory are restored
 * and the journal is removed last. Returns false, keeping the journal, when data may have changed,
 * the journal predates this recovery or a step fails; the manual restore remains the way back.
 */
export function rollbackInterruptedUpdate(installation: string, journalPath: string): boolean {
  try {
    const journal = updateJournalSchema.parse(JSON.parse(String(readFileSync(journalPath))));
    if (currentDatabaseSchema(installation) !== journal.schemaVersion) return false;
    restore(installation, journalPath, journal);
    return true;
  } catch {
    return false;
  }
}
