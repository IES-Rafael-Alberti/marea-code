import type { SqliteApplicationDatabase, SqliteRow } from "@marea/sqlite-storage";

import {
  IndexCheckpointSchema,
  IndexInspectionSchema,
  type IndexCheckpoint,
  type IndexInspection,
  type TargetRef,
} from "../index.js";
import { parseTarget, targetIdentity } from "../index.js";
import { canonicalJsonBytes } from "../canonical-encoder.js";
import type { StorageConfiguration } from "./configuration.js";
import { DeletionIndexStorageError } from "./deletion-index-errors.js";

function text(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string")
    throw new DeletionIndexStorageError("index-corrupt", "Index data is invalid.");
  return value;
}

function parseJson(row: SqliteRow, key: string): object {
  try {
    const value = JSON.parse(text(row, key)) as object | null;
    if (value === null) throw new TypeError();
    return value;
  } catch {
    throw new DeletionIndexStorageError("index-corrupt", "Index data is invalid.");
  }
}

function parseCheckpoint(row: SqliteRow): IndexCheckpoint {
  try {
    return IndexCheckpointSchema.parse(parseJson(row, "checkpoint_json"));
  } catch {
    throw new DeletionIndexStorageError("index-corrupt", "Checkpoint data is invalid.");
  }
}

function parseTargets(row: SqliteRow): readonly TargetRef[] {
  try {
    return (JSON.parse(text(row, "targets_json")) as object[]).map(parseTarget);
  } catch {
    throw new DeletionIndexStorageError("index-corrupt", "Target data is invalid.");
  }
}

function nullable(row: SqliteRow, key: string): string | null {
  const value = row[key];
  return value === null || value === undefined ? null : text(row, key);
}

export function checkpointBytes(checkpoint: IndexCheckpoint): string {
  return new TextDecoder().decode(canonicalJsonBytes(checkpoint));
}

export function targetBytes(target: TargetRef): string {
  return new TextDecoder().decode(canonicalJsonBytes(target));
}

function checkpointMatches(left: IndexCheckpoint, right: IndexCheckpoint): boolean {
  return checkpointBytes(left) === checkpointBytes(right);
}

function validateCheckpointState(checkpoint: IndexCheckpoint): void {
  if (checkpoint.durableIntent === "none" && checkpoint.contentState !== "pending")
    throw new DeletionIndexStorageError("index-corrupt", "Checkpoint state is inconsistent.");
}

function isIncomplete(checkpoint: IndexCheckpoint): boolean {
  return (
    checkpoint.state === "prepared" ||
    checkpoint.state === "uncertain" ||
    (checkpoint.state === "committed" && checkpoint.contentState !== "complete")
  );
}

export function targetSet(targets: readonly TargetRef[]): Set<string> {
  return new Set(targets.map(targetIdentity));
}

export function inspectFromRow(
  row: SqliteRow | undefined,
  expected: Pick<StorageConfiguration, "authorityLineage" | "rootId" | "databaseLineage">,
): IndexInspection {
  if (row === undefined)
    return IndexInspectionSchema.parse({
      ...expected,
      generation: 0,
      state: "missing",
      pendingCheckpoint: null,
    });
  const pending = nullable(row, "pending_checkpoint_json");
  let pendingCheckpoint: IndexCheckpoint | null = null;
  if (pending !== null) {
    try {
      pendingCheckpoint = IndexCheckpointSchema.parse(JSON.parse(pending) as object);
    } catch {
      throw new DeletionIndexStorageError("index-corrupt", "Pending checkpoint is invalid.");
    }
  }
  try {
    return IndexInspectionSchema.parse({
      authorityLineage: text(row, "authority_lineage"),
      rootId: text(row, "root_id"),
      databaseLineage: text(row, "database_lineage"),
      generation:
        typeof row.generation === "bigint" ? Number(row.generation) : (row.generation as number),
      state: text(row, "state"),
      pendingCheckpoint,
    });
  } catch {
    throw new DeletionIndexStorageError("index-corrupt", "Index metadata is invalid.");
  }
}

