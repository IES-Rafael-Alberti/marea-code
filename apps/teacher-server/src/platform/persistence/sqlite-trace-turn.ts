import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import { CanonicalRunEventSchema, PrivateProviderRouteSchema } from "@marea/protocol";
import { TelemetryExporterError } from "@marea/plugin-api";
import type { TraceTurn } from "../../observability/contracts.js";
import type { QueuedTrace } from "./sqlite-trace-queue.js";
import { requiredRow, rowInteger, rowJson, rowText } from "./row-parser.boundary.js";
import { exportUsage } from "./sqlite-session-export.js";

/** Reads one completed turn, bounded before parsing content; no configuration/credentials. */
export function readTraceTurn(
  database: SqliteApplicationDatabase,
  item: QueuedTrace,
): TraceTurn | undefined {
  return database.transaction(() => {
    const row = database.readOne(
      `SELECT runs.student_id,runs.class_id,snapshots.provider_route_json
      FROM marea_runs runs JOIN marea_run_snapshots snapshots ON snapshots.id=runs.snapshot_id WHERE runs.id=?1`,
      [item.runId],
    );
    if (row === undefined) return undefined;
    const start = database.readOne(
      `SELECT sequence FROM marea_run_events WHERE run_id=?1 AND sequence<=?2
      AND event_type='student-message' ORDER BY sequence DESC LIMIT 1`,
      [item.runId, item.through],
    );
    const after = start === undefined ? item.through : rowInteger(start, "sequence");
    const size = requiredRow(
      database.readOne(
        `SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(CAST(payload_json AS BLOB))),0) AS bytes
      FROM marea_run_events WHERE run_id=?1 AND sequence>=?2 AND sequence<=?3`,
        [item.runId, after, item.through],
      ),
    );
    if (rowInteger(size, "count") > 1000 || rowInteger(size, "bytes") > 131072)
      throw new TelemetryExporterError("payload-too-large");
    const events = database
      .readAll(
        "SELECT payload_json FROM marea_run_events WHERE run_id=?1 AND sequence>=?2 AND sequence<=?3 ORDER BY sequence",
        [item.runId, after, item.through],
      )
      .map((event) => rowJson(event, "payload_json", CanonicalRunEventSchema));
    const route = rowJson(row, "provider_route_json", PrivateProviderRouteSchema);
    const usage = database.readAll(
      `SELECT attempts.*, json_extract(accounts.policy_json,'$.costUnit') AS cost_unit FROM marea_usage_attempts attempts
      JOIN marea_usage_accounts accounts USING(run_id,purpose)
      WHERE attempts.run_id=?1 AND attempts.request_id IN (
        SELECT json_extract(payload_json,'$.requestId') FROM marea_run_events
        WHERE run_id=?1 AND sequence>=?2 AND sequence<=?3 AND event_type='model-diagnostic') ORDER BY created_at,attempt LIMIT 1001`,
      [item.runId, after, item.through],
    );
    if (usage.length > 1000) throw new TelemetryExporterError("payload-too-large");
    return {
      runId: item.runId,
      studentId: rowText(row, "student_id"),
      classId: rowText(row, "class_id"),
      model: route.model,
      provider: route.providerId,
      events,
      usage: usage.map(exportUsage),
    };
  });
}
