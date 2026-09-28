import type { SchemaObjectDefinition } from "./migration-catalog.js";

export function createRetentionAuditSchema(): readonly SchemaObjectDefinition[] {
  const operation: SchemaObjectDefinition = {
    name: "marea_retention_operations",
    sql: `CREATE TABLE marea_retention_operations (
    operation_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    authority_lineage TEXT NOT NULL,
    actor_binding TEXT NOT NULL,
    policy_revision TEXT NOT NULL,
    artifact_digest TEXT NOT NULL,
    graph_digest TEXT NOT NULL,
    expected_index_generation INTEGER NOT NULL CHECK (expected_index_generation >= 0),
    artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json)),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'index-committed', 'content-started', 'content-complete', 'applied', 'failed', 'uncertain')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    error_code TEXT
  ) STRICT`,
    tableName: "marea_retention_operations",
    type: "table",
  };

  const disposition: SchemaObjectDefinition = {
    name: "marea_retention_dispositions",
    sql: `CREATE TABLE marea_retention_dispositions (
    operation_id TEXT NOT NULL REFERENCES marea_retention_operations(operation_id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL,
    logical_key TEXT NOT NULL,
    observed_json TEXT NOT NULL CHECK (json_valid(observed_json)),
    disposition TEXT NOT NULL CHECK (disposition IN ('planned', 'deleted', 'blocked')),
    detail_code TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (operation_id, target_kind, logical_key)
  ) WITHOUT ROWID, STRICT`,
    tableName: "marea_retention_dispositions",
    type: "table",
  };

  const operationState: SchemaObjectDefinition = {
    name: "marea_retention_operations_state",
    sql: "CREATE INDEX marea_retention_operations_state ON marea_retention_operations (state, updated_at, operation_id)",
    tableName: "marea_retention_operations",
    type: "index",
  };

  const dispositionOperation: SchemaObjectDefinition = {
    name: "marea_retention_dispositions_operation",
    sql: "CREATE INDEX marea_retention_dispositions_operation ON marea_retention_dispositions (operation_id, disposition)",
    tableName: "marea_retention_dispositions",
    type: "index",
  };

  return [operation, disposition, operationState, dispositionOperation];
}

export const retentionAuditSchema: readonly SchemaObjectDefinition[] = createRetentionAuditSchema();
