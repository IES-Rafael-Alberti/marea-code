import { describe, expect, it } from "vitest";

import { DatabaseFake } from "../../../test-support/database-fake.js";
import { SqliteRunSessionRepository } from "./sqlite-run-session-repository.js";

const RENEWAL = {
  classId: "class:physics",
  expiresAt: "2026-09-03T10:15:00.000Z",
  issuedAt: "2026-09-03T10:05:00.000Z",
  leaseId: "lease:renewed",
  leaseTokenHash: "digest:renewed",
  runId: "run:1",
  studentId: "user:alice",
} as const;

describe("SQLite run session repository lease recovery", () => {
  it("rotates every live lease only after verifying the active run owner", () => {
    const database = new DatabaseFake();
    database.oneRows.push({ id: "run:1", state: "active" });

    expect(new SqliteRunSessionRepository(database).renewLease(RENEWAL)).toEqual({
      expiresAt: RENEWAL.expiresAt,
      issuedAt: RENEWAL.issuedAt,
      runId: "run:1",
    });
    expect(database.reads[0]?.parameters).toEqual(["run:1", "user:alice", "class:physics"]);
    expect(database.reads[0]?.sql).toContain("student_id = ?2 AND class_id = ?3");
    expect(database.executions.map(({ parameters }) => parameters)).toEqual([
      ["run:1", RENEWAL.issuedAt],
      [
        RENEWAL.leaseId,
        RENEWAL.runId,
        RENEWAL.studentId,
        RENEWAL.leaseTokenHash,
        RENEWAL.issuedAt,
        RENEWAL.expiresAt,
      ],
    ]);
    expect(database.executions[0]?.sql).toContain("revoked_at");
    expect(database.executions[1]?.sql).toContain("INSERT INTO marea_run_leases");
  });

  it("rejects foreign, missing, and closed runs before changing a lease", () => {
    for (const row of [undefined, { id: "run:1", state: "closed" }]) {
      const database = new DatabaseFake();
      database.oneRows.push(row);
      expect(() => new SqliteRunSessionRepository(database).renewLease(RENEWAL)).toThrow(
        expect.objectContaining({ code: "run.unavailable" }),
      );
      expect(database.executions).toHaveLength(0);
    }
  });
});
