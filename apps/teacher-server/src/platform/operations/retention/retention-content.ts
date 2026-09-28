import { hasProfileStorage } from "./profile-retention.js";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

import type { RetentionPlan } from "./retention-graph.js";

const RUN_DELETIONS = [
  "DELETE FROM marea_usage_tool_calls WHERE reservation_id IN (SELECT id FROM marea_usage_attempts WHERE run_id = ?1)",
  "DELETE FROM marea_usage_attempts WHERE run_id = ?1",
  "DELETE FROM marea_usage_accounts WHERE run_id = ?1",
  "DELETE FROM marea_evaluations WHERE run_id = ?1",
  "DELETE FROM marea_teacher_notices WHERE run_id = ?1",
  "DELETE FROM marea_run_events WHERE run_id = ?1",
  "DELETE FROM marea_run_leases WHERE run_id = ?1",
  "DELETE FROM marea_run_open_requests WHERE run_id = ?1",
  "DELETE FROM marea_active_runs WHERE run_id = ?1",
  "DELETE FROM marea_runs WHERE id = ?1",
] as const;

const SNAPSHOT_DELETIONS = [
  "DELETE FROM marea_run_teaching_snapshots WHERE snapshot_id = ?1",
  "DELETE FROM marea_run_snapshots WHERE id = ?1",
] as const;

const ACCOUNT_DELETIONS = [
  "DELETE FROM marea_auth_sessions WHERE user_id = ?1",
  "DELETE FROM marea_invitations WHERE consumed_by = ?1",
  "DELETE FROM marea_governance_memberships WHERE user_id = ?1",
  "DELETE FROM marea_center_memberships WHERE user_id = ?1",
  "DELETE FROM marea_governance_accounts WHERE user_id = ?1",
  "DELETE FROM marea_users WHERE id = ?1",
] as const;

type RowPlan = Omit<RetentionPlan, "backupNames">;

function removeRows(database: SqliteApplicationDatabase, plan: RowPlan): number {
  let removed = 0;
  const run = (statements: readonly string[], ids: readonly string[]) => {
    for (const id of ids)
      for (const statement of statements)
        removed += database.readAll(`${statement} RETURNING 1`, [id]).length;
  };
  run(RUN_DELETIONS, plan.runIds);
  run(SNAPSHOT_DELETIONS, plan.snapshotIds);
  if (hasProfileStorage(database))
    run(["DELETE FROM marea_dashboard_profiles WHERE owner_id = ?1"], plan.accountIds);
  run(ACCOUNT_DELETIONS, plan.accountIds);
  return removed;
}

/**
 * Deletes exactly the planned rows in one transaction, in foreign-key order, and fails
 * (rolling everything back) unless the number of removed rows equals the reviewed count.
 */
export function deleteRetentionContent(
  database: SqliteApplicationDatabase,
  plan: RetentionPlan,
  expectedRows: number,
): void {
  database.transaction(() => {
    if (removeRows(database, plan) !== expectedRows)
      throw new Error("Retention deletion row count changed.");
  });
}

/**
 * Removes whatever planned rows remain after an interrupted confirmation. The earlier
 * transaction either committed completely or not at all, so no reviewed count applies.
 */
export function removeRemainingRetentionContent(
  database: SqliteApplicationDatabase,
  plan: RowPlan,
): number {
  return database.transaction(() => removeRows(database, plan));
}
