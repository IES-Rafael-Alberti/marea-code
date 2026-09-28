import { describe, expect, it } from "vitest";

import type { SqliteRow } from "./contracts.js";
import { activateRetentionAuditSchema, createSqliteAuditStore } from "./audit-storage.js";
import { validateOperationInput } from "./audit-validation.js";
import {
  auditOperation,
  baseAuditDatabase,
  plannedAuditDisposition,
} from "./audit-test-support.fixture.js";

const operation = auditOperation("operation:persistence");

describe("SQLite audit persistence contracts", () => {
  it("decodes persisted integers strictly", () => {
    const database = baseAuditDatabase();
    activateRetentionAuditSchema(database);
    createSqliteAuditStore(database).appendPrepared(operation, [
      plannedAuditDisposition(operation.operationId, operation.updatedAt),
    ]);
    const withGeneration = (generation: SqliteRow[string]) =>
      createSqliteAuditStore({
        execute: database.execute.bind(database),
        readAll: database.readAll.bind(database),
        readOne(sql, parameters = []) {
          const row = database.readOne(sql, parameters);
          return row === undefined ? row : { ...row, expected_index_generation: generation };
        },
        transaction: database.transaction.bind(database),
      }).readOperation(operation.operationId)?.expectedIndexGeneration;
    expect(withGeneration(3n)).toBe(3);
    expect(withGeneration(3)).toBe(3);
    for (const malformed of ["3", 1.5, 2n ** 60n, null]) {
      expect(() => withGeneration(malformed)).toThrow("malformed");
    }
    database.close();
  });

  it("accepts only exact replays of settled dispositions", () => {
    const database = baseAuditDatabase();
    activateRetentionAuditSchema(database);
    const store = createSqliteAuditStore(database);
    const planned = plannedAuditDisposition(operation.operationId, operation.updatedAt);
    store.appendPrepared(operation, [planned]);
    const blocked = {
      ...planned,
      disposition: "blocked" as const,
      detailCode: "active-reference",
      updatedAt: "2026-09-13T10:05:00.000Z",
    };
    store.updateDisposition(blocked);
    store.updateDisposition(blocked);
    expect(store.readDispositions(operation.operationId)).toEqual([
      { ...blocked, detailCode: "active-reference" },
    ]);
    expect(() => {
      store.updateDisposition({ ...blocked, updatedAt: "2026-09-13T10:06:00.000Z" });
    }).toThrow("replay differs");
    expect(() => {
      store.updateDisposition({ ...blocked, detailCode: null });
    }).toThrow("replay differs");
    expect(() => {
      store.updateDisposition({ ...blocked, disposition: "deleted" });
    }).toThrow("regression");
    expect(() => {
      store.updateDisposition({ ...blocked, disposition: "planned" });
    }).toThrow("regression");
    database.close();
  });

  it("fails closed when the change count cannot be observed", () => {
    const database = baseAuditDatabase();
    activateRetentionAuditSchema(database);
    const planned = plannedAuditDisposition(operation.operationId, operation.updatedAt);
    createSqliteAuditStore(database).appendPrepared(operation, [planned]);
    const blind = createSqliteAuditStore({
      execute: database.execute.bind(database),
      readAll: database.readAll.bind(database),
      readOne(sql, parameters = []) {
        return sql.includes("changes()") ? undefined : database.readOne(sql, parameters);
      },
      transaction: database.transaction.bind(database),
    });
    expect(() => {
      blind.updateState(operation.operationId, "failed", "2026-09-13T10:01:00.000Z");
    }).toThrow("operation compare-and-advance");
    expect(() => {
      blind.updateDisposition({ ...planned, disposition: "deleted" });
    }).toThrow("disposition compare-and-advance");
    const store = createSqliteAuditStore(database);
    expect(store.readOperation(operation.operationId)?.state).toBe("prepared");
    expect(store.readDispositions(operation.operationId)[0]?.disposition).toBe("planned");
    database.close();
  });

  it("binds every artifact identity field to the operation", () => {
    const artifact = JSON.parse(operation.artifactJson) as Record<string, string | number>;
    for (const key of [
      "previewId",
      "requestId",
      "authorityLineage",
      "actorBinding",
      "policyRevision",
      "graphDigest",
      "expectedIndexGeneration",
    ]) {
      const changed = { ...artifact, [key]: key === "expectedIndexGeneration" ? 1 : "other" };
      expect(() => {
        validateOperationInput({ ...operation, artifactJson: JSON.stringify(changed) });
      }).toThrow(`artifact ${key} does not match operation`);
    }
    expect(() => {
      validateOperationInput({ ...operation, artifactJson: "not-json" });
    }).toThrow(/invalid: JSON value$/u);
  });

  it("rejects a replay in which any single disposition differs", () => {
    const database = baseAuditDatabase();
    activateRetentionAuditSchema(database);
    const store = createSqliteAuditStore(database);
    const artifact = JSON.parse(operation.artifactJson) as Record<string, object>;
    const targets = ["user:one", "user:two"].map((userId) => ({
      kind: "account",
      key: { userId },
      observed: {},
    }));
    const multi = { ...operation, artifactJson: JSON.stringify({ ...artifact, targets }) };
    const [first, second] = targets.map((target) => ({
      ...plannedAuditDisposition(operation.operationId, operation.updatedAt, null),
      logicalKey: JSON.stringify({ key: target.key, kind: target.kind }),
    }));
    if (first === undefined || second === undefined) throw new Error("Expected two dispositions.");
    store.appendPrepared(multi, [first, second]);
    store.appendPrepared(multi, [second, first]);
    expect(() => {
      store.appendPrepared(multi, [first, { ...second, detailCode: "x" }]);
    }).toThrow("replay differs");
    database.close();
  });
});
