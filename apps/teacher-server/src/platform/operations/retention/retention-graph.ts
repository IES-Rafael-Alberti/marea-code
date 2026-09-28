import { canonicalJsonBytes, protocolDigest } from "../canonical-encoder.js";
import type { ReadOnlySqliteApplicationDatabase, ReferenceGraphReader } from "../contracts.js";
import { GraphSchema, type ReferenceGraph, type TargetRef } from "../schemas.js";
import { observationMatches, targetIdentity } from "../validators.js";
import { inspectAccount } from "./retention-accounts.js";
import type { InventoriedBackup } from "./retention-backups.boundary.js";
import { blocker, type RetentionBlocker } from "./retention-blockers.js";
import { inspectRun, inspectSnapshot, type ContentInspection } from "./retention-runs.js";

/** Kinds an operator may name as a deletion root; every other kind is only a derived node. */
function isRootKind(kind: TargetRef["kind"]): boolean {
  return kind === "run" || kind === "account" || kind === "backup";
}

export interface RetentionPlan {
  readonly runIds: readonly string[];
  readonly snapshotIds: readonly string[];
  readonly accountIds: readonly string[];
  readonly backupNames: readonly string[];
}

export interface RetentionGraph {
  readonly graph: ReferenceGraph;
  readonly counts: { readonly rows: number; readonly files: 0; readonly backups: number };
  readonly bytes: { readonly database: number; readonly files: 0; readonly backups: number };
  readonly plan: RetentionPlan;
}

class GraphBuilder {
  readonly nodes = new Map<string, TargetRef>();
  readonly content = new Map<string, string>();
  readonly blockers: RetentionBlocker[] = [];
  rows = 0;
  bytes = 0;

  add(inspection: ContentInspection<TargetRef>): void {
    const identity = targetIdentity(inspection.node);
    this.nodes.set(identity, inspection.node);
    this.content.set(identity, inspection.fingerprint);
    this.blockers.push(...inspection.blockers);
    this.rows += inspection.rows;
    this.bytes += inspection.bytes;
  }

  /** A requested target must still be present with the observation the operator reviewed. */
  check(requested: TargetRef): void {
    const current = this.nodes.get(targetIdentity(requested));
    if (current === undefined)
      this.blockers.push(
        blocker(
          "unknown",
          requested,
          isRootKind(requested.kind) ? "unresolved-target" : "unsupported-target",
        ),
      );
    else if (!observationMatches(current, requested))
      this.blockers.push(blocker("stale", requested, "observation-changed"));
  }
}

function sortedByIdentity<T>(entries: Iterable<[string, T]>): T[] {
  return [...entries]
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([, value]) => value);
}

function addRuns(
  builder: GraphBuilder,
  database: ReadOnlySqliteApplicationDatabase,
  runIds: ReadonlySet<string>,
  now: string,
): { readonly runIds: readonly string[]; readonly snapshotIds: readonly string[] } {
  const snapshotIds = new Set<string>();
  const found: string[] = [];
  for (const runId of [...runIds].sort()) {
    const run = inspectRun(database, runId, now);
    if (run === undefined) continue;
    builder.add(run);
    found.push(runId);
    snapshotIds.add(run.snapshotId);
  }
  const deletable: string[] = [];
  for (const snapshotId of snapshotIds) {
    const users = database.readAll("SELECT id FROM marea_runs WHERE snapshot_id = ?1", [
      snapshotId,
    ]);
    if (users.some((row) => !runIds.has(String(row.id)))) continue;
    builder.add(inspectSnapshot(database, snapshotId));
    deletable.push(snapshotId);
  }
  return { runIds: found, snapshotIds: deletable };
}

function addBackups(
  builder: GraphBuilder,
  inventory: readonly InventoriedBackup[] | null,
  targets: readonly TargetRef[],
  hasData: boolean,
): { readonly names: readonly string[]; readonly bytes: number } {
  if (inventory === null) {
    builder.blockers.push(blocker("unverifiable", null, "backup-root"));
    return { names: [], bytes: 0 };
  }
  const wanted = new Set(targets.map((target) => targetIdentity(target)));
  const names: string[] = [];
  let bytes = 0;
  for (const backup of inventory) {
    if (backup.state === "unverifiable") {
      builder.blockers.push(blocker("unverifiable", null, "backup-unverifiable"));
      continue;
    }
    const identity = targetIdentity(backup.target);
    if (wanted.has(identity)) {
      builder.nodes.set(identity, backup.target);
      names.push(backup.name);
      bytes += backup.bytes;
    } else if (hasData)
      builder.blockers.push(blocker("shared-backup", backup.target, "shared-backup"));
  }
  return { names, bytes };
}

/** The maintenance graph port over the retention closure of explicitly named roots. */
export function retentionGraphReader(
  database: ReadOnlySqliteApplicationDatabase,
  backups: () => readonly InventoriedBackup[] | null,
  now: () => string,
): ReferenceGraphReader {
  return Object.freeze({
    read: ({ targets }: { readonly targets: readonly TargetRef[] }) =>
      Promise.resolve(readRetentionGraph(database, backups(), targets, now()).graph),
  });
}

/**
 * Reads the complete deletion closure of explicitly requested roots without writing.
 * Unsupported, missing, changed or protected state is reported as a blocker instead of
 * broadening or narrowing the operator's scope.
 */
export function readRetentionGraph(
  database: ReadOnlySqliteApplicationDatabase,
  inventory: readonly InventoriedBackup[] | null,
  targets: readonly TargetRef[],
  now: string,
): RetentionGraph {
  const builder = new GraphBuilder();
  const runIds = new Set<string>();
  const accountIds: string[] = [];
  for (const target of targets) {
    if (target.kind === "run") runIds.add(target.key.runId);
    if (target.kind !== "account") continue;
    const account = inspectAccount(database, target.key.userId, now);
    if (account === undefined) continue;
    builder.add(account);
    accountIds.push(target.key.userId);
    for (const runId of account.runIds) runIds.add(runId);
    for (const membership of account.memberships)
      builder.nodes.set(targetIdentity(membership), membership);
  }
  const runs = addRuns(builder, database, runIds, now);
  const backups = addBackups(builder, inventory, targets, builder.nodes.size > 0);
  for (const target of targets) builder.check(target);
  const nodes = sortedByIdentity(builder.nodes);
  const blockers = [...builder.blockers].sort((left, right) =>
    Buffer.compare(Buffer.from(canonicalJsonBytes(left)), Buffer.from(canonicalJsonBytes(right))),
  );
  const digest = protocolDigest(
    canonicalJsonBytes({ nodes, blockers, content: sortedByIdentity(builder.content) }),
  );
  return {
    graph: GraphSchema.parse({ digest, nodes, blockers }),
    counts: { rows: builder.rows, files: 0, backups: backups.names.length },
    bytes: { database: builder.bytes, files: 0, backups: backups.bytes },
    plan: { ...runs, accountIds, backupNames: backups.names },
  };
}
