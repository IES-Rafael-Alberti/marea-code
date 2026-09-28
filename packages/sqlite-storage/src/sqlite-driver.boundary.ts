import { Database } from "bun:sqlite";

import type {
  DatabaseRow,
  SqliteDatabasePort,
  SqliteDriverPort,
  SqliteParameter,
} from "./database-port.js";

class BunSqliteDatabase implements SqliteDatabasePort {
  readonly #database: Database;

  public constructor(database: Database) {
    this.#database = database;
  }

  public close(): void {
    this.#database.close(true);
  }

  // Stryker disable next-line ArrayDeclaration: omitted parameters and a fresh empty list are equivalent.
  public execute(sql: string, parameters: readonly SqliteParameter[] = []): void {
    this.#database.run(sql, [...parameters]);
  }

  // Stryker disable next-line ArrayDeclaration: omitted parameters and a fresh empty list are equivalent.
  public readAll(sql: string, parameters: readonly SqliteParameter[] = []): readonly DatabaseRow[] {
    const statement = this.#database.prepare<DatabaseRow, SqliteParameter[]>(sql);
    try {
      return statement.all(...parameters);
    } finally {
      statement.finalize();
    }
  }

  public readOne(
    sql: string,
    parameters: readonly SqliteParameter[] = [],
  ): DatabaseRow | undefined {
    const statement = this.#database.prepare<DatabaseRow, SqliteParameter[]>(sql);
    try {
      return statement.get(...parameters) ?? undefined;
    } finally {
      statement.finalize();
    }
  }

  public serialize(): Uint8Array {
    return Uint8Array.from(this.#database.serialize());
  }

  public transactionImmediate<T>(operation: () => T): T {
    this.#database.run("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.run("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.run("ROLLBACK");
      } catch {
        // Preserve the operation or commit failure.
      }
      throw error;
    }
  }
}

export const bunSqliteDriver: SqliteDriverPort = Object.freeze({
  open(databasePath: string): SqliteDatabasePort {
    return new BunSqliteDatabase(
      new Database(databasePath, {
        create: true,
        readwrite: true,
        safeIntegers: true,
        strict: true,
      }),
    );
  },
});
