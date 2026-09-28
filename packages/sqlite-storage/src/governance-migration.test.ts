import { afterEach, describe, expect, it } from "vitest";
import {
  governanceDatabase,
  seedLegacyGovernanceSubjects,
} from "../test-support/governance-database.fixture.js";
import { migrateDatabase, verifyDatabase } from "./database-schema.js";
import { createMigrationCatalog } from "./migration-catalog.js";

const catalog = createMigrationCatalog().slice(0, 7);
const opened: ReturnType<typeof governanceDatabase>[] = [];
afterEach(() => {
  for (const fixture of opened.splice(0)) fixture.close();
});
function open(version: number) {
  const fixture = governanceDatabase(version);
  opened.push(fixture);
  return fixture;
}

describe("real additive governance migration", () => {
  it.each([1, 2, 3, 4, 5, 6])(
    "upgrades supported schema %i and repeats without changes",
    (version) => {
      const { port } = open(version);
      expect(migrateDatabase(port, catalog).version).toBe(7);
      const ledger = port.readAll("SELECT * FROM marea_schema_migrations ORDER BY version");
      expect(migrateDatabase(port, catalog).version).toBe(7);
      expect(port.readAll("SELECT * FROM marea_schema_migrations ORDER BY version")).toEqual(
        ledger,
      );
      expect(port.readAll("PRAGMA foreign_key_check")).toEqual([]);
    },
  );

  it("preserves every legacy table and creates empty governance tables without adoption", () => {
    const { database, port } = open(6);
    seedLegacyGovernanceSubjects(database);
    const tables = port.readAll(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name != 'marea_schema_migrations' ORDER BY name",
    );
    const before = tables.map(({ name }) => ({
      name,
      rows: port.readAll(`SELECT * FROM ${String(name)}`),
    }));
    expect(migrateDatabase(port, catalog).version).toBe(7);
    for (const { name, rows } of before)
      expect(port.readAll(`SELECT * FROM ${String(name)}`)).toEqual(rows);
    for (const table of [
      "marea_centers",
      "marea_governance_accounts",
      "marea_center_memberships",
      "marea_governance_classes",
      "marea_governance_memberships",
      "marea_class_exchange_previews",
      "marea_governance_audit",
    ]) {
      expect(port.readOne(`SELECT COUNT(*) AS count FROM ${table}`)).toEqual({ count: 0n });
    }
    expect(verifyDatabase(port, catalog).version).toBe(7);
  });

  it("rolls back actual SQLite state after failure at every schema-7 statement", () => {
    const migration = catalog.at(-1);
    expect(migration?.version).toBe(7);
    if (migration === undefined) throw new Error("Missing migration 7.");
    for (const statement of migration.statements) {
      const { database, port } = open(6);
      seedLegacyGovernanceSubjects(database);
      const schemaBefore = port.readAll("SELECT * FROM sqlite_schema ORDER BY name");
      const ledgerBefore = port.readAll("SELECT * FROM marea_schema_migrations ORDER BY version");
      const usersBefore = port.readAll("SELECT * FROM marea_users ORDER BY id");
      const failure = new Error("Injected schema-7 statement failure");
      const failingPort = {
        ...port,
        execute: (sql: string, values = [] as Parameters<typeof port.execute>[1]) => {
          if (sql === statement) throw failure;
          port.execute(sql, values);
        },
      };
      expect(() => migrateDatabase(failingPort, catalog)).toThrow(failure);
      expect(verifyDatabase(port, catalog.slice(0, 6)).version).toBe(6);
      expect(port.readAll("SELECT * FROM sqlite_schema ORDER BY name")).toEqual(schemaBefore);
      expect(port.readAll("SELECT * FROM marea_schema_migrations ORDER BY version")).toEqual(
        ledgerBefore,
      );
      expect(port.readAll("SELECT * FROM marea_users ORDER BY id")).toEqual(usersBefore);
      expect(migrateDatabase(port, catalog).version).toBe(7);
    }
  });

  it("fails closed on future versions and changed governance schema or ledger", () => {
    const future = open(7);
    future.database.exec("PRAGMA user_version = 8");
    expect(() => migrateDatabase(future.port, catalog)).toThrow();
    expect(future.port.readOne("PRAGMA user_version")).toEqual({ user_version: 8n });
    const drift = open(7);
    drift.database.exec(
      "UPDATE marea_schema_migrations SET checksum = 'changed' WHERE version = 7",
    );
    expect(() => verifyDatabase(drift.port, catalog)).toThrow();
    const changed = open(7);
    changed.database.exec("DROP INDEX marea_governance_one_student_class");
    expect(() => verifyDatabase(changed.port, catalog)).toThrow();
  });
});
