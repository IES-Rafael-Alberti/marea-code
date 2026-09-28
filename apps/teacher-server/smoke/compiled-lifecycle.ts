import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSqliteDatabaseFile } from "@marea/sqlite-storage";
import { z } from "zod";

import { teacherHostInstallation } from "../src/platform/teacher-host/teacher-host.fixture.js";
import {
  compileInstallationExecutables,
  startCompiledHost,
  stopCompiledHost,
} from "./compiled-host-process.js";

// W07 lifecycle rehearsal on compiled executables: clean install, health while serving, pre-upgrade
// backup, activation, rollback restore of the previous schema, deletion and non-resurrection.
const record = z.record(z.string(), z.json());
const f = teacherHostInstallation({ activate: false, teacher: false });
const isolated = realpathSync(mkdtempSync(join(tmpdir(), "marea-lifecycle-restores-")));
chmodSync(isolated, 0o700);
let binaries: ReturnType<typeof compileInstallationExecutables>;

function invoke(
  binary: string,
  root: string,
  args: readonly string[],
  status = 0,
  stdin?: string,
): z.infer<typeof record> {
  const result = spawnSync(binary, ["--installation", root, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    ...(stdin === undefined ? {} : { input: stdin }),
  });
  assert.equal(result.status, status, `${args.join(" ")}: ${result.stderr}`);
  return status === 0 ? record.parse(JSON.parse(result.stdout)) : {};
}

let inputs = 0;
function withInput(payload: object): string[] {
  inputs += 1;
  return ["--input", f.work(`lifecycle-${String(inputs)}.json`, payload)];
}

const operations = (root: string, args: string[], status = 0) =>
  invoke(binaries.operations, root, args, status);
const admin = (root: string, name: string, payload: object) =>
  invoke(binaries.admin, root, [...name.split(" "), ...withInput(payload)]);

function scalar(databasePath: string, sql: string): string | number | bigint | null | undefined {
  const file = openSqliteDatabaseFile({ databasePath });
  try {
    const row = z
      .record(z.string(), z.union([z.string(), z.number(), z.bigint(), z.null()]))
      .parse(file.database.readOne(sql));
    return Object.values(row)[0];
  } finally {
    file.close();
  }
}

