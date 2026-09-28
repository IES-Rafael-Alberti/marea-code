import type { SqliteApplicationDatabase, SqliteParameter, SqliteRow } from "@marea/sqlite-storage";

export interface SqlCall {
  readonly parameters: readonly SqliteParameter[];
  readonly sql: string;
}

export class DatabaseFake implements SqliteApplicationDatabase {
  public readonly allRows: (readonly SqliteRow[])[] = [];
  public readonly executions: SqlCall[] = [];
  public readonly oneRows: (SqliteRow | undefined)[] = [];
  public readonly reads: SqlCall[] = [];
  public transactions = 0;

  public execute(sql: string, parameters: readonly SqliteParameter[] = []): void {
    this.executions.push({ parameters, sql });
  }

  public readAll(sql: string, parameters: readonly SqliteParameter[] = []): readonly SqliteRow[] {
    this.reads.push({ parameters, sql });
    return this.allRows.shift() ?? [];
  }

  public readOne(sql: string, parameters: readonly SqliteParameter[] = []): SqliteRow | undefined {
    this.reads.push({ parameters, sql });
    return this.oneRows.shift();
  }

  public transaction<T>(operation: () => T): T {
    this.transactions += 1;
    return operation();
  }
}
