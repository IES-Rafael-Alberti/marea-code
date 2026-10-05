import { describe, expect, it } from "vitest";

import type { ExternalProvisioning } from "../../external-identity/contracts.js";
import {
  GOVERNANCE_EXPIRES,
  GOVERNANCE_NOW,
  governanceFixture,
  seedGovernancePilot,
} from "./governance-repository.fixture.js";
import { SqliteExternalIdentityRepository } from "./sqlite-external-identity-repository.js";

const PROVIDER = "org.example.idp";

function pilot(accountCreatable = true) {
  const guard = { accountCreatable: () => accountCreatable };
  const f = governanceFixture(undefined, "student-identities");
  seedGovernancePilot(f);
  f.createAccount("center:a", "user:teacher", "teacher", "class:a");
  f.activate("center:a", "user:teacher");
  return { ...f, external: new SqliteExternalIdentityRepository(f.database, guard) };
}

function person(
  admittedClassIds: readonly string[],
  overrides: Partial<ExternalProvisioning> = {},
) {
  return {
    providerId: PROVIDER,
    subject: "subject-1",
    email: "ana@school.test",
    displayName: "Ana",
    admittedClassIds,
    newUserId: "user:ana",
    newLogin: "x-ana",
    version: "revision:sync",
    now: GOVERNANCE_NOW,
    ...overrides,
  };
}

function memberships(f: ReturnType<typeof pilot>, userId = "user:ana") {
  return f.database.readAll(
    `SELECT class_id, state, external_provider FROM marea_governance_memberships
      WHERE user_id = ?1 ORDER BY class_id`,
    [userId],
  );
}

