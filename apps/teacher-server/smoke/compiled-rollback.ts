import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSqliteDatabaseFile } from "@marea/sqlite-storage";
import { z } from "zod";

import { teacherHostInstallation } from "../src/platform/teacher-host/teacher-host.fixture.js";
import { compileInstallationExecutables } from "./compiled-host-process.js";
import { buildPreviousAdmin, PREVIOUS_RELEASE } from "./previous-release.js";

// W07 operational rollback rehearsal: the previous release, rebuilt from git, creates schema-8
// data; the current release backs it up, upgrades it and changes it; the pre-upgrade bundle is
// restored into a copy of the installation and the previous release operates on that copy.
const record = z.record(z.string(), z.json());
const workspace = realpathSync(mkdtempSync(join(tmpdir(), "marea-rollback-")));
chmodSync(workspace, 0o700);
const live = teacherHostInstallation({ activate: false, teacher: false });
const copy = teacherHostInstallation({ activate: false, teacher: false });

function invoke(binary: string, root: string, args: readonly string[], status = 0, stdin = "") {
  const result = spawnSync(binary, ["--installation", root, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    input: stdin,
  });
  assert.equal(result.status, status, `${binary} ${args.join(" ")}: ${result.stderr}`);
  return status === 0 ? record.parse(JSON.parse(result.stdout)) : {};
}

let inputs = 0;
function input(payload: object): string[] {
  inputs += 1;
  return ["--input", live.work(`rollback-${String(inputs)}.json`, payload)];
}

function scalar(databasePath: string, sql: string): string | number | bigint | null | undefined {
  const file = openSqliteDatabaseFile({ databasePath });
  try {
    return Object.values(
      z
        .record(z.string(), z.union([z.string(), z.number(), z.bigint(), z.null()]))
        .parse(file.database.readOne(sql)),
    )[0];
  } finally {
    file.close();
  }
}

const users = (databasePath: string) =>
  scalar(
    databasePath,
    "SELECT group_concat(id, ',') FROM (SELECT id FROM marea_users ORDER BY id)",
  );
const accountVersion = (databasePath: string, userId: string) =>
  z
    .string()
    .parse(
      scalar(
        databasePath,
        `SELECT version FROM marea_governance_accounts WHERE user_id = '${userId}'`,
      ),
    );

try {
  const previous = buildPreviousAdmin(workspace);
  const current = compileInstallationExecutables(workspace);
  const account = (userId: string, login: string) => ({
    centerId: "center:a",
    userId,
    displayName: login,
    login,
    role: "student",
    classId: "class:ready",
    expectedVersion: null,
  });

  // The previous release creates the data the pilot would have had before the upgrade.
  const admin = (binary: string, root: string, name: string, payload: object, status = 0) =>
    invoke(binary, root, [...name.split(" "), ...input(payload)], status);
  admin(previous, live.root, "center create", {
    centerId: "center:a",
    displayName: "Center",
    expectedVersion: null,
  });
  admin(previous, live.root, "class create", {
    centerId: "center:a",
    classId: "class:ready",
    displayName: "Ready",
    expectedVersion: null,
  });
  admin(previous, live.root, "account create", account("user:before", "before"));
  assert.equal(scalar(live.databasePath, "PRAGMA user_version"), 8n);

  // The current release takes the pre-upgrade backup, upgrades and records a later change.
  const status = invoke(current.operations, live.root, ["installation", "status"]);
  assert.deepEqual([status.schemaVersion, status.upgrade], [8, "activate"]);
  invoke(current.operations, live.root, ["backup", "create", ...input({ name: "pre-upgrade" })]);
  const offsite = join(workspace, "pre-upgrade");
  cpSync(join(live.root, "backups", "pre-upgrade"), offsite, { recursive: true });
  assert.deepEqual(invoke(current.operations, live.root, ["deletion", "activate"]), {
    schemaVersion: 9,
  });
  admin(current.admin, live.root, "account create", account("user:after", "after"));
  assert.equal(users(live.databasePath), "user:after,user:before");

  // The previous release refuses the upgraded installation and leaves it untouched.
  admin(previous, live.root, "account create", account("user:refused", "refused"), 5);
  assert.equal(scalar(live.databasePath, "PRAGMA user_version"), 9n);
  assert.equal(users(live.databasePath), "user:after,user:before");

  // Rollback: restore the pre-upgrade bundle and place it under a copy of the installation.
  const restored = invoke(current.operations, live.root, [
    "backup",
    "restore",
    ...input({ bundlePath: offsite, destinationRoot: join(workspace, "restored") }),
  ]);
  assert.deepEqual(
    [restored.state, restored.reasonCode, restored.schemaVersion],
    ["restored", "no-deletions-recorded", PREVIOUS_RELEASE.schemaVersion],
  );
  rmSync(copy.databasePath);
  renameSync(join(workspace, "restored", "database.sqlite"), copy.databasePath);
  chmodSync(copy.databasePath, 0o600);

  // The previous release operates on the rolled-back copy: earlier data present, later change
  // absent, reads and writes succeed and the schema stays at the previous version.
  assert.equal(users(copy.databasePath), "user:before");
  admin(previous, copy.root, "account rename", {
    centerId: "center:a",
    userId: "user:before",
    displayName: "Renamed",
    expectedVersion: accountVersion(copy.databasePath, "user:before"),
  });
  const credential = invoke(
    previous,
    copy.root,
    [
      "credential",
      "provision",
      "--user",
      "user:before",
      "--expected-version",
      accountVersion(copy.databasePath, "user:before"),
      "--password-stdin",
    ],
    0,
    "synthetic-rollback-password\n",
  );
  assert.equal(credential.userId, "user:before");
  admin(previous, copy.root, "account create", account("user:after", "after"));
  admin(previous, copy.root, "account create", account("user:before", "before"), 4);
  assert.equal(users(copy.databasePath), "user:after,user:before");
  assert.equal(
    scalar(copy.databasePath, "SELECT display_name FROM marea_users WHERE id = 'user:before'"),
    "Renamed",
  );
  assert.match(
    z
      .string()
      .parse(
        scalar(copy.databasePath, "SELECT password_hash FROM marea_users WHERE id = 'user:before'"),
      ),
    /^\$argon2id\$/,
  );
  assert.equal(scalar(copy.databasePath, "PRAGMA user_version"), 8n);

  // The rolled-back copy remains upgradable by the current release.
  const rolledBack = invoke(current.operations, copy.root, ["installation", "status"]);
  assert.deepEqual([rolledBack.schemaVersion, rolledBack.upgrade], [8, "activate"]);
  console.log(
    `compiled rollback rehearsal (schema ${String(PREVIOUS_RELEASE.schemaVersion)}): pass`,
  );
} finally {
  for (const root of [live.root, copy.root, workspace])
    rmSync(root, { recursive: true, force: true });
}
