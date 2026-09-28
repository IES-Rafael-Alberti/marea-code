import { describe, expect, it } from "vitest";

import type { AppliedMigration } from "./contracts.js";
import { SqliteStorageError } from "./contracts.js";
import type { DatabaseRow, SqliteDatabasePort, SqliteParameter } from "./database-port.js";
import { configureDatabase, migrateDatabase, verifyDatabase } from "./database-schema.js";
import {
  calculateMigrationChecksum,
  createMigrationCatalog,
  type MigrationDefinition,
  type SchemaObjectDefinition,
} from "./migration-catalog.js";
import {
  applyFakeMigrationStatement,
  initialMigration,
  latestMigration,
  schemaRow,
  sortSchemaRows,
} from "../test-support/storage-fakes.js";

const MIGRATIONS = createMigrationCatalog();

interface FakeDatabaseOptions {
  readonly applied?: readonly DatabaseRow[];
  readonly schema?: readonly DatabaseRow[];
  readonly userVersion?: number;
}

function schemaRows(): readonly DatabaseRow[] {
  return latestMigration().schemaAfter.map((entry) => ({
    name: entry.name,
    sql: entry.sql,
    tbl_name: entry.tableName,
    type: entry.type,
  }));
}

class FakeDatabase implements SqliteDatabasePort {
  public applied: DatabaseRow[];
  public closed = false;
  public readonly executions: { parameters: readonly SqliteParameter[]; sql: string }[] = [];
  public failOnSql: string | undefined;
  public immediateTransactions = 0;
  public integrity: DatabaseRow | undefined = { quick_check: "ok" };
  public schema: DatabaseRow[];
  public readonly settings = new Map<string, DatabaseRow>([
    ["PRAGMA busy_timeout", { timeout: 5000n }],
    ["PRAGMA journal_mode", { journal_mode: "wal" }],
    ["PRAGMA foreign_keys", { foreign_keys: 1n }],
    ["PRAGMA synchronous", { synchronous: 2n }],
  ]);
  public userVersion: number | undefined;

  public constructor(options: FakeDatabaseOptions = {}) {
    this.applied = options.applied?.map((migration) => ({ ...migration })) ?? [];
    this.schema = options.schema?.map((row) => ({ ...row })) ?? [];
    this.userVersion = options.userVersion ?? 0;
  }

  public close(): void {
    this.closed = true;
  }

  public execute(sql: string, parameters: readonly SqliteParameter[] = []): void {
    this.executions.push({ parameters, sql });
    if (sql === this.failOnSql) {
      throw new Error("simulated SQL failure");
    }
    applyFakeMigrationStatement(
      sql,
      parameters,
      this.applied,
      (name) => {
        this.addSchemaObject(name);
      },
      (version) => {
        this.userVersion = version;
      },
    );
  }

  public readAll(sql: string): readonly DatabaseRow[] {
    if (sql.includes("FROM marea_schema_migrations")) {
      return this.applied;
    }
    if (sql.includes("FROM sqlite_schema")) {
      return this.schema;
    }
    throw new Error("unexpected readAll query");
  }

  public readOne(sql: string): DatabaseRow | undefined {
    if (sql === "PRAGMA quick_check") {
      return this.integrity;
    }
    if (sql === "PRAGMA user_version") {
      if (this.userVersion === undefined) {
        return undefined;
      }
      return { user_version: BigInt(this.userVersion) };
    }
    return this.settings.get(sql);
  }

  public serialize(): Uint8Array {
    return new Uint8Array([1]);
  }

  public transactionImmediate<T>(operation: () => T): T {
    this.immediateTransactions += 1;
    const applied = this.applied.map((migration) => ({ ...migration }));
    const schema = this.schema.map((row) => ({ ...row }));
    const userVersion = this.userVersion;
    try {
      return operation();
    } catch (error) {
      this.applied = applied;
      this.schema = schema;
      this.userVersion = userVersion;
      throw error;
    }
  }

  private addSchemaObject(name: string): void {
    if (this.schema.some((entry) => entry.name === name)) {
      return;
    }
    const expected = latestMigration().schemaAfter.find((entry) => entry.name === name);
    if (expected !== undefined) {
      this.schema.push(schemaRow(expected));
      sortSchemaRows(this.schema);
    }
  }
}

function appliedMigration(change: Partial<AppliedMigration> = {}): DatabaseRow {
  const expected = initialMigration();
  return {
    checksum: change.checksum ?? expected.checksum,
    name: change.name ?? expected.name,
    version: change.version ?? expected.version,
  };
}