describe("SQLite external identity repository", () => {
  it("reports schema 12 storage", () => {
    expect(pilot().external.available()).toBe(true);
    const legacy = governanceFixture();
    expect(
      new SqliteExternalIdentityRepository(legacy.database, legacy.store.identities).available(),
    ).toBe(false);
  });

  it("creates an admitted person once as an active student of the first admitted class's center", () => {
    const f = pilot();
    expect(f.external.provision(person(["class:second", "class:a", "class:b"]))).toEqual({
      classId: null,
      displayName: "Ana",
      role: "student",
      userId: "user:ana",
    });
    expect(
      f.database.readOne(
        "SELECT login, password_hash, role, display_name, class_id FROM marea_users WHERE id = 'user:ana'",
      ),
    ).toEqual({
      login: "x-ana",
      password_hash: "",
      role: "student",
      display_name: "Ana",
      class_id: "class:a",
    });
    expect(
      f.database.readOne(
        "SELECT owner_center_id, state FROM marea_governance_accounts WHERE user_id = 'user:ana'",
      ),
    ).toEqual({ owner_center_id: "center:a", state: "active" });
    expect(memberships(f)).toEqual([
      { class_id: "class:a", state: "active", external_provider: PROVIDER },
      { class_id: "class:second", state: "active", external_provider: PROVIDER },
    ]);
    expect(f.identities.studentClasses("user:ana").map((entry) => entry.classId)).toEqual([
      "class:a",
      "class:second",
    ]);
    expect(f.identities.findCredential("x-ana")).toMatchObject({ passwordHash: "" });
    expect(
      f.external.provision(
        person(["class:a"], {
          newUserId: "user:other",
          email: "new@school.test",
          now: GOVERNANCE_EXPIRES,
        }),
      )?.userId,
    ).toBe("user:ana");
    expect(
      f.database.readOne("SELECT email, created_at, last_login_at FROM marea_external_identities"),
    ).toEqual({
      email: "new@school.test",
      created_at: GOVERNANCE_NOW,
      last_login_at: GOVERNANCE_EXPIRES,
    });
  });

  it("denies a new person admitted nowhere and refuses retired or taken identities", () => {
    expect(pilot().external.provision(person([]))).toBeUndefined();
    expect(pilot().external.provision(person(["class:unknown"]))).toBeUndefined();
    expect(() => pilot(false).external.provision(person(["class:a"]))).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );
    const taken = pilot();
    expect(() =>
      taken.external.provision(person(["class:a"], { newLogin: "user-teacher" })),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    expect(() =>
      taken.external.provision(person(["class:a"], { newUserId: "user:teacher" })),
    ).toThrow(expect.objectContaining({ code: "request.conflict" }));
  });

  it("ends only provider-granted memberships that no rule admits and keeps people's grants", () => {
    const f = pilot();
    f.external.provision(person(["class:a", "class:second"]));
    f.identities.createSession({
      classId: "class:second",
      sessionId: "session:second",
      userId: "user:ana",
      issuedAt: GOVERNANCE_NOW,
      expiresAt: GOVERNANCE_EXPIRES,
      tokenHash: "token:second",
    });
    f.database.execute(
      "UPDATE marea_governance_memberships SET external_provider = NULL WHERE class_id = 'class:a'",
    );
    f.database.execute("UPDATE marea_users SET class_id = 'class:second' WHERE id = 'user:ana'");
    f.external.provision(person([]));
    expect(memberships(f)).toEqual([
      { class_id: "class:a", state: "active", external_provider: null },
      { class_id: "class:second", state: "revoked", external_provider: PROVIDER },
    ]);
    expect(f.identities.resolveSession("token:second", GOVERNANCE_NOW)).toBeUndefined();
    expect(
      f.database.readOne("SELECT class_id FROM marea_users WHERE id = 'user:ana'")?.class_id,
    ).toBe("class:a");
    f.external.provision(person(["class:second", "class:b"]));
    expect(memberships(f)).toEqual([
      { class_id: "class:a", state: "active", external_provider: null },
      { class_id: "class:second", state: "active", external_provider: PROVIDER },
    ]);
    expect(
      f.database.readOne("SELECT class_id FROM marea_users WHERE id = 'user:ana'")?.class_id,
    ).toBe("class:a");
  });

  it("denies a disabled account or an account that is not a student", () => {
    const f = pilot();
    f.external.provision(person(["class:a"]));
    f.database.execute(
      "UPDATE marea_governance_accounts SET state = 'disabled' WHERE user_id = 'user:ana'",
    );
    expect(f.external.provision(person(["class:a"]))).toBeUndefined();
    f.database.execute(
      "INSERT INTO marea_external_identities VALUES (?1, 'teacher-subject', 'user:teacher', 't@school.test', ?2, ?2)",
      [PROVIDER, GOVERNANCE_NOW],
    );
    expect(
      f.external.provision(person(["class:a"], { subject: "teacher-subject" })),
    ).toBeUndefined();
  });

  it("lets a class teacher manage bounded rules and groups them by class for a provider", () => {
    const f = pilot();
    expect(f.external.teacherClassAccess("user:teacher", "class:a")).toBe(true);
    expect(() => f.external.teacherClassAccess("user:teacher", "class:second")).toThrow(
      expect.objectContaining({ code: "dashboard.forbidden" }),
    );
    const change = {
      teacherId: "user:teacher",
      classId: "class:a",
      providerId: PROVIDER,
      kind: "email",
      values: ["b@school.test", "a@school.test"],
      operation: "add" as const,
      now: GOVERNANCE_NOW,
    };
    f.external.changeRules(change);
    f.external.changeRules(change);
    f.external.changeRules({
      ...change,
      providerId: "org.example.other",
      values: ["x@school.test"],
    });
    f.external.changeRules({ ...change, kind: "group", values: ["all@school.test"] });
    expect(f.external.classRulesFor("class:a", [PROVIDER])).toEqual([
      { providerId: PROVIDER, kind: "email", value: "a@school.test" },
      { providerId: PROVIDER, kind: "email", value: "b@school.test" },
      { providerId: PROVIDER, kind: "group", value: "all@school.test" },
    ]);
    expect(f.external.classRules(PROVIDER)).toEqual([
      {
        classId: "class:a",
        rules: [
          { kind: "email", value: "a@school.test" },
          { kind: "email", value: "b@school.test" },
          { kind: "group", value: "all@school.test" },
        ],
      },
    ]);
    f.external.changeRules({ ...change, operation: "remove", values: ["a@school.test"] });
    expect(f.external.classRulesFor("class:a", [PROVIDER]).map((rule) => rule.value)).toEqual([
      "b@school.test",
      "all@school.test",
    ]);
    expect(
      f.database.readOne(
        "SELECT created_by, created_at FROM marea_external_admission_rules LIMIT 1",
      ),
    ).toEqual({ created_by: "user:teacher", created_at: GOVERNANCE_NOW });
    expect(() => {
      f.external.changeRules({
        ...change,
        values: Array.from({ length: 498 }, (_, index) => `p${String(index)}@school.test`),
      });
    }).toThrow(expect.objectContaining({ code: "request.conflict" }));
    expect(f.external.classRulesFor("class:a", [PROVIDER])).toHaveLength(2);
    f.external.changeRules({
      ...change,
      values: Array.from({ length: 497 }, (_, index) => `p${String(index)}@school.test`),
    });
    expect(f.external.classRulesFor("class:a", [PROVIDER, "org.example.other"])).toHaveLength(500);
  });

  it("treats a legacy class as unavailable for external access", () => {
    const f = pilot();
    f.database.execute("INSERT INTO marea_classes VALUES ('class:legacy', 'legacy', 'Legacy')");
    f.database.execute(
      "INSERT INTO marea_teacher_classes (teacher_id, class_id) VALUES ('user:teacher', 'class:legacy')",
    );
    expect(f.external.teacherClassAccess("user:teacher", "class:legacy")).toBe(false);
    expect(() => {
      f.external.changeRules({
        teacherId: "user:teacher",
        classId: "class:legacy",
        providerId: PROVIDER,
        kind: "email",
        values: ["a@school.test"],
        operation: "add",
        now: GOVERNANCE_NOW,
      });
    }).toThrow(expect.objectContaining({ code: "request.conflict" }));
  });
});