try {
  binaries = compileInstallationExecutables(f.root);

  // Clean install: explicit configuration exists, the database does not.
  rmSync(f.databasePath);
  assert.deepEqual(operations(f.root, ["installation", "status"]), {
    releaseId: "release:host",
    schemaVersion: null,
    supportedSchemaVersion: 9,
    upgrade: "initialize",
    locked: false,
    host: null,
  });
  assert.deepEqual(operations(f.root, ["installation", "initialize"]), { schemaVersion: 9 });
  operations(f.root, ["installation", "initialize"], 4);
  admin(f.root, "center create", {
    centerId: "center:a",
    displayName: "Center",
    expectedVersion: null,
  });
  admin(f.root, "class create", {
    centerId: "center:a",
    classId: "class:ready",
    displayName: "Ready",
    expectedVersion: null,
  });
  const teacher = admin(f.root, "account create", {
    centerId: "center:a",
    userId: "user:teacher",
    displayName: "Teacher",
    login: "teacher",
    role: "teacher",
    classId: "class:ready",
    expectedVersion: null,
  });
  invoke(
    binaries.admin,
    f.root,
    [
      "credential",
      "provision",
      "--user",
      "user:teacher",
      "--expected-version",
      z.string().parse(teacher.version),
      "--password-stdin",
    ],
    0,
    "synthetic-teacher-password\n",
  );
  f.writeHost({ ...f.host, allowedHosts: ["127.0.0.1"], allowedOrigins: ["http://127.0.0.1"] });
  const host = await startCompiledHost(binaries.host, f.root, "release:host");
  const serving = operations(f.root, ["installation", "status"]);
  assert.deepEqual([serving.schemaVersion, serving.upgrade, serving.locked], [9, "none", true]);
  assert.equal(record.parse(serving.host).status, "ready");
  operations(f.root, ["recovery", "inspect", ...withInput({})], 3);
  await stopCompiledHost(host);
  assert.equal(record.parse(operations(f.root, ["installation", "status"]).host).status, "stopped");

  // Previous-release data: a schema-8 installation with a student, upgraded in place.
  const legacy = teacherHostInstallation({ activate: false, teacher: false });
  const legacyRoot = legacy.root;
  admin(legacyRoot, "center create", {
    centerId: "center:a",
    displayName: "Center",
    expectedVersion: null,
  });
  admin(legacyRoot, "class create", {
    centerId: "center:a",
    classId: "class:ready",
    displayName: "Ready",
    expectedVersion: null,
  });
  admin(legacyRoot, "account create", {
    centerId: "center:a",
    userId: "user:student",
    displayName: "Student",
    login: "student",
    role: "student",
    classId: "class:ready",
    expectedVersion: null,
  });
  const before = operations(legacyRoot, ["installation", "status"]);
  assert.deepEqual([before.schemaVersion, before.upgrade], [8, "activate"]);
  const preUpgrade = operations(legacyRoot, [
    "backup",
    "create",
    ...withInput({ name: "pre-upgrade" }),
  ]);
  assert.equal(preUpgrade.path, join(legacyRoot, "backups", "pre-upgrade"));
  const offsite = (name: string) => {
    const copy = join(isolated, `${name}-offsite`);
    cpSync(join(legacyRoot, "backups", name), copy, { recursive: true });
    return copy;
  };
  const preUpgradeCopy = offsite("pre-upgrade");
  assert.deepEqual(operations(legacyRoot, ["deletion", "activate"]), { schemaVersion: 9 });
  const upgradedCopy = (() => {
    operations(legacyRoot, ["backup", "create", ...withInput({ name: "upgraded" })]);
    return offsite("upgraded");
  })();

  // Rollback rehearsal: the pre-upgrade bundle restores beside the upgraded installation.
  const legacyRestore = (destinationRoot: string) =>
    operations(legacyRoot, [
      "backup",
      "restore",
      ...withInput({ bundlePath: preUpgradeCopy, destinationRoot }),
    ]);
  const rollback = legacyRestore(join(isolated, "rollback"));
  assert.deepEqual(
    [rollback.state, rollback.reasonCode, rollback.schemaVersion],
    ["restored", "no-deletions-recorded", 8],
  );
  const rolledBack = join(isolated, "rollback", "database.sqlite");
  assert.equal(scalar(rolledBack, "PRAGMA user_version"), 8n);
  assert.equal(
    scalar(rolledBack, "SELECT COUNT(*) FROM marea_users WHERE id = 'user:student'"),
    1n,
  );

  // Permanent deletion of the student and every backup that contains it.
  const studentVersion = z
    .string()
    .parse(
      scalar(
        legacy.databasePath,
        "SELECT version FROM marea_governance_accounts WHERE user_id = 'user:student'",
      ),
    );
  const account = {
    kind: "account",
    key: { userId: "user:student" },
    observed: { kind: "version", version: studentVersion },
  };
  const preview = (previewId: string, targets: readonly z.infer<typeof record>[string][]) => {
    const output = join(legacyRoot, "work", `${previewId.replace(":", "-")}.json`);
    const summary = operations(legacyRoot, [
      "deletion",
      "preview",
      ...withInput({
        requestId: `request:${previewId}`,
        previewId,
        policyRevision: "policy:w07",
        targets,
      }),
      "--output",
      output,
    ]);
    return { summary, output };
  };
  const blocked = preview("preview:blocked", [account]);
  const blockers = z
    .object({ blockers: z.array(z.object({ target: z.json() })) })
    .parse(JSON.parse(await Bun.file(blocked.output).text()))
    .blockers.map((blocker) => blocker.target);
  assert.equal(blockers.length, 2);
  const confirmed = preview("preview:student", [account, ...blockers]);
  assert.equal(confirmed.summary.blockers, 0);
  assert.equal(
    operations(legacyRoot, ["deletion", "confirm", "--input", confirmed.output]).state,
    "applied",
  );
  assert.equal(
    existsSync(join(legacyRoot, "backups", "pre-upgrade")) ||
      existsSync(join(legacyRoot, "backups", "upgraded")),
    false,
  );

  // Non-resurrection: neither older bundle restores; a later backup does, without the student.
  for (const [bundle, destination, reason] of [
    [upgradedCopy, "upgraded", "tombstoned-identity"],
    [preUpgradeCopy, "pre-upgrade", "unknown-ancestry"],
  ] as const) {
    const result = operations(legacyRoot, [
      "backup",
      "restore",
      ...withInput({ bundlePath: bundle, destinationRoot: join(isolated, destination) }),
    ]);
    assert.deepEqual([result.state, result.reasonCode, result.path], ["blocked", reason, null]);
    assert.equal(existsSync(join(isolated, destination)), false);
  }
  operations(legacyRoot, ["backup", "create", ...withInput({ name: "after-deletion" })]);
  const after = operations(legacyRoot, [
    "backup",
    "restore",
    ...withInput({
      bundlePath: join(legacyRoot, "backups", "after-deletion"),
      destinationRoot: join(isolated, "after-deletion"),
    }),
  ]);
  assert.deepEqual([after.state, after.reasonCode, after.schemaVersion], ["restored", "none", 9]);
  assert.equal(
    scalar(
      join(isolated, "after-deletion", "database.sqlite"),
      "SELECT COUNT(*) FROM marea_users WHERE id = 'user:student'",
    ),
    0n,
  );
  // An isolated restore is never placed inside an installation.
  mkdirSync(join(legacyRoot, "work", "nested"), { mode: 0o700 });
  operations(
    legacyRoot,
    [
      "backup",
      "restore",
      ...withInput({
        bundlePath: join(legacyRoot, "backups", "after-deletion"),
        destinationRoot: join(legacyRoot, "work", "nested", "restored"),
      }),
    ],
    2,
  );
  rmSync(legacyRoot, { recursive: true, force: true });
  console.log("compiled lifecycle rehearsal: pass");
} finally {
  rmSync(f.root, { recursive: true, force: true });
  rmSync(isolated, { recursive: true, force: true });
}