function readCheckpoints(
  database: SqliteApplicationDatabase,
  inspection: IndexInspection,
): { rows: readonly SqliteRow[]; pending: IndexCheckpoint | null } {
  const rows = database.readAll(
    "SELECT operation_id, checkpoint_json, targets_json FROM marea_deletion_index_checkpoints ORDER BY operation_id",
  );
  const ids = new Set<string>();
  const incomplete: IndexCheckpoint[] = [];
  for (const row of rows) {
    const checkpoint = parseCheckpoint(row);
    const targets = parseTargets(row);
    if (
      ids.has(checkpoint.operationId) ||
      text(row, "operation_id") !== checkpoint.operationId ||
      checkpoint.authorityLineage !== inspection.authorityLineage ||
      checkpoint.targetCount !== targets.length
    )
      throw new DeletionIndexStorageError("index-corrupt", "Checkpoint data is inconsistent.");
    if (new Set(targets.map(targetIdentity)).size !== targets.length)
      throw new DeletionIndexStorageError("index-corrupt", "Checkpoint data is inconsistent.");
    validateCheckpointState(checkpoint);
    ids.add(checkpoint.operationId);
    if (isIncomplete(checkpoint)) incomplete.push(checkpoint);
  }
  if (incomplete.length > 1)
    throw new DeletionIndexStorageError("index-corrupt", "Multiple pending checkpoints exist.");
  return { rows, pending: incomplete[0] ?? null };
}

function validateGenerationChain(
  checkpoints: readonly SqliteRow[],
  inspection: IndexInspection,
): void {
  const committed = checkpoints
    .map(parseCheckpoint)
    .filter((checkpoint) => checkpoint.durableIntent === "committed")
    .sort((left, right) => left.expectedIndexGeneration - right.expectedIndexGeneration);
  let generation = 0;
  for (const checkpoint of committed) {
    if (checkpoint.nextIndexGeneration !== generation + 1)
      throw new DeletionIndexStorageError("index-corrupt", "Generation chain is inconsistent.");
    generation = checkpoint.nextIndexGeneration;
  }
  if (inspection.generation !== generation)
    throw new DeletionIndexStorageError("index-corrupt", "Authority generation is inconsistent.");
  for (const checkpoint of checkpoints.map(parseCheckpoint)) {
    if (checkpoint.durableIntent !== "none") continue;
    if (checkpoint.expectedIndexGeneration > generation)
      throw new DeletionIndexStorageError("index-corrupt", "Checkpoint generation is stale.");
    if (checkpoint.state !== "failed" && checkpoint.expectedIndexGeneration !== generation)
      throw new DeletionIndexStorageError("index-corrupt", "Checkpoint generation is stale.");
  }
}

function readTombstones(database: SqliteApplicationDatabase): readonly SqliteRow[] {
  return database.readAll(
    "SELECT authority_lineage, target_kind, logical_key, target_json, operation_id FROM marea_deletion_index_tombstones",
  );
}

function validateTombstones(
  rows: readonly SqliteRow[],
  checkpoints: readonly SqliteRow[],
  inspection: IndexInspection,
): void {
  for (const row of rows) {
    const operationId = text(row, "operation_id");
    if (
      text(row, "authority_lineage") !== inspection.authorityLineage ||
      !checkpoints.some((candidate) => text(candidate, "operation_id") === operationId)
    )
      throw new DeletionIndexStorageError("index-corrupt", "Tombstone has no matching checkpoint.");
    const target = parseTarget(parseJson(row, "target_json"));
    if (target.kind !== text(row, "target_kind"))
      throw new DeletionIndexStorageError("index-corrupt", "Tombstone identity is inconsistent.");
    if (targetIdentity(target) !== text(row, "logical_key"))
      throw new DeletionIndexStorageError("index-corrupt", "Tombstone identity is inconsistent.");
  }
}

