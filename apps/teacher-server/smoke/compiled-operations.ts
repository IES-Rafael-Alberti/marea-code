import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { initializeSqliteStorage, openSqliteDatabaseFile } from "@marea/sqlite-storage";
import { z } from "zod";

import { createSharedInstallationExclusivity } from "../src/platform/installation/shared-installation-exclusivity.js";
import { FilesystemInstallationExclusivity } from "../src/platform/operations/host/filesystem-exclusivity.js";
import { acquireInstallation } from "../src/platform/operator-cli/installation-lock.js";
import { installationFixture } from "../src/platform/operator-cli/installation.fixture.js";
import { compileExecutable } from "./compile-executable.js";

const json = z.record(z.string(), z.json());
type Json = z.infer<typeof json>;
const f = installationFixture();
const binaries = {
  admin: join(f.root, "marea-admin"),
  operations: join(f.root, "marea-operations"),
};
const diagnostics = new Map([
  [2, "Invalid command or input.\n"],
  [3, "Installation is busy or its authority is unavailable.\n"],
  [4, "Operator command conflicts with the current state.\n"],
  [5, "Operator prerequisites are unavailable.\n"],
]);

let hostHoldsInstallation = false;

function run(binary: string, name: string, payload?: Json, flags: string[] = [], status = 0): Json {
  const input =
    payload === undefined ? [] : ["--input", f.work(`${name.replace(" ", "-")}.json`, payload)];
  const result = spawnSync(
    binary,
    ["--installation", f.root, ...name.split(" "), ...input, ...flags],
    { cwd: f.root, encoding: "utf8", timeout: 30_000, maxBuffer: 2_000_000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, status, `${name}: ${result.stderr}`);
  // A held installation explains, without a terminal, how an abandoned lock would be reviewed.
  const notice =
    status === 3 && hostHoldsInstallation
      ? "The installation is locked. If Marea did not shut down correctly, run this command in a terminal to review and remove the lock.\n"
      : "";
  assert.equal(result.stderr, status === 0 ? "" : `${notice}${diagnostics.get(status) ?? ""}`);
  assert.equal(existsSync(join(f.root, "locks/installation.lock")), hostHoldsInstallation);
  if (status !== 0) return {};
  assert.ok(!result.stdout.includes(f.root) || name === "backup create");
  return json.parse(JSON.parse(result.stdout));
}

function scalar(sql: string, key: string): string {
  const file = openSqliteDatabaseFile({ databasePath: f.databasePath });
  try {
    return String(
      z
        .record(z.string(), z.union([z.string(), z.number(), z.bigint()]))
        .parse(file.database.readOne(sql))[key],
    );
  } finally {
    file.close();
  }
}

try {
  compileExecutable("cli-entry.ts", binaries.admin);
  compileExecutable("operations-entry.ts", binaries.operations);
  const admin = (name: string, payload?: Json, status = 0) =>
    run(binaries.admin, name, payload, [], status);
  const operations = (name: string, payload?: Json, flags: string[] = [], status = 0) =>
    run(binaries.operations, name, payload, flags, status);

  // Synthetic governance created through the accepted GOVERNANCE executable on schema 8.
  const scope = { centerId: "center:a" };
  admin("center create", { ...scope, displayName: "Center", expectedVersion: null });
  admin("class create", {
    ...scope,
    classId: "class:ready",
    displayName: "Ready",
    expectedVersion: null,
  });
  admin("account create", {
    ...scope,
    userId: "user:student",
    displayName: "Student",
    login: "student",
    role: "student",
    classId: "class:ready",
    expectedVersion: null,
  });
  const storage = initializeSqliteStorage({ databasePath: f.databasePath });
  try {
    storage.database.execute(
      "INSERT INTO marea_run_snapshots VALUES ('snapshot:closed', '{\"project\":\"synthetic\"}', '{}', '2026-09-12T09:00:00.000Z')",
    );
    storage.database.execute(
      "INSERT INTO marea_runs VALUES ('run:closed', 'user:student', 'class:ready', 'snapshot:closed', 'client:closed', 'Closed', 'closed', '2026-09-12T09:00:00.000Z', '2026-09-12T09:01:00.000Z', 'student-requested')",
    );
  } finally {
    storage.close();
  }

  mkdirSync(join(f.root, "backups"), { mode: 0o700 });
  writeFileSync(
    join(f.root, "config", "operations.json"),
    JSON.stringify({
      version: 1,
      databasePath: f.databasePath,
      indexPath: join(f.root, "deletion-index.sqlite"),
      backupRoot: join(f.root, "backups"),
      authorityLineage: "lineage:compiled",
      rootId: "root:compiled",
      databaseLineage: `sha256:${"b".repeat(64)}`,
      releaseId: "release:compiled",
      limits: { fileCount: 4, fileBytes: 16_000_000, totalBytes: 32_000_000 },
      stateFiles: [],
    }),
    { mode: 0o600 },
  );

  const request = (previewId: string, targets: Json[keyof Json][]) => ({
    requestId: `request:${previewId}`,
    previewId,
    policyRevision: "policy:compiled",
    targets,
  });
  const early = [
    {
      kind: "account",
      key: { userId: "user:student" },
      observed: { kind: "version", version: "v:1" },
    },
  ];
  operations(
    "deletion preview",
    request("preview:early", early),
    ["--output", join(f.root, "work/early.json")],
    5,
  );
  assert.deepEqual(operations("deletion activate"), { schemaVersion: 9 });
  assert.deepEqual(operations("deletion activate"), { schemaVersion: 9 });
  assert.equal(scalar("PRAGMA user_version", "user_version"), "9");
  // The GOVERNANCE executable keeps working on the activated installation.
  admin("center rename", {
    ...scope,
    displayName: "Renamed",
    expectedVersion: scalar("SELECT version FROM marea_centers WHERE id = 'center:a'", "version"),
  });

  assert.deepEqual(operations("backup create", { name: "backup-a" }), {
    path: join(f.root, "backups/backup-a"),
    files: 1,
  });
  const offsite = join(f.root, "work", "backup-a-offsite");
  cpSync(join(f.root, "backups/backup-a"), offsite, { recursive: true });
  const restored = join(f.root, "work", "restored.sqlite");
  const snapshot = openSqliteDatabaseFile({ databasePath: f.databasePath });
  try {
    snapshot.database.execute("VACUUM INTO ?1", [restored]);
  } finally {
    snapshot.close();
  }

  const account = {
    kind: "account",
    key: { userId: "user:student" },
    observed: {
      kind: "version",
      version: scalar(
        "SELECT version FROM marea_governance_accounts WHERE user_id = 'user:student'",
        "version",
      ),
    },
  };
  const blockedPath = join(f.root, "work/blocked.json");
  assert.equal(
    operations("deletion preview", request("preview:blocked", [account]), ["--output", blockedPath])
      .blockers,
    1,
  );
  operations("deletion confirm", undefined, ["--input", blockedPath], 4);
  const blocked = json.parse(JSON.parse(await Bun.file(blockedPath).text()));
  const backupTarget =
    z.array(z.object({ target: z.json() })).parse(blocked.blockers)[0]?.target ?? null;
  const artifactPath = join(f.root, "work/artifact.json");
  const preview = operations(
    "deletion preview",
    request("preview:account", [account, backupTarget]),
    ["--output", artifactPath],
  );
  assert.deepEqual([preview.blockers, preview.backups], [0, 1]);
  assert.deepEqual(operations("deletion confirm", undefined, ["--input", artifactPath]), {
    operationId: "preview:account",
    requestId: "request:preview:account",
    artifactDigest: preview.artifactDigest,
    state: "applied",
  });
  assert.equal(existsSync(join(f.root, "backups/backup-a")), false);
  assert.equal(
    scalar("SELECT COUNT(*) AS total FROM marea_users WHERE id = 'user:student'", "total"),
    "0",
  );
  assert.equal(scalar("SELECT COUNT(*) AS total FROM marea_runs", "total"), "0");
  assert.deepEqual(operations("recovery inspect", {}), {
    state: "none",
    operationId: null,
    checkpointState: null,
    reasonCode: "idle",
  });

  const reconciliation = operations("backup reconcile", {
    bundlePath: offsite,
    restoredDatabasePath: restored,
  });
  assert.deepEqual(
    [reconciliation.state, reconciliation.reasonCode],
    ["blocked", "tombstoned-identity"],
  );

  admin(
    "account create",
    {
      ...scope,
      userId: "user:student",
      displayName: "Returning",
      login: "returning",
      role: "student",
      classId: "class:ready",
      expectedVersion: null,
    },
    4,
  );

  // The host lock and the executables exclude each other.
  const exclusivity = createSharedInstallationExclusivity(
    new FilesystemInstallationExclusivity(),
    acquireInstallation,
  );
  const hostLock = await exclusivity.acquire(f.root);
  hostHoldsInstallation = true;
  operations("recovery inspect", {}, [], 3);
  admin("center rename", { ...scope, displayName: "Blocked", expectedVersion: "revision:none" }, 3);
  await hostLock.release();
  hostHoldsInstallation = false;
  operations("recovery inspect", {});
  console.log("compiled OPERATIONS operations rehearsal: pass");
} finally {
  rmSync(f.root, { recursive: true, force: true });
}
