import { CanonicalRunEventSchema } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import { DatabaseFake } from "../../../test-support/database-fake.js";
import { activeLeaseRow, activeRunProjection } from "./sqlite-run-repository.test-support.js";
import { SqliteRunSessionRepository } from "./sqlite-run-session-repository.js";

const INPUT = {
  closedAt: "2026-09-03T10:05:00.000Z",
  closingEventId: "event:closed",
  leaseTokenHash: "digest:lease",
  reason: "student-exit" as const,
};

describe("SQLite run close repository", () => {
  it("closes once, appends its canonical event, removes projection, and revokes leases", () => {
    const database = new DatabaseFake();
    database.oneRows.push(
      { run_id: "run:1", state: "active" },
      activeLeaseRow(),
      activeRunProjection(3),
    );
    expect(new SqliteRunSessionRepository(database).closeRun(INPUT)).toEqual({
      alreadyClosed: false,
      runId: "run:1",
    });
    expect(database.reads.slice(0, 2).map(({ parameters }) => parameters)).toEqual([
      ["digest:lease"],
      ["digest:lease", "2026-09-03T10:05:00.000Z"],
    ]);
    expect(database.reads[0]?.sql).toContain("marea_run_leases");
    expect(database.reads[1]?.sql).toContain("provider_route_json");
    expect(database.executions).toHaveLength(4);
    expect(database.executions.every(({ sql }) => sql.length > 0)).toBe(true);
    expect(database.executions[0]?.parameters).toEqual([
      "event:closed",
      "run:1",
      4,
      "2026-09-03T10:05:00.000Z",
      "run-closed",
      JSON.stringify(
        CanonicalRunEventSchema.parse({
          eventId: "event:closed",
          eventType: "run-closed",
          occurredAt: "2026-09-03T10:05:00.000Z",
          reason: "student-exit",
          sequence: 4,
        }),
      ),
    ]);
    expect(database.executions.map(({ parameters }) => parameters).slice(1)).toEqual([
      ["run:1", "2026-09-03T10:05:00.000Z", "student-exit"],
      ["run:1"],
      ["run:1", "2026-09-03T10:05:00.000Z"],
    ]);
  });

  it("reports repeated close only for the same scoped lease", () => {
    const database = new DatabaseFake();
    database.oneRows.push({ run_id: "run:1", state: "closed" });
    expect(new SqliteRunSessionRepository(database).closeRun(INPUT)).toEqual({
      alreadyClosed: true,
      runId: "run:1",
    });
    expect(database.executions).toHaveLength(0);
  });

  it("rejects unknown, revoked, expired, or internally inconsistent leases", () => {
    for (const rows of [
      [undefined],
      [{ run_id: "run:1", state: "active" }, undefined],
      [{ run_id: "run:1", state: "active" }, activeLeaseRow("run:other"), activeRunProjection(3)],
    ]) {
      const database = new DatabaseFake();
      database.oneRows.push(...rows);
      expect(() => new SqliteRunSessionRepository(database).closeRun(INPUT)).toThrow(
        expect.objectContaining({ code: "run.unavailable" }),
      );
    }
  });

  it("does not query lease scope after a missing run", () => {
    const database = new DatabaseFake();
    database.oneRows.push(undefined);
    expect(() => new SqliteRunSessionRepository(database).closeRun(INPUT)).toThrow(
      expect.objectContaining({ code: "run.unavailable" }),
    );
    expect(database.reads).toHaveLength(1);
  });

  it("closes an owned run through authentication without consulting an expired lease", () => {
    const database = new DatabaseFake();
    database.oneRows.push({ run_id: "run:1", state: "active" }, activeRunProjection(3));
    const input = {
      closedAt: "2026-09-03T10:20:00.000Z",
      closingEventId: "event:authenticated-close",
      reason: "student-exit" as const,
      runId: "run:1",
      studentId: "user:alice",
      classId: "class:physics",
    };

    expect(new SqliteRunSessionRepository(database).closeRunAuthenticated(input)).toEqual({
      alreadyClosed: false,
      runId: "run:1",
    });
    expect(database.reads[0]?.parameters).toEqual(["run:1", "user:alice", "class:physics"]);
    expect(database.reads[0]?.sql).toContain("student_id = ?2 AND class_id = ?3");
    expect(database.reads.every(({ sql }) => !sql.includes("JOIN marea_run_leases"))).toBe(true);
    expect(database.executions.at(-1)?.parameters).toEqual(["run:1", "2026-09-03T10:20:00.000Z"]);
  });

  it("makes authenticated close owner-scoped and idempotent", () => {
    const input = {
      closedAt: "2026-09-03T10:20:00.000Z",
      closingEventId: "event:authenticated-close",
      reason: "student-exit" as const,
      runId: "run:1",
      studentId: "user:alice",
      classId: "class:physics",
    };
    const missing = new DatabaseFake();
    missing.oneRows.push(undefined);
    expect(() => new SqliteRunSessionRepository(missing).closeRunAuthenticated(input)).toThrow(
      expect.objectContaining({ code: "run.unavailable" }),
    );
    expect(missing.executions).toHaveLength(0);

    const closed = new DatabaseFake();
    closed.oneRows.push({ run_id: "run:1", state: "closed" });
    expect(new SqliteRunSessionRepository(closed).closeRunAuthenticated(input)).toEqual({
      alreadyClosed: true,
      runId: "run:1",
    });
    expect(closed.executions).toHaveLength(0);
  });
});
