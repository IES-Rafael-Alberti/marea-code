import type { ReadOnlySqliteApplicationDatabase } from "../contracts.js";
import type { TargetRef } from "../schemas.js";
import { accountNode, membershipNodes } from "../retention/retention-accounts.js";
import type { BackupTarget } from "../retention/retention-backups.boundary.js";
import { runNode, snapshotNode, type RunTarget } from "../retention/retention-runs.js";

function ids(database: ReadOnlySqliteApplicationDatabase, table: string): string[] {
  return database.readAll(`SELECT id FROM ${table} ORDER BY id`).map((row) => String(row.id));
}

/**
 * Every identity kind that version 1 retention can tombstone, read from a restored
 * database together with the bundle it was restored from.
 */
export function readRestoredTargets(
  database: ReadOnlySqliteApplicationDatabase,
  bundle: BackupTarget,
): readonly TargetRef[] {
  const targets: TargetRef[] = [bundle];
  for (const id of ids(database, "marea_run_snapshots")) targets.push(snapshotNode(database, id));
  for (const id of ids(database, "marea_runs"))
    targets.push((runNode(database, id) as { readonly node: RunTarget }).node);
  for (const id of ids(database, "marea_users"))
    targets.push(accountNode(database, id) as TargetRef, ...membershipNodes(database, id));
  return targets;
}
