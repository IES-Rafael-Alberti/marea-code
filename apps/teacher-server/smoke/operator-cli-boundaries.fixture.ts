import assert from "node:assert/strict";
import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { initializeSqliteStorage, inspectSqliteSchemaVersion } from "@marea/sqlite-storage";
import { z } from "zod";
import type { installationFixture } from "../src/platform/operator-cli/installation.fixture.js";
import {
  brokenOutput,
  interruptCredential,
  terminalCredential,
} from "./operator-cli-process.fixture.js";
import { readOperatorRows } from "./operator-cli-database.fixture.js";

export async function verifyCompiledBoundaries(
  f: ReturnType<typeof installationFixture>,
  binary: string,
  snapshot: () => ReturnType<typeof readOperatorRows>[],
) {
  const json = z.record(z.string(), z.json());
  const query = (sql: string) => readOperatorRows(f.databasePath, sql);
  const credential = () =>
    json.parse(query("SELECT * FROM marea_governance_accounts WHERE user_id = 'user:teacher'")[0]);
  const version = z.string().parse(credential().version);
  const terminal = terminalCredential({
    binary,
    root: f.root,
    user: "user:teacher",
    version,
    password: "synthetic-private-tty-password",
    ending: "\r",
  });
  assert.equal(terminal.status, 0);
  const result = json.parse(JSON.parse(terminal.transcript.slice("Password: \n".length)));
  const nextVersion = z.string().parse(result.version);
  assert.notEqual(nextVersion, version);
  const hash = z
    .string()
    .parse(
      query("SELECT password_hash FROM marea_users WHERE id = 'user:teacher'")[0]?.password_hash,
    );
  assert.equal(await Bun.password.verify("synthetic-private-tty-password", hash), true);
  const before = snapshot();
  for (const ending of ["\x03", "\x04"] as const) {
    const canceled = terminalCredential({
      binary,
      root: f.root,
      user: "user:teacher",
      version: nextVersion,
      password: "uncommitted-private-password",
      ending,
    });
    assert.equal(canceled.status, ending === "\x03" ? 130 : 2);
    assert.equal(
      canceled.transcript,
      "Password: \n" +
        (ending === "\x03"
          ? "Operator command interrupted; verify its outcome.\n"
          : "Invalid command or input.\n"),
    );
    assert.deepEqual(snapshot(), before);
  }
  await interruptCredential(binary, f.root, nextVersion);
  assert.deepEqual(snapshot(), before);
  assert.equal(
    query("SELECT password_hash FROM marea_users WHERE id = 'user:teacher'")[0]?.password_hash,
    hash,
  );
  const input = f.work("boundary.json", {
    centerId: "center:negative",
    displayName: "Negative",
    expectedVersion: null,
  });
  const args = ["--installation", f.root, "center", "create", "--input", input];
  brokenOutput(binary, f.root, args);
  assert.equal(
    query("SELECT display_name FROM marea_centers WHERE id = 'center:negative'")[0]?.display_name,
    "Negative",
  );
  const expectFailure = (argv: string[], code: number) => {
    const result = spawnSync(binary, argv, { cwd: f.root, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, code, result.stderr);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(f.root));
    assert.ok(!result.stderr.includes("private-input"));
  };
  const lock = join(f.root, "locks/installation.lock");
  writeFileSync(lock, "foreign-owner", { mode: 0o600 });
  expectFailure(args, 3);
  assert.equal(readFileSync(lock, "utf8"), "foreign-owner");
  unlinkSync(lock);
  for (const bytes of [
    Buffer.from(" ".repeat(65_537)),
    Buffer.from("\ufeff{}"),
    Buffer.from("{}\0"),
    Buffer.concat([Buffer.from('{"private-input":"'), Buffer.from([0xff]), Buffer.from('"}')]),
  ]) {
    writeFileSync(input, bytes);
    expectFailure(args, 2);
    assert.equal(existsSync(lock), false);
  }
  writeFileSync(input, "{}");
  const alias = join(f.root, "work/input-alias.json");
  symlinkSync(input, alias);
  expectFailure([...args.slice(0, -1), alias], 2);
  const missingDatabase = join(f.root, "missing.sqlite");
  f.writeConfig({ ...f.config, databasePath: missingDatabase });
  expectFailure(args, 5);
  assert.equal(existsSync(missingDatabase), false);
  f.writeConfig(f.config);
  const storage = initializeSqliteStorage({ databasePath: f.databasePath });
  try {
    for (const schema of [0, 7, 9]) {
      storage.database.execute("PRAGMA user_version = " + String(schema));
      expectFailure(args, 5);
      assert.equal(inspectSqliteSchemaVersion({ databasePath: f.databasePath }), schema);
    }
  } finally {
    storage.database.execute("PRAGMA user_version = 8");
    storage.close();
  }
  assert.equal(existsSync(lock), false);
}
