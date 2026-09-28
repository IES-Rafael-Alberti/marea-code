import { describe, expect, it } from "vitest";

import { compareMigrationText, createAuditMigrationCatalog } from "./audit-migration-catalog.js";
import { createRetentionAuditSchema, retentionAuditSchema } from "./audit-schema.js";
import { createMigrationCatalog } from "./migration-catalog.js";

describe("additive retention audit migration catalog", () => {
  it("defines strict operation/disposition tables and their indexes", () => {
    expect(createRetentionAuditSchema()).toEqual(retentionAuditSchema);
    const operation = retentionAuditSchema.find(
      ({ name }) => name === "marea_retention_operations",
    );
    const dispositions = retentionAuditSchema.find(
      ({ name }) => name === "marea_retention_dispositions",
    );
    const operationState = retentionAuditSchema.find(
      ({ name }) => name === "marea_retention_operations_state",
    );
    const dispositionOperation = retentionAuditSchema.find(
      ({ name }) => name === "marea_retention_dispositions_operation",
    );
    expect(operation).toMatchObject({
      name: "marea_retention_operations",
      tableName: "marea_retention_operations",
      type: "table",
    });
    expect(operation?.sql).toContain(
      "artifact_json TEXT NOT NULL CHECK (json_valid(artifact_json))",
    );
    expect(dispositions).toMatchObject({
      name: "marea_retention_dispositions",
      tableName: "marea_retention_dispositions",
      type: "table",
    });
    expect(dispositions?.sql).toContain("PRIMARY KEY (operation_id, target_kind, logical_key)");
    expect(operationState?.sql).toContain("(state, updated_at, operation_id)");
    expect(dispositionOperation?.sql).toContain("(operation_id, disposition)");
    expect(retentionAuditSchema).toEqual([
      {
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
      },
      {
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
      },
      {
        name: "marea_retention_operations_state",
        sql: "CREATE INDEX marea_retention_operations_state ON marea_retention_operations (state, updated_at, operation_id)",
        tableName: "marea_retention_operations",
        type: "index",
      },
      {
        name: "marea_retention_dispositions_operation",
        sql: "CREATE INDEX marea_retention_dispositions_operation ON marea_retention_dispositions (operation_id, disposition)",
        tableName: "marea_retention_dispositions",
        type: "index",
      },
    ]);
  });

  it("keeps migrations 1-8 byte-for-byte and adds only migration 9", () => {
    expect(compareMigrationText("same", "same")).toBe(0);
    expect(compareMigrationText("b", "a")).toBe(1);
    const base = createMigrationCatalog();
    const audit = createAuditMigrationCatalog();
    expect(base).toHaveLength(8);
    expect(audit).toHaveLength(9);
    expect(audit.slice(0, 8)).toEqual(base);
    expect(audit[8]).toMatchObject({ name: "create_retention_audit", version: 9 });
    expect(audit[8]?.statements).toEqual(
      expect.arrayContaining([
        expect.stringContaining("CREATE TABLE marea_retention_operations"),
        expect.stringContaining("CREATE TABLE marea_retention_dispositions"),
      ]),
    );
    expect(
      audit[8]?.schemaAfter
        .filter(({ name }) => name.startsWith("marea_retention_"))
        .map(({ name, tableName, type }) => ({ name, tableName, type })),
    ).toEqual([
      {
        name: "marea_retention_dispositions_operation",
        tableName: "marea_retention_dispositions",
        type: "index",
      },
      {
        name: "marea_retention_operations_state",
        tableName: "marea_retention_operations",
        type: "index",
      },
      {
        name: "marea_retention_dispositions",
        tableName: "marea_retention_dispositions",
        type: "table",
      },
      {
        name: "marea_retention_operations",
        tableName: "marea_retention_operations",
        type: "table",
      },
    ]);
  });

  it("pins the frozen GOVERNANCE migration fingerprints", () => {
    expect(
      createMigrationCatalog().map(({ version, name, checksum }) => ({ version, name, checksum })),
    ).toEqual([
      {
        version: 1,
        name: "create_metadata",
        checksum: "fbad05a3a1a844c8c04a9944a7cce8ff049a147b9090a5c1b7b7bc930ac7666a",
      },
      {
        version: 2,
        name: "create_teacher_runtime",
        checksum: "ce965e512350c55ca8b530459ed7a587c661017186d1871454bd20da346e3fe8",
      },
      {
        version: 3,
        name: "create_teaching_snapshots",
        checksum: "d06c58d2ff3f62ae0f7af3da8d3eeb5da620de5c5322fb3f7b493d8d618aa10c",
      },
      {
        version: 4,
        name: "create_teacher_notices",
        checksum: "5756c805699850a7ec3bb63dba1a22cc4a95479cb64bd2b15e078343b6f6fc08",
      },
      {
        version: 5,
        name: "create_usage_reservations",
        checksum: "1d242dc70b280838c3d35d4603bdeb0877ccbcbf3bc1ab2e6e07827971cbd9fa",
      },
      {
        version: 6,
        name: "create_evaluation_queue",
        checksum: "1d988283dc6e0999c83c1d243a711198b842a0cd4ed0408c9c1e8bcd5cb1e19a",
      },
      {
        version: 7,
        name: "create_governance_schema",
        checksum: "1ca99491467f3b4435048668690c6bb9c507b44c5bce4fc2c39ab33c59943f5a",
      },
      {
        version: 8,
        name: "explicit_teaching_revision_authorship",
        checksum: "bf3f5162ac2a18b16823ad5ff2a7e2d03bc823ee9e0b9ee2f38ed8b41c40325b",
      },
    ]);
  });
});
