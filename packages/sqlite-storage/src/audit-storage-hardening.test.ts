import { describe, expect, it } from "vitest";

import type { SqliteApplicationDatabase } from "./contracts.js";
import { activateRetentionAuditSchema, createSqliteAuditStore } from "./audit-storage.js";
import { validateDispositions, validateOperationInput } from "./audit-validation.js";
import {
  auditArtifactJson,
  auditOperation,
  baseAuditDatabase,
  plannedAuditDisposition,
} from "./audit-test-support.fixture.js";

const operation = auditOperation("operation:hardening");
const planned = plannedAuditDisposition(operation.operationId, operation.updatedAt);

describe("SQLite audit hardening", () => {
  it("rejects malformed JSON and operation/target bindings", () => {
    expect(() => {
      validateOperationInput({ ...operation, artifactJson: "not-json" });
    }).toThrow("JSON value");
    expect(() => {
      validateOperationInput({ ...operation, artifactJson: "[]" });
    }).toThrow("JSON value");
    expect(() => {
      validateOperationInput({ ...operation, artifactJson: "null" });
    }).toThrow("JSON value");
    for (const primitive of ["true", "1", '"text"']) {
      expect(() => {
        validateOperationInput({ ...operation, artifactJson: primitive });
      }).toThrow("JSON value");
    }
    const nonPreviewArtifact = JSON.stringify({
      format: "other",
      previewId: operation.operationId,
      requestId: operation.requestId,
      authorityLineage: operation.authorityLineage,
      actorBinding: operation.actorBinding,
      policyRevision: operation.policyRevision,
      expectedIndexGeneration: operation.expectedIndexGeneration,
      graphDigest: operation.graphDigest,
    });
    expect(() => {
      validateOperationInput({ ...operation, artifactJson: nonPreviewArtifact });
    }).not.toThrow();
    for (const key of [
      "previewId",
      "requestId",
      "authorityLineage",
      "installationId",
      "sourceDatabaseLineage",
      "actorBinding",
      "policyRevision",
      "expectedIndexGeneration",
      "targets",
      "graphDigest",
      "createdAt",
      "expiresAt",
      "artifactDigest",
    ]) {
      const artifact = Object.fromEntries(
        Object.entries(JSON.parse(operation.artifactJson) as Record<string, object>).filter(
          ([entryKey]) => entryKey !== key,
        ),
      );
      expect(() => {
        validateOperationInput({ ...operation, artifactJson: JSON.stringify(artifact) });
      }).toThrow(`artifact ${key} is required`);
    }
    expect(() => {
      validateOperationInput({
        ...operation,
        artifactJson: auditArtifactJson("operation:other", operation.artifactDigest),
      });
    }).toThrow("does not match");
    expect(() => {
      validateOperationInput({
        ...operation,
        artifactJson: auditArtifactJson(operation.operationId, "sha256:" + "f".repeat(64)),
      });
    }).toThrow("artifact digest");
    expect(() => {
      validateOperationInput({
        ...operation,
        artifactJson: JSON.stringify({
          ...JSON.parse(auditArtifactJson(operation.operationId, operation.artifactDigest)),
          expectedIndexGeneration: -1,
        }),
        expectedIndexGeneration: -1,
      });
    }).toThrow("generation");
    expect(() => {
      validateDispositions(operation, [{ ...planned, operationId: "operation:other" }]);
    }).toThrow("operation binding");
    expect(() => {
      validateDispositions(operation, [{ ...planned, targetKind: "" }]);
    }).toThrow("identity");
    const malformedTargets = JSON.stringify({
      ...JSON.parse(operation.artifactJson),
      targets: [null],
    });
    expect(() => {
      validateDispositions({ ...operation, artifactJson: malformedTargets }, [planned]);
    }).toThrow("target identity");
    const duplicateTargets = JSON.stringify({
      ...JSON.parse(operation.artifactJson),
      targets: [
        { kind: "account", key: { userId: "user:one" }, observed: {} },
        { kind: "account", key: { userId: "user:one" }, observed: {} },
      ],
    });
    expect(() => {
      validateDispositions({ ...operation, artifactJson: duplicateTargets }, [
        planned,
        { ...planned, logicalKey: '{"key":{"userId":"user:two"},"kind":"account"}' },
      ]);
    }).toThrow("duplicate disposition target");
    expect(() => {
      validateDispositions(operation, [{ ...planned, logicalKey: "other" }]);
    }).toThrow("target set");
    expect(() => {
      validateDispositions(operation, [{ ...planned, observedJson: "[]" }]);
    }).toThrow("JSON value");
    expect(() => {
      validateDispositions(operation, [{ ...planned, logicalKey: "", observedJson: "{}" }]);
    }).toThrow("identity");
    const targetWithNullKey = JSON.stringify({
      ...JSON.parse(operation.artifactJson),
      targets: [{ kind: "account", key: null }],
    });
    expect(() => {
      validateDispositions({ ...operation, artifactJson: targetWithNullKey }, [planned]);
    }).toThrow("target identity");
    for (const malformedTarget of [
      { kind: 1, key: {} },
      { kind: "account", key: "not-an-object" },
    ]) {
      expect(() => {
        validateDispositions(
          {
            ...operation,
            artifactJson: JSON.stringify({
              ...JSON.parse(operation.artifactJson),
              targets: [malformedTarget],
            }),
          },
          [planned],
        );
      }).toThrow("target identity");
    }
  });

  it("enforces exact replays and rejects malformed persisted state", () => {
    const database = baseAuditDatabase();
    activateRetentionAuditSchema(database);
    const store = createSqliteAuditStore(database);
    store.appendPrepared(operation, [planned]);
    expect(() => {
      store.appendPrepared({ ...operation, updatedAt: "2026-09-13T10:02:00.000Z" }, [planned]);
    }).toThrow("replay differs");
    expect(() => {
      store.appendPrepared({ ...operation, errorCode: null }, [planned]);
    }).toThrow("replay differs");
    expect(() => {
      store.appendPrepared(operation, [{ ...planned, observedJson: '{"changed":true}' }]);
    }).toThrow("replay differs");
    const multiArtifact = JSON.parse(operation.artifactJson) as Record<string, string | object>;
    multiArtifact.previewId = "operation:multi";
    multiArtifact.targets = [
      {
        kind: "account",
        key: { userId: "user:one" },
        observed: { kind: "version", version: "v1" },
      },
      {
        kind: "account",
        key: { userId: "user:two" },
        observed: { kind: "version", version: "v1" },
      },
    ];
    const multiOperation = {
      ...operation,
      operationId: "operation:multi",
      artifactJson: JSON.stringify(multiArtifact),
    };
    const multiDispositions = [
      planned,
      {
        ...planned,
        operationId: "operation:multi",
        logicalKey: '{"key":{"userId":"user:two"},"kind":"account"}',
      },
    ].map((value) => ({ ...value, operationId: "operation:multi" }));
    const multiFirst = multiDispositions[0];
    if (multiFirst === undefined) throw new Error("Expected a multi-target disposition.");
    store.appendPrepared(multiOperation, multiDispositions);
    store.appendPrepared(multiOperation, [...multiDispositions].reverse());
    database.execute("DELETE FROM marea_retention_dispositions WHERE operation_id = ?1", [
      operation.operationId,
    ]);
    expect(() => {
      store.appendPrepared(operation, [planned]);
    }).toThrow("replay differs");
    database.execute(
      "INSERT INTO marea_retention_dispositions (operation_id, target_kind, logical_key, observed_json, disposition, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [
        operation.operationId,
        planned.targetKind,
        planned.logicalKey,
        "{}",
        "planned",
        operation.updatedAt,
      ],
    );
    store.updateState(operation.operationId, "prepared", operation.updatedAt, operation.errorCode);
    store.updateState(operation.operationId, "prepared", operation.updatedAt, null);
    store.updateState(operation.operationId, "uncertain", "2026-09-13T10:02:10.000Z");
    store.updateState(operation.operationId, "index-committed", "2026-09-13T10:02:20.000Z");
    expect(() => {
      store.updateDisposition({ ...planned, targetKind: "" });
    }).toThrow("does not exist");
    expect(() => {
      store.updateDisposition({ ...planned, logicalKey: "missing" });
    }).toThrow("does not exist");
    store.updateDisposition(planned);
    store.updateDisposition({ ...planned, disposition: "deleted" });
    expect(() => {
      store.updateDisposition({ ...planned, disposition: "deleted", detailCode: "changed" });
    }).toThrow("replay differs");
    const compareAndAdvance: SqliteApplicationDatabase = {
      execute: database.execute.bind(database),
      readAll: database.readAll.bind(database),
      readOne(sql, parameters = []) {
        if (sql.includes("SELECT changes()")) return { count: 0n };
        return database.readOne(sql, parameters);
      },
      transaction: database.transaction.bind(database),
    };
    expect(() => {
      createSqliteAuditStore(compareAndAdvance).updateState(
        multiOperation.operationId,
        "index-committed",
        "2026-09-13T10:03:00.000Z",
      );
    }).toThrow("compare-and-advance");
    expect(() => {
      createSqliteAuditStore(compareAndAdvance).updateDisposition({
        ...multiFirst,
        disposition: "blocked",
      });
    }).toThrow("compare-and-advance");
    const malformedDisposition: SqliteApplicationDatabase = {
      execute: database.execute.bind(database),
      readOne: database.readOne.bind(database),
      readAll(sql, parameters = []) {
        const rows = database.readAll(sql, parameters);
        return sql.includes("marea_retention_dispositions")
          ? rows.map((row) => ({ ...row, disposition: "unexpected" }))
          : rows;
      },
      transaction: database.transaction.bind(database),
    };
    expect(() =>
      createSqliteAuditStore(malformedDisposition).readDispositions(operation.operationId),
    ).toThrow("disposition state");
    const malformedOperation: SqliteApplicationDatabase = {
      execute: database.execute.bind(database),
      readAll: database.readAll.bind(database),
      readOne(sql, parameters = []) {
        const row = database.readOne(sql, parameters);
        return sql.includes("marea_retention_operations") && row !== undefined
          ? { ...row, state: "unexpected" }
          : row;
      },
      transaction: database.transaction.bind(database),
    };
    expect(() =>
      createSqliteAuditStore(malformedOperation).readOperation(operation.operationId),
    ).toThrow("operation state");
    database.close();
  });

  it("verifies migration history, schema and version only inside the activation transaction", () => {
    type Drift = "none" | "ledger" | "schema" | "version" | "integrity";
    const observe = (drift: Drift) => {
      const database = baseAuditDatabase();
      const outsideReads: string[] = [];
      let inTransaction = false;
      const record = (sql: string): void => {
        if (!inTransaction) outsideReads.push(sql);
      };
      const wrapped: SqliteApplicationDatabase = {
        execute: database.execute.bind(database),
        readAll(sql, parameters = []) {
          record(sql);
          const rows = database.readAll(sql, parameters);
          if (drift === "ledger" && sql.includes("marea_schema_migrations"))
            return rows.map((row, index) => (index === 0 ? { ...row, checksum: "drift" } : row));
          if (drift === "schema" && sql.includes("sqlite_schema"))
            return [...rows, { type: "table", name: "zz", tbl_name: "zz", sql: "CREATE TABLE zz" }];
          return rows;
        },
        readOne(sql, parameters = []) {
          record(sql);
          if (drift === "version" && sql === "PRAGMA user_version") return { user_version: 7n };
          if (drift === "integrity" && sql === "PRAGMA quick_check") return { quick_check: "bad" };
          return database.readOne(sql, parameters);
        },
        transaction<T>(operation: () => T): T {
          return database.transaction(() => {
            inTransaction = true;
            try {
              return operation();
            } finally {
              inTransaction = false;
            }
          });
        },
      };
      return { database, outsideReads, wrapped };
    };

    const valid = observe("none");
    activateRetentionAuditSchema(valid.wrapped);
    expect(valid.outsideReads).toEqual([]);
    expect(valid.database.readOne("PRAGMA user_version")).toEqual({ user_version: 9n });
    valid.database.close();

    const expectations: readonly (readonly [Drift, string])[] = [
      ["ledger", "migration history does not match"],
      ["schema", "schema does not match"],
      ["version", "schema does not match"],
      ["integrity", "schema does not match"],
    ];
    for (const [drift, message] of expectations) {
      const rejected = observe(drift);
      expect(() => {
        activateRetentionAuditSchema(rejected.wrapped);
      }).toThrow(message);
      expect(rejected.outsideReads).toEqual([]);
      expect(rejected.database.readOne("PRAGMA user_version")).toEqual({ user_version: 8n });
      expect(
        rejected.database.readAll(
          "SELECT name FROM sqlite_schema WHERE name LIKE 'marea_retention_%'",
        ),
      ).toEqual([]);
      rejected.database.close();
    }
  });
});
