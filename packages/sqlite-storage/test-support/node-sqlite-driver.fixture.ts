import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  SqliteDatabasePort,
  SqliteDriverPort,
  SqliteParameter,
} from "../src/database-port.js";

type NodeValue = Exclude<SqliteParameter, boolean>;

function values(parameters: readonly SqliteParameter[]): NodeValue[] {
  return parameters.map((parameter) =>
    typeof parameter === "boolean" ? Number(parameter) : parameter,
  );
}

/** The storage driver port on Node's SQLite engine, so public entries run on real files. */
export const nodeSqliteDriver: SqliteDriverPort = {
  open(databasePath: string): SqliteDatabasePort {
    const database = new DatabaseSync(databasePath);
    return {
      close: () => {
        database.close();
      },
      execute: (sql, parameters = []) => {
        database.prepare(sql).run(...values(parameters));
      },
      readAll: (sql, parameters = []) => database.prepare(sql).all(...values(parameters)),
      readOne: (sql, parameters = []) => database.prepare(sql).get(...values(parameters)),
      serialize: () => {
        const directory = mkdtempSync(join(tmpdir(), "marea-sqlite-serialize-"));
        try {
          const path = join(directory, "copy.sqlite");
          database.prepare("VACUUM INTO ?1").run(path);
          return new Uint8Array(readFileSync(path));
        } finally {
          rmSync(directory, { recursive: true });
        }
      },
      transactionImmediate: (operation) => {
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
  },
};
