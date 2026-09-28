import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { governanceFixture, seedGovernanceHistory } from "./governance-repository.fixture.js";
import { withoutDeletionAuthority } from "./identity-creation-guard.js";
import { createSqliteGovernanceRepository } from "./sqlite-governance-repository.js";
import type { AdoptionMap } from "../../governance/adoption-contracts.js";

describe("explicit offline legacy adoption on real SQLite", () => {
  let f: ReturnType<typeof governanceFixture>;
  let repository: ReturnType<typeof createSqliteGovernanceRepository>;
  beforeEach(() => {
    f = governanceFixture();
    repository = createSqliteGovernanceRepository(
      f.database,
      () => false,
      withoutDeletionAuthority(),
    );
    f.createCenter("center:a");
    f.createCenter("center:b");
    f.database.executeScript(`
      INSERT INTO marea_classes VALUES ('legacy:a', 'legacy-seed:a', 'Legacy A'), ('legacy:b', 'legacy-seed:b', 'Legacy B');
      INSERT INTO marea_users VALUES
        ('legacy:teacher', 'legacy-teacher', 'original-teacher-hash', 'teacher', 'Legacy teacher', 'legacy:a'),
        ('legacy:student', 'legacy-student', 'original-student-hash', 'student', 'Legacy student', 'legacy:a');
      INSERT INTO marea_teacher_classes VALUES ('legacy:teacher', 'legacy:a'), ('legacy:teacher', 'legacy:b');
      INSERT INTO marea_auth_sessions VALUES ('legacy:session', 'legacy:teacher', 'original-token', '2026-09-12T09:00:00.000Z', '2026-09-12T12:00:00.000Z', NULL);
    `);
  });
  afterEach(() => {
    f.database.close();
  });
  const map: AdoptionMap = {
    classes: [
      { classId: "legacy:a", centerId: "center:a" },
      { classId: "legacy:b", centerId: "center:b" },
    ],
    accounts: [
      { userId: "legacy:teacher", ownerCenterId: "center:a" },
      { userId: "legacy:student", ownerCenterId: "center:a" },
    ],
    administrators: [{ userId: "legacy:teacher", centerId: "center:a" }],
  };
  function preview(value = map) {
    return repository.previewAdoption({ ...f.operatorContext(), map: value });
  }
  function confirm(value = map, digest = preview(value).digest) {
    return repository.commitAdoption({
      context: f.operatorContext(),
      map: value,
      expectedInventoryDigest: digest,
    });
  }
  function snapshot() {
    return [
      "marea_classes",
      "marea_users",
      "marea_teacher_classes",
      "marea_auth_sessions",
      "marea_governance_accounts",
      "marea_governance_classes",
      "marea_governance_memberships",
      "marea_center_memberships",
      "marea_governance_audit",
    ].map((table) => f.database.readAll(`SELECT * FROM ${table}`));
  }

  it("previews read-only, preserves all legacy bytes, adopts proven joins and grants only explicit administration", () => {
    const before = snapshot();
    const receipt = preview();
    expect(receipt).toMatchObject({
      classes: 2,
      accounts: 2,
      memberships: 3,
      missingClassIds: [],
      missingUserIds: [],
    });
    expect(snapshot()).toEqual(before);
    expect(JSON.stringify(receipt)).not.toContain("original");
    expect(confirm(map, receipt.digest)).toEqual(receipt);
    expect(snapshot().slice(0, 4)).toEqual(before.slice(0, 4));
    expect(
      f.database.readAll(
        "SELECT user_id, center_id, capability, state FROM marea_center_memberships ORDER BY user_id, center_id",
      ),
    ).toEqual([
      { user_id: "legacy:student", center_id: "center:a", capability: "member", state: "active" },
      {
        user_id: "legacy:teacher",
        center_id: "center:a",
        capability: "administrator",
        state: "active",
      },
      { user_id: "legacy:teacher", center_id: "center:b", capability: "member", state: "active" },
    ]);
    expect(
      f.database.readAll(
        "SELECT user_id, class_id, role, state FROM marea_governance_memberships ORDER BY user_id, class_id",
      ),
    ).toEqual([
      { user_id: "legacy:student", class_id: "legacy:a", role: "student", state: "active" },
      { user_id: "legacy:teacher", class_id: "legacy:a", role: "teacher", state: "active" },
      { user_id: "legacy:teacher", class_id: "legacy:b", role: "teacher", state: "active" },
    ]);
    const adopted = snapshot();
    expect(() => confirm(map, receipt.digest)).toThrow();
    confirm();
    expect(snapshot()).toEqual(adopted);
  });

  it("reports complete closure and rejects partial adoption atomically", () => {
    const partial: AdoptionMap = {
      classes: [{ classId: "legacy:a", centerId: "center:a" }],
      accounts: [{ userId: "legacy:teacher", ownerCenterId: "center:a" }],
      administrators: [],
    };
    const before = snapshot();
    expect(preview(partial)).toMatchObject({
      missingClassIds: ["legacy:b"],
      missingUserIds: ["legacy:student"],
    });
    expect(() => confirm(partial)).toThrow();
    expect(snapshot()).toEqual(before);
    const grantWithoutAccount = { classes: [], accounts: [], administrators: map.administrators };
    expect(preview(grantWithoutAccount).missingUserIds).toEqual(["legacy:teacher"]);
  });

  it("requires historical class mappings without turning run history into an active assignment", () => {
    f.database.execute("DELETE FROM marea_teacher_classes WHERE class_id = 'legacy:b'");
    seedGovernanceHistory(f, "legacy:student", "legacy:b");
    const partial = { ...map, classes: [{ classId: "legacy:a", centerId: "center:a" }] };
    expect(preview(partial).missingClassIds).toEqual(["legacy:b"]);
    expect(() => confirm(partial)).toThrow();
    const history = f.database.readAll("SELECT * FROM marea_runs");
    const frozen = f.database.readAll("SELECT * FROM marea_run_snapshots");
    confirm();
    expect(
      f.database.readAll("SELECT * FROM marea_governance_memberships WHERE class_id = 'legacy:b'"),
    ).toEqual([]);
    expect(f.database.readAll("SELECT * FROM marea_runs")).toEqual(history);
    expect(f.database.readAll("SELECT * FROM marea_run_snapshots")).toEqual(frozen);
  });

  it.each([
    "UPDATE marea_centers SET version = 'center:changed' WHERE id = 'center:a'",
    "UPDATE marea_users SET password_hash = 'changed' WHERE id = 'legacy:teacher'",
    "UPDATE marea_classes SET display_name = 'Changed' WHERE id = 'legacy:a'",
    "DELETE FROM marea_teacher_classes WHERE class_id = 'legacy:b'",
  ])("rejects a changed relational inventory: %s", (sql) => {
    const receipt = preview();
    f.database.execute(sql);
    const before = snapshot();
    expect(() => confirm(map, receipt.digest)).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it("rejects conflicting ownership, roles and implicit administrator escalation", () => {
    expect(() =>
      preview({
        ...map,
        classes: [
          { classId: "legacy:a", centerId: "center:b" },
          { classId: "legacy:b", centerId: "center:b" },
        ],
      }),
    ).toThrow();
    f.database.execute("INSERT INTO marea_teacher_classes VALUES ('legacy:student', 'legacy:a')");
    expect(() => preview()).toThrow(expect.objectContaining({ code: "request.conflict" }));
    f.database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 'legacy:student'");
    const before = snapshot();
    expect(() =>
      confirm({ ...map, administrators: [{ userId: "legacy:student", centerId: "center:a" }] }),
    ).toThrow();
    expect(snapshot()).toEqual(before);
    confirm({ ...map, administrators: [] });
    const adopted = snapshot();
    expect(() => confirm()).toThrow();
    expect(snapshot()).toEqual(adopted);
    expect(() =>
      preview({
        ...map,
        accounts: [
          { userId: "legacy:teacher", ownerCenterId: "center:b" },
          { userId: "legacy:student", ownerCenterId: "center:a" },
        ],
      }),
    ).toThrow();
    expect(() =>
      preview({
        ...map,
        classes: [
          { classId: "legacy:a", centerId: "center:b" },
          { classId: "legacy:b", centerId: "center:b" },
        ],
      }),
    ).toThrow();
  });

  it("does not resurrect revoked associations or class memberships", () => {
    confirm();
    f.database.execute(
      "UPDATE marea_center_memberships SET state = 'revoked' WHERE user_id = 'legacy:teacher' AND center_id = 'center:b'",
    );
    let before = snapshot();
    expect(() => confirm()).toThrow();
    expect(snapshot()).toEqual(before);
    f.database.execute(
      "UPDATE marea_center_memberships SET state = 'active' WHERE user_id = 'legacy:teacher' AND center_id = 'center:b'",
    );
    f.database.execute(
      "UPDATE marea_governance_memberships SET state = 'revoked' WHERE user_id = 'legacy:teacher' AND class_id = 'legacy:b'",
    );
    before = snapshot();
    expect(() => confirm()).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it("rejects absent centers/accounts/classes and loss of exclusive ownership", () => {
    expect(() =>
      preview({ ...map, classes: [{ classId: "legacy:missing", centerId: "center:a" }] }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    expect(() =>
      preview({ ...map, classes: [{ classId: "legacy:a", centerId: "center:missing" }] }),
    ).toThrow();
    expect(() =>
      preview({ ...map, accounts: [{ userId: "legacy:missing", ownerCenterId: "center:a" }] }),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    const digest = preview().digest;
    const before = snapshot();
    f.release();
    expect(() => preview()).toThrow("Installation is not owned.");
    expect(() => confirm(map, digest)).toThrow("Installation is not owned.");
    expect(snapshot()).toEqual(before);
  });

  it("rolls all governance grants back if the final audit write fails", () => {
    f.database.executeScript(
      "CREATE TRIGGER reject_adoption_audit BEFORE INSERT ON marea_governance_audit WHEN NEW.operation = 'adoption-confirm' BEGIN SELECT RAISE(ABORT, 'injected-audit-failure'); END;",
    );
    const before = snapshot();
    expect(() => confirm()).toThrow("injected-audit-failure");
    expect(snapshot()).toEqual(before);
    f.database.executeScript("DROP TRIGGER reject_adoption_audit");
    confirm();
    expect(f.database.readAll("SELECT * FROM marea_governance_accounts")).toHaveLength(2);
  });

  it("rejects independently missing users or classes and includes unfulfilled explicit grants in the digest", () => {
    const classesOnly = { ...map, accounts: [], administrators: [] };
    const accountsOnly = { ...map, classes: [], administrators: [] };
    expect(preview(classesOnly).missingClassIds).toEqual([]);
    expect(preview(accountsOnly).missingUserIds).toEqual([]);
    for (const partial of [classesOnly, accountsOnly])
      expect(() => confirm(partial)).toThrow(expect.objectContaining({ code: "request.conflict" }));
    const empty = { classes: [], accounts: [], administrators: [] };
    expect(preview({ ...empty, administrators: map.administrators }).digest).not.toBe(
      preview(empty).digest,
    );
    expect(
      preview({
        ...map,
        administrators: [...map.administrators, { userId: "user:unmapped", centerId: "center:a" }],
      }).digest,
    ).not.toBe(preview(map).digest);
  });

  it("rejects changed governed ownership without relying on student relationships", () => {
    confirm();
    const changed = {
      classes: [{ classId: "legacy:b", centerId: "center:a" }],
      accounts: [],
      administrators: [],
    };
    expect(() => preview(changed)).toThrow(expect.objectContaining({ code: "request.conflict" }));
  });

  it("sorts missing identities independently of relationship and explicit-grant discovery order", () => {
    f.database.execute("UPDATE marea_users SET class_id = 'legacy:b' WHERE id = 'legacy:student'");
    expect(preview({ ...map, classes: [] }).missingClassIds).toEqual(["legacy:a", "legacy:b"]);
    expect(
      preview({
        ...map,
        accounts: [],
        administrators: [{ userId: "aaa:user", centerId: "center:a" }],
      }).missingUserIds,
    ).toEqual(["aaa:user", "legacy:student", "legacy:teacher"]);
  });

  it("keeps a teacher's legacy primary class in the required closure even without an assignment", () => {
    f.database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 'legacy:teacher'");
    const partial = {
      classes: [],
      accounts: [{ userId: "legacy:teacher", ownerCenterId: "center:a" }],
      administrators: [],
    };
    expect(preview(partial).missingClassIds).toEqual(["legacy:a"]);
  });

  it("rejects an active stored class membership with a conflicting role", () => {
    confirm();
    f.database.execute(
      "UPDATE marea_governance_memberships SET role = 'student' WHERE user_id = 'legacy:teacher' AND class_id = 'legacy:b'",
    );
    const before = snapshot();
    expect(() => confirm()).toThrow(expect.objectContaining({ code: "request.conflict" }));
    expect(snapshot()).toEqual(before);
  });

  it("audits a class-only adoption without accounts or relationships", () => {
    f.database.execute("INSERT INTO marea_classes VALUES ('legacy:empty', 'seed:empty', 'Empty')");
    confirm({
      classes: [{ classId: "legacy:empty", centerId: "center:b" }],
      accounts: [],
      administrators: [],
    });
    expect(
      f.database.readAll(
        "SELECT center_id, operation FROM marea_governance_audit WHERE operation = 'adoption-confirm'",
      ),
    ).toEqual([{ center_id: "center:b", operation: "adoption-confirm" }]);
  });

  it("audits only the center where an existing association gains its missing proven membership", () => {
    confirm();
    const before = f.database.readAll("SELECT * FROM marea_governance_audit").length;
    f.database.execute(
      "DELETE FROM marea_governance_memberships WHERE user_id = 'legacy:teacher' AND class_id = 'legacy:b'",
    );
    confirm();
    expect(
      f.database
        .readAll("SELECT center_id, operation FROM marea_governance_audit ORDER BY sequence")
        .slice(before),
    ).toEqual([{ center_id: "center:b", operation: "adoption-confirm" }]);
  });

  it("creates and audits independent owner associations and explicit foreign grants for an existing account", () => {
    f.createAccount("center:a", "user:independent");
    f.activate("center:a", "user:independent");
    f.database.execute("DELETE FROM marea_center_memberships WHERE user_id = 'user:independent'");
    const before = f.database.readAll("SELECT * FROM marea_governance_audit").length;
    confirm({
      classes: [],
      accounts: [{ userId: "user:independent", ownerCenterId: "center:a" }],
      administrators: [{ userId: "user:independent", centerId: "center:b" }],
    });
    expect(
      f.database.readAll(
        "SELECT center_id, capability FROM marea_center_memberships WHERE user_id = 'user:independent' ORDER BY center_id",
      ),
    ).toEqual([
      { center_id: "center:a", capability: "member" },
      { center_id: "center:b", capability: "administrator" },
    ]);
    expect(
      f.database
        .readAll("SELECT center_id, operation FROM marea_governance_audit ORDER BY sequence")
        .slice(before),
    ).toEqual([
      { center_id: "center:a", operation: "adoption-confirm" },
      { center_id: "center:b", operation: "adoption-confirm" },
    ]);
  });
});
