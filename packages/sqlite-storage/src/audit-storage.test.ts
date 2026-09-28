import { describe, expect, it } from "vitest";

import type { SqliteApplicationDatabase, SqliteParameter, SqliteRow } from "./contracts.js";
import { createMigrationCatalog } from "./migration-catalog.js";
import { activateRetentionAuditSchema, createSqliteAuditStore } from "./audit-storage.js";
import { canonicalJson, validateDispositions, validateOperationInput } from "./audit-validation.js";
import {
  AuditTestDatabase,
  auditArtifactJson,
  auditOperation,
  baseAuditDatabase,
  plannedAuditDisposition,
} from "./audit-test-support.fixture.js";

class FailingDatabase implements SqliteApplicationDatabase {
  public constructor(
    private readonly delegate: AuditTestDatabase,
    private readonly failureNeedle: string,
  ) {}

  public execute(sql: string, parameters: readonly SqliteParameter[] = []): void {
    this.delegate.execute(sql, parameters);
    if (sql.includes(this.failureNeedle)) throw new Error("injected migration interruption");
  }

  public readAll(sql: string, parameters: readonly SqliteParameter[] = []): readonly SqliteRow[] {
    return this.delegate.readAll(sql, parameters);
  }

  public readOne(sql: string, parameters: readonly SqliteParameter[] = []): SqliteRow | undefined {
    return this.delegate.readOne(sql, parameters);
  }

  public transaction<T>(operation: () => T): T {
    return this.delegate.transaction(operation);
  }

  public close(): void {
    this.delegate.close();
  }
}

const operation = auditOperation("operation:one");

const expectActivationRejected = (database: AuditTestDatabase, message: string): void => {
  expect(() => {
    activateRetentionAuditSchema(database);
  }).toThrow(message);
  expect(database.readOne("PRAGMA user_version")).toEqual({ user_version: 8n });
  database.close();
};

