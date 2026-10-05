import { createEducationalMigrationCatalog } from "./educational-migration-catalog.js";
import { describe, expect, it } from "vitest";

import { SqliteStorageError } from "./contracts.js";
import {
  calculateMigrationChecksum,
  createMigrationCatalog,
  type MigrationDefinition,
  type SchemaObjectDefinition,
} from "./migration-catalog.js";
import { parseMigrationCatalog } from "./migration-catalog.boundary.js";

const SCHEMA = [
  {
    name: "example",
    sql: "CREATE TABLE example (id INTEGER PRIMARY KEY) STRICT",
    tableName: "example",
    type: "table",
  },
] as const satisfies readonly SchemaObjectDefinition[];
const MIGRATIONS = createMigrationCatalog();

function createMigration(
  change: Partial<Omit<MigrationDefinition, "checksum">> & { readonly checksum?: string } = {},
): MigrationDefinition {
  const candidate = {
    name: change.name ?? "create_example",
    schemaAfter: change.schemaAfter ?? SCHEMA,
    statements: change.statements ?? ["CREATE TABLE example (id INTEGER PRIMARY KEY) STRICT"],
    version: change.version ?? 1,
  };
  return {
    ...candidate,
    checksum: change.checksum ?? calculateMigrationChecksum(candidate),
  };
}

function expectInvalid(migrations: readonly MigrationDefinition[]): void {
  expect(() => parseMigrationCatalog(migrations)).toThrow(
    expect.objectContaining<Partial<SqliteStorageError>>({
      code: "migration-invalid",
      message: "The migration catalog is invalid.",
      name: "SqliteStorageError",
    }),
  );
}

function initialMigration(): MigrationDefinition {
  const migration = MIGRATIONS[0];
  if (migration === undefined) {
    throw new Error("Expected the initial migration");
  }
  return migration;
}

function recalculateChecksum(migration: MigrationDefinition): void {
  Object.defineProperty(migration, "checksum", {
    configurable: true,
    value: calculateMigrationChecksum(migration),
  });
}