function appliedMigrations(): readonly DatabaseRow[] {
  return MIGRATIONS.map(({ checksum, name, version }) => ({ checksum, name, version }));
}

function extendedMigrationCatalog(): readonly MigrationDefinition[] {
  const third = {
    name: "record_future",
    schemaAfter: latestMigration().schemaAfter,
    statements: ["SELECT 1"],
    version: MIGRATIONS.length + 1,
  };
  return [
    ...MIGRATIONS,
    {
      ...third,
      checksum: calculateMigrationChecksum(third),
    },
  ];
}

function expectStorageError(
  operation: () => void,
  code: "database-unavailable" | "migration-drift" | "schema-mismatch",
): void {
  const messages = {
    "database-unavailable": "SQLite could not apply the required storage settings.",
    "migration-drift": "The database migration history does not match this release.",
    "schema-mismatch": "The database schema does not match this release.",
  };
  expect(operation).toThrow(
    expect.objectContaining<Partial<SqliteStorageError>>({
      code,
      message: messages[code],
      name: "SqliteStorageError",
    }),
  );
}

describe("database configuration", () => {
  it("sets and verifies the required WAL, timeout, foreign-key, and durability settings", () => {
    const database = new FakeDatabase();
    configureDatabase(database);

    expect(database.executions.map(({ sql }) => sql)).toEqual([
      "PRAGMA busy_timeout = 5000",
      "PRAGMA journal_mode = WAL",
      "PRAGMA foreign_keys = ON",
      "PRAGMA synchronous = FULL",
    ]);
  });

  it("accepts numeric pragma results and rejects every mismatched setting", () => {
    const numeric = new FakeDatabase();
    numeric.settings.set("PRAGMA busy_timeout", { timeout: 5000 });
    numeric.settings.set("PRAGMA foreign_keys", { foreign_keys: 1 });
    numeric.settings.set("PRAGMA synchronous", { synchronous: 2 });
    expect(() => {
      configureDatabase(numeric);
    }).not.toThrow();

    for (const [sql, row] of [
      ["PRAGMA busy_timeout", { timeout: 1 }],
      ["PRAGMA journal_mode", { journal_mode: "delete" }],
      ["PRAGMA foreign_keys", { foreign_keys: 0 }],
      ["PRAGMA synchronous", { synchronous: 1 }],
      ["PRAGMA synchronous", {}],
    ] satisfies readonly (readonly [string, DatabaseRow])[]) {
      const database = new FakeDatabase();
      database.settings.set(sql, row);
      expectStorageError(() => {
        configureDatabase(database);
      }, "database-unavailable");
    }

    const missing = new FakeDatabase();
    missing.settings.delete("PRAGMA synchronous");
    expectStorageError(() => {
      configureDatabase(missing);
    }, "database-unavailable");
  });
});

