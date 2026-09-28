import { describe, expect, it } from "vitest";

import {
  activateRetentionAuditSchema,
  createSqliteAuditStore,
  type AuditOperationState,
} from "./audit-storage.js";
import {
  auditOperation,
  baseAuditDatabase,
  plannedAuditDisposition,
} from "./audit-test-support.fixture.js";

const states: readonly AuditOperationState[] = [
  "prepared",
  "index-committed",
  "content-started",
  "content-complete",
  "applied",
  "failed",
  "uncertain",
];

const pathTo: Readonly<Record<AuditOperationState, readonly AuditOperationState[]>> = {
  prepared: [],
  "index-committed": ["index-committed"],
  "content-started": ["index-committed", "content-started"],
  "content-complete": ["index-committed", "content-started", "content-complete"],
  applied: ["index-committed", "content-started", "content-complete", "applied"],
  failed: ["failed"],
  uncertain: ["uncertain"],
};

const allowed: Readonly<Record<AuditOperationState, readonly AuditOperationState[]>> = {
  prepared: ["prepared", "index-committed", "failed", "uncertain"],
  "index-committed": ["index-committed", "content-started", "uncertain"],
  "content-started": ["content-started", "content-complete", "uncertain"],
  "content-complete": ["content-complete", "applied", "uncertain"],
  applied: ["applied"],
  failed: ["failed"],
  uncertain: ["uncertain", "index-committed", "content-started", "content-complete"],
};

function storeAt(current: AuditOperationState) {
  const operationId = `operation:${current}`;
  const database = baseAuditDatabase();
  activateRetentionAuditSchema(database);
  const store = createSqliteAuditStore(database);
  store.appendPrepared(auditOperation(operationId, {}), [
    plannedAuditDisposition(operationId, "2026-09-13T10:00:00.000Z"),
  ]);
  for (const [index, step] of pathTo[current].entries()) {
    store.updateState(operationId, step, `2026-09-13T10:0${String(index + 1)}:00.000Z`);
  }
  return { database, operationId, store };
}

describe("SQLite audit state transitions", () => {
  it("accepts exactly the allowed transition matrix", () => {
    for (const current of states) {
      for (const next of states) {
        const { database, operationId, store } = storeAt(current);
        const transition = (): void => {
          store.updateState(operationId, next, "2026-09-13T11:00:00.000Z", "code");
        };
        if (allowed[current].includes(next)) {
          transition();
          expect(store.readOperation(operationId)).toMatchObject({
            state: next,
            updatedAt: "2026-09-13T11:00:00.000Z",
            errorCode: "code",
          });
        } else {
          expect(transition).toThrow("operation transition");
          expect(store.readOperation(operationId)?.state).toBe(current);
        }
        database.close();
      }
    }
  });

  it("stores a null error code when none is supplied", () => {
    const { database, operationId, store } = storeAt("prepared");
    store.updateState(operationId, "index-committed", "2026-09-13T11:00:00.000Z");
    expect(store.readOperation(operationId)?.errorCode).toBeNull();
    database.close();
  });
});
