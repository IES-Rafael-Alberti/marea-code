import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMigrationCatalog } from "@marea/sqlite-storage/migrations";

import { NodeSqliteTestDatabase } from "../../../test-support/node-sqlite-database.boundary.js";
import { SqliteIdentityRepository } from "./sqlite-identity-repository.js";
import { SqliteTeachingConfigurationRepository } from "./sqlite-teaching-configuration-repository.js";
import { SqliteTeachingDashboardRepository } from "./sqlite-teaching-dashboard-repository.js";
import { activeGovernanceAccount, activeGovernanceMembership } from "./governance-access-sql.js";

const NOW = "2026-09-12T10:00:00.000Z";
const EXPIRES = "2026-09-12T11:00:00.000Z";

describe("governance compatibility gates on real SQLite", () => {
  let database: NodeSqliteTestDatabase;
  let identities: SqliteIdentityRepository;

  beforeEach(() => {
    database = new NodeSqliteTestDatabase();
    for (const migration of createMigrationCatalog()) {
      for (const sql of migration.statements) database.executeScript(sql);
    }
    identities = new SqliteIdentityRepository(database);
    identities.applyBootstrap(
      {
        seedId: "compatibility",
        classes: [{ classId: "class:one", key: "one", displayName: "One" }],
        accounts: [
          {
            userId: "user:teacher",
            classKey: "one",
            displayName: "Teacher",
            login: "teacher",
            passwordHash: "private-hash",
            role: "teacher",
          },
        ],
        invitations: [],
      },
      NOW,
    );
  });

  afterEach(() => {
    database.close();
  });

  function adopt() {
    database.execute("INSERT INTO marea_centers VALUES ('center:one', 'Center', 'v:one', ?1, ?1)", [
      NOW,
    ]);
    database.execute(
      "INSERT INTO marea_governance_accounts VALUES ('user:teacher', 'center:one', 'active', 'v:one', ?1, ?1)",
      [NOW],
    );
    database.execute(
      "INSERT INTO marea_center_memberships VALUES ('center:one', 'user:teacher', 'member', 'active', 'v:one', ?1, ?1)",
      [NOW],
    );
    database.execute(
      "INSERT INTO marea_governance_classes VALUES ('class:one', 'center:one', 'v:one', ?1, ?1)",
      [NOW],
    );
    database.execute(
      "INSERT INTO marea_governance_memberships VALUES ('class:one', 'center:one', 'user:teacher', 'teacher', 'active', 'v:one', ?1, ?1)",
      [NOW],
    );
  }

  function session(suffix: string) {
    identities.createSession({
      userId: "user:teacher",
      sessionId: `session:${suffix}`,
      tokenHash: `token:${suffix}`,
      issuedAt: NOW,
      expiresAt: EXPIRES,
    });
  }

  it("keeps legacy identities usable without granting adopted-class fallback", () => {
    session("legacy");
    expect(identities.findCredential("teacher")?.userId).toBe("user:teacher");
    expect(identities.resolveSession("token:legacy", NOW)?.role).toBe("teacher");
    const repository = new SqliteTeachingConfigurationRepository(database);
    expect(() => {
      repository.requireTeacherClass("user:teacher", "class:one");
    }).not.toThrow();
    database.execute("INSERT INTO marea_centers VALUES ('center:one', 'Center', 'v:one', ?1, ?1)", [
      NOW,
    ]);
    database.execute(
      "INSERT INTO marea_governance_classes VALUES ('class:one', 'center:one', 'v:one', ?1, ?1)",
      [NOW],
    );
    expect(() => {
      repository.requireTeacherClass("user:teacher", "class:one");
    }).toThrow(expect.objectContaining({ code: "dashboard.forbidden" }));
  });

  it.each(["pending", "disabled"])(
    "denies %s at lookup, resolution and the post-hash session commit",
    (state) => {
      adopt();
      session("before");
      expect(identities.findCredential("teacher")?.passwordHash).toBe("private-hash");
      database.execute("UPDATE marea_governance_accounts SET state = ?1", [state]);
      expect(identities.findCredential("teacher")).toBeUndefined();
      expect(identities.resolveSession("token:before", NOW)).toBeUndefined();
      expect(() => {
        session("after");
      }).toThrow(expect.objectContaining({ code: "auth.invalid" }));
      expect(
        database.readOne("SELECT id FROM marea_auth_sessions WHERE id = 'session:after'"),
      ).toBeUndefined();
    },
  );

  it.each([
    "UPDATE marea_governance_accounts SET state = 'disabled'",
    "UPDATE marea_center_memberships SET state = 'revoked'",
    "UPDATE marea_governance_memberships SET state = 'revoked'",
    "UPDATE marea_governance_memberships SET role = 'student'",
    "DELETE FROM marea_governance_memberships",
  ])("rechecks current membership for class reads and teaching commits: %s", async (change) => {
    adopt();
    const configuration = new SqliteTeachingConfigurationRepository(database);
    const directory = new SqliteTeachingDashboardRepository(database);
    const query = { teacherId: "user:teacher", afterClassId: null, limit: 100 };
    expect(() => {
      configuration.requireTeacherClass("user:teacher", "class:one");
    }).not.toThrow();
    expect(await directory.listClasses(query)).toHaveLength(1);
    database.execute(change);
    expect(() => {
      configuration.requireTeacherClass("user:teacher", "class:one");
    }).toThrow(expect.objectContaining({ code: "dashboard.forbidden" }));
    expect(await directory.listClasses(query)).toEqual([]);
    expect(database.readOne("SELECT * FROM marea_teacher_classes")).toBeDefined();
  });

  it("does not turn an administrator grant into a teaching assignment", () => {
    adopt();
    database.execute("UPDATE marea_center_memberships SET capability = 'administrator'");
    database.execute("DELETE FROM marea_governance_memberships");
    expect(() => {
      new SqliteTeachingConfigurationRepository(database).requireTeacherClass(
        "user:teacher",
        "class:one",
      );
    }).toThrow(expect.objectContaining({ code: "dashboard.forbidden" }));
  });

  it("binds predicates to the requested identity, class and role with no foreign fallback", () => {
    adopt();
    const allowed = (user: string, classroom: string, role: string) =>
      database.readOne(
        `SELECT 1 AS allowed WHERE ${activeGovernanceMembership("?1", "?2", "?3")}`,
        [user, classroom, role],
      ) !== undefined;
    expect(allowed("user:teacher", "class:one", "teacher")).toBe(true);
    expect(allowed("user:foreign", "class:one", "teacher")).toBe(false);
    expect(allowed("user:teacher", "class:one", "student")).toBe(false);
    expect(allowed("user:teacher", "class:unadopted", "teacher")).toBe(true);
    database.execute("UPDATE marea_governance_accounts SET state = 'disabled'");
    expect(allowed("user:teacher", "class:unadopted", "teacher")).toBe(false);
    expect(
      database.readOne(`SELECT 1 WHERE ${activeGovernanceAccount("?1")}`, ["user:teacher"]),
    ).toBeUndefined();
    expect(
      database.readOne(`SELECT 1 WHERE ${activeGovernanceAccount("?1")}`, ["user:legacy"]),
    ).toBeDefined();
  });
});
