import type { SqliteApplicationDatabase, SqliteRow } from "@marea/sqlite-storage";

import {
  assertCreatable,
  parseTarget,
  reconcileRestoredTargets,
  targetIdentity,
  transitionCheckpoint,
  type DeletionIndex,
} from "../index.js";
import {
  IndexCheckpointSchema,
  IndexInspectionSchema,
  PreparedDeletionSchema,
  RestoredDatabaseIdentitySchema,
  type CreationGateResult,
  type IndexCheckpoint,
  type IndexInspection,
  type Reconciliation,
  type RestoredDatabaseIdentity,
  type TargetRef,
} from "../index.js";
import { canonicalizeStorageConfiguration, type StorageConfiguration } from "./configuration.js";
import { DeletionIndexStorageError } from "./deletion-index-errors.js";
import {
  checkpointMatches,
  checkpointBytes,
  inspectFromRow,
  readCheckpoint,
  readConsistentInspection,
  readTombstoneKeys,
  targetSet,
  targetBytes,
} from "./sqlite-deletion-index-inspection.js";

function invalidTransitionError(): DeletionIndexStorageError {
  return new DeletionIndexStorageError("invalid-transition", "Index checkpoint is not current.");
}

type DeletionIndexSchema = readonly [string, string, string];

function deletionIndexSchema(): DeletionIndexSchema {
  return [
    `CREATE TABLE marea_deletion_index_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  authority_lineage TEXT NOT NULL,
  root_id TEXT NOT NULL,
  database_lineage TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'transfer-prepared', 'retired', 'uncertain', 'missing', 'corrupt')),
  pending_checkpoint_json TEXT CHECK (pending_checkpoint_json IS NULL OR json_valid(pending_checkpoint_json))
) STRICT`,
    `CREATE TABLE marea_deletion_index_tombstones (
  authority_lineage TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  operation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (authority_lineage, target_kind, logical_key)
) WITHOUT ROWID, STRICT`,
    `CREATE TABLE marea_deletion_index_checkpoints (
  operation_id TEXT PRIMARY KEY,
  checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json)),
  targets_json TEXT NOT NULL CHECK (json_valid(targets_json))
) STRICT`,
  ];
}

export const DELETION_INDEX_SCHEMA = Object.freeze(deletionIndexSchema());

export function normalizeSql(sql: string): string {
  return sql.replaceAll(/\s+/gu, " ").trim().replaceAll("IF NOT EXISTS ", "");
}

function readUserSchema(database: SqliteApplicationDatabase): readonly SqliteRow[] {
  return database.readAll(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
  );
}

