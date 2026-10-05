import { afterEach, describe, expect, it } from "vitest";

import { governanceDatabase } from "../test-support/governance-database.fixture.js";
import { migrateDatabase, verifyDatabase } from "./database-schema.js";
import { createEducationalMigrationCatalog } from "./educational-migration-catalog.js";
import { parseMigrationCatalog } from "./migration-catalog.boundary.js";
import { createStudentIdentityMigrationCatalog } from "./student-identity-migration-catalog.js";

const opened: ReturnType<typeof governanceDatabase>[] = [];
afterEach(() => {
  for (const f of opened.splice(0)) f.close();
});

const NOW = "2026-10-05T00:00:00.000Z";

function educational() {
  const f = governanceDatabase(8);
  opened.push(f);
  f.database.exec(`
    INSERT INTO marea_classes VALUES ('class-1', 'seed-1', 'One'), ('class-2', 'seed-2', 'Two');
    INSERT INTO marea_users VALUES
      ('student-1', 'student-1', 'hash', 'student', 'Student', 'class-1'),
      ('teacher-1', 'teacher-1', 'hash', 'teacher', 'Teacher', 'class-1');
    INSERT INTO marea_auth_sessions (id, user_id, token_hash, issued_at, expires_at) VALUES
      ('session-s', 'student-1', 'token-s', '${NOW}', '${NOW}'),
      ('session-t', 'teacher-1', 'token-t', '${NOW}', '${NOW}');
    INSERT INTO marea_centers VALUES ('center-1', 'Center', 'v', '${NOW}', '${NOW}');
    INSERT INTO marea_governance_classes VALUES
      ('class-1', 'center-1', 'v', '${NOW}', '${NOW}'),
      ('class-2', 'center-1', 'v', '${NOW}', '${NOW}');
    INSERT INTO marea_governance_accounts VALUES ('student-1', 'center-1', 'active', 'v', '${NOW}', '${NOW}');
    INSERT INTO marea_center_memberships VALUES
      ('center-1', 'student-1', 'member', 'active', 'v', '${NOW}', '${NOW}');
    INSERT INTO marea_governance_memberships VALUES
      ('class-1', 'center-1', 'student-1', 'student', 'active', 'v', '${NOW}', '${NOW}');
  `);
  migrateDatabase(f.port, createEducationalMigrationCatalog());
  return f;
}

describe("student identity schema 12", () => {
  it("extends the educational catalog explicitly and round-trips through the boundary", () => {
    const catalog = createStudentIdentityMigrationCatalog();
    expect(catalog.slice(0, 11)).toEqual(createEducationalMigrationCatalog());
    expect(catalog.at(-1)).toMatchObject({
      name: "student_classes_and_external_identities",
      version: 12,
    });
    expect(parseMigrationCatalog(catalog)).toEqual(catalog);
  });

  it("keeps each live student session in its current class and verifies the new schema", () => {
    const { port } = educational();
    const ledger = port.readAll("SELECT * FROM marea_schema_migrations");
    const catalog = createStudentIdentityMigrationCatalog();
    expect(migrateDatabase(port, catalog).version).toBe(12);
    expect(port.readAll("SELECT * FROM marea_schema_migrations WHERE version <= 11")).toEqual(
      ledger,
    );
    expect(verifyDatabase(port, catalog).version).toBe(12);
    expect(port.readAll("SELECT id, class_id FROM marea_auth_sessions ORDER BY id")).toEqual([
      { id: "session-s", class_id: "class-1" },
      { id: "session-t", class_id: null },
    ]);
    expect(port.readAll("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("admits several active classes per student and records the granting provider", () => {
    const { port } = educational();
    migrateDatabase(port, createStudentIdentityMigrationCatalog());
    port.execute(
      `INSERT INTO marea_governance_memberships
      (class_id, center_id, user_id, role, state, version, created_at, updated_at, external_provider)
      VALUES ('class-2', 'center-1', 'student-1', 'student', 'active', 'v', ?1, ?1, 'org.example.idp')`,
      [NOW],
    );
    expect(
      port.readAll(
        "SELECT class_id, external_provider FROM marea_governance_memberships ORDER BY class_id",
      ),
    ).toEqual([
      { class_id: "class-1", external_provider: null },
      { class_id: "class-2", external_provider: "org.example.idp" },
    ]);
  });

  it("binds one external subject to one account and rules to governed classes", () => {
    const { port } = educational();
    migrateDatabase(port, createStudentIdentityMigrationCatalog());
    const identity = (provider: string, subject: string, user: string) => {
      port.execute(
        "INSERT INTO marea_external_identities VALUES (?1, ?2, ?3, 'a@example.test', ?4, ?4)",
        [provider, subject, user, NOW],
      );
    };
    identity("org.example.idp", "subject-1", "student-1");
    expect(() => {
      identity("org.example.idp", "subject-2", "student-1");
    }).toThrow();
    expect(() => {
      identity("org.example.idp", "subject-1", "teacher-1");
    }).toThrow();
    expect(() => {
      identity("org.example.idp", "subject-3", "missing");
    }).toThrow();
    const rule = (classId: string) => {
      port.execute(
        "INSERT INTO marea_external_admission_rules VALUES (?1, 'org.example.idp', 'email', 'a@example.test', 'teacher-1', ?2)",
        [classId, NOW],
      );
    };
    rule("class-1");
    expect(() => {
      rule("class-1");
    }).toThrow();
    port.execute("DELETE FROM marea_governance_memberships WHERE class_id = 'class-2'");
    port.execute("DELETE FROM marea_governance_classes WHERE class_id = 'class-2'");
    expect(() => {
      rule("class-2");
    }).toThrow();
  });

  it("rolls back every failed schema 12 statement", () => {
    const catalog = createStudentIdentityMigrationCatalog();
    const migration = catalog.at(-1);
    if (migration === undefined) throw new Error("Missing schema 12");
    for (const fail of migration.statements) {
      const { port } = educational();
      const before = port.readAll("SELECT * FROM sqlite_schema ORDER BY name");
      const sessions = port.readAll("SELECT * FROM marea_auth_sessions ORDER BY id");
      const failing: typeof port = Object.create(port) as typeof port;
      failing.execute = (sql, args) => {
        if (sql === fail) throw new Error("injected failure");
        port.execute(sql, args);
      };
      expect(() => migrateDatabase(failing, catalog)).toThrow("injected failure");
      expect(port.readAll("SELECT * FROM sqlite_schema ORDER BY name")).toEqual(before);
      expect(port.readAll("SELECT * FROM marea_auth_sessions ORDER BY id")).toEqual(sessions);
    }
  });
});
