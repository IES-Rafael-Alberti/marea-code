import type { SqliteApplicationDatabase, SqliteRow } from "./contracts.js";
import { createAuditMigrationCatalog } from "./audit-migration-catalog.js";
import { applyPendingMigrations, verifyDatabase } from "./database-schema.js";
import { createMigrationCatalog } from "./migration-catalog.js";
import {
  auditError,
  canonicalJson,
  parseJsonValue,
  validateDispositions,
  validateOperationInput,
} from "./audit-validation.js";

export type AuditOperationState =
  | "prepared"
  | "index-committed"
  | "content-started"
  | "content-complete"
  | "applied"
  | "failed"
  | "uncertain";
export type AuditDisposition = "planned" | "deleted" | "blocked";

export interface AuditOperationInput {
  readonly operationId: string;
  readonly requestId: string;
  readonly authorityLineage: string;
  readonly actorBinding: string;
  readonly policyRevision: string;
  readonly artifactDigest: string;
  readonly graphDigest: string;
  readonly expectedIndexGeneration: number;
  readonly artifactJson: string;
  readonly state: AuditOperationState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly errorCode?: string | null;
}

export interface AuditDispositionInput {
  readonly operationId: string;
  readonly targetKind: string;
  readonly logicalKey: string;
  readonly observedJson: string;
  readonly disposition: AuditDisposition;
  readonly detailCode?: string | null;
  readonly updatedAt: string;
}

export interface AuditOperationRecord extends AuditOperationInput {
  readonly errorCode: string | null;
}

export interface SqliteAuditStore {
  appendPrepared(
    operation: AuditOperationInput,
    dispositions: readonly AuditDispositionInput[],
  ): void;
  updateState(
    operationId: string,
    state: AuditOperationState,
    updatedAt: string,
    errorCode?: string | null,
  ): void;
  updateDisposition(input: AuditDispositionInput): void;
  readOperation(operationId: string): AuditOperationRecord | undefined;
  readDispositions(operationId: string): readonly AuditDispositionInput[];
}

function transitionAllowed(current: AuditOperationState, next: AuditOperationState): boolean {
  if (current === next) return true;
  if (current === "failed" || current === "applied") return false;
  if (next === "uncertain") return true;
  if (next === "failed") return current === "prepared";
  if (current === "uncertain")
    return next === "index-committed" || next === "content-started" || next === "content-complete";
  return (
    (current === "prepared" && next === "index-committed") ||
    (current === "index-committed" && next === "content-started") ||
    (current === "content-started" && next === "content-complete") ||
    (current === "content-complete" && next === "applied")
  );
}

function malformedRow(): never {
  throw new Error("SQLite audit row is malformed.");
}

function text(row: SqliteRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") malformedRow();
  return value;
}

function integer(row: SqliteRow, key: string): number {
  const value = row[key];
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(numeric)) malformedRow();
  return numeric as number;
}

function nullableText(row: SqliteRow, key: string): string | null {
  return row[key] === null ? null : text(row, key);
}

function state(row: SqliteRow): AuditOperationState {
  const value = text(row, "state");
  const states: readonly string[] = [
    "prepared",
    "index-committed",
    "content-started",
    "content-complete",
    "applied",
    "failed",
    "uncertain",
  ];
  if (!states.includes(value)) auditError("operation state");
  return value as AuditOperationState;
}

function disposition(row: SqliteRow): AuditDisposition {
  const value = text(row, "disposition");
  const dispositions: readonly string[] = ["planned", "deleted", "blocked"];
  if (!dispositions.includes(value)) auditError("disposition state");
  return value as AuditDisposition;
}

function parseOperation(row: SqliteRow): AuditOperationRecord {
  return Object.freeze({
    operationId: text(row, "operation_id"),
    requestId: text(row, "request_id"),
    authorityLineage: text(row, "authority_lineage"),
    actorBinding: text(row, "actor_binding"),
    policyRevision: text(row, "policy_revision"),
    artifactDigest: text(row, "artifact_digest"),
    graphDigest: text(row, "graph_digest"),
    expectedIndexGeneration: integer(row, "expected_index_generation"),
    artifactJson: text(row, "artifact_json"),
    state: state(row),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
    errorCode: nullableText(row, "error_code"),
  });
}

function parseDisposition(row: SqliteRow): AuditDispositionInput {
  return Object.freeze({
    operationId: text(row, "operation_id"),
    targetKind: text(row, "target_kind"),
    logicalKey: text(row, "logical_key"),
    observedJson: text(row, "observed_json"),
    disposition: disposition(row),
    detailCode: nullableText(row, "detail_code"),
    updatedAt: text(row, "updated_at"),
  });
}

function readOperationRow(
  database: SqliteApplicationDatabase,
  operationId: string,
): SqliteRow | undefined {
  return database.readOne(
    "SELECT operation_id, request_id, authority_lineage, actor_binding, policy_revision, artifact_digest, graph_digest, expected_index_generation, artifact_json, state, created_at, updated_at, error_code FROM marea_retention_operations WHERE operation_id = ?1",
    [operationId],
  );
}

function readDispositionRows(
  database: SqliteApplicationDatabase,
  operationId: string,
): readonly AuditDispositionInput[] {
  return database
    .readAll(
      "SELECT operation_id, target_kind, logical_key, observed_json, disposition, detail_code, updated_at FROM marea_retention_dispositions WHERE operation_id = ?1 ORDER BY target_kind, logical_key",
      [operationId],
    )
    .map(parseDisposition);
}

function canonicalOperation(operation: AuditOperationInput): string {
  return canonicalJson({
    ...operation,
    artifactJson: canonicalJson(parseJsonValue(operation.artifactJson)),
    errorCode: operation.errorCode ?? null,
  });
}

