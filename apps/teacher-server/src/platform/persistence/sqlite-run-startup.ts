import {
  CanonicalRunEventSchema,
  STARTUP_MESSAGE_ID,
  StudentRunSnapshotSchema,
  type CanonicalRunEvent,
  type RunStartupState,
  type StudentRunSnapshot,
} from "@marea/protocol";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

import { TeacherDomainError } from "../../identity/errors.js";
import { rowJson } from "./row-parser.boundary.js";

export function loadRunStartup(
  database: SqliteApplicationDatabase,
  runId: string,
  snapshot: StudentRunSnapshot,
): RunStartupState | undefined {
  if (snapshot.agentMode !== "tutoring" || snapshot.startup === undefined) return undefined;
  const latest = database.readOne(
    "SELECT payload_json FROM marea_run_events WHERE run_id = ?1 AND event_type = 'tutor-startup' ORDER BY sequence DESC LIMIT 1",
    [runId],
  );
  if (latest === undefined) return "pending";
  const event = rowJson(latest, "payload_json", CanonicalRunEventSchema);
  if (event.eventType !== "tutor-startup") throw new TeacherDomainError("run.unavailable");
  return event.state;
}

/** Called inside event insertion's transaction, after exact-retry deduplication. */
export function validateStartupEvent(
  database: SqliteApplicationDatabase,
  runId: string,
  event: CanonicalRunEvent,
): void {
  const startupMessage = "messageId" in event && event.messageId === STARTUP_MESSAGE_ID;
  if (event.eventType !== "tutor-startup" && !startupMessage) return;
  const row = database.readOne(
    "SELECT snapshots.public_snapshot_json FROM marea_runs runs JOIN marea_run_snapshots snapshots ON snapshots.id = runs.snapshot_id WHERE runs.id = ?1",
    [runId],
  );
  if (row === undefined) throw new TeacherDomainError("run.unavailable");
  const state = loadRunStartup(
    database,
    runId,
    rowJson(row, "public_snapshot_json", StudentRunSnapshotSchema),
  );
  const valid =
    event.eventType === "tutor-startup"
      ? (state === "pending" && event.state === "started") ||
        (state === "started" && event.state !== "started")
      : state === "started" &&
        (event.eventType === "tool-started"
          ? [
              "marea_read_project",
              "marea_list_project",
              "marea_read_skill",
              "marea_search_project",
              "marea_glob_project",
            ].includes(event.name)
          : event.eventType === "assistant-message" ||
            event.eventType === "assistant-progress" ||
            event.eventType === "tool-finished" ||
            event.eventType === "turn-failed" ||
            (event.eventType === "project-change" && event.actor !== "agent"));
  if (!valid) throw new TeacherDomainError("request.conflict");
}
