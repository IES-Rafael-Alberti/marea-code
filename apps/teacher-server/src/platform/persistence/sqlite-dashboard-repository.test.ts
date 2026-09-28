import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import { DatabaseFake } from "../../../test-support/database-fake.js";
import { SqliteDashboardRepository } from "./sqlite-dashboard-repository.js";

function runRow(runId: string, activity: string) {
  return {
    class_display_name: "Physics",
    highest_durable_sequence: 3,
    last_activity_at: activity,
    pending_approval: 1,
    project_display_name: "Wave lab",
    run_id: runId,
    started_at: "2026-09-03T10:00:00.000Z",
    student_display_name: "Student Alice",
  } as const;
}

describe("SQLite dashboard repository", () => {
  it("returns an ordered bounded first page and opaque continuation cursor", () => {
    const database = new DatabaseFake();
    database.allRows.push([
      runRow("run:2", "2026-09-03T10:02:00.000Z"),
      runRow("run:1", "2026-09-03T10:01:00.000Z"),
    ]);
    const page = new SqliteDashboardRepository(database).listActiveRuns({
      cursor: undefined,
      limit: 1,
      teacherId: "teacher:ada",
    });

    expect(page.runs).toEqual([
      expect.objectContaining({ pendingApproval: true, runId: "run:2", state: "active" }),
    ]);
    expect(page.nextCursor).toBe(Buffer.from("run:2").toString("base64url"));
    expect(database.reads[0]?.parameters).toEqual(["teacher:ada", 2]);
    expect(database.reads[0]?.sql).toContain("marea_active_runs");
  });

  it("continues after an authorized cursor and terminates the final page", () => {
    const database = new DatabaseFake();
    database.oneRows.push({
      last_activity_at: "2026-09-03T10:02:00.000Z",
      run_id: "run:2",
    });
    database.allRows.push([runRow("run:1", "2026-09-03T10:01:00.000Z")]);
    const page = new SqliteDashboardRepository(database).listActiveRuns({
      cursor: Buffer.from("run:2").toString("base64url"),
      limit: 10,
      teacherId: "teacher:ada",
    });

    expect(page.runs[0]?.runId).toBe("run:1");
    expect(page.nextCursor).toBeNull();
    expect(database.reads[0]?.parameters).toEqual(["teacher:ada", "run:2"]);
    expect(database.reads[0]?.sql).toContain("marea_teacher_classes");
    expect(database.reads[1]?.parameters).toEqual([
      "teacher:ada",
      "2026-09-03T10:02:00.000Z",
      "run:2",
      11,
    ]);
    expect(database.reads[1]?.sql).toContain("active.last_activity_at < ?2");
  });

  it("does not advertise a continuation when the result count equals the limit", () => {
    const database = new DatabaseFake();
    database.allRows.push([runRow("run:1", "2026-09-03T10:01:00.000Z")]);
    expect(
      new SqliteDashboardRepository(database).listActiveRuns({
        cursor: undefined,
        limit: 1,
        teacherId: "teacher:ada",
      }).nextCursor,
    ).toBeNull();
  });

  it("returns an empty page for a cursor outside the teacher's authorized classes", () => {
    const database = new DatabaseFake();
    database.oneRows.push(undefined);
    expect(
      new SqliteDashboardRepository(database).listActiveRuns({
        cursor: Buffer.from("run:private").toString("base64url"),
        limit: 10,
        teacherId: "teacher:ada",
      }),
    ).toEqual({ nextCursor: null, runs: [] });
  });
});
