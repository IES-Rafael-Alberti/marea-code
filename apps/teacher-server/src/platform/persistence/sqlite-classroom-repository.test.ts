import { describe, expect, it } from "vitest";

import { DatabaseFake } from "../../../test-support/database-fake.js";
import type { AuthenticatedIdentity } from "../../identity/contracts.js";
import { SqliteClassroomRepository } from "./sqlite-classroom-repository.js";

const STUDENT: AuthenticatedIdentity = {
  classId: "class:physics",
  displayName: "Student Alice",
  role: "student",
  userId: "user:alice",
};

describe("SQLite classroom repository", () => {
  it("loads the class and latest active run", () => {
    const database = new DatabaseFake();
    database.oneRows.push(
      { display_name: "Physics" },
      { id: "run:1", project_display_name: "Wave lab" },
    );
    expect(new SqliteClassroomRepository(database).loadStudentBootstrap(STUDENT)).toEqual({
      activeRun: { projectDisplayName: "Wave lab", runId: "run:1" },
      classDisplayName: "Physics",
    });
    expect(database.reads.map(({ parameters }) => parameters)).toEqual([
      ["class:physics", "user:alice"],
      ["user:alice", "class:physics"],
    ]);
    expect(database.reads[1]?.sql).toContain("student_id = ?1 AND class_id = ?2");
    expect(database.reads[0]?.sql).toContain("marea_classes");
    expect(database.reads[1]?.sql).toContain("marea_runs");
  });

  it("returns no active run and rejects absent authority data", () => {
    const noRun = new DatabaseFake();
    noRun.oneRows.push({ display_name: "Physics" }, undefined);
    expect(new SqliteClassroomRepository(noRun).loadStudentBootstrap(STUDENT)).toEqual({
      activeRun: null,
      classDisplayName: "Physics",
    });

    const missingClass = new DatabaseFake();
    missingClass.oneRows.push(undefined);
    expect(
      new SqliteClassroomRepository(missingClass).loadStudentBootstrap(STUDENT),
    ).toBeUndefined();
    const absentAuthority = new DatabaseFake();
    expect(
      new SqliteClassroomRepository(absentAuthority).loadStudentBootstrap({
        ...STUDENT,
        classId: null,
      }),
    ).toBeUndefined();
    expect(absentAuthority.reads).toHaveLength(0);
  });
});