describe("database migrations", () => {
  it("applies the pending migration and records it in one immediate transaction", () => {
    const database = new FakeDatabase();

    const schema = migrateDatabase(database, MIGRATIONS);
    expect(schema).toEqual({ migrations: appliedMigrations(), version: MIGRATIONS.length });
    expect(database.immediateTransactions).toBe(1);
    expect(database.executions).toContainEqual({
      parameters: [1, "create_metadata", MIGRATIONS[0]?.checksum],
      sql: "INSERT INTO marea_schema_migrations (version, name, checksum) VALUES (?1, ?2, ?3)",
    });
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.migrations)).toBe(true);
    expect(Object.isFrozen(schema.migrations[0])).toBe(true);
  });
  it("leaves an already-current database unchanged", () => {
    const database = new FakeDatabase({
      applied: [appliedMigration()],
      schema: initialMigration().schemaAfter.map((entry) => ({
        name: entry.name,
        sql: entry.sql,
        tbl_name: entry.tableName,
        type: entry.type,
      })),
      userVersion: 1,
    });
    migrateDatabase(database, MIGRATIONS);
    expect(database.applied).toEqual(appliedMigrations());
  });
  it("rolls back all migration changes when a statement fails", () => {
    const database = new FakeDatabase();
    database.failOnSql = initialMigration().statements[0];
    expect(() => migrateDatabase(database, MIGRATIONS)).toThrow("simulated SQL failure");
    expect(database.applied).toEqual([]);
    expect(database.userVersion).toBe(0);
    expect(database.schema.map(({ name }) => name)).toEqual(["marea_schema_migrations"]);
  });
  it("rolls back every schema-7 statement failure without changing the schema-6 base", () => {
    const schemaSix = MIGRATIONS[5];
    const governance = MIGRATIONS[6];
    if (schemaSix === undefined || governance === undefined) {
      throw new Error("Expected schema six and seven migrations.");
    }
    for (const statement of governance.statements) {
      const database = new FakeDatabase({
        applied: appliedMigrations().slice(0, 6),
        schema: schemaSix.schemaAfter.map(schemaRow),
        userVersion: 6,
      });
      database.failOnSql = statement;
      expect(() => migrateDatabase(database, MIGRATIONS)).toThrow("simulated SQL failure");
      expect(database.applied).toEqual(appliedMigrations().slice(0, 6));
      expect(database.userVersion).toBe(6);
      expect(database.schema).toEqual(schemaSix.schemaAfter.map(schemaRow));
    }
  });
  it("detects drift in every migration identity field", () => {
    for (const [migration, userVersion] of [
      [appliedMigration({ version: 2 }), 2],
      [appliedMigration({ name: "renamed" }), 1],
      [appliedMigration({ checksum: "f".repeat(64) }), 1],
    ] satisfies readonly (readonly [DatabaseRow, number])[]) {
      const database = new FakeDatabase({ applied: [migration], userVersion });
      expectStorageError(() => migrateDatabase(database, MIGRATIONS), "migration-drift");
    }
  });
  it("rejects databases newer than the release and mismatched user versions", () => {
    const newer = new FakeDatabase({
      applied: [
        ...appliedMigrations(),
        { checksum: "f".repeat(64), name: "future", version: MIGRATIONS.length + 1 },
      ],
      userVersion: MIGRATIONS.length + 1,
    });
    expectStorageError(() => migrateDatabase(newer, MIGRATIONS), "schema-mismatch");
    const inconsistent = new FakeDatabase({ applied: [appliedMigration()], userVersion: 0 });
    expectStorageError(() => migrateDatabase(inconsistent, MIGRATIONS), "schema-mismatch");

    const missing = new FakeDatabase({ applied: [appliedMigration()], userVersion: 1 });
    missing.userVersion = undefined;
    expectStorageError(() => migrateDatabase(missing, MIGRATIONS), "schema-mismatch");

    const partiallyApplied = new FakeDatabase({
      applied: [appliedMigration()],
      schema: schemaRows(),
      userVersion: 0,
    });
    expectStorageError(
      () => migrateDatabase(partiallyApplied, extendedMigrationCatalog()),
      "schema-mismatch",
    );
    expect(partiallyApplied.applied).toEqual([appliedMigration()]);
    expect(partiallyApplied.executions.some(({ sql }) => sql === "SELECT 1")).toBe(false);
  });

  it("does not apply pending migrations after detecting existing drift", () => {
    const drifted = appliedMigration({ checksum: "f".repeat(64) });
    const database = new FakeDatabase({
      applied: [drifted],
      schema: schemaRows(),
      userVersion: 1,
    });

    expectStorageError(
      () => migrateDatabase(database, extendedMigrationCatalog()),
      "migration-drift",
    );
    expect(database.applied).toEqual([drifted]);
    expect(database.userVersion).toBe(1);
    expect(database.executions.some(({ sql }) => sql === "SELECT 1")).toBe(false);
  });
});