function validateSchema(
  database: SqliteApplicationDatabase,
  schema: DeletionIndexSchema = deletionIndexSchema(),
): boolean {
  const actual = readUserSchema(database).map((row) => ({
    type: text(row, "type"),
    name: text(row, "name"),
    tableName: text(row, "tbl_name"),
    sql: normalizeSql(text(row, "sql")),
  }));
  const expected: readonly { type: string; name: string; tableName: string; sql: string }[] = [
    {
      type: "table",
      name: "marea_deletion_index_checkpoints",
      tableName: "marea_deletion_index_checkpoints",
      sql: normalizeSql(schema[2]),
    },
    {
      type: "table",
      name: "marea_deletion_index_meta",
      tableName: "marea_deletion_index_meta",
      sql: normalizeSql(schema[0]),
    },
    {
      type: "table",
      name: "marea_deletion_index_tombstones",
      tableName: "marea_deletion_index_tombstones",
      sql: normalizeSql(schema[1]),
    },
  ];
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export { DeletionIndexStorageError } from "./deletion-index-errors.js";

export interface DurableDeletionIndex extends DeletionIndex {
  startContent(input: IndexCheckpoint): Promise<IndexCheckpoint>;
  completeContent(input: IndexCheckpoint): Promise<IndexCheckpoint>;
  markUncertain(input: IndexCheckpoint): Promise<IndexCheckpoint>;
  /** Returns an uncertain checkpoint with committed intent to in-progress content removal. */
  resumeContent(input: IndexCheckpoint): Promise<IndexCheckpoint>;
  failBeforeIntent(input: IndexCheckpoint): Promise<IndexCheckpoint>;
}

export interface RestoredTargetReader {
  read(input: RestoredDatabaseIdentity): Promise<readonly TargetRef[]>;
}

function requireActive(inspection: IndexInspection, generation: number): void {
  if (inspection.state === "missing")
    throw new DeletionIndexStorageError("missing-authority", "Deletion authority is missing.");
  if (inspection.state !== "active") {
    throw new DeletionIndexStorageError("stale-authority", "Deletion authority is stale.");
  }
  if (inspection.generation !== generation) {
    throw new DeletionIndexStorageError("stale-authority", "Deletion authority is stale.");
  }
  if (inspection.pendingCheckpoint !== null)
    throw new DeletionIndexStorageError(
      "pending-checkpoint",
      "Deletion index has a pending checkpoint.",
    );
}

function text(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string")
    throw new DeletionIndexStorageError("index-corrupt", "Index data is invalid.");
  return value;
}

function updateCheckpoint(
  database: SqliteApplicationDatabase,
  checkpoint: IndexCheckpoint,
  pending: boolean,
): void {
  database.execute(
    "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1 WHERE operation_id = ?2",
    [checkpointBytes(checkpoint), checkpoint.operationId],
  );
  database.execute(
    "UPDATE marea_deletion_index_meta SET pending_checkpoint_json = ?1 WHERE singleton = 1",
    [pending ? checkpointBytes(checkpoint) : null],
  );
}

export function initializeDeletionIndex(
  database: SqliteApplicationDatabase,
  configuration: StorageConfiguration,
): void {
  configuration = canonicalizeStorageConfiguration(configuration);
  const schema = deletionIndexSchema();
  database.transaction(() => {
    const existing = readUserSchema(database);
    if (existing.length === 0) {
      for (const statement of schema) database.execute(statement);
      if (!validateSchema(database, schema))
        throw new DeletionIndexStorageError("index-corrupt", "Deletion index schema is invalid.");
    } else {
      if (!validateSchema(database, schema))
        throw new DeletionIndexStorageError("index-corrupt", "Deletion index schema is foreign.");
      const meta = database.readOne("SELECT * FROM marea_deletion_index_meta WHERE singleton = 1");
      if (meta === undefined)
        throw new DeletionIndexStorageError(
          "missing-authority",
          "Existing deletion index has no durable authority.",
        );
    }
    if (existing.length === 0)
      database.execute(
        "INSERT INTO marea_deletion_index_meta (singleton, authority_lineage, root_id, database_lineage, generation, state, pending_checkpoint_json) VALUES (1, ?1, ?2, ?3, 0, 'active', NULL)",
        [configuration.authorityLineage, configuration.rootId, configuration.databaseLineage],
      );
    const meta = database.readOne("SELECT * FROM marea_deletion_index_meta WHERE singleton = 1");
    const inspection = inspectFromRow(meta, configuration);
    if (
      inspection.authorityLineage !== configuration.authorityLineage ||
      inspection.rootId !== configuration.rootId ||
      inspection.databaseLineage !== configuration.databaseLineage
    )
      throw new DeletionIndexStorageError(
        "stale-authority",
        "Deletion authority is not compatible.",
      );
    if (inspection.state !== "active")
      throw new DeletionIndexStorageError(
        "stale-authority",
        "Deletion authority is not compatible.",
      );
    readConsistentInspection(database, configuration);
  });
}

function creationGate(
  database: SqliteApplicationDatabase,
  expected: StorageConfiguration,
  target: TargetRef,
): CreationGateResult {
  const parsed = parseTarget(target);
  try {
    const inspection = readConsistentInspection(database, expected);
    return assertCreatable(
      parsed,
      inspection.state === "missing" ? null : inspection,
      readTombstoneKeys(database, expected.authorityLineage),
    );
  } catch {
    return { allowed: false, code: "corrupt" };
  }
}

export interface CreationGate {
  check(target: TargetRef): CreationGateResult;
}

/** The deletion index creation gate for callers deciding inside an application transaction. */
export function createSqliteCreationGate(
  database: SqliteApplicationDatabase,
  configuration: StorageConfiguration,
): CreationGate {
  const expected = canonicalizeStorageConfiguration(configuration);
  return Object.freeze({ check: (target: TargetRef) => creationGate(database, expected, target) });
}

export function createSqliteDeletionIndex(
  database: SqliteApplicationDatabase,
  configuration: StorageConfiguration,
  restoredTargetReader?: RestoredTargetReader,
): DurableDeletionIndex {
  const expected = canonicalizeStorageConfiguration(configuration);
  return Object.freeze({
    inspect(): Promise<IndexInspection> {
      try {
        return Promise.resolve(readConsistentInspection(database, expected));
      } catch {
        return Promise.resolve(
          IndexInspectionSchema.parse({
            authorityLineage: expected.authorityLineage,
            rootId: expected.rootId,
            databaseLineage: expected.databaseLineage,
            generation: 0,
            state: "corrupt",
            pendingCheckpoint: null,
          }),
        );
      }
    },
    prepare(input: import("../schemas.js").PreparedDeletion): Promise<IndexCheckpoint> {
      const prepared = PreparedDeletionSchema.parse(input);
      const inspection = readConsistentInspection(database, expected);
      if (prepared.authorityLineage !== expected.authorityLineage)
        throw new DeletionIndexStorageError("stale-authority", "Deletion authority is stale.");
      requireActive(inspection, prepared.expectedIndexGeneration);
      const ids = targetSet(prepared.targets);
      if (ids.size !== prepared.targets.length)
        throw new DeletionIndexStorageError(
          "tombstoned-identity",
          "Deletion targets contain duplicate identities.",
        );
      const existing = readTombstoneKeys(database, expected.authorityLineage);
      if (
        prepared.targets.some((target) =>
          existing.includes(`${expected.authorityLineage}:${targetIdentity(target)}`),
        )
      )
        throw new DeletionIndexStorageError(
          "tombstoned-identity",
          "Deletion target identity is already tombstoned.",
        );
      const checkpoint = IndexCheckpointSchema.parse({
        operationId: prepared.operationId,
        authorityLineage: prepared.authorityLineage,
        expectedIndexGeneration: prepared.expectedIndexGeneration,
        nextIndexGeneration: prepared.expectedIndexGeneration + 1,
        targetCount: prepared.targets.length,
        artifactDigest: prepared.artifactDigest,
        state: "prepared",
        contentState: "pending",
        durableIntent: "none",
      });
      database.transaction(() => {
        const current = readConsistentInspection(database, expected);
        requireActive(current, prepared.expectedIndexGeneration);
        const existing = readTombstoneKeys(database, current.authorityLineage);
        if (
          prepared.targets.some((target) =>
            existing.includes(`${current.authorityLineage}:${targetIdentity(target)}`),
          )
        )
          throw new DeletionIndexStorageError(
            "tombstoned-identity",
            "Deletion target identity is already tombstoned.",
          );
        database.execute(
          "INSERT INTO marea_deletion_index_checkpoints (operation_id, checkpoint_json, targets_json) VALUES (?1, ?2, ?3)",
          [prepared.operationId, checkpointBytes(checkpoint), JSON.stringify(prepared.targets)],
        );
        database.execute(
          "UPDATE marea_deletion_index_meta SET pending_checkpoint_json = ?1 WHERE singleton = 1",
          [checkpointBytes(checkpoint)],
        );
      });
      return Promise.resolve(checkpoint);
    },
    commit(input: IndexCheckpoint): Promise<IndexCheckpoint> {
      const requested = IndexCheckpointSchema.parse(input);
      let result: IndexCheckpoint | undefined;
      database.transaction(() => {
        const stored = readCheckpoint(database, requested.operationId);
        if (stored === undefined || !checkpointMatches(stored.checkpoint, requested))
          throw new DeletionIndexStorageError(
            "invalid-transition",
            "Index checkpoint is not current.",
          );
        const inspection = readConsistentInspection(database, expected);
        if (stored.checkpoint.state === "committed") {
          if (inspection.state !== "active")
            throw new DeletionIndexStorageError("stale-authority", "Deletion authority is stale.");
          if (inspection.generation !== requested.nextIndexGeneration)
            throw new DeletionIndexStorageError("stale-authority", "Deletion authority is stale.");
          result = stored.checkpoint;
          return;
        }
        if (stored.checkpoint.state !== "prepared")
          throw new DeletionIndexStorageError(
            "invalid-transition",
            "Index checkpoint cannot be committed.",
          );
        if (inspection.state !== "active")
          throw new DeletionIndexStorageError("stale-authority", "Deletion authority is stale.");
        if (inspection.pendingCheckpoint === null)
          throw new DeletionIndexStorageError(
            "pending-checkpoint",
            "Deletion index has a pending checkpoint.",
          );
        const committed = IndexCheckpointSchema.parse({
          ...requested,
          state: "committed",
          durableIntent: "committed",
          contentState: "pending",
        });
        for (const target of stored.targets) {
          database.execute(
            "INSERT INTO marea_deletion_index_tombstones (authority_lineage, target_kind, logical_key, target_json, operation_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            [
              expected.authorityLineage,
              target.kind,
              targetIdentity(target),
              targetBytes(target),
              requested.operationId,
              new Date().toISOString(),
            ],
          );
        }
        database.execute(
          "UPDATE marea_deletion_index_checkpoints SET checkpoint_json = ?1 WHERE operation_id = ?2",
          [checkpointBytes(committed), requested.operationId],
        );
        database.execute(
          "UPDATE marea_deletion_index_meta SET generation = ?1, pending_checkpoint_json = ?2 WHERE singleton = 1",
          [committed.nextIndexGeneration, checkpointBytes(committed)],
        );
        result = committed;
      });
      if (result === undefined)
        throw new DeletionIndexStorageError("invalid-transition", "Commit did not persist.");
      return Promise.resolve(result);
    },
    reconcile(input: RestoredDatabaseIdentity): Promise<Reconciliation> {
      const identity = RestoredDatabaseIdentitySchema.parse(input);
      return (async () => {
        const inspection = readConsistentInspection(database, expected);
        if (restoredTargetReader === undefined)
          return {
            state: "blocked",
            currentIndexGeneration: inspection.generation,
            checked: 0,
            tombstoned: [],
            reasonCode: "unknown-ancestry",
          };
        const targets = await restoredTargetReader.read(identity);
        // The reader may suspend while another maintenance operation commits.
        // Re-read both authority and tombstones after enumeration so the result
        // cannot be based on a pre-commit snapshot.
        const current = readConsistentInspection(database, expected);
        const tombstones = readTombstoneKeys(database, expected.authorityLineage);
        return reconcileRestoredTargets(identity, current, targets.map(parseTarget), tombstones);
      })();
    },
    assertCreatable(target: TargetRef): Promise<CreationGateResult> {
      return Promise.resolve(creationGate(database, expected, target));
    },
    startContent(input: IndexCheckpoint): Promise<IndexCheckpoint> {
      return transitionAndPersist(database, expected, input, { type: "content-started" }, true);
    },
    completeContent(input: IndexCheckpoint): Promise<IndexCheckpoint> {
      return transitionAndPersist(database, expected, input, { type: "content-complete" }, false);
    },
    markUncertain(input: IndexCheckpoint): Promise<IndexCheckpoint> {
      return transitionAndPersist(database, expected, input, { type: "mark-uncertain" }, true);
    },
    resumeContent(input: IndexCheckpoint): Promise<IndexCheckpoint> {
      return transitionAndPersist(database, expected, input, { type: "resume-content" }, true);
    },
    failBeforeIntent(input: IndexCheckpoint): Promise<IndexCheckpoint> {
      return transitionAndPersist(
        database,
        expected,
        input,
        { type: "mark-failed", committedTombstones: false },
        false,
      );
    },
  });
}

