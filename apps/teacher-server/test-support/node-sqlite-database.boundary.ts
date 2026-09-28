import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { SqliteApplicationDatabase, SqliteParameter, SqliteRow } from "@marea/sqlite-storage";

function inputValues(parameters: readonly SqliteParameter[]): SQLInputValue[] {
  return parameters.map((parameter) =>
    typeof parameter === "boolean" ? Number(parameter) : parameter,
  );
}

export class NodeSqliteTestDatabase implements SqliteApplicationDatabase {
  readonly #database: DatabaseSync;

  constructor(databasePath = ":memory:") {
    this.#database = new DatabaseSync(databasePath, { readBigInts: true });
  }

  public close(): void {
    this.#database.close();
  }

  public execute(sql: string, parameters: readonly SqliteParameter[] = []): void {
    this.#database.prepare(sql).run(...inputValues(parameters));
  }

  public executeScript(sql: string): void {
    this.#database.exec(sql);
  }

  public readAll(sql: string, parameters: readonly SqliteParameter[] = []): readonly SqliteRow[] {
    return this.#database.prepare(sql).all(...inputValues(parameters));
  }

  public readOne(sql: string, parameters: readonly SqliteParameter[] = []): SqliteRow | undefined {
    return this.#database.prepare(sql).get(...inputValues(parameters));
  }

  public transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
