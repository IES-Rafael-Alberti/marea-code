import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialLoginSchema, SafeDisplayNameSchema } from "@marea/protocol";
import type { GovernanceCommitContext } from "../../governance/authority.js";
import {
  governanceFixture,
  seedGovernancePilot,
  governanceId as id,
  GOVERNANCE_NOW,
} from "./governance-repository.fixture.js";

describe("atomic governance writes", () => {
  let f: ReturnType<typeof governanceFixture>;
  let admin: GovernanceCommitContext;
  beforeEach(() => {
    f = governanceFixture();
    admin = seedGovernancePilot(f);
  });
  afterEach(() => {
    f.database.close();
  });

  it("creates pending identities and coherent class assignments without disclosing credentials", () => {
    const account = f.createAccount("center:a", "user:student", "student", "class:a");
    expect(account).toEqual({
      userId: "user:student",
      centerId: "center:a",
      displayName: "Person",
      role: "student",
      state: "pending",
      version: account.version,
      canManageAccount: true,
    });
    expect(f.identities.findCredential("user-student")).toBeUndefined();
    expect(() => f.session("user:student")).toThrow(
      expect.objectContaining({ code: "auth.invalid" }),
    );
    expect(
      f.database.readOne("SELECT class_id FROM marea_users WHERE id = 'user:student'"),
    ).toEqual({ class_id: "class:a" });
    expect(
      f.reads.listMemberships(
        { context: admin, centerId: id("center:a"), classId: id("class:a") },
        null,
      ).items,
    ).toEqual([
      expect.objectContaining({ userId: "user:student", role: "student", state: "active" }),
    ]);
    for (const state of ["active", "disabled"] as const) {
      expect(() =>
        f.accounts.commitChangeAccountState({
          context: admin,
          centerId: id("center:a"),
          userId: account.userId,
          expectedVersion: account.version,
          state,
        }),
      ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    }
    f.activate("center:a", "user:student");
    expect(f.identities.findCredential("user-student")?.passwordHash).toBe(
      "provisioned:user:student",
    );
    expect(f.session("user:student").identity.classId).toBe("class:a");
    expect(JSON.stringify(f.reads.listAccounts(admin, id("center:a"), null))).not.toMatch(
      /login|password|session|token|hash/,
    );
  });

  it("keeps teacher grants multi-class and admin-only accounts outside teacher access", () => {
    const teacher = f.createAccount("center:a", "user:teacher", "teacher", "class:a");
    f.memberships.commitChangeMembership({
      context: admin,
      centerId: id("center:a"),
      classId: id("class:second"),
      userId: teacher.userId,
      state: "active",
      expectedVersion: null,
    });
    expect(
      f.database.readAll(
        "SELECT class_id FROM marea_teacher_classes WHERE teacher_id = 'user:teacher' ORDER BY class_id",
      ),
    ).toEqual([{ class_id: "class:a" }, { class_id: "class:second" }]);
    f.memberships.commitChangeMembership({
      context: admin,
      centerId: id("center:a"),
      classId: id("class:a"),
      userId: teacher.userId,
      state: "revoked",
      expectedVersion: teacher.version,
    });
    expect(
      f.database.readAll(
        "SELECT class_id FROM marea_teacher_classes WHERE teacher_id = 'user:teacher'",
      ),
    ).toEqual([{ class_id: "class:second" }]);
    expect(
      f.database.readOne("SELECT class_id FROM marea_users WHERE id = 'user:teacher'"),
    ).toEqual({ class_id: null });
    expect(
      f.database.readAll("SELECT * FROM marea_teacher_classes WHERE teacher_id = 'user:admin'"),
    ).toEqual([]);
  });

  it("revokes student authentication atomically and requires explicit reassignment", () => {
    const account = f.createAccount("center:a", "user:student", "student", "class:a");
    f.activate("center:a", "user:student");
    const session = f.session("user:student");
    const mutation = {
      context: admin,
      centerId: id("center:a"),
      classId: id("class:second"),
      userId: account.userId,
      state: "active" as const,
      expectedVersion: null,
    };
    expect(() => f.memberships.commitChangeMembership(mutation)).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );
    const revoked = f.memberships.commitChangeMembership({
      ...mutation,
      classId: id("class:a"),
      state: "revoked",
      expectedVersion: account.version,
    });
    expect(revoked.state).toBe("revoked");
    expect(() => f.reads.requireSession(session.sessionId, account.userId, GOVERNANCE_NOW)).toThrow(
      expect.objectContaining({ code: "auth.invalid" }),
    );
    expect(
      f.database.readOne("SELECT class_id FROM marea_users WHERE id = 'user:student'"),
    ).toEqual({ class_id: null });
    expect(f.memberships.commitChangeMembership(mutation).classId).toBe("class:second");
  });

  it("blocks historical foreign associations and administrator accounts from local global edits", () => {
    const account = f.createAccount("center:a", "user:shared");
    f.operator.commitAssociateAccount({
      context: f.operatorContext(),
      centerId: id("center:b"),
      userId: account.userId,
      expectedVersion: null,
    });
    f.database.execute(
      "UPDATE marea_center_memberships SET state = 'revoked' WHERE center_id = 'center:b' AND user_id = 'user:shared'",
    );
    const input = {
      context: admin,
      centerId: id("center:a"),
      userId: account.userId,
      expectedVersion: account.version,
      displayName: SafeDisplayNameSchema.parse("Changed"),
    };
    expect(f.store.account(admin, id("center:a"), account.userId).canManageAccount).toBe(false);
    expect(() => f.accounts.commitRenameAccount(input)).toThrow(
      expect.objectContaining({ code: "dashboard.forbidden" }),
    );
    expect(f.accounts.commitRenameAccount({ ...input, context: f.context() }).displayName).toBe(
      "Changed",
    );
    const administrator = f.store.account(admin, id("center:a"), id("user:admin"));
    expect(administrator.canManageAccount).toBe(false);
    expect(() =>
      f.accounts.commitRevokeSessions({
        context: admin,
        centerId: id("center:a"),
        userId: administrator.userId,
        expectedVersion: administrator.version,
      }),
    ).toThrow(expect.objectContaining({ code: "dashboard.forbidden" }));
  });

  it("uses create-only IDs, normalized global login conflicts and exact class versions", () => {
    const before = f.database.readAll("SELECT * FROM marea_governance_audit");
    expect(() => f.createClass("center:a", "class:a")).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );
    expect(f.database.readAll("SELECT * FROM marea_governance_audit")).toEqual(before);
    const current = f.store.requireClass(admin, id("center:a"), id("class:a"));
    const renamed = f.classes.commitRenameClass({
      context: admin,
      centerId: id("center:a"),
      classId: current.classId,
      expectedVersion: current.version,
      displayName: SafeDisplayNameSchema.parse("Renamed"),
    });
    expect(renamed.displayName).toBe("Renamed");
    expect(
      f.database.readOne("SELECT display_name FROM marea_classes WHERE id = 'class:a'"),
    ).toEqual({ display_name: "Renamed" });
    expect(() =>
      f.classes.commitRenameClass({
        context: admin,
        centerId: id("center:a"),
        classId: current.classId,
        expectedVersion: current.version,
        displayName: current.displayName,
      }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    f.createAccount("center:b", "user:collision");
    expect(() =>
      f.accounts.commitCreateAccount({
        context: admin,
        centerId: id("center:a"),
        userId: id("user:new"),
        login: CredentialLoginSchema.parse("user-collision"),
        displayName: SafeDisplayNameSchema.parse("New"),
        role: "teacher",
        classId: null,
        passwordHash: "private",
      }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    expect(f.database.readOne("SELECT * FROM marea_users WHERE id = 'user:new'")).toBeUndefined();
  });

  it("rejects missing students, absent revocations and stale memberships before writing", () => {
    expect(() => f.createAccount("center:a", "user:unassigned", "student")).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );
    expect(() => f.store.account(admin, id("center:a"), id("user:missing"))).toThrow(
      expect.objectContaining({ code: "dashboard.forbidden" }),
    );
    const account = f.createAccount("center:a", "user:student", "student", "class:a");
    const base = {
      context: admin,
      centerId: id("center:a"),
      classId: id("class:a"),
      userId: account.userId,
      state: "active" as const,
      expectedVersion: account.version,
    };
    expect(() =>
      f.memberships.commitChangeMembership({ ...base, expectedVersion: id("stale") }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    expect(() =>
      f.memberships.commitChangeMembership({
        ...base,
        classId: id("class:second"),
        state: "revoked",
        expectedVersion: null,
      }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    const refreshed = f.memberships.commitChangeMembership(base);
    const revoked = f.memberships.commitChangeMembership({
      ...base,
      context: f.context(),
      state: "revoked",
      expectedVersion: refreshed.version,
    });
    expect(
      f.memberships.commitChangeMembership({ ...base, expectedVersion: revoked.version }).state,
    ).toBe("active");
  });

  it("rolls back projections and audit together when a final write fails", () => {
    f.database.executeScript(
      "CREATE TRIGGER reject_audit BEFORE INSERT ON marea_governance_audit BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END",
    );
    expect(() => f.createAccount("center:a", "user:rollback", "student", "class:a")).toThrow();
    expect(
      f.database.readOne("SELECT id FROM marea_users WHERE id = 'user:rollback'"),
    ).toBeUndefined();
    expect(
      f.database.readOne(
        "SELECT user_id FROM marea_governance_accounts WHERE user_id = 'user:rollback'",
      ),
    ).toBeUndefined();
    expect(
      f.database.readOne(
        "SELECT user_id FROM marea_governance_memberships WHERE user_id = 'user:rollback'",
      ),
    ).toBeUndefined();
    expect(() => f.createClass("center:a", "class:rollback")).toThrow();
    expect(
      f.database.readOne("SELECT id FROM marea_classes WHERE id = 'class:rollback'"),
    ).toBeUndefined();
  });
});
