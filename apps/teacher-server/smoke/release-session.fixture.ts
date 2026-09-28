import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import { StudentRunSnapshotSchema } from "@marea/protocol";
import { teachingConfiguration } from "../test-support/teaching-fixture.js";

/** One inert active session: no provider, evaluation job or external inference. */
export function seedReleaseSession(database: SqliteApplicationDatabase) {
  const teaching = teachingConfiguration();
  const snapshot = StudentRunSnapshotSchema.parse({
    ...teaching.publicTemplate,
    id: "snapshot:release",
  });
  database.execute(
    "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES ('student:release', 'release-student', 'synthetic', 'student', 'Synthetic student', 'class:ready')",
  );
  database.execute(
    "INSERT INTO marea_run_snapshots (id, public_snapshot_json, provider_route_json, created_at) VALUES (?1, ?2, ?3, ?4)",
    [
      snapshot.id,
      JSON.stringify(snapshot),
      JSON.stringify(teaching.providerRoute),
      "2026-09-22T00:00:00Z",
    ],
  );
  database.execute(
    "INSERT INTO marea_run_teaching_snapshots (snapshot_id, teaching_json) VALUES (?1, ?2)",
    [snapshot.id, JSON.stringify(teaching.content)],
  );
  database.execute(
    "INSERT INTO marea_runs (id, student_id, class_id, snapshot_id, client_session_id, project_display_name, state, opened_at, closed_at) VALUES ('run:release', 'student:release', 'class:ready', ?1, 'client:release', 'Synthetic release project', 'active', ?2, NULL)",
    [snapshot.id, "2026-09-22T00:00:00Z"],
  );
}
