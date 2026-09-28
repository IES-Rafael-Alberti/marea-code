import { afterEach, describe, expect, it } from "vitest";
import {
  governanceDatabase,
  seedGovernanceScopes,
} from "../test-support/governance-database.fixture.js";
import { createMigrationCatalog } from "./migration-catalog.js";
import { migrateDatabase, verifyDatabase } from "./database-schema.js";

const catalog = createMigrationCatalog();
const opened: ReturnType<typeof governanceDatabase>[] = [];
afterEach(() => {
  for (const fixture of opened.splice(0)) fixture.close();
});

function legacy() {
  const fixture = governanceDatabase(7);
  opened.push(fixture);
  seedGovernanceScopes(fixture.database);
  fixture.database.exec(`INSERT INTO marea_class_exchange_previews
    (id, center_id, class_id, authority, user_id, session_id, expected_class_version, operator_fingerprint,
      package_digest, created_at, expires_at, state, result_revision_id)
    VALUES ('preview-1', 'center-1', 'class-1', 'administrator', 'teacher-1', 'session-1', 'v1',
      'private-fingerprint', 'digest', '2026-09-12T08:00:00.000Z', '2026-09-12T08:05:00.000Z', 'consumed', 'revision-1')`);
  return fixture;
}

describe("explicit revision authorship migration 8", () => {
  it("preserves revision bytes, original authors and both incoming relationships", () => {
    const { port } = legacy();
    const current = port.readAll("SELECT * FROM marea_current_class_teaching");
    const previews = port.readAll("SELECT * FROM marea_class_exchange_previews");
    const revisions = port.readAll("SELECT * FROM marea_class_teaching_revisions");
    const ledger = port.readAll("SELECT * FROM marea_schema_migrations ORDER BY version");
    expect(migrateDatabase(port, catalog).version).toBe(8);
    expect(
      port.readAll(
        "SELECT id, class_id, created_by, created_at, configuration_json FROM marea_class_teaching_revisions",
      ),
    ).toEqual(revisions);
    expect(port.readAll("SELECT authority FROM marea_class_teaching_revisions")).toEqual([
      { authority: "teacher" },
    ]);
    expect(port.readAll("SELECT * FROM marea_current_class_teaching")).toEqual(current);
    expect(port.readAll("SELECT * FROM marea_class_exchange_previews")).toEqual(previews);
    expect(
      port.readAll("SELECT * FROM marea_schema_migrations WHERE version <= 7 ORDER BY version"),
    ).toEqual(ledger);
    expect(port.readAll("PRAGMA foreign_key_check")).toEqual([]);
    expect(port.readOne("PRAGMA foreign_keys")).toEqual({ foreign_keys: 1n });
    expect(port.readAll("SELECT name FROM sqlite_temp_schema")).toEqual([]);
    expect(migrateDatabase(port, catalog).version).toBe(8);
    expect(
      port.readAll(
        "SELECT id, class_id, created_by, created_at, configuration_json FROM marea_class_teaching_revisions",
      ),
    ).toEqual(revisions);
  });

  it("accepts only explicit operator-without-user and identified teacher/administrator authors", () => {
    const { port } = legacy();
    migrateDatabase(port, catalog);
    const sql = `INSERT INTO marea_class_teaching_revisions (id, class_id, created_by, created_at, configuration_json, authority)
      VALUES (?1, 'class-1', ?2, '2026-09-12T08:01:00.000Z', '{}', ?3)`;
    port.execute(sql, ["revision-operator", null, "operator"]);
    port.execute(sql, ["revision-admin", "teacher-1", "administrator"]);
    port.execute(`INSERT INTO marea_class_teaching_revisions (id, class_id, created_by, created_at, configuration_json)
      VALUES ('revision-default', 'class-1', 'teacher-1', '2026-09-12T08:01:00.000Z', '{}')`);
    expect(
      port.readOne(
        "SELECT authority FROM marea_class_teaching_revisions WHERE id = 'revision-default'",
      ),
    ).toEqual({ authority: "teacher" });
    for (const [user, authority] of [
      [null, "teacher"],
      [null, "administrator"],
      ["teacher-1", "operator"],
      ["missing-user", "teacher"],
      [null, "unknown"],
    ] as const) {
      expect(() => {
        port.execute(sql, ["denied", user, authority]);
      }).toThrow();
    }
    port.execute("UPDATE marea_current_class_teaching SET revision_id = 'revision-operator'");
    expect(port.readAll("PRAGMA foreign_key_check")).toEqual([]);
    expect(() => {
      port.execute("DELETE FROM marea_class_teaching_revisions WHERE id = 'revision-operator'");
    }).toThrow();
    expect(() => {
      port.execute("DELETE FROM marea_class_teaching_revisions WHERE id = 'revision-1'");
    }).toThrow();
  });

  it("rolls back every rebuild statement, including populated child tables and the migration ledger", () => {
    const migration = catalog[7];
    if (migration === undefined) throw new Error("Expected migration eight.");
    for (const statement of migration.statements) {
      const { port } = legacy();
      const before = [
        "sqlite_schema",
        "marea_schema_migrations",
        "marea_class_teaching_revisions",
        "marea_current_class_teaching",
        "marea_class_exchange_previews",
      ].map((table) => ({ table, rows: port.readAll(`SELECT * FROM ${table}`) }));
      const failure = new Error("Synthetic migration failure.");
      expect(() =>
        migrateDatabase(
          {
            ...port,
            execute(sql, parameters) {
              if (sql === statement) throw failure;
              port.execute(sql, parameters);
            },
          },
          catalog,
        ),
      ).toThrow(failure);
      for (const { table, rows } of before)
        expect(port.readAll(`SELECT * FROM ${table}`)).toEqual(rows);
      expect(port.readAll("SELECT name FROM sqlite_temp_schema")).toEqual([]);
      expect(verifyDatabase(port, catalog.slice(0, 7)).version).toBe(7);
      expect(migrateDatabase(port, catalog).version).toBe(8);
    }
  });
});
