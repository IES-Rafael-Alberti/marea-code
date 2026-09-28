/* global console */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { initializeSqliteStorage } from "../../packages/sqlite-storage/src/index.ts";

// SQLite's pager enforces an isolated quota; this never fills the host filesystem.
const root = mkdtempSync(join(tmpdir(), "marea-resilience-full-"));
try {
  const databasePath = join(root, "quota.sqlite");
  initializeSqliteStorage({ databasePath }).close();
  const db = new Database(databasePath);
  db.run("INSERT INTO marea_classes VALUES ('class:1', 'one', 'durable-before')");
  const pages = db.query("PRAGMA page_count").get().page_count;
  db.run(`PRAGMA max_page_count=${pages}`);
  assert.throws(
    () =>
      db.transaction(() => {
        db.run("INSERT INTO marea_classes VALUES ('class:2', 'two', 'uncommitted')");
        db.run(
          "INSERT INTO marea_classes VALUES ('class:3', 'three', CAST(zeroblob(1048576) AS TEXT))",
        );
      })(),
    /full/i,
  );
  assert.equal(db.query("SELECT count(*) AS n FROM marea_classes").get().n, 1);
  assert.equal(db.query("PRAGMA integrity_check").get().integrity_check, "ok");
  db.run("PRAGMA max_page_count=10000");
  db.run("INSERT INTO marea_classes VALUES ('class:2', 'two', 'recovered')");
  db.close();
  const reopened = new Database(join(root, "quota.sqlite"));
  assert.equal(reopened.query("SELECT count(*) AS n FROM marea_classes").get().n, 2);
  reopened.close();
  console.log(
    "Isolated SQLITE_FULL: rollback, integrity and subsequent durable write pass; not filesystem ENOSPC injection",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
