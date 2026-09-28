import { beforeEach, describe, expect, it, vi } from "vitest";

const sqliteMock = vi.hoisted(() => {
  interface StatementMock {
    readonly all: ReturnType<typeof vi.fn>;
    readonly finalize: ReturnType<typeof vi.fn>;
    readonly get: ReturnType<typeof vi.fn>;
  }

  class DatabaseMock {
    public static readonly instances: DatabaseMock[] = [];
    public readonly close = vi.fn();
    public failRollback = false;
    public readonly filename: string;
    public readonly options: object;
    public readonly prepare = vi.fn((): StatementMock => {
      const statement = {
        all: vi.fn(() => this.rows),
        finalize: vi.fn(),
        get: vi.fn(() => this.row),
      };
      this.statements.push(statement);
      return statement;
    });
    public readonly run = vi.fn((sql: string) => {
      if (sql === "ROLLBACK" && this.failRollback) {
        throw new Error("rollback failed");
      }
    });
    public row: object | null = null;
    public rows: readonly object[] = [];
    public readonly serialize = vi.fn(() => Uint8Array.from([1, 2, 3]));
    public readonly statements: StatementMock[] = [];

    public constructor(filename: string, options: object) {
      this.filename = filename;
      this.options = options;
      DatabaseMock.instances.push(this);
    }
  }

  return { DatabaseMock };
});

vi.mock("bun:sqlite", () => ({ Database: sqliteMock.DatabaseMock }));

import { bunSqliteDriver } from "./sqlite-driver.boundary.js";

function nativeDatabase(): InstanceType<typeof sqliteMock.DatabaseMock> {
  const database = sqliteMock.DatabaseMock.instances[0];
  if (database === undefined) {
    throw new Error("Expected a native database instance");
  }
  return database;
}

describe("Bun SQLite driver boundary", () => {
  beforeEach(() => {
    sqliteMock.DatabaseMock.instances.length = 0;
  });

  it("opens a strict persistent database and delegates parameterized operations", () => {
    const database = bunSqliteDriver.open("/data/marea.sqlite");
    const native = nativeDatabase();
    native.row = { value: 1n };
    native.rows = [{ value: 1n }, { value: 2n }];

    database.execute("INSERT INTO example VALUES (?1)", [7]);
    database.execute("VACUUM");
    expect(database.readOne("SELECT one WHERE value = ?1", [1])).toEqual({ value: 1n });
    expect(database.readAll("SELECT all WHERE enabled = ?1", [true])).toEqual([
      { value: 1n },
      { value: 2n },
    ]);
    expect(database.serialize()).toEqual(Uint8Array.from([1, 2, 3]));
    database.close();

    expect(native.filename).toBe("/data/marea.sqlite");
    expect(native.options).toEqual({
      create: true,
      readwrite: true,
      safeIntegers: true,
      strict: true,
    });
    expect(native.run.mock.calls.slice(0, 2)).toEqual([
      ["INSERT INTO example VALUES (?1)", [7]],
      ["VACUUM", []],
    ]);
    expect(native.close).toHaveBeenCalledWith(true);
    expect(native.prepare).toHaveBeenCalledTimes(2);
    expect(native.statements[0]?.get).toHaveBeenCalledWith(1);
    expect(native.statements[1]?.all).toHaveBeenCalledWith(true);
    for (const statement of native.statements) {
      expect(statement.finalize).toHaveBeenCalledOnce();
    }
  });

  it("maps a missing row to undefined and finalizes after read failures", () => {
    const database = bunSqliteDriver.open("/data/marea.sqlite");
    const native = nativeDatabase();

    expect(database.readOne("SELECT missing")).toBeUndefined();
    const firstStatement = native.statements[0];
    if (firstStatement === undefined) {
      throw new Error("Expected a prepared statement");
    }
    expect(firstStatement.get).toHaveBeenCalledWith();
    expect(firstStatement.finalize).toHaveBeenCalledOnce();

    const failedStatement = {
      all: vi.fn(() => {
        throw new Error("read failed");
      }),
      finalize: vi.fn(),
      get: vi.fn(),
    };
    native.prepare.mockReturnValueOnce(failedStatement);
    expect(() => database.readAll("SELECT broken")).toThrow("read failed");
    expect(failedStatement.finalize).toHaveBeenCalledOnce();
  });

  it("commits successful immediate transactions", () => {
    const database = bunSqliteDriver.open("/data/marea.sqlite");
    const native = nativeDatabase();

    expect(database.transactionImmediate(() => "result")).toBe("result");
    expect(native.run.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
  });

  it("rolls back failures while preserving the original error", () => {
    const database = bunSqliteDriver.open("/data/marea.sqlite");
    const native = nativeDatabase();
    native.failRollback = true;

    expect(() =>
      database.transactionImmediate(() => {
        throw new Error("operation failed");
      }),
    ).toThrow("operation failed");
    expect(native.run.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
  });

  it("rolls back a commit failure", () => {
    const database = bunSqliteDriver.open("/data/marea.sqlite");
    const native = nativeDatabase();
    native.run.mockImplementation((sql: string) => {
      if (sql === "COMMIT") {
        throw new Error("commit failed");
      }
    });

    expect(() => database.transactionImmediate(() => "result")).toThrow("commit failed");
    expect(native.run.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN IMMEDIATE",
      "COMMIT",
      "ROLLBACK",
    ]);
  });
});