describe("SQLite retention audit store", () => {
  it("requires explicit schema activation and persists operation/disposition state", () => {
    const database = baseAuditDatabase();
    activateRetentionAuditSchema(database);
    expect(database.readOne("PRAGMA user_version")).toEqual({ user_version: 9n });
    const store = createSqliteAuditStore(database);
    store.appendPrepared(operation, [
      {
        operationId: operation.operationId,
        targetKind: "account",
        logicalKey: '{"key":{"userId":"user:one"},"kind":"account"}',
        observedJson: '{"kind":"version","version":"v1"}',
        disposition: "planned",
        detailCode: "planned",
        updatedAt: operation.updatedAt,
      },
    ]);
    expect(store.readOperation(operation.operationId)).toMatchObject({ state: "prepared" });
    expect(store.readDispositions(operation.operationId)).toHaveLength(1);
    expect(store.readOperation("operation:missing")).toBeUndefined();
    const artifactValue = JSON.parse(operation.artifactJson) as Record<string, object>;
    const reorderedArtifact = JSON.stringify(
      Object.fromEntries(Object.entries(artifactValue).reverse()),
    );
    store.appendPrepared({ ...operation, artifactJson: reorderedArtifact }, [
      {
        operationId: operation.operationId,
        targetKind: "account",
        logicalKey: '{"key":{"userId":"user:one"},"kind":"account"}',
        observedJson: '{"version":"v1","kind":"version"}',
        disposition: "planned",
        detailCode: "planned",
        updatedAt: operation.updatedAt,
      },
    ]);
    store.updateState(operation.operationId, "index-committed", "2026-09-13T10:00:10.000Z");
    store.updateState(operation.operationId, "content-started", "2026-09-13T10:00:20.000Z");
    store.updateState(operation.operationId, "content-complete", "2026-09-13T10:00:30.000Z");
    store.updateState(operation.operationId, "applied", "2026-09-13T10:01:00.000Z");
    expect(store.readOperation(operation.operationId)?.state).toBe("applied");
    store.appendPrepared(
      {
        ...operation,
        operationId: "operation:two",
        artifactJson: auditArtifactJson(
          "operation:two",
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ),
        errorCode: null,
      },
      [
        {
          operationId: "operation:two",
          targetKind: "account",
          logicalKey: '{"key":{"userId":"user:one"},"kind":"account"}',
          observedJson: "{}",
          disposition: "planned",
          detailCode: null,
          updatedAt: operation.updatedAt,
        },
      ],
    );
    database.close();
  });

  it("rejects malformed operation, target-set and transition evidence", () => {
    const database = baseAuditDatabase();
    activateRetentionAuditSchema(database);
    const store = createSqliteAuditStore(database);
    const planned = plannedAuditDisposition(operation.operationId, operation.updatedAt, null);
    expect(() => {
      store.appendPrepared({ ...operation, state: "applied" }, [planned]);
    }).toThrow();
    expect(() => {
      store.appendPrepared(
        {
          ...operation,
          artifactJson: auditArtifactJson(operation.operationId, "sha256:" + "b".repeat(64)),
        },
        [planned],
      );
    }).toThrow();
    expect(() => {
      store.appendPrepared(operation, []);
    }).toThrow("target count");
    expect(() => {
      store.appendPrepared(operation, [planned, planned]);
    }).toThrow("duplicate");
    store.appendPrepared(operation, [planned]);
    expect(() => {
      store.updateState("operation:missing", "failed", operation.updatedAt);
    }).toThrow("does not exist");
    expect(() => {
      store.updateState(operation.operationId, "applied", operation.updatedAt);
    }).toThrow("transition");
    expect(() => {
      store.updateDisposition({ ...planned, observedJson: '{"changed":true}' });
    }).toThrow("observation");
    expect(() => {
      store.updateDisposition({ ...planned, disposition: "deleted" });
    }).not.toThrow();
    expect(() => {
      store.updateDisposition({ ...planned, disposition: "blocked" });
    }).toThrow("regression");
    database.close();
  });

  it("covers bounded canonical audit validation and stable byte ordering", () => {
    expect(canonicalJson(["z", { a: 1 }])).toBe('["z",{"a":1}]');
    expect(() => canonicalJson({ invalid: undefined })).toThrow("undefined");
    expect(() => {
      validateOperationInput({ ...operation, state: "failed" });
    }).toThrow("prepared");
    const artifactValue = JSON.parse(operation.artifactJson) as Record<string, object>;
    for (const key of [
      "previewId",
      "requestId",
      "authorityLineage",
      "actorBinding",
      "policyRevision",
      "graphDigest",
      "expectedIndexGeneration",
    ]) {
      const missing = Object.fromEntries(
        Object.entries(artifactValue).filter(([entryKey]) => entryKey !== key),
      );
      expect(() => {
        validateOperationInput({ ...operation, artifactJson: JSON.stringify(missing) });
      }).toThrow();
    }
    const invalidGeneration = { ...artifactValue, expectedIndexGeneration: -1 };
    expect(() => {
      validateOperationInput({
        ...operation,
        expectedIndexGeneration: -1,
        artifactJson: JSON.stringify(invalidGeneration),
      });
    }).toThrow();
    const invalidTargets = { ...artifactValue, targets: [{ kind: "account" }] };
    expect(() => {
      validateDispositions({ ...operation, artifactJson: JSON.stringify(invalidTargets) }, [
        {
          operationId: operation.operationId,
          targetKind: "account",
          logicalKey: "account",
          observedJson: "{}",
          disposition: "planned",
          detailCode: null,
          updatedAt: operation.updatedAt,
        },
      ]);
    }).toThrow("target identity");
  });

  it("rejects activation unless the existing catalog is exactly schema 8", () => {
    const database = new AuditTestDatabase();
    database.execute("PRAGMA user_version = 7");
    expect(() => {
      activateRetentionAuditSchema(database);
    }).toThrow("marea_schema_migrations");
    database.close();

    const missingLedger = baseAuditDatabase();
    missingLedger.execute("DELETE FROM marea_schema_migrations WHERE version = 1");
    expect(() => {
      activateRetentionAuditSchema(missingLedger);
    }).toThrow("migration history");
    missingLedger.close();

    const alreadyActivated = baseAuditDatabase();
    alreadyActivated.execute(
      "INSERT INTO marea_schema_migrations (version, name, checksum) VALUES (9, 'create_retention_audit', 'already-present')",
    );
    expect(() => {
      activateRetentionAuditSchema(alreadyActivated);
    }).toThrow("schema does not match");
    alreadyActivated.close();
  });

  it("rejects migration history drift and malformed persisted numeric values", () => {
    const drifted = baseAuditDatabase();
    drifted.execute("UPDATE marea_schema_migrations SET checksum = 'drift' WHERE version = 8");
    expect(() => {
      activateRetentionAuditSchema(drifted);
    }).toThrow("migration history");
    drifted.close();

    const database = baseAuditDatabase();
    activateRetentionAuditSchema(database);
    const store = createSqliteAuditStore(database);
    store.appendPrepared(operation, [
      {
        operationId: operation.operationId,
        targetKind: "account",
        logicalKey: '{"key":{"userId":"user:one"},"kind":"account"}',
        observedJson: "{}",
        disposition: "planned",
        detailCode: null,
        updatedAt: operation.updatedAt,
      },
    ]);
    const malformed: SqliteApplicationDatabase = {
      execute: database.execute.bind(database),
      readAll: database.readAll.bind(database),
      readOne(sql, parameters = []) {
        const row = database.readOne(sql, parameters);
        return sql.startsWith("SELECT operation_id") && row !== undefined
          ? { ...row, expected_index_generation: "0" }
          : row;
      },
      transaction: database.transaction.bind(database),
    };
    expect(() => createSqliteAuditStore(malformed).readOperation(operation.operationId)).toThrow(
      "malformed",
    );
    const numeric: SqliteApplicationDatabase = {
      ...malformed,
      readOne(sql, parameters = []) {
        const row = database.readOne(sql, parameters);
        return sql.startsWith("SELECT operation_id") && row !== undefined
          ? { ...row, expected_index_generation: 0 }
          : row;
      },
    };
    expect(
      createSqliteAuditStore(numeric).readOperation(operation.operationId)?.expectedIndexGeneration,
    ).toBe(0);
    const unsafe: SqliteApplicationDatabase = {
      ...malformed,
      readOne(sql, parameters = []) {
        const row = database.readOne(sql, parameters);
        return sql.startsWith("SELECT operation_id") && row !== undefined
          ? { ...row, expected_index_generation: BigInt(Number.MAX_SAFE_INTEGER) + 1n }
          : row;
      },
    };
    expect(() => createSqliteAuditStore(unsafe).readOperation(operation.operationId)).toThrow(
      "malformed",
    );
    const invalidText: SqliteApplicationDatabase = {
      ...malformed,
      readOne(sql, parameters = []) {
        const row = database.readOne(sql, parameters);
        return sql.startsWith("SELECT operation_id") && row !== undefined
          ? { ...row, operation_id: 1 }
          : row;
      },
    };
    expect(() => createSqliteAuditStore(invalidText).readOperation(operation.operationId)).toThrow(
      "malformed",
    );
    database.close();
  });

  it("rejects drift in every frozen prerequisite migration", () => {
    for (const migration of createMigrationCatalog()) {
      const drifted = baseAuditDatabase();
      drifted.execute("UPDATE marea_schema_migrations SET checksum = 'drift' WHERE version = ?1", [
        migration.version,
      ]);
      expectActivationRejected(drifted, "migration history");
    }
  });

  it("rejects each independent migration identity field drift", () => {
    for (const migration of createMigrationCatalog()) {
      for (const field of ["version", "name", "checksum"] as const) {
        const drifted = baseAuditDatabase();
        const replacement = field === "version" ? migration.version + 100 : "drift";
        drifted.execute(`UPDATE marea_schema_migrations SET ${field} = ?1 WHERE version = ?2`, [
          replacement,
          migration.version,
        ]);
        expect(() => {
          activateRetentionAuditSchema(drifted);
        }).toThrow("migration history");
        expect(drifted.readOne("PRAGMA user_version")).toEqual({ user_version: 8n });
        drifted.close();
      }
    }
    const missingRow = baseAuditDatabase();
    missingRow.execute("DELETE FROM marea_schema_migrations WHERE version = 4");
    expect(() => {
      activateRetentionAuditSchema(missingRow);
    }).toThrow("migration history");
    missingRow.close();
  });

  it("rejects drift in every schema object and rolls back an interrupted activation", () => {
    const latest = createMigrationCatalog().at(-1);
    if (latest === undefined) throw new Error("Expected a migration catalog.");
    for (const schemaObject of latest.schemaAfter) {
      const drifted = baseAuditDatabase();
      if (schemaObject.type === "index") {
        drifted.execute(`DROP INDEX ${schemaObject.name}`);
      } else if (schemaObject.type === "table") {
        drifted.execute(`ALTER TABLE ${schemaObject.name} RENAME TO ${schemaObject.name}_drift`);
      } else {
        throw new Error(`Unexpected prerequisite schema object type: ${schemaObject.type}`);
      }
      expect(() => {
        activateRetentionAuditSchema(drifted);
      }).toThrow("schema");
      expect(drifted.readOne("PRAGMA user_version")).toEqual({ user_version: 8n });
      drifted.close();
    }

    const intact = baseAuditDatabase();
    const failing = new FailingDatabase(intact, "marea_retention_dispositions");
    expect(() => {
      activateRetentionAuditSchema(failing);
    }).toThrow("interruption");
    expect(intact.readOne("PRAGMA user_version")).toEqual({ user_version: 8n });
    expect(
      intact.readAll(
        "SELECT name FROM sqlite_schema WHERE name LIKE 'marea_retention_%' ORDER BY name",
      ),
    ).toEqual([]);
    failing.close();
  });

  it("covers persisted enum/numeric decoding and exactly-once replay predicates", () => {
    const database = baseAuditDatabase();
    activateRetentionAuditSchema(database);
    const store = createSqliteAuditStore(database);
    const planned = plannedAuditDisposition(operation.operationId, operation.updatedAt, null);
    store.appendPrepared(operation, [planned]);
    store.updateState(operation.operationId, "prepared", operation.updatedAt, "none");
    store.updateDisposition(planned);

    const bigintRow: SqliteApplicationDatabase = {
      execute: database.execute.bind(database),
      readAll: database.readAll.bind(database),
      readOne(sql, parameters = []) {
        const row = database.readOne(sql, parameters);
        return sql.startsWith("SELECT operation_id") && row !== undefined
          ? { ...row, expected_index_generation: 0n }
          : row;
      },
      transaction: database.transaction.bind(database),
    };
    expect(
      createSqliteAuditStore(bigintRow).readOperation(operation.operationId)
        ?.expectedIndexGeneration,
    ).toBe(0);

    const invalidState: SqliteApplicationDatabase = {
      ...bigintRow,
      readOne(sql, parameters = []) {
        const row = database.readOne(sql, parameters);
        return sql.startsWith("SELECT operation_id") && row !== undefined
          ? { ...row, state: "unknown" }
          : row;
      },
    };
    expect(() => createSqliteAuditStore(invalidState).readOperation(operation.operationId)).toThrow(
      "operation state",
    );

    const invalidDisposition: SqliteApplicationDatabase = {
      ...bigintRow,
      readAll(sql, parameters = []) {
        const rows = database.readAll(sql, parameters);
        return sql.startsWith("SELECT operation_id")
          ? rows.map((row) => ({ ...row, disposition: "unknown" }))
          : rows;
      },
    };
    expect(() =>
      createSqliteAuditStore(invalidDisposition).readDispositions(operation.operationId),
    ).toThrow("disposition state");
    database.close();
  });

  it("distinguishes every state and disposition replay field", () => {
    const database = baseAuditDatabase();
    activateRetentionAuditSchema(database);
    const store = createSqliteAuditStore(database);
    const planned = plannedAuditDisposition(operation.operationId, operation.updatedAt, null);
    store.appendPrepared(operation, [planned]);

    store.updateState(operation.operationId, "prepared", operation.updatedAt, null);
    store.updateState(operation.operationId, "prepared", "2026-09-13T10:01:00.000Z", null);
    store.updateState(operation.operationId, "prepared", "2026-09-13T10:02:00.000Z", "changed");
    expect(store.readOperation(operation.operationId)).toMatchObject({
      state: "prepared",
      updatedAt: "2026-09-13T10:02:00.000Z",
      errorCode: "changed",
    });

    store.updateDisposition(planned);
    store.updateDisposition({ ...planned, updatedAt: "2026-09-13T10:01:00.000Z" });
    store.updateDisposition({
      ...planned,
      detailCode: "observed",
      updatedAt: "2026-09-13T10:02:00.000Z",
    });
    expect(store.readDispositions(operation.operationId)[0]).toMatchObject({
      disposition: "planned",
      detailCode: "observed",
      updatedAt: "2026-09-13T10:02:00.000Z",
    });
    database.close();
  });
});
