import { afterEach, expect, it } from "vitest";
import { governanceDatabase } from "../test-support/governance-database.fixture.js";
import { createProfileMigrationCatalog } from "./profile-migration-catalog.js";
import { migrateDatabase, verifyDatabase } from "./database-schema.js";
import { createDashboardProfileStore } from "./profile-storage.js";
const opened: ReturnType<typeof governanceDatabase>[] = [];
afterEach(() => {
  for (const f of opened.splice(0)) f.close();
});
function fixture() {
  const f = governanceDatabase(8);
  opened.push(f);
  f.database.exec(
    "INSERT INTO marea_classes VALUES ('class-1','seed-1','One'); INSERT INTO marea_users VALUES ('teacher-1','teacher-1','hash','teacher','Synthetic',NULL)",
  );
  return f;
}
function profiles() {
  const { port } = fixture();
  migrateDatabase(port, createProfileMigrationCatalog());
  return {
    port,
    store: createDashboardProfileStore({
      ...port,
      transaction: (op) => port.transactionImmediate(op),
    }),
  };
}
it("adds migration 10 without rewriting prior ledgers and rejects older releases", () => {
  const { port } = fixture();
  const ledger = port.readAll("SELECT * FROM marea_schema_migrations");
  const catalog = createProfileMigrationCatalog();
  expect(migrateDatabase(port, catalog).version).toBe(10);
  expect(port.readAll("SELECT * FROM marea_schema_migrations WHERE version <= 8")).toEqual(ledger);
  expect(() => verifyDatabase(port, catalog.slice(0, 8))).toThrow();
  expect(port.readAll("PRAGMA foreign_key_check")).toEqual([]);
});
it("enforces distinct unique keys and cascades only the deleted subject's profiles", () => {
  const { port, store } = profiles();
  const row = {
    schemaVersion: 1,
    revision: "revision-1",
    updatedAt: "2026-09-22T00:00:00Z",
    serializedValue: null,
  };
  store.write("teacher-1", null, row);
  store.write("teacher-1", "class-1", row);
  expect(store.read("teacher-1", null)).toEqual(row);
  expect(() => {
    port.execute("INSERT INTO marea_dashboard_profiles SELECT * FROM marea_dashboard_profiles");
  }).toThrow();
  expect(() =>
    store.transaction(() => {
      store.write("teacher-1", null, { ...row, revision: "rolled-back" });
      throw new Error("rollback");
    }),
  ).toThrow("rollback");
  expect(store.read("teacher-1", null)?.revision).toBe("revision-1");
  port.execute("DELETE FROM marea_teacher_classes");
  port.execute("UPDATE marea_users SET class_id = NULL");
  port.execute("DELETE FROM marea_classes WHERE id = 'class-1'");
  expect(store.read("teacher-1", "class-1")).toBeNull();
  expect(store.read("teacher-1", null)).toEqual(row);
  port.execute("DELETE FROM marea_users WHERE id = 'teacher-1'");
  expect(store.read("teacher-1", null)).toBeNull();
});
it("rolls back every failed migration statement", () => {
  const catalog = createProfileMigrationCatalog();
  const migration = catalog.at(-1);
  if (migration === undefined) throw new Error("Missing profiles migration");
  for (const fail of migration.statements) {
    const { port } = fixture();
    const before = port.readAll("SELECT * FROM sqlite_schema ORDER BY name");
    expect(() =>
      migrateDatabase(
        {
          ...port,
          execute(sql, args) {
            if (sql === fail) throw new Error("injected failure");
            port.execute(sql, args);
          },
        },
        catalog,
      ),
    ).toThrow();
    expect(port.readAll("SELECT * FROM sqlite_schema ORDER BY name")).toEqual(before);
  }
});
it.each([
  { schema_version: "bad", revision: "r", updated_at: "now", value_json: null },
  { schema_version: 1, revision: 1, updated_at: "now", value_json: null },
  { schema_version: 1, revision: "r", updated_at: null, value_json: null },
  { schema_version: 1, revision: "r", updated_at: "now", value_json: 1 },
])("rejects malformed storage rows", (row) => {
  const store = createDashboardProfileStore({
    execute() {
      throw new Error("Unexpected write");
    },
    readOne: () => row,
    readAll: () => [],
    transaction: (op) => op(),
  });
  expect(() => store.read("owner", null)).toThrow("Invalid profile");
});
it("independently enforces personal and class uniqueness and the UTF-8 storage bound", () => {
  const { port, store } = profiles();
  const row = {
    schemaVersion: 1,
    revision: "revision-1",
    updatedAt: "2026-09-22T00:00:00Z",
    serializedValue: "é".repeat(32_768),
  };
  store.write("teacher-1", null, row);
  store.write("teacher-1", "class-1", { ...row, serializedValue: null });
  for (const filter of ["class_id IS NULL", "class_id IS NOT NULL"])
    expect(() => {
      port.execute(
        `INSERT INTO marea_dashboard_profiles SELECT * FROM marea_dashboard_profiles WHERE ${filter}`,
      );
    }).toThrow();
  expect(() => {
    store.transaction(() => {
      store.write("teacher-1", null, { ...row, serializedValue: row.serializedValue + "a" });
    });
  }).toThrow();
  expect(store.read("teacher-1", null)).toEqual(row);
});
it("authorizes only current teachers and memberships", () => {
  const { port, store } = profiles();
  expect(store.authorized("teacher-1", null)).toBe(true);
  expect(store.authorized("missing", null)).toBe(false);
  expect(store.authorized("teacher-1", "class-1")).toBe(false);
  port.execute("INSERT INTO marea_teacher_classes VALUES ('teacher-1','class-1')");
  expect(store.authorized("teacher-1", "class-1")).toBe(true);
  port.execute("UPDATE marea_users SET role = 'student' WHERE id = 'teacher-1'");
  expect(store.authorized("teacher-1", "class-1")).toBe(false);
});
it("parses native numeric versions and rejects text versions with a safe diagnostic", () => {
  const row = { schema_version: 1, revision: "revision", updated_at: "now", value_json: "{}" };
  const store = createDashboardProfileStore({
    execute() {
      throw new Error("Unexpected write");
    },
    readOne: () => row,
    readAll: () => [],
    transaction: (op) => op(),
  });
  expect(store.read("owner", null)).toEqual({
    schemaVersion: 1,
    revision: "revision",
    updatedAt: "now",
    serializedValue: "{}",
  });
  Reflect.set(row, "schema_version", "future");
  expect(() => store.read("owner", null)).toThrow("Invalid profile version.");
});