describe("migration catalog", () => {
  it("round-trips educational triggers without permitting extra statements", () => {
    const educational = createEducationalMigrationCatalog();
    expect(parseMigrationCatalog(educational)).toEqual(educational);
    for (const statement of [
      "SELECT 1; CREATE TRIGGER example BEFORE DELETE ON example BEGIN UPDATE example SET id = 1; END",
      "CREATE TRIGGER example BEFORE DELETE ON example BEGIN UPDATE example SET id = 1; COMMIT; END",
      "CREATE TRIGGER example BEFORE DELETE ON example BEGIN UPDATE example SET id = 1; END; DELETE FROM example",
      "CREATE TRIGGER example BEFORE DELETE ON example BEGIN UPDATE example SET id = 1; UPDATE example SET id = 2; END",
    ])
      expectInvalid([createMigration({ statements: [statement] })]);
  });
  it("round-trips every shipped migration through the storage boundary", () => {
    expect(parseMigrationCatalog(MIGRATIONS)).toEqual(MIGRATIONS);
  });
  it("ships an ordered, immutable, checksummed initial migration", () => {
    expect(MIGRATIONS).toHaveLength(8);
    expect(MIGRATIONS[0]).toMatchObject({ name: "create_metadata", version: 1 });
    expect(calculateMigrationChecksum(initialMigration())).toBe(initialMigration().checksum);
    expect(Object.isFrozen(MIGRATIONS)).toBe(true);
    expect(Object.isFrozen(MIGRATIONS[0])).toBe(true);
    expect(Object.isFrozen(MIGRATIONS[0]?.statements)).toBe(true);
    expect(Object.isFrozen(MIGRATIONS[0]?.schemaAfter[0])).toBe(true);
    expect(MIGRATIONS[1]).toMatchObject({ name: "create_teacher_runtime", version: 2 });
    const teacherMigration = MIGRATIONS[1];
    if (teacherMigration === undefined) {
      throw new Error("Expected the teacher runtime migration.");
    }
    expect(calculateMigrationChecksum(teacherMigration)).toBe(teacherMigration.checksum);
    expect(MIGRATIONS[2]).toMatchObject({ name: "create_teaching_snapshots", version: 3 });
    expect(MIGRATIONS[3]).toMatchObject({ name: "create_teacher_notices", version: 4 });
    expect(MIGRATIONS[4]).toMatchObject({ name: "create_usage_reservations", version: 5 });
    expect(MIGRATIONS[5]).toMatchObject({ name: "create_evaluation_queue", version: 6 });
    expect(MIGRATIONS[6]).toMatchObject({ name: "create_governance_schema", version: 7 });
    expect(MIGRATIONS[7]).toMatchObject({
      name: "explicit_teaching_revision_authorship",
      version: 8,
    });
    expect(MIGRATIONS.slice(0, 7).map(({ checksum }) => checksum)).toEqual([
      "fbad05a3a1a844c8c04a9944a7cce8ff049a147b9090a5c1b7b7bc930ac7666a",
      "ce965e512350c55ca8b530459ed7a587c661017186d1871454bd20da346e3fe8",
      "d06c58d2ff3f62ae0f7af3da8d3eeb5da620de5c5322fb3f7b493d8d618aa10c",
      "5756c805699850a7ec3bb63dba1a22cc4a95479cb64bd2b15e078343b6f6fc08",
      "1d242dc70b280838c3d35d4603bdeb0877ccbcbf3bc1ab2e6e07827971cbd9fa",
      "1d988283dc6e0999c83c1d243a711198b842a0cd4ed0408c9c1e8bcd5cb1e19a",
      "1ca99491467f3b4435048668690c6bb9c507b44c5bce4fc2c39ab33c59943f5a",
    ]);
    expect(parseMigrationCatalog(MIGRATIONS)).toEqual(MIGRATIONS);
  });

  it("returns defensive immutable catalog records", () => {
    const source = [createMigration()];
    const validated = parseMigrationCatalog(source);

    expect(validated).not.toBe(source);
    expect(validated[0]?.statements).not.toBe(source[0]?.statements);
    expect(validated[0]?.schemaAfter).not.toBe(source[0]?.schemaAfter);
    expect(Object.isFrozen(validated[0]?.schemaAfter)).toBe(true);
  });

  it("binds every release-relevant field into the checksum", () => {
    const migration = createMigration();
    const baseline = migration.checksum;
    const variants = [
      createMigration({ name: "create_other" }),
      createMigration({ statements: ["CREATE TABLE other (id INTEGER) STRICT"] }),
      createMigration({ version: 2 }),
      createMigration({
        schemaAfter: [{ ...SCHEMA[0], sql: "CREATE TABLE example (id TEXT)" }],
      }),
    ];

    expect(variants.every((variant) => variant.checksum !== baseline)).toBe(true);
    expect(baseline).toMatch(/^[a-f\d]{64}$/u);
  });

  it("rejects empty, unordered, unsafe, and checksummed-wrong catalogs", () => {
    expectInvalid([]);
    expectInvalid([createMigration({ version: 2 })]);
    expectInvalid([createMigration(), createMigration({ name: "second", version: 3 })]);
    expectInvalid([createMigration({ version: Number.MAX_SAFE_INTEGER + 1 })]);
    expectInvalid([createMigration(), createMigration({ name: "create_example", version: 2 })]);
    expectInvalid([createMigration({ checksum: "0".repeat(64) })]);
    expectInvalid([createMigration({ checksum: "A".repeat(64) })]);
    expectInvalid([createMigration({ checksum: "g".repeat(64) })]);
    expectInvalid([createMigration({ checksum: "a".repeat(63) })]);
  });

  it("rejects malformed runtime catalog records at the boundary", () => {
    const malformedValues = [
      null,
      {},
      [null],
      [{ checksum: 1 }],
      [{ checksum: "a".repeat(64), name: 1 }],
      [{ checksum: "a".repeat(64), name: "bad", schemaAfter: null }],
      [{ checksum: "a".repeat(64), name: "bad", schemaAfter: [], statements: null }],
      [{ checksum: "a".repeat(64), name: "bad", schemaAfter: [], statements: [1] }],
      [
        {
          checksum: "a".repeat(64),
          name: "bad",
          schemaAfter: [],
          statements: [],
          version: "one",
        },
      ],
      [
        {
          checksum: "a".repeat(64),
          name: "bad",
          schemaAfter: [null],
          statements: [],
          version: 1,
        },
      ],
      [
        {
          checksum: "a".repeat(64),
          name: "bad",
          schemaAfter: [{ name: 1, sql: "sql", tableName: "table", type: "table" }],
          statements: [],
          version: 1,
        },
      ],
      [
        {
          checksum: "a".repeat(64),
          name: "bad",
          schemaAfter: [{ name: "name", sql: 1, tableName: "table", type: "table" }],
          statements: [],
          version: 1,
        },
      ],
      [
        {
          checksum: "a".repeat(64),
          name: "bad",
          schemaAfter: [{ name: "name", sql: "sql", tableName: 1, type: "table" }],
          statements: [],
          version: 1,
        },
      ],
      [
        {
          checksum: "a".repeat(64),
          name: "bad",
          schemaAfter: [{ name: "name", sql: "sql", tableName: "table", type: "virtual" }],
          statements: [],
          version: 1,
        },
      ],
    ];

    for (const value of malformedValues) {
      expect(() => parseMigrationCatalog(value)).toThrow(
        expect.objectContaining<Partial<SqliteStorageError>>({
          code: "migration-invalid",
          message: "The migration catalog is invalid.",
          name: "SqliteStorageError",
        }),
      );
    }
  });

  it("rejects callable and array-shaped records even when their fields are valid", () => {
    const migration = createMigration();
    const callableMigration = () => undefined;
    Object.defineProperties(callableMigration, {
      checksum: { value: migration.checksum },
      name: { configurable: true, value: migration.name },
      schemaAfter: { value: migration.schemaAfter },
      statements: { value: migration.statements },
      version: { value: migration.version },
    });
    expect(() => parseMigrationCatalog([callableMigration])).toThrow(
      expect.objectContaining({ code: "migration-invalid" }),
    );

    const arraySchema = Object.assign([], SCHEMA[0]);
    expectInvalid([createMigration({ schemaAfter: [arraySchema] })]);
  });

  it("rejects malformed field types even when their checksum matches", () => {
    const malformed = [
      (): MigrationDefinition => {
        const migration = createMigration();
        Object.defineProperty(migration, "name", { value: 1 });
        recalculateChecksum(migration);
        return migration;
      },
      (): MigrationDefinition => {
        const migration = createMigration();
        Object.defineProperty(migration, "statements", { value: [1] });
        recalculateChecksum(migration);
        return migration;
      },
      ...(["name", "sql", "tableName"] as const).map((key) => (): MigrationDefinition => {
        const migration = createMigration({ schemaAfter: [{ ...SCHEMA[0] }] });
        Object.defineProperty(migration.schemaAfter[0], key, { value: 1 });
        recalculateChecksum(migration);
        return migration;
      }),
      (): MigrationDefinition => {
        const migration = createMigration({ schemaAfter: [{ ...SCHEMA[0] }] });
        Object.defineProperty(migration.schemaAfter[0], "type", { value: "virtual" });
        recalculateChecksum(migration);
        return migration;
      },
    ];

    for (const createMalformed of malformed) {
      expectInvalid([createMalformed()]);
    }
  });

  it("parses every supported SQLite schema object kind", () => {
    for (const type of ["index", "table", "trigger", "view"] as const) {
      const migration = createMigration({ schemaAfter: [{ ...SCHEMA[0], type }] });
      expect(parseMigrationCatalog([migration])[0]?.schemaAfter[0]?.type).toBe(type);
    }
  });

  it("rejects ambiguous migration names and missing schema declarations", () => {
    for (const name of ["", "Create_example", "create-example", "create__example", "create_"]) {
      expectInvalid([createMigration({ name })]);
    }
    expectInvalid([createMigration({ name: "a".repeat(65) })]);
    expectInvalid([createMigration({ schemaAfter: [] })]);
    expectInvalid([createMigration({ schemaAfter: [{ ...SCHEMA[0], name: "" }] })]);
    expectInvalid([createMigration({ schemaAfter: [{ ...SCHEMA[0], sql: "" }] })]);
    expectInvalid([createMigration({ schemaAfter: [{ ...SCHEMA[0], tableName: "" }] })]);
    expectInvalid([createMigration({ schemaAfter: [SCHEMA[0], SCHEMA[0]] })]);
  });

  it("rejects empty, compound, transaction-owning, and user-version SQL", () => {
    const invalidStatements = [
      "",
      "   ",
      "SELECT 1;",
      "SELECT 1; SELECT 2",
      "BEGIN IMMEDIATE",
      "commit",
      "ROLLBACK",
      "SAVEPOINT migration",
      "RELEASE migration",
      "PRAGMA user_version = 2",
    ];
    for (const statement of invalidStatements) {
      expectInvalid([createMigration({ statements: [statement] })]);
    }
    expectInvalid([createMigration({ statements: [] })]);
  });

  it("allows minimal unambiguous migration names", () => {
    expect(parseMigrationCatalog([createMigration({ name: "a" })])).toHaveLength(1);
    expect(parseMigrationCatalog([createMigration({ name: "a_b" })])).toHaveLength(1);
    expect(parseMigrationCatalog([createMigration({ name: "a".repeat(64) })])).toHaveLength(1);
  });
});