function transitionAndPersist(
  database: SqliteApplicationDatabase,
  configuration: StorageConfiguration,
  input: IndexCheckpoint,
  event: Parameters<typeof transitionCheckpoint>[1],
  pending: boolean,
): Promise<IndexCheckpoint> {
  const requested = IndexCheckpointSchema.parse(input);
  let next: IndexCheckpoint | undefined;
  database.transaction(() => {
    const stored = readCheckpoint(database, requested.operationId);
    if (stored === undefined) throw invalidTransitionError();
    if (!checkpointMatches(stored.checkpoint, requested)) throw invalidTransitionError();
    const transition = transitionCheckpoint(stored.checkpoint, event);
    if (!transition.accepted)
      throw new DeletionIndexStorageError(
        "invalid-transition",
        "Index checkpoint transition is invalid.",
      );
    const inspection = readConsistentInspection(database, configuration);
    if (inspection.state !== "active")
      throw new DeletionIndexStorageError("stale-authority", "Deletion authority is stale.");
    const pendingCheckpoint = inspection.pendingCheckpoint ?? stored.checkpoint;
    if (inspection.pendingCheckpoint === null)
      throw new DeletionIndexStorageError("stale-authority", "Deletion authority is stale.");
    if (!checkpointMatches(pendingCheckpoint, stored.checkpoint))
      throw new DeletionIndexStorageError("stale-authority", "Deletion authority is stale.");
    next = IndexCheckpointSchema.parse({
      ...stored.checkpoint,
      state: transition.state,
      contentState: transition.contentState,
      durableIntent: transition.durableIntent,
    });
    updateCheckpoint(database, next, pending);
  });
  if (next === undefined)
    throw new DeletionIndexStorageError("invalid-transition", "Transition did not persist.");
  return Promise.resolve(next);
}
