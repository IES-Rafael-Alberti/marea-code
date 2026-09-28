import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteDatabasePort, SqliteParameter } from "../src/database-port.js";
import type { SqliteRow } from "../src/contracts.js";
import { configureDatabase, migrateDatabase } from "../src/database-schema.js";
import { createMigrationCatalog } from "../src/migration-catalog.js";

type SqliteValue = Exclude<SqliteParameter, boolean>;

interface ProbeDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: SqliteValue[]): void;
    all(...values: SqliteValue[]): readonly SqliteRow[];
    get(...values: SqliteValue[]): SqliteRow | undefined | null;
  };
}

// The same assertions run on the real engine of each supported runtime. Do not
// skip these suites on Bun, which does not expose Node's SQLite module.
const createDatabase: (path: string) => ProbeDatabase = process.versions.bun
  ? await import("../src/sqlite-driver.boundary.js").then(
      ({ bunSqliteDriver }) =>
        (path: string) => {
          const database = bunSqliteDriver.open(path);
          return {
            close: () => {
              database.close();
            },
            exec: (sql: string) => {
              database.execute(sql);
            },
            prepare: (sql: string) => ({
              run: (...values: SqliteValue[]) => {
                database.execute(sql, values);
              },
              all: (...values: SqliteValue[]) => database.readAll(sql, values),
              get: (...values: SqliteValue[]) => database.readOne(sql, values),
            }),
          };
        },
    )
  : await import("node:sqlite").then(
      ({ DatabaseSync }) =>
        (path: string) =>
          new DatabaseSync(path, { readBigInts: true }),
    );

function parameters(values: readonly SqliteParameter[]): SqliteValue[] {
  return values.map((value) => (typeof value === "boolean" ? Number(value) : value));
}

export function governanceDatabase(version = 7) {
  const root = mkdtempSync(join(tmpdir(), "marea-governance-schema-"));
  const database = createDatabase(join(root, "state.sqlite"));
  const port: SqliteDatabasePort = {
    close: () => {
      database.close();
    },
    execute: (sql, values = []) => {
      database.prepare(sql).run(...parameters(values));
    },
    readAll: (sql, values = []) => database.prepare(sql).all(...parameters(values)),
    readOne: (sql, values = []) => database.prepare(sql).get(...parameters(values)) ?? undefined,
    serialize: () => {
      throw new Error("Serialization is not part of this migration probe.");
    },
    transactionImmediate: <T>(operation: () => T): T => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const close = () => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  };
  try {
    configureDatabase(port);
    migrateDatabase(port, createMigrationCatalog().slice(0, version));
    return { database, port, close };
  } catch (error) {
    close();
    throw error;
  }
}

export function seedLegacyGovernanceSubjects(database: ProbeDatabase): void {
  database.exec(`
    INSERT INTO marea_classes VALUES ('class-1', 'legacy:1', 'One'), ('class-2', 'legacy:2', 'Two');
    INSERT INTO marea_users VALUES
      ('teacher-1', 'teacher-1', 'synthetic-hash', 'teacher', 'Teacher', 'class-1'),
      ('student-1', 'student-1', 'synthetic-hash', 'student', 'Student', 'class-1');
    INSERT INTO marea_teacher_classes VALUES ('teacher-1', 'class-1'), ('teacher-1', 'class-2');
    INSERT INTO marea_auth_sessions VALUES
      ('session-1', 'teacher-1', 'synthetic-token-hash', '2026-09-12T08:00:00.000Z', '2026-09-12T09:00:00.000Z', NULL);
    INSERT INTO marea_class_teaching_revisions VALUES
      ('revision-1', 'class-1', 'teacher-1', '2026-09-12T08:00:00.000Z', '{}');
    INSERT INTO marea_current_class_teaching VALUES ('class-1', 'revision-1');
  `);
}

export function seedGovernanceScopes(database: ProbeDatabase): void {
  seedLegacyGovernanceSubjects(database);
  const time = "2026-09-12T08:00:00.000Z";
  for (const number of ["1", "2"]) {
    database
      .prepare("INSERT INTO marea_centers VALUES (?, ?, 'v1', ?, ?)")
      .run(`center-${number}`, `Center ${number}`, time, time);
    database
      .prepare("INSERT INTO marea_governance_classes VALUES (?, ?, 'v1', ?, ?)")
      .run(`class-${number}`, `center-${number}`, time, time);
  }
  for (const user of ["teacher-1", "student-1"]) {
    database
      .prepare("INSERT INTO marea_governance_accounts VALUES (?, 'center-1', 'active', 'v1', ?, ?)")
      .run(user, time, time);
    for (const center of ["center-1", "center-2"]) {
      database
        .prepare(
          "INSERT INTO marea_center_memberships VALUES (?, ?, 'member', 'active', 'v1', ?, ?)",
        )
        .run(center, user, time, time);
    }
  }
}