function dispositionIdentity(value: AuditDispositionInput): string {
  return `${value.targetKind}\u0000${value.logicalKey}`;
}

function canonicalDisposition(value: AuditDispositionInput): string {
  return canonicalJson({
    ...value,
    observedJson: canonicalJson(parseJsonValue(value.observedJson)),
    detailCode: value.detailCode ?? null,
  });
}

function assertExactReplay(
  database: SqliteApplicationDatabase,
  stored: SqliteRow,
  operation: AuditOperationInput,
  dispositions: readonly AuditDispositionInput[],
): void {
  if (canonicalOperation(parseOperation(stored)) !== canonicalOperation(operation))
    auditError("operation replay differs");
  const expected = new Map(
    dispositions.map((value) => [dispositionIdentity(value), canonicalDisposition(value)]),
  );
  const current = readDispositionRows(database, operation.operationId);
  if (
    current.length !== expected.size ||
    current.some(
      (value) => expected.get(dispositionIdentity(value)) !== canonicalDisposition(value),
    )
  )
    auditError("operation replay differs");
}

function assertSingleChange(database: SqliteApplicationDatabase, subject: string): void {
  const changed = database.readOne("SELECT changes() AS count");
  if (Number(changed?.count) !== 1) auditError(`${subject} compare-and-advance`);
}

/** Explicitly activates schema 9; no storage constructor calls this function. */
export function activateRetentionAuditSchema(database: SqliteApplicationDatabase): void {
  const base = createMigrationCatalog();
  database.transaction(() => {
    // Verification runs inside the write transaction that installs schema 9, so
    // no concurrent migration can change the verified history before it is applied.
    verifyDatabase(database, base);
    applyPendingMigrations(database, base.length, createAuditMigrationCatalog());
  });
}

export function createSqliteAuditStore(database: SqliteApplicationDatabase): SqliteAuditStore {
  return Object.freeze({
    appendPrepared(
      operation: AuditOperationInput,
      dispositions: readonly AuditDispositionInput[],
    ): void {
      validateOperationInput(operation);
      validateDispositions(operation, dispositions);
      database.transaction(() => {
        const stored = readOperationRow(database, operation.operationId);
        if (stored !== undefined) {
          assertExactReplay(database, stored, operation, dispositions);
          return;
        }
        database.execute(
          "INSERT INTO marea_retention_operations (operation_id, request_id, authority_lineage, actor_binding, policy_revision, artifact_digest, graph_digest, expected_index_generation, artifact_json, state, created_at, updated_at, error_code) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
          [
            operation.operationId,
            operation.requestId,
            operation.authorityLineage,
            operation.actorBinding,
            operation.policyRevision,
            operation.artifactDigest,
            operation.graphDigest,
            operation.expectedIndexGeneration,
            operation.artifactJson,
            operation.state,
            operation.createdAt,
            operation.updatedAt,
            operation.errorCode ?? null,
          ],
        );
        for (const value of dispositions) {
          database.execute(
            "INSERT INTO marea_retention_dispositions (operation_id, target_kind, logical_key, observed_json, disposition, detail_code, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            [
              value.operationId,
              value.targetKind,
              value.logicalKey,
              value.observedJson,
              value.disposition,
              value.detailCode ?? null,
              value.updatedAt,
            ],
          );
        }
      });
    },
    updateState(
      operationId: string,
      nextState: AuditOperationState,
      updatedAt: string,
      errorCode: string | null = null,
    ): void {
      database.transaction(() => {
        const row = readOperationRow(database, operationId);
        if (row === undefined) auditError("operation does not exist");
        const current = parseOperation(row);
        if (!transitionAllowed(current.state, nextState)) auditError("operation transition");
        database.execute(
          "UPDATE marea_retention_operations SET state = ?1, updated_at = ?2, error_code = ?3 WHERE operation_id = ?4 AND state = ?5 AND updated_at = ?6",
          [nextState, updatedAt, errorCode, operationId, current.state, current.updatedAt],
        );
        assertSingleChange(database, "operation");
      });
    },
    updateDisposition(input: AuditDispositionInput): void {
      database.transaction(() => {
        const row = database.readOne(
          "SELECT disposition, detail_code, observed_json, updated_at FROM marea_retention_dispositions WHERE operation_id = ?1 AND target_kind = ?2 AND logical_key = ?3",
          [input.operationId, input.targetKind, input.logicalKey],
        );
        if (row === undefined) auditError("disposition does not exist");
        if (row.observed_json !== input.observedJson) auditError("disposition observation changed");
        const current = disposition(row);
        if (current !== "planned") {
          if (current !== input.disposition) auditError("disposition regression");
          if (row.detail_code !== (input.detailCode ?? null) || row.updated_at !== input.updatedAt)
            auditError("disposition replay differs");
          return;
        }
        database.execute(
          "UPDATE marea_retention_dispositions SET disposition = ?1, detail_code = ?2, updated_at = ?3 WHERE operation_id = ?4 AND target_kind = ?5 AND logical_key = ?6 AND disposition = 'planned'",
          [
            input.disposition,
            input.detailCode ?? null,
            input.updatedAt,
            input.operationId,
            input.targetKind,
            input.logicalKey,
          ],
        );
        assertSingleChange(database, "disposition");
      });
    },
    readOperation(operationId: string): AuditOperationRecord | undefined {
      const row = readOperationRow(database, operationId);
      return row === undefined ? undefined : parseOperation(row);
    },
    readDispositions(operationId: string): readonly AuditDispositionInput[] {
      return readDispositionRows(database, operationId);
    },
  });
}
