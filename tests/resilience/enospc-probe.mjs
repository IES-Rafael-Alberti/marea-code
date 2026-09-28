/* global console, process */
import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { initializeSqliteStorage } from "../../packages/sqlite-storage/src/index.ts";

// Never run against an arbitrary directory: the parent must mount a fresh bounded image
// and supply its random ownership marker. Capacity is checked again inside this binary.
const volume = process.argv[2];
const nonce = process.argv[3];
assert.ok(volume && nonce && nonce.length >= 32);
assert.equal(realpathSync(volume), volume);
assert.equal(readFileSync(join(volume, ".marea-resilience-disposable-volume"), "utf8"), nonce);
const geometry = statfsSync(volume);
const volumeBytes = geometry.blocks * geometry.bsize;
assert.ok(
  volumeBytes > 1024 * 1024 && volumeBytes <= 40 * 1024 * 1024,
  "Refuse to fill any filesystem larger than the disposable image",
);
const installation = join(volume, "installation");
mkdirSync(installation, { mode: 0o700 });
const databasePath = join(installation, "marea.sqlite");
assert.equal(existsSync(databasePath), false);
const storage = initializeSqliteStorage({ databasePath });
storage.database.execute(
  "INSERT INTO marea_classes VALUES ('class:before', 'before', 'Durable before filesystem failure')",
);
storage.close();

const database = new Database(databasePath);
assert.equal(database.query("SELECT count(*) AS n FROM marea_classes").get().n, 1);
const filler = join(volume, "synthetic-fill.bin");
const descriptor = openSync(filler, "wx", 0o600);
const chunk = new Uint8Array(1024 * 1024).fill(65);
let writtenBytes = 0;
let filesystemCode;
let sqliteCode;
try {
  while (writtenBytes <= 40 * 1024 * 1024) {
    try {
      writtenBytes += writeSync(descriptor, chunk);
      fsyncSync(descriptor);
    } catch (error) {
      filesystemCode = error.code;
      break;
    }
  }
  assert.equal(
    filesystemCode,
    "ENOSPC",
    "The isolated filesystem must produce a real ENOSPC error",
  );
  try {
    database.transaction(() => {
      database.run(
        "INSERT INTO marea_classes VALUES ('class:uncommitted', 'uncommitted', 'Must roll back')",
      );
      database.run("INSERT INTO marea_classes VALUES ('class:large', 'large', ?)", [
        "x".repeat(2 * 1024 * 1024),
      ]);
    })();
  } catch (error) {
    sqliteCode = error.code;
  }
  assert.ok(
    sqliteCode === "SQLITE_FULL" || sqliteCode?.startsWith("SQLITE_IOERR"),
    `SQLite must report a storage write failure, received ${sqliteCode}`,
  );
} finally {
  closeSync(descriptor);
  rmSync(filler, { force: true });
  database.close();
}

const recovered = new Database(databasePath);
assert.equal(recovered.query("PRAGMA integrity_check").get().integrity_check, "ok");
assert.deepEqual(recovered.query("PRAGMA foreign_key_check").all(), []);
assert.equal(recovered.query("SELECT count(*) AS n FROM marea_classes").get().n, 1);
recovered.run(
  "INSERT INTO marea_classes VALUES ('class:after', 'after', 'Recovered durable write')",
);
recovered.close();
const reopened = new Database(databasePath, { readonly: true });
assert.equal(reopened.query("SELECT count(*) AS n FROM marea_classes").get().n, 2);
reopened.close();
console.log(
  JSON.stringify({
    filesystemCode,
    sqliteCode,
    volumeBytes,
    writtenBytes,
    rollbackPreservedRows: 1,
    recoveredDurableRows: 2,
    integrity: "ok",
    foreignKeys: "ok",
  }),
);