describe("schema verification", () => {
  function currentDatabase(): FakeDatabase {
    return new FakeDatabase({
      applied: [...appliedMigrations()],
      schema: schemaRows(),
      userVersion: MIGRATIONS.length,
    });
  }

  it("accepts the canonical schema and normalizes harmless SQL whitespace", () => {
    const database = currentDatabase();
    const first = database.schema[0];
    if (first === undefined) {
      throw new Error("Expected a schema row");
    }
    database.schema[0] = {
      ...first,
      sql: `  ${String(first.sql)
        .replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")
        .replaceAll(" ", "  ")}  `,
    };

    expect(verifyDatabase(database, MIGRATIONS).version).toBe(MIGRATIONS.length);
  });

  it("rejects failed integrity checks and missing migration rows", () => {
    const corrupt = currentDatabase();
    corrupt.integrity = { quick_check: "corrupt" };
    expectStorageError(() => verifyDatabase(corrupt, MIGRATIONS), "schema-mismatch");

    const missingIntegrity = currentDatabase();
    missingIntegrity.integrity = undefined;
    expectStorageError(() => verifyDatabase(missingIntegrity, MIGRATIONS), "schema-mismatch");

    const incomplete = currentDatabase();
    incomplete.applied = [];
    expectStorageError(() => verifyDatabase(incomplete, MIGRATIONS), "schema-mismatch");
  });

  it("rejects a dropped, added, renamed, retyped, or altered schema object", () => {
    const changes: readonly ((schema: DatabaseRow[]) => void)[] = [
      (schema) => {
        schema.pop();
      },
      (schema) => {
        schema.push({
          name: "extra",
          sql: "CREATE TABLE extra (id INTEGER)",
          tbl_name: "extra",
          type: "table",
        });
      },
      (schema) => {
        schema[0] = { ...schema[0], name: "renamed" };
      },
      (schema) => {
        schema[0] = { ...schema[0], tbl_name: "renamed" };
      },
      (schema) => {
        schema[0] = { ...schema[0], type: "view" };
      },
      (schema) => {
        schema[0] = { ...schema[0], sql: "CREATE TABLE marea_metadata (key TEXT)" };
      },
      (schema) => {
        schema[0] = {
          ...schema[0],
          sql: `${String(schema[0]?.sql)} INVALID`,
        };
      },
    ];
    for (const change of changes) {
      const database = currentDatabase();
      change(database.schema);
      expectStorageError(() => verifyDatabase(database, MIGRATIONS), "schema-mismatch");
    }
  });

  it("rejects malformed database rows without exposing their contents", () => {
    const booleanVersion = appliedMigration();
    Object.defineProperty(booleanVersion, "version", { value: true });
    const malformedRows: readonly DatabaseRow[] = [
      { checksum: 1, name: "create_metadata", version: 1 },
      { checksum: initialMigration().checksum, name: 1, version: 1 },
      { checksum: initialMigration().checksum, name: "create_metadata", version: "one" },
      { checksum: initialMigration().checksum, name: "create_metadata", version: 1.5 },
      {
        checksum: initialMigration().checksum,
        name: "create_metadata",
        version: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      },
      booleanVersion,
    ];
    for (const row of malformedRows) {
      const database = currentDatabase();
      database.applied = [row];
      expectStorageError(() => verifyDatabase(database, MIGRATIONS), "schema-mismatch");
    }
    const booleanCurrent = new FakeDatabase({
      applied: [booleanVersion],
      schema: initialMigration().schemaAfter.map(schemaRow),
      userVersion: 1,
    });
    expectStorageError(
      () => verifyDatabase(booleanCurrent, [initialMigration()]),
      "schema-mismatch",
    );

    const malformedSchema = currentDatabase();
    malformedSchema.schema[0] = { ...malformedSchema.schema[0], type: "virtual" };
    expectStorageError(() => verifyDatabase(malformedSchema, MIGRATIONS), "schema-mismatch");
  });

  it("accepts every supported schema object type and rejects an empty catalog", () => {
    for (const type of ["index", "table", "trigger", "view"] as const) {
      const schemaObject: SchemaObjectDefinition = {
        name: `example_${type}`,
        sql: `CREATE ${type.toUpperCase()} example_${type}`,
        tableName: "example",
        type,
      };
      const candidate = {
        name: `create_${type}`,
        schemaAfter: [schemaObject],
        statements: ["SELECT 1"],
        version: 1,
      };
      const migration: MigrationDefinition = {
        ...candidate,
        checksum: calculateMigrationChecksum(candidate),
      };
      const database = new FakeDatabase({
        applied: [{ checksum: migration.checksum, name: migration.name, version: 1 }],
        schema: [
          {
            name: schemaObject.name,
            sql: schemaObject.sql,
            tbl_name: schemaObject.tableName,
            type,
          },
        ],
        userVersion: 1,
      });

      expect(verifyDatabase(database, [migration]).version).toBe(1);
    }

    expectStorageError(() => verifyDatabase(new FakeDatabase(), []), "schema-mismatch");
  });

  it("verifies history and user version independently of schema shape", () => {
    const drifted = currentDatabase();
    drifted.applied = [appliedMigration({ name: "renamed" }), appliedMigrations()[1] ?? {}];
    expectStorageError(() => verifyDatabase(drifted, MIGRATIONS), "migration-drift");

    const wrongVersion = currentDatabase();
    wrongVersion.userVersion = 1;
    expectStorageError(() => verifyDatabase(wrongVersion, MIGRATIONS), "schema-mismatch");
  });
});
