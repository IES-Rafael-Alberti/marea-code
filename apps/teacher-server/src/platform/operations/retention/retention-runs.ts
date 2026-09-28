import { educationalRunRows } from "./educational-retention.js";
import { protocolDigest } from "../canonical-encoder.js";
import type { ReadOnlySqliteApplicationDatabase } from "../contracts.js";
import { TargetRefSchema, type TargetRef } from "../schemas.js";
import type { RetentionBlocker } from "./retention-blockers.js";
import { blockersOf, measure, type BlockerQuery, type DerivedQuery } from "./retention-rows.js";

export type RunTarget = Extract<TargetRef, { kind: "run" }>;
export type SnapshotTarget = Extract<TargetRef, { kind: "snapshot" }>;

export interface ContentInspection<T extends TargetRef> {
  readonly node: T;
  readonly blockers: readonly RetentionBlocker[];
  readonly rows: number;
  readonly bytes: number;
  /** Identifiers, states and counts of every derived row; a change makes a preview stale. */
  readonly fingerprint: string;
}

export interface RunInspection extends ContentInspection<RunTarget> {
  readonly snapshotId: string;
}

/** Every row deleted with a run; each query selects its `rows` and `bytes`. */
function runRows(): readonly DerivedQuery[] {
  return [
    ["run", "SELECT state, closed_at, 1 AS rows, 0 AS bytes FROM marea_runs WHERE id = ?1"],
    [
      "events",
      "SELECT COUNT(*) AS rows, MAX(sequence) AS last, COALESCE(SUM(LENGTH(payload_json)), 0) AS bytes FROM marea_run_events WHERE run_id = ?1",
    ],
    [
      "evaluations",
      "SELECT id, state, updated_at, 1 AS rows, LENGTH(input_json) + COALESCE(LENGTH(draft_json), 0) AS bytes FROM marea_evaluations WHERE run_id = ?1 ORDER BY id",
    ],
    [
      "notices",
      "SELECT id, acknowledged_at, 1 AS rows, LENGTH(text) AS bytes FROM marea_teacher_notices WHERE run_id = ?1 ORDER BY id",
    ],
    [
      "attempts",
      "SELECT id, state, 1 + (SELECT COUNT(*) FROM marea_usage_tool_calls calls WHERE calls.reservation_id = attempts.id) AS rows, 0 AS bytes FROM marea_usage_attempts attempts WHERE run_id = ?1 ORDER BY id",
    ],
    [
      "leases",
      "SELECT id, revoked_at, expires_at, 1 AS rows, 0 AS bytes FROM marea_run_leases WHERE run_id = ?1 ORDER BY id",
    ],
    [
      "usageAccounts",
      "SELECT purpose, 1 AS rows, 0 AS bytes FROM marea_usage_accounts WHERE run_id = ?1 ORDER BY purpose",
    ],
    [
      "openRequests",
      "SELECT idempotency_key, 1 AS rows, 0 AS bytes FROM marea_run_open_requests WHERE run_id = ?1 ORDER BY student_id, idempotency_key",
    ],
    ["activeRuns", "SELECT 1 AS rows, 0 AS bytes FROM marea_active_runs WHERE run_id = ?1"],
  ];
}

function runBlockers(): readonly BlockerQuery[] {
  return [
    ["active", "run-open", "SELECT 1 FROM marea_runs WHERE id = ?1 AND state <> 'closed'"],
    ["active", "run-active", "SELECT 1 FROM marea_active_runs WHERE run_id = ?1"],
    [
      "active",
      "lease-live",
      "SELECT 1 FROM marea_run_leases WHERE run_id = ?1 AND revoked_at IS NULL AND expires_at > ?2",
    ],
    [
      "active",
      "evaluation-pending",
      "SELECT 1 FROM marea_evaluations WHERE run_id = ?1 AND state IN ('queued', 'running')",
    ],
    [
      "unknown",
      "usage-unsettled",
      "SELECT 1 FROM marea_usage_attempts WHERE run_id = ?1 AND state IN ('reserved', 'unknown')",
    ],
  ];
}

function snapshotRows(): readonly DerivedQuery[] {
  return [
    [
      "snapshot",
      "SELECT 1 AS rows, LENGTH(public_snapshot_json) + LENGTH(provider_route_json) AS bytes FROM marea_run_snapshots WHERE id = ?1",
    ],
    [
      "teaching",
      "SELECT 1 AS rows, LENGTH(teaching_json) AS bytes FROM marea_run_teaching_snapshots WHERE snapshot_id = ?1",
    ],
  ];
}

function snapshotDigests(database: ReadOnlySqliteApplicationDatabase, snapshotId: string) {
  // Raw column text is digested directly: project snapshots may exceed canonical encoder limits.
  const identity = database
    .readAll(
      "SELECT json_array(public_snapshot_json, provider_route_json, created_at) AS identity FROM marea_run_snapshots WHERE id = ?1",
      [snapshotId],
    )
    .map((row) => String(row.identity))
    .join();
  const teaching = database.readOne(
    "SELECT teaching_json FROM marea_run_teaching_snapshots WHERE snapshot_id = ?1",
    [snapshotId],
  );
  return {
    snapshotDigest: protocolDigest(new TextEncoder().encode(identity)),
    teachingDigest:
      teaching === undefined
        ? null
        : protocolDigest(new TextEncoder().encode(String(teaching.teaching_json))),
  };
}

/** The stable identity and current observation of a run, or undefined when it does not exist. */
export function runNode(
  database: ReadOnlySqliteApplicationDatabase,
  runId: string,
): { readonly node: RunTarget; readonly snapshotId: string } | undefined {
  const run = database.readOne("SELECT snapshot_id FROM marea_runs WHERE id = ?1", [runId]);
  if (run === undefined) return undefined;
  const snapshotId = String(run.snapshot_id);
  const node = TargetRefSchema.parse({
    kind: "run",
    key: { runId },
    observed: {
      kind: "run-snapshot",
      runId,
      snapshotId,
      snapshotDigest: snapshotDigests(database, snapshotId).snapshotDigest,
    },
  }) as RunTarget;
  return { node, snapshotId };
}

export function snapshotNode(
  database: ReadOnlySqliteApplicationDatabase,
  snapshotId: string,
): SnapshotTarget {
  return TargetRefSchema.parse({
    kind: "snapshot",
    key: { snapshotId },
    observed: { kind: "snapshot", snapshotId, ...snapshotDigests(database, snapshotId) },
  }) as SnapshotTarget;
}

export function inspectRun(
  database: ReadOnlySqliteApplicationDatabase,
  runId: string,
  now: string,
): RunInspection | undefined {
  const found = runNode(database, runId);
  if (found === undefined) return undefined;
  const { node, snapshotId } = found;
  return {
    node,
    snapshotId,
    blockers: blockersOf(database, runBlockers(), node, runId, now),
    ...measure(database, [...runRows(), ...educationalRunRows(database)], runId),
  };
}

export function inspectSnapshot(
  database: ReadOnlySqliteApplicationDatabase,
  snapshotId: string,
): ContentInspection<SnapshotTarget> {
  return {
    node: snapshotNode(database, snapshotId),
    blockers: [],
    ...measure(database, snapshotRows(), snapshotId),
  };
}
