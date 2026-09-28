import { StudentRunSnapshotSchema } from "@marea/protocol";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

import { TeachingSnapshotContentSchema } from "../../teaching/configuration/configuration-schema.js";
import type {
  RunSkillRepository,
  StoredRunTeachingSnapshot,
} from "../../teaching/skills/run-skill-service.js";
import { rowJson } from "./row-parser.boundary.js";

export class SqliteRunSkillRepository implements RunSkillRepository {
  readonly #database: SqliteApplicationDatabase;

  constructor(database: SqliteApplicationDatabase) {
    this.#database = database;
  }

  loadRunTeaching(runId: string, snapshotId: string): StoredRunTeachingSnapshot | null {
    const row = this.#database.readOne(
      `SELECT snapshots.public_snapshot_json, teaching.teaching_json FROM marea_runs runs
        JOIN marea_run_snapshots snapshots ON snapshots.id = runs.snapshot_id
        JOIN marea_run_teaching_snapshots teaching ON teaching.snapshot_id = snapshots.id
        WHERE runs.id = ?1 AND snapshots.id = ?2`,
      [runId, snapshotId],
    );
    if (row === undefined) return null;
    return Object.freeze({
      snapshot: rowJson(row, "public_snapshot_json", StudentRunSnapshotSchema),
      teaching: rowJson(row, "teaching_json", TeachingSnapshotContentSchema),
    });
  }
}
