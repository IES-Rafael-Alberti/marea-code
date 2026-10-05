import { describe, expect, it } from "vitest";

import {
  GOVERNANCE_EXPIRES,
  GOVERNANCE_NOW,
  governanceFixture,
  governanceId,
  seedGovernancePilot,
} from "./governance-repository.fixture.js";
import { hasClassScopedSessions, readStudentClasses } from "./student-classes.js";
import { SqliteClassroomRepository } from "./sqlite-classroom-repository.js";
import { SqliteRunSessionRepository } from "./sqlite-run-session-repository.js";

const LATER = "2026-09-12T10:05:00.000Z";

function pilot(schema: "application" | "student-identities" = "student-identities") {
  const f = governanceFixture(undefined, schema);
  seedGovernancePilot(f);
  f.createAccount("center:a", "user:student", "student", "class:a");
  f.activate("center:a", "user:student");
  return f;
}

function join(f: ReturnType<typeof pilot>, classId: string, expectedVersion: string | null = null) {
  return f.memberships.commitChangeMembership({
    context: f.context(),
    centerId: governanceId("center:a"),
    classId: governanceId(classId),
    userId: governanceId("user:student"),
    state: "active",
    expectedVersion: expectedVersion === null ? null : governanceId(expectedVersion),
  });
}

function leave(f: ReturnType<typeof pilot>, classId: string, expectedVersion: string) {
  return f.memberships.commitChangeMembership({
    context: f.context(),
    centerId: governanceId("center:a"),
    classId: governanceId(classId),
    userId: governanceId("user:student"),
    state: "revoked",
    expectedVersion: governanceId(expectedVersion),
  });
}

function session(f: ReturnType<typeof pilot>, token: string, classId: string | null) {
  f.identities.createSession({
    classId,
    sessionId: `session:${token}`,
    userId: "user:student",
    issuedAt: GOVERNANCE_NOW,
    expiresAt: GOVERNANCE_EXPIRES,
    tokenHash: token,
  });
}

function run(f: ReturnType<typeof pilot>, runId: string, classId: string) {
  f.database.execute(
    "INSERT OR IGNORE INTO marea_run_snapshots VALUES ('snapshot:x', '{}', '{}', ?1)",
    [GOVERNANCE_NOW],
  );
  f.database.execute(
    `INSERT INTO marea_runs (id, student_id, class_id, snapshot_id, client_session_id,
      project_display_name, state, opened_at) VALUES (?1, 'user:student', ?2, 'snapshot:x', ?1, 'Lab', 'active', ?3)`,
    [runId, classId, GOVERNANCE_NOW],
  );
  f.database.execute(
    `INSERT INTO marea_run_leases (id, run_id, student_id, token_hash, issued_at, expires_at)
      VALUES (?1, ?1, 'user:student', ?1, ?2, ?3)`,
    [runId, GOVERNANCE_NOW, GOVERNANCE_EXPIRES],
  );
}

function membershipVersion(f: ReturnType<typeof pilot>, classId: string): string {
  return String(
    f.database.readOne(
      "SELECT version FROM marea_governance_memberships WHERE class_id = ?1 AND user_id = 'user:student'",
      [classId],
    )?.version,
  );
}

function revokedAt(f: ReturnType<typeof pilot>, table: string, id: string) {
  return f.database.readOne(`SELECT revoked_at FROM ${table} WHERE id = ?1`, [id])?.revoked_at;
}

