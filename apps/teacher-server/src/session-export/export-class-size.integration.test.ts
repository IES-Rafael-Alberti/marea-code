import { expect, it } from "vitest";
import { SessionExportQuerySchema } from "@marea/protocol";
import { setup, NOW } from "../../test-support/history-fixture.js";
import { teacher } from "../../test-support/teaching-integration.fixture.js";
import { SqliteSessionExportRepository } from "../platform/persistence/sqlite-session-export.js";
import { SessionExportError } from "./contracts.js";

it("exports a complete class at the row ceiling and lets teachers narrow larger selections", () => {
  const { database, snapshot } = setup();
  try {
    const insert = (id: number) =>
      database.execute(
        `INSERT INTO marea_runs
       (id, student_id, class_id, snapshot_id, client_session_id, project_display_name, state, opened_at, closed_at)
       VALUES (?1, 's1', 'class:one', ?2, 'client:export', 'Export project', 'closed', ?3, ?3)`,
        [`export:${String(id)}`, snapshot.id, NOW],
      );
    database.transaction(() => {
      for (let index = 0; index < 1997; index++) insert(index);
    });
    const repository = new SqliteSessionExportRepository(database);
    const query = SessionExportQuerySchema.parse({ identities: "names", classId: "class:one" });
    const sessions = repository.read(teacher, query);
    expect(sessions).toHaveLength(2000);
    expect(new Set(sessions.map((session) => session.runId)).size).toBe(2000);
    insert(1997);
    expect(() => repository.read(teacher, query)).toThrow(new SessionExportError(413));
    expect(
      repository.read(teacher, { ...query, until: NOW }).map((session) => session.runId),
    ).toEqual(["run:older"]);
  } finally {
    database.close();
  }
});
