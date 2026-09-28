import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StudentRunSnapshotSchema, UtcTimestampSchema } from "@marea/protocol";
import type { GovernanceCommitContext } from "../../governance/authority.js";
import { SqliteRunSessionRepository } from "./sqlite-run-session-repository.js";
import {
  governanceFixture,
  seedGovernancePilot,
  governanceId as id,
  GOVERNANCE_NOW,
  GOVERNANCE_EXPIRES,
} from "./governance-repository.fixture.js";

describe("governance account and execution lifecycle", () => {
  let f: ReturnType<typeof governanceFixture>;
  let admin: GovernanceCommitContext;
  beforeEach(() => {
    f = governanceFixture();
    admin = seedGovernancePilot(f);
    f.createAccount("center:a", "user:student", "student", "class:a");
    f.activate("center:a", "user:student");
  });
  afterEach(() => {
    f.database.close();
  });

  function version() {
    return f.store.account(f.context(), id("center:a"), id("user:student")).version;
  }
  function freshAdmin(): GovernanceCommitContext {
    return { ...f.context(), authority: admin.authority };
  }
  function openRun() {
    const runs = new SqliteRunSessionRepository(f.database);
    const student = f.session("user:student").identity;
    runs.openRun({
      student,
      activatedEventId: "event:active",
      clientSessionId: "client:student",
      expiresAt: GOVERNANCE_EXPIRES,
      fingerprint: "fingerprint:run",
      idempotencyKey: "open:run",
      intent: { kind: "new" },
      issuedAt: GOVERNANCE_NOW,
      leaseId: "lease:student",
      leaseTokenHash: "lease-token",
      openedAt: GOVERNANCE_NOW,
      projectDisplayName: "Synthetic project",
      proposedRunId: "run:student",
      requestId: "request:run",
      captureSnapshot: () => ({
        providerRoute: { providerId: "openrouter", model: "synthetic-model" },
        snapshot: StudentRunSnapshotSchema.parse({
          id: "snapshot:student",
          agentMode: "free",
          modelAlias: "marea",
          didacticSkills: [],
          prompt: {
            content: "Synthetic",
            digest: `sha256:${"a".repeat(64)}`,
            version: "prompt:one",
          },
          teacherToolPolicy: { restrictions: [], version: "policy:one" },
        }),
      }),
    });
    return runs;
  }

  it("disables and reactivates without reviving sessions, leases or changing snapshots", () => {
    const runs = openRun();
    const before = f.database.readAll("SELECT * FROM marea_run_snapshots");
    expect(runs.authorizeLease({ leaseTokenHash: "lease-token", now: GOVERNANCE_NOW }).runId).toBe(
      "run:student",
    );
    const previousVersion = version();
    const disabled = f.accounts.commitChangeAccountState({
      context: freshAdmin(),
      centerId: id("center:a"),
      userId: id("user:student"),
      state: "disabled",
      expectedVersion: version(),
    });
    expect(disabled.state).toBe("disabled");
    expect(disabled.version).not.toBe(previousVersion);
    expect(f.identities.findCredential("user-student")).toBeUndefined();
    expect(() =>
      runs.authorizeLease({ leaseTokenHash: "lease-token", now: GOVERNANCE_NOW }),
    ).toThrow();
    expect(() =>
      runs.renewLease({
        runId: "run:student",
        studentId: "user:student",
        issuedAt: GOVERNANCE_NOW,
        expiresAt: GOVERNANCE_EXPIRES,
        leaseId: "lease:denied",
        leaseTokenHash: "denied",
      }),
    ).toThrow();
    const active = f.accounts.commitChangeAccountState({
      context: freshAdmin(),
      centerId: id("center:a"),
      userId: id("user:student"),
      state: "active",
      expectedVersion: disabled.version,
    });
    expect(active.state).toBe("active");
    expect(f.session("user:student").identity.userId).toBe("user:student");
    expect(() =>
      runs.authorizeLease({ leaseTokenHash: "lease-token", now: GOVERNANCE_NOW }),
    ).toThrow();
    expect(f.database.readAll("SELECT * FROM marea_run_snapshots")).toEqual(before);
    expect(f.database.readOne("SELECT state FROM marea_runs WHERE id = 'run:student'")).toEqual({
      state: "active",
    });
  });

  it("rotates an active credential, revoking existing sessions and leases but preserving memberships", () => {
    const runs = openRun();
    const session = f.session("user:student");
    const members = f.database.readAll("SELECT * FROM marea_governance_memberships");
    f.operator.commitProvisionCredential({
      context: f.operatorContext(),
      userId: "user:student",
      expectedVersion: version(),
      passwordHash: "rotated-hash",
    });
    expect(() => f.reads.requireSession(session.sessionId, "user:student", GOVERNANCE_NOW)).toThrow(
      expect.objectContaining({ code: "auth.invalid" }),
    );
    expect(() =>
      runs.authorizeLease({ leaseTokenHash: "lease-token", now: GOVERNANCE_NOW }),
    ).toThrow();
    expect(f.database.readAll("SELECT * FROM marea_governance_memberships")).toEqual(members);
    expect(f.session("user:student").identity.userId).toBe("user:student");
  });

  it("reactivates a revoked student membership only when no active run remains", () => {
    const member = f.reads.listMemberships(
      { context: freshAdmin(), centerId: "center:a", classId: "class:a" },
      null,
    ).items[0];
    if (member === undefined) throw new Error("Expected membership");
    const revoked = f.memberships.commitChangeMembership({
      context: freshAdmin(),
      centerId: "center:a",
      classId: "class:a",
      userId: "user:student",
      state: "revoked",
      expectedVersion: member.version,
    });
    expect(
      f.database.readOne("SELECT class_id FROM marea_users WHERE id = 'user:student'"),
    ).toEqual({ class_id: null });
    f.memberships.commitChangeMembership({
      context: freshAdmin(),
      centerId: "center:a",
      classId: "class:a",
      userId: "user:student",
      state: "active",
      expectedVersion: revoked.version,
    });
    expect(f.session("user:student").identity.classId).toBe("class:a");
  });

  it("rejects a revoked assignment at run opening before creating any run, snapshot or lease", () => {
    f.database.execute(
      "UPDATE marea_governance_memberships SET state = 'revoked' WHERE user_id = 'user:student'",
    );
    expect(() => openRun()).toThrow(expect.objectContaining({ code: "run.unavailable" }));
    for (const table of [
      "marea_runs",
      "marea_run_snapshots",
      "marea_run_leases",
      "marea_run_open_requests",
    ])
      expect(f.database.readAll(`SELECT * FROM ${table}`)).toEqual([]);
  });

  it("keeps active sessions and leases on an active-to-active membership update", () => {
    const runs = openRun();
    const before = f.database.readAll("SELECT * FROM marea_auth_sessions");
    const membership = f.reads.listMemberships(
      { context: freshAdmin(), centerId: "center:a", classId: "class:a" },
      null,
    ).items[0];
    if (membership === undefined) throw new Error("Expected student membership");
    const updated = f.memberships.commitChangeMembership({
      context: freshAdmin(),
      centerId: "center:a",
      classId: "class:a",
      userId: "user:student",
      state: "active",
      expectedVersion: membership.version,
    });
    expect(updated.version).not.toBe(membership.version);
    expect(f.database.readAll("SELECT * FROM marea_auth_sessions")).toEqual(before);
    expect(runs.authorizeLease({ leaseTokenHash: "lease-token", now: GOVERNANCE_NOW }).runId).toBe(
      "run:student",
    );
    f.accounts.commitChangeAccountState({
      context: freshAdmin(),
      centerId: "center:a",
      userId: "user:student",
      expectedVersion: version(),
      state: "active",
    });
    expect(f.database.readAll("SELECT * FROM marea_auth_sessions")).toEqual(before);
    expect(runs.authorizeLease({ leaseTokenHash: "lease-token", now: GOVERNANCE_NOW }).runId).toBe(
      "run:student",
    );
  });

  it("does not revoke the new assignment or session when an old revoked membership is revoked again", () => {
    const member = f.reads.listMemberships(
      { context: freshAdmin(), centerId: "center:a", classId: "class:a" },
      null,
    ).items[0];
    if (member === undefined) throw new Error("Expected student membership");
    const revoked = f.memberships.commitChangeMembership({
      context: freshAdmin(),
      centerId: "center:a",
      classId: "class:a",
      userId: "user:student",
      state: "revoked",
      expectedVersion: member.version,
    });
    f.memberships.commitChangeMembership({
      context: freshAdmin(),
      centerId: "center:a",
      classId: "class:second",
      userId: "user:student",
      state: "active",
      expectedVersion: null,
    });
    const session = f.session("user:student");
    f.memberships.commitChangeMembership({
      context: freshAdmin(),
      centerId: "center:a",
      classId: "class:a",
      userId: "user:student",
      state: "revoked",
      expectedVersion: revoked.version,
    });
    expect(f.reads.requireSession(session.sessionId, "user:student", GOVERNANCE_NOW).classId).toBe(
      "class:second",
    );
    expect(
      f.database.readOne("SELECT class_id FROM marea_users WHERE id = 'user:student'"),
    ).toEqual({ class_id: "class:second" });
    expect(
      f.database.readOne(
        "SELECT state FROM marea_governance_memberships WHERE user_id = 'user:student' AND class_id = 'class:second'",
      ),
    ).toEqual({ state: "active" });
  });

  it("versions global revocation, preserves earlier timestamps and does not disable credentials", () => {
    openRun();
    const before = version();
    const revoked = f.accounts.commitRevokeSessions({
      context: freshAdmin(),
      centerId: id("center:a"),
      userId: id("user:student"),
      expectedVersion: before,
    });
    expect(revoked.version).not.toBe(before);
    expect(revoked.revokedAt).toBe(GOVERNANCE_NOW);
    const later = UtcTimestampSchema.parse("2026-09-12T10:05:00.000Z");
    f.accounts.commitRevokeSessions({
      context: { ...freshAdmin(), now: later },
      centerId: id("center:a"),
      userId: id("user:student"),
      expectedVersion: revoked.version,
    });
    expect(
      f.database.readOne("SELECT revoked_at FROM marea_run_leases WHERE id = 'lease:student'"),
    ).toEqual({ revoked_at: GOVERNANCE_NOW });
    expect(f.identities.findCredential("user-student")).toBeDefined();
    expect(() =>
      f.accounts.commitRevokeSessions({
        context: freshAdmin(),
        centerId: id("center:a"),
        userId: id("user:student"),
        expectedVersion: before,
      }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
  });

  it("prevents reassignment while any run remains active and never permits cross-center transfer", () => {
    openRun();
    const membership = f.reads.listMemberships(
      { context: admin, centerId: id("center:a"), classId: id("class:a") },
      null,
    ).items[0];
    if (membership === undefined) throw new Error("Expected membership fixture.");
    f.memberships.commitChangeMembership({
      context: freshAdmin(),
      centerId: id("center:a"),
      classId: id("class:a"),
      userId: id("user:student"),
      state: "revoked",
      expectedVersion: membership.version,
    });
    const revoked = f.reads.listMemberships(
      { context: freshAdmin(), centerId: "center:a", classId: "class:a" },
      null,
    ).items[0];
    if (revoked === undefined) throw new Error("Expected revoked membership");
    expect(() =>
      f.memberships.commitChangeMembership({
        context: freshAdmin(),
        centerId: "center:a",
        classId: "class:a",
        userId: "user:student",
        state: "active",
        expectedVersion: revoked.version,
      }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    const input = {
      context: freshAdmin(),
      centerId: id("center:a"),
      classId: id("class:second"),
      userId: id("user:student"),
      state: "active" as const,
      expectedVersion: null,
    };
    expect(() => f.memberships.commitChangeMembership(input)).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );
    f.operator.commitAssociateAccount({
      context: f.operatorContext(),
      centerId: id("center:b"),
      userId: id("user:student"),
      expectedVersion: null,
    });
    expect(() =>
      f.memberships.commitChangeMembership({
        ...input,
        context: f.context(),
        centerId: id("center:b"),
        classId: id("class:b"),
      }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
  });

  it("rechecks private credential versions and restricts administrator grants to active teachers", () => {
    const teacher = f.createAccount("center:a", "user:pending");
    const grant = {
      context: f.operatorContext(),
      centerId: id("center:a"),
      userId: teacher.userId,
      expectedVersion: teacher.version,
      capability: "administrator" as const,
    };
    expect(() => f.operator.commitSetAdministrator(grant)).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );
    const student = f.createAccount("center:a", "user:other-student", "student", "class:a");
    f.activate("center:a", student.userId);
    expect(() =>
      f.operator.commitSetAdministrator({
        ...grant,
        userId: student.userId,
        expectedVersion: student.version,
      }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    const prior = version();
    f.activate("center:a", "user:student");
    expect(() =>
      f.operator.commitProvisionCredential({
        context: f.operatorContext(),
        userId: id("user:student"),
        expectedVersion: prior,
        passwordHash: "stale-hash",
      }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    expect(f.identities.findCredential("user-student")?.passwordHash).toBe(
      "provisioned:user:student",
    );
  });
});