describe("students in several classes (schema 12)", () => {
  it("activates several classes and lists them in a stable order", () => {
    const f = pilot();
    f.database.execute("UPDATE marea_classes SET display_name = 'Zoology' WHERE id = 'class:a'");
    f.database.execute(
      "UPDATE marea_classes SET display_name = 'Algebra' WHERE id = 'class:second'",
    );
    expect(join(f, "class:second")).toMatchObject({ classId: "class:second", state: "active" });
    expect(f.identities.studentClasses("user:student")).toEqual([
      { classId: "class:second", displayName: "Algebra" },
      { classId: "class:a", displayName: "Zoology" },
    ]);
    expect(
      f.database.readOne("SELECT class_id FROM marea_users WHERE id = 'user:student'")?.class_id,
    ).toBe("class:second");
    expect(readStudentClasses(f.database, "user:admin")).toEqual([]);
    expect(hasClassScopedSessions(f.database)).toBe(true);
  });

  it("scopes a student session to one class, chosen once among its active classes", () => {
    const f = pilot();
    join(f, "class:second");
    session(f, "token:open", null);
    expect(f.identities.resolveSession("token:open", GOVERNANCE_NOW)).toMatchObject({
      classId: null,
      role: "student",
    });
    expect(f.identities.selectSessionClass("token:open", "class:b", GOVERNANCE_NOW)).toBe(
      undefined,
    );
    expect(f.identities.selectSessionClass("token:open", "class:second", GOVERNANCE_NOW)).toEqual({
      classId: "class:second",
      displayName: "Person",
      role: "student",
      userId: "user:student",
    });
    expect(f.identities.selectSessionClass("token:open", "class:a", GOVERNANCE_NOW)).toBe(
      undefined,
    );
    expect(f.identities.resolveSession("token:open", GOVERNANCE_NOW)?.classId).toBe("class:second");
    session(f, "token:expired", null);
    expect(f.identities.selectSessionClass("token:expired", "class:a", GOVERNANCE_EXPIRES)).toBe(
      undefined,
    );
    f.identities.createSession({
      sessionId: "session:teacher",
      userId: "user:admin",
      issuedAt: GOVERNANCE_NOW,
      expiresAt: GOVERNANCE_EXPIRES,
      tokenHash: "token:teacher",
    });
    expect(f.identities.selectSessionClass("token:teacher", "class:a", GOVERNANCE_NOW)).toBe(
      undefined,
    );
    expect(f.identities.resolveSession("token:teacher", GOVERNANCE_NOW)).toMatchObject({
      classId: null,
      role: "teacher",
    });
  });

  it("revokes only the sessions and leases of the class a student leaves", () => {
    const f = pilot();
    const second = join(f, "class:second");
    session(f, "token:a", "class:a");
    session(f, "token:second", "class:second");
    run(f, "run:a", "class:a");
    run(f, "run:second", "class:second");
    const membership = { version: membershipVersion(f, "class:a") };
    leave(f, "class:a", membership.version);
    expect(f.identities.resolveSession("token:a", GOVERNANCE_NOW)).toBeUndefined();
    expect(f.identities.resolveSession("token:second", GOVERNANCE_NOW)?.classId).toBe(
      "class:second",
    );
    expect(revokedAt(f, "marea_auth_sessions", "session:token:a")).toBe(GOVERNANCE_NOW);
    expect(revokedAt(f, "marea_auth_sessions", "session:token:second")).toBeNull();
    expect(revokedAt(f, "marea_run_leases", "run:a")).toBe(GOVERNANCE_NOW);
    expect(revokedAt(f, "marea_run_leases", "run:second")).toBeNull();
    expect(
      f.database.readOne("SELECT class_id FROM marea_users WHERE id = 'user:student'")?.class_id,
    ).toBe("class:second");
    leave(f, "class:second", second.version);
    expect(
      f.database.readOne("SELECT class_id FROM marea_users WHERE id = 'user:student'")?.class_id,
    ).toBeNull();
  });

  it("rejects reactivation only while the same class still has an active run", () => {
    const f = pilot();
    const second = join(f, "class:second");
    run(f, "run:a", "class:a");
    const revoked = leave(f, "class:second", second.version);
    expect(join(f, "class:second", revoked.version)).toMatchObject({ state: "active" });
    run(f, "run:second", "class:second");
    const again = { version: membershipVersion(f, "class:second") };
    const left = leave(f, "class:second", again.version);
    expect(() => join(f, "class:second", left.version)).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );
  });

  it("opens, resumes, renews and closes runs only within the session class", () => {
    const f = pilot();
    join(f, "class:second");
    run(f, "run:a", "class:a");
    const runs = new SqliteRunSessionRepository(f.database);
    const lease = {
      expiresAt: GOVERNANCE_EXPIRES,
      issuedAt: LATER,
      leaseId: "lease:renewed",
      leaseTokenHash: "digest:renewed",
      runId: "run:a",
      studentId: "user:student",
    };
    expect(() => runs.renewLease({ ...lease, classId: "class:second" })).toThrow(
      expect.objectContaining({ code: "run.unavailable" }),
    );
    expect(runs.renewLease({ ...lease, classId: "class:a" }).runId).toBe("run:a");
    const close = {
      closedAt: LATER,
      closingEventId: "event:closed",
      reason: "student-exit" as const,
      runId: "run:a",
      studentId: "user:student",
    };
    expect(() => runs.closeRunAuthenticated({ ...close, classId: "class:second" })).toThrow(
      expect.objectContaining({ code: "run.unavailable" }),
    );
    const classroom = new SqliteClassroomRepository(f.database);
    const identity = {
      classId: "class:second",
      displayName: "Person",
      role: "student" as const,
      userId: "user:student",
    };
    expect(classroom.loadStudentBootstrap(identity)).toEqual({
      activeRun: null,
      classDisplayName: "Class",
    });
    expect(classroom.loadStudentBootstrap({ ...identity, classId: "class:a" })?.activeRun).toEqual({
      projectDisplayName: "Lab",
      runId: "run:a",
    });
    expect(classroom.studentClasses("user:student")).toHaveLength(2);
  });
});

describe("students before schema 12", () => {
  it("keep one class, resolved from the account and never selected", () => {
    const f = pilot("application");
    expect(hasClassScopedSessions(f.database)).toBe(false);
    expect(() => join(f, "class:second")).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );
    session(f, "token:legacy", "class:a");
    expect(f.identities.resolveSession("token:legacy", GOVERNANCE_NOW)?.classId).toBe("class:a");
    expect(f.identities.selectSessionClass("token:legacy", "class:a", GOVERNANCE_NOW)).toBe(
      undefined,
    );
    run(f, "run:a", "class:a");
    const membership = { version: membershipVersion(f, "class:a") };
    leave(f, "class:a", membership.version);
    expect(revokedAt(f, "marea_auth_sessions", "session:token:legacy")).toBe(GOVERNANCE_NOW);
    expect(revokedAt(f, "marea_run_leases", "run:a")).toBe(GOVERNANCE_NOW);
  });

  it("admit an unadopted legacy class through the account class", () => {
    const f = pilot("application");
    f.database.execute("INSERT INTO marea_classes VALUES ('class:legacy', 'legacy', 'Legacy')");
    f.database.execute(
      "INSERT INTO marea_users VALUES ('user:legacy', 'legacy', 'hash', 'student', 'Legacy', 'class:legacy')",
    );
    expect(readStudentClasses(f.database, "user:legacy")).toEqual([
      { classId: "class:legacy", displayName: "Legacy" },
    ]);
  });
});
