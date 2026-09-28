import { expect, it } from "vitest";
import { Database } from "./bun-sqlite.fixture.js";

it("rejects SQL without a statement before entering native statement methods, like Bun", () => {
  const database = new Database(":memory:");
  try {
    for (const sql of ["", "  ", "-- comment", ";"]) {
      expect(() => database.query(sql)).toThrow("no valid SQL statement");
      expect(() => database.prepare(sql)).toThrow("no valid SQL statement");
      expect(() => {
        database.run(sql, [1]);
      }).toThrow();
    }
    for (const blank of ["", " \n"])
      expect(() => {
        database.run(blank);
      }).toThrow("mustn't be blank");
    database.run("CREATE TABLE t (v INTEGER)");
    database.run("INSERT INTO t (v) VALUES (?1)", [true]);
    expect(database.query("SELECT v FROM t").get()).toEqual({ v: 1 });
    expect(database.prepare("SELECT v FROM t WHERE v = ?1").all(2)).toEqual([]);
  } finally {
    database.close();
  }
});
