import * as z from "zod";
import { EvaluationDraftSchema, StudentRunSnapshotSchema } from "@marea/protocol";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import { TeachingSnapshotContentSchema } from "../teaching/configuration/configuration-schema.js";
import { anonymizeDraft } from "./anonymize.js";
import type { EducationalRoute } from "./configuration.js";
import { PROMPT_RESERVE_BYTES } from "./reports-model.js";

const MAX_EVENTS_PER_RUN = 2000;
export const MAX_MATERIAL_BYTES = 262144;
const WRAPPER_BYTES = Buffer.byteLength('{"events":[],"omittedEarlierEvents":}');

interface Material {
  readonly material: string;
  readonly skip: "material-too-large" | undefined;
}

/**
 * Keeps the most recent events that fit the per-run byte cap. Earlier events are summarised by
 * their count so the model knows the beginning of the session is missing.
 */
export function materialOf(
  events: readonly string[],
  omittedBefore: number,
  limit = MAX_MATERIAL_BYTES,
): Material {
  const sizes = events.map((event) => Buffer.byteLength(event));
  let remaining = sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, events.length - 1);
  for (const [dropped, size] of sizes.entries()) {
    const omitted = omittedBefore + dropped;
    if (WRAPPER_BYTES + String(omitted).length + remaining <= limit)
      return {
        material: `{"events":[${events.slice(dropped).join(",")}],"omittedEarlierEvents":${String(omitted)}}`,
        skip: undefined,
      };
    remaining -= size + (dropped < events.length - 1 ? 1 : 0);
  }
  return { material: "", skip: events.length === 0 ? undefined : "material-too-large" };
}

/** The per-run cap, lowered so that material plus teaching always fits the route's input ceiling. */
export function materialLimit(route: EducationalRoute, teaching: object): number {
  return route.budget.unlimited === true
    ? MAX_MATERIAL_BYTES
    : Math.min(
        MAX_MATERIAL_BYTES,
        route.inputTokenCeiling -
          PROMPT_RESERVE_BYTES -
          Buffer.byteLength(JSON.stringify(teaching)),
      );
}

export type Row = NonNullable<ReturnType<SqliteApplicationDatabase["readOne"]>>;

/** Freezes one session as an anonymous source: aliased material and its approved evaluation. */
export function sourceOf(
  database: SqliteApplicationDatabase,
  run: Row,
  to: string,
  alias: string,
  route: EducationalRoute,
) {
  const studentId = String(run.student_id);
  const runId = String(run.id);
  const snapshot = StudentRunSnapshotSchema.parse(JSON.parse(String(run.public_snapshot_json)));
  const teaching = TeachingSnapshotContentSchema.parse(JSON.parse(String(run.teaching_json)));
  const approved = database.readOne(
    "SELECT draft_json FROM marea_evaluations WHERE run_id = ?1 AND state = 'approved' ORDER BY generation DESC LIMIT 1",
    [runId],
  );
  const person = database.readOne("SELECT display_name,login FROM marea_users WHERE id = ?1", [
    studentId,
  ]);
  const filter = `FROM marea_run_events WHERE run_id = ?1 AND event_type IN ('student-message','assistant-message','tool-finished','project-change') AND occurred_at <= ?2`;
  const rows = database.readAll(
    `SELECT payload_json ${filter} ORDER BY sequence DESC LIMIT ${String(MAX_EVENTS_PER_RUN)}`,
    [runId, to],
  );
  const total = Number(database.readOne(`SELECT COUNT(*) AS n ${filter}`, [runId, to])?.n);
  const identifiers = [person?.display_name, person?.login].filter(
    (value): value is string => typeof value === "string" && value.length > 1,
  );
  const events = [...rows]
    .reverse()
    .map((row) =>
      identifiers.reduce(
        (text, identifier) => text.replaceAll(identifier, alias),
        JSON.stringify(z.json().parse(JSON.parse(String(row.payload_json)))),
      ),
    );
  return {
    runId,
    studentId,
    alias,
    mode: snapshot.agentMode,
    teaching,
    skills: teaching.didacticSkills.map((s) => s.id),
    ...materialOf(events, total - rows.length, materialLimit(route, teaching)),
    approved:
      approved === undefined
        ? null
        : anonymizeDraft(
            EvaluationDraftSchema.parse(JSON.parse(String(approved.draft_json))),
            identifiers,
            alias,
          ),
  };
}