function validateCheckpointTombstones(
  checkpoints: readonly SqliteRow[],
  tombstones: readonly SqliteRow[],
): void {
  for (const row of checkpoints) {
    const checkpoint = parseCheckpoint(row);
    const targets = parseTargets(row);
    const operationTombstones = tombstones.filter(
      (candidate) => text(candidate, "operation_id") === checkpoint.operationId,
    );
    if (checkpoint.durableIntent !== "committed") {
      if (operationTombstones.length > 0)
        throw new DeletionIndexStorageError("index-corrupt", "Prepared checkpoint has tombstones.");
      continue;
    }
    const actual = new Set(
      operationTombstones.map(
        (candidate) => `${text(candidate, "target_kind")}\u0000${text(candidate, "logical_key")}`,
      ),
    );
    const expected = new Set(
      targets.map((target) => `${target.kind}\u0000${targetIdentity(target)}`),
    );
    if (actual.size !== expected.size)
      throw new DeletionIndexStorageError("index-corrupt", "Committed tombstones are incomplete.");
    if ([...expected].some((key) => !actual.has(key)))
      throw new DeletionIndexStorageError("index-corrupt", "Committed tombstones are incomplete.");
    for (const target of targets) {
      const identity = `${target.kind}\u0000${targetIdentity(target)}`;
      const tombstone = Object.assign(
        Object.create(null) as SqliteRow,
        operationTombstones.find(
          (candidate) =>
            `${text(candidate, "target_kind")}\u0000${text(candidate, "logical_key")}` === identity,
        ),
      );
      if (targetBytes(parseTarget(parseJson(tombstone, "target_json"))) !== targetBytes(target))
        throw new DeletionIndexStorageError(
          "index-corrupt",
          "Committed tombstone payload differs.",
        );
    }
  }
}

export function readConsistentInspection(
  database: SqliteApplicationDatabase,
  expected: StorageConfiguration,
): IndexInspection {
  const metaRow = database.readOne("SELECT * FROM marea_deletion_index_meta WHERE singleton = 1");
  const inspection = inspectFromRow(metaRow, {
    authorityLineage: expected.authorityLineage,
    rootId: expected.rootId,
    databaseLineage: expected.databaseLineage,
  });
  if (inspection.state === "missing") {
    const objects = database.readAll(
      "SELECT name FROM sqlite_schema WHERE name IN ('marea_deletion_index_meta', 'marea_deletion_index_tombstones', 'marea_deletion_index_checkpoints')",
    );
    if (objects.length !== 0)
      throw new DeletionIndexStorageError(
        "index-corrupt",
        "Deletion authority metadata is missing.",
      );
    return inspection;
  }
  if (
    inspection.authorityLineage !== expected.authorityLineage ||
    inspection.rootId !== expected.rootId ||
    inspection.databaseLineage !== expected.databaseLineage
  )
    throw new DeletionIndexStorageError(
      "stale-authority",
      "Configured authority does not match index.",
    );
  const checkpoints = readCheckpoints(database, inspection);
  const pendingCheckpoint = checkpoints.pending;
  if (pendingCheckpoint !== null) {
    const pendingMarker = inspection.pendingCheckpoint ?? pendingCheckpoint;
    if (
      inspection.pendingCheckpoint === null ||
      !checkpointMatches(pendingMarker, pendingCheckpoint)
    )
      throw new DeletionIndexStorageError(
        "index-corrupt",
        "Pending checkpoint marker is inconsistent.",
      );
  }
  if (checkpoints.pending === null && inspection.pendingCheckpoint !== null)
    throw new DeletionIndexStorageError("index-corrupt", "Pending checkpoint marker is orphaned.");
  const tombstones = readTombstones(database);
  validateTombstones(tombstones, checkpoints.rows, inspection);
  validateCheckpointTombstones(checkpoints.rows, tombstones);
  validateGenerationChain(checkpoints.rows, inspection);
  return inspection;
}

export function readCheckpoint(
  database: SqliteApplicationDatabase,
  operationId: string,
): { checkpoint: IndexCheckpoint; targets: readonly TargetRef[] } | undefined {
  const row = database.readOne(
    "SELECT operation_id, checkpoint_json, targets_json FROM marea_deletion_index_checkpoints WHERE operation_id = ?1",
    [operationId],
  );
  return row === undefined
    ? undefined
    : text(row, "operation_id") === operationId
      ? { checkpoint: parseCheckpoint(row), targets: parseTargets(row) }
      : undefined;
}

export function readTombstoneKeys(
  database: SqliteApplicationDatabase,
  authorityLineage: string,
): readonly string[] {
  return database
    .readAll(
      "SELECT logical_key FROM marea_deletion_index_tombstones WHERE authority_lineage = ?1",
      [authorityLineage],
    )
    .map((row) => `${authorityLineage}:${text(row, "logical_key")}`);
}

export { checkpointMatches };
