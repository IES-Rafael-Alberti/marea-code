import {
  RunHistoryQuerySchema,
  SessionHistoryQuerySchema,
  StudentRunSnapshotSchema,
} from "@marea/protocol";

import { NodeSqliteTestDatabase } from "./node-sqlite-database.boundary.js";
import { seedTeachingDatabase } from "./teaching-integration.fixture.js";
import { teachingConfiguration } from "./teaching-fixture.js";
import { HistoryService } from "../src/sessions/history-service.js";
import { SqliteHistoryRepository } from "../src/platform/persistence/sqlite-history-repository.js";

export const NOW = "2026-09-07T12:00:00.000Z";
export function query(runId = "run:b", afterSequence = 0, throughSequence?: number) {
  return RunHistoryQuerySchema.parse({
    kind: "run-history-query",
    protocolVersion: "0.1",
    requestId: "request:history",
    runId,
    afterSequence,
    limit: 1,
    ...(throughSequence === undefined ? {} : { throughSequence }),
  });
}
export function list(beforeRunId?: string) {
  return SessionHistoryQuerySchema.parse({
    kind: "session-history-query",
    protocolVersion: "0.1",
    requestId: "request:list",
    limit: 1,
    ...(beforeRunId === undefined ? {} : { beforeRunId }),
  });
}
export function addEvent(database: NodeSqliteTestDatabase, runId: string, sequence: number) {
  const event = {
    eventType: "assistant-message",
    eventId: `event:${runId}:${String(sequence)}`,
    occurredAt: NOW,
    sequence,
    content: `Canonical ${String(sequence)}`,
  };
  database.execute(
    `INSERT INTO marea_run_events
    (event_id, run_id, sequence, occurred_at, event_type, payload_json)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    [event.eventId, runId, sequence, NOW, event.eventType, JSON.stringify(event)],
  );
}
export function setup(databasePath?: string) {
  const database = new NodeSqliteTestDatabase(databasePath);
  seedTeachingDatabase(database);
  const configuration = teachingConfiguration();
  const snapshot = StudentRunSnapshotSchema.parse({
    ...configuration.publicTemplate,
    id: "snapshot:history",
  });
  database.execute(
    `INSERT INTO marea_run_snapshots
    (id, public_snapshot_json, provider_route_json, created_at) VALUES (?1, ?2, ?3, ?4)`,
    [snapshot.id, JSON.stringify(snapshot), JSON.stringify(configuration.providerRoute), NOW],
  );
  for (const [id, studentId, classId, state, opened] of [
    ["run:a", "s1", "class:one", "active", NOW],
    ["run:b", "s1", "class:one", "closed", NOW],
    ["run:c", "s2", "class:two", "closed", NOW],
    ["run:older", "s1", "class:one", "closed", "2026-09-06T12:00:00.000Z"],
  ] as const) {
    database.execute(
      `INSERT INTO marea_runs
      (id, student_id, class_id, snapshot_id, client_session_id, project_display_name, state, opened_at, closed_at)
      VALUES (?1, ?2, ?3, ?4, 'client:one', 'Synthetic project', ?5, ?6, ?7)`,
      [id, studentId, classId, snapshot.id, state, opened, state === "closed" ? NOW : null],
    );
    addEvent(database, id, 1);
    addEvent(database, id, 2);
  }
  return { database, snapshot, service: new HistoryService(new SqliteHistoryRepository(database)) };
}
