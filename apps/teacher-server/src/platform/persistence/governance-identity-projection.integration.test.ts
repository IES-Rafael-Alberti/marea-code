import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { governanceFixture, GOVERNANCE_NOW } from "./governance-repository.fixture.js";

describe("legacy identity creation inside explicitly adopted classes", () => {
  let f: ReturnType<typeof governanceFixture>;
  beforeEach(() => {
    f = governanceFixture();
    f.createCenter("center:a");
    f.createClass("center:a", "class:a");
  });
  afterEach(() => {
    f.database.close();
  });
  function bootstrap() {
    return f.identities.applyBootstrap(
      {
        seedId: "seed:new-identities",
        classes: [],
        accounts: [
          {
            userId: "user:new-teacher",
            role: "teacher",
            displayName: "New teacher",
            login: "new-teacher",
            classKey: "governance:class:a",
            passwordHash: "teacher-hash",
          },
          {
            userId: "user:new-student",
            role: "student",
            displayName: "New student",
            login: "new-student",
            classKey: "governance:class:a",
            passwordHash: "student-hash",
          },
          {
            userId: "user:unassigned",
            role: "teacher",
            displayName: "Unassigned teacher",
            login: "unassigned",
            classKey: null,
            passwordHash: "unassigned-hash",
          },
        ],
        invitations: [],
      },
      GOVERNANCE_NOW,
    );
  }
  function invite() {
    f.identities.applyBootstrap(
      {
        seedId: "seed:invitation",
        classes: [],
        accounts: [],
        invitations: [{ codeHash: "invitation-hash", classKey: "governance:class:a" }],
      },
      GOVERNANCE_NOW,
    );
  }
  function enroll() {
    return f.identities.consumeInvitation({
      codeHash: "invitation-hash",
      displayName: "Enrolled",
      enrolledAt: GOVERNANCE_NOW,
      login: "enrolled",
      passwordHash: "enrollment-hash",
      userId: "user:enrolled",
    });
  }

  it("projects bootstrap accounts atomically with derived roles and no administrator privilege", () => {
    expect(bootstrap()).toBe(true);
    expect(bootstrap()).toBe(false);
    expect(
      f.database.readAll(
        "SELECT user_id, owner_center_id, state FROM marea_governance_accounts ORDER BY user_id",
      ),
    ).toEqual([
      { user_id: "user:new-student", owner_center_id: "center:a", state: "active" },
      { user_id: "user:new-teacher", owner_center_id: "center:a", state: "active" },
    ]);
    expect(f.database.readAll("SELECT DISTINCT capability FROM marea_center_memberships")).toEqual([
      { capability: "member" },
    ]);
    expect(
      f.database.readAll("SELECT user_id, role FROM marea_governance_memberships ORDER BY user_id"),
    ).toEqual([
      { user_id: "user:new-student", role: "student" },
      { user_id: "user:new-teacher", role: "teacher" },
    ]);
    expect(f.identities.findCredential("new-student")?.passwordHash).toBe("student-hash");
    expect(f.database.readAll("SELECT * FROM marea_teacher_classes")).toEqual([
      { teacher_id: "user:new-teacher", class_id: "class:a" },
    ]);
  });

  it("projects invited students in the same transaction as invitation consumption", () => {
    invite();
    expect(enroll()).toMatchObject({
      enrolled: true,
      identity: { classId: "class:a", role: "student" },
    });
    expect(
      f.database.readOne("SELECT user_id, role, state FROM marea_governance_memberships"),
    ).toEqual({ user_id: "user:enrolled", role: "student", state: "active" });
    expect(f.database.readOne("SELECT capability FROM marea_center_memberships")).toEqual({
      capability: "member",
    });
    expect(enroll()).toEqual({ enrolled: false });
    expect(f.identities.findCredential("enrolled")?.passwordHash).toBe("enrollment-hash");
  });

  it("rolls back the account and restores a consumable invitation on projection failure", () => {
    invite();
    f.database.executeScript(
      "CREATE TRIGGER reject_identity_projection BEFORE INSERT ON marea_governance_memberships BEGIN SELECT RAISE(ABORT, 'injected-projection-failure'); END;",
    );
    expect(() => enroll()).toThrow("injected-projection-failure");
    expect(f.database.readAll("SELECT * FROM marea_users")).toEqual([]);
    expect(f.database.readAll("SELECT * FROM marea_governance_accounts")).toEqual([]);
    expect(f.database.readAll("SELECT * FROM marea_center_memberships")).toEqual([]);
    expect(f.database.readOne("SELECT consumed_at, consumed_by FROM marea_invitations")).toEqual({
      consumed_at: null,
      consumed_by: null,
    });
    expect(() => bootstrap()).toThrow("injected-projection-failure");
    expect(
      f.database.readOne(
        "SELECT seed_id FROM marea_bootstrap_markers WHERE seed_id = 'seed:new-identities'",
      ),
    ).toBeUndefined();
    expect(f.database.readAll("SELECT * FROM marea_teacher_classes")).toEqual([]);
    f.database.executeScript("DROP TRIGGER reject_identity_projection");
    expect(enroll()).toMatchObject({ enrolled: true });
  });
});
