import { CanonicalRunEventSchema } from "@marea/protocol";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

import {
  EvaluationInputSchema,
  MAX_EVALUATION_INPUT_BYTES,
  type EvaluationInput,
} from "../../evaluation/evaluation-input.js";
import { TeacherDomainError } from "../../identity/errors.js";
import { PrivateProviderRouteSchema } from "../../model-gateway/route-policy.js";
import { TeachingSnapshotContentSchema } from "../../teaching/configuration/configuration-schema.js";
import { rowInteger, rowJson, rowText } from "./row-parser.boundary.js";

// Keep the captured sequence complete without retaining auxiliary model bodies
// or repeated streaming prefixes as grading evidence.
const EVIDENCE_PAYLOAD = `CASE WHEN event_type IN ('model-diagnostic', 'assistant-progress')
  THEN json_object('eventType', 'internal-activity',
    'eventId', json_extract(payload_json, '$.eventId'),
    'sequence', json_extract(payload_json, '$.sequence'),
    'occurredAt', json_extract(payload_json, '$.occurredAt'))
  ELSE payload_json END`;

/** Caller owns a transaction. Closed runs cannot receive further canonical events. */
export function captureEvaluationInput(
  database: SqliteApplicationDatabase,
  runId: string,
): EvaluationInput {
  const metadata = database.readOne(
    `SELECT runs.snapshot_id,
      json_extract(snapshots.public_snapshot_json, '$.agentMode') AS mode,
      json_extract(teaching.teaching_json, '$.evaluationSkills[0].id') AS evaluator_id,
      json_extract(teaching.teaching_json, '$.evaluationSkills[0].digest') AS evaluator_digest,
      length(CAST(teaching.teaching_json AS BLOB)) + length(CAST(snapshots.provider_route_json AS BLOB))
        + (SELECT COALESCE(SUM(length(CAST(${EVIDENCE_PAYLOAD} AS BLOB))), 0) FROM marea_run_events
          WHERE run_id = runs.id) AS total_bytes
      FROM marea_runs runs
      JOIN marea_run_snapshots snapshots ON snapshots.id = runs.snapshot_id
      JOIN marea_run_teaching_snapshots teaching ON teaching.snapshot_id = runs.snapshot_id
      WHERE runs.id = ?1 AND runs.state = 'closed'
        AND json_array_length(teaching.teaching_json, '$.evaluationSkills') = 1`,
    [runId],
  );
  if (metadata === undefined) throw new TeacherDomainError("request.conflict");
  const references = database
    .readAll(
      `SELECT json_extract(skill.value, '$.id') AS id, json_extract(skill.value, '$.digest') AS digest
      FROM marea_run_teaching_snapshots teaching, json_each(teaching.teaching_json, '$.didacticSkills') skill
      WHERE teaching.snapshot_id = ?1 LIMIT 65`,
      [rowText(metadata, "snapshot_id")],
    )
    .map((row) => ({ id: rowText(row, "id"), digest: rowText(row, "digest") }));
  const captured = EvaluationInputSchema.parse({
    format: "marea-evaluation-input:1",
    runId,
    snapshotId: rowText(metadata, "snapshot_id"),
    mode: rowText(metadata, "mode"),
    evaluator: {
      id: rowText(metadata, "evaluator_id"),
      digest: rowText(metadata, "evaluator_digest"),
    },
    didacticSkills: references,
    content:
      // Stryker disable next-line EqualityOperator: At exact raw bytes the positive JSON envelope also exceeds the final limit; both branches produce the same bounded manifest.
      rowInteger(metadata, "total_bytes") > MAX_EVALUATION_INPUT_BYTES
        ? null
        : readContent(database, runId, rowText(metadata, "snapshot_id")),
  });
  return Buffer.byteLength(JSON.stringify(captured)) > MAX_EVALUATION_INPUT_BYTES
    ? Object.freeze({ ...captured, content: null })
    : captured;
}

function readContent(database: SqliteApplicationDatabase, runId: string, snapshotId: string) {
  const row = database.readOne(
    `SELECT teaching.teaching_json, snapshots.provider_route_json FROM marea_run_teaching_snapshots teaching
      JOIN marea_run_snapshots snapshots ON snapshots.id = teaching.snapshot_id WHERE snapshots.id = ?1`,
    [snapshotId],
  );
  if (row === undefined) throw new TeacherDomainError("request.conflict");
  const events = database
    .readAll(
      `SELECT sequence, ${EVIDENCE_PAYLOAD} AS payload_json FROM marea_run_events WHERE run_id = ?1 ORDER BY sequence ASC`,
      [runId],
    )
    .map((row) => {
      const event = rowJson(row, "payload_json", CanonicalRunEventSchema);
      if (event.sequence !== rowInteger(row, "sequence"))
        throw new TeacherDomainError("request.conflict");
      return event;
    });
  if (
    events[0]?.eventType !== "run-activated" ||
    // Stryker disable next-line OptionalChaining: The first guard has already rejected the empty array.
    events.at(-1)?.eventType !== "run-closed" ||
    events.some((event, index) => event.sequence !== index + 1)
  )
    throw new TeacherDomainError("request.conflict");
  return {
    teaching: rowJson(row, "teaching_json", TeachingSnapshotContentSchema),
    providerRoute: rowJson(row, "provider_route_json", PrivateProviderRouteSchema),
    events,
  };
}
