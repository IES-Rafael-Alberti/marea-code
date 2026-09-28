import { assertReleasePackaging } from "./release-packaging.fixture.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  createDashboardProfileStore,
  initializeSqliteStorage,
  inspectSqliteSchemaVersion,
} from "@marea/sqlite-storage";
import { acquireInstallation } from "../src/platform/operator-cli/installation-lock.js";
import { compileExecutable } from "./compile-executable.js";
import {
  answeringLockQuestions,
  compileInstallationExecutables,
  startCompiledHost,
  stopCompiledHost,
} from "./compiled-host-process.js";
import { buildProfileBaseline } from "./profile-baseline-release.fixture.js";
import {
  actualReleaseInstallation,
  secureDashboard,
} from "./profile-upgrade-acceptance.fixture.js";

const workspace = realpathSync(mkdtempSync(join(tmpdir(), "marea-profile-upgrade-")));
chmodSync(workspace, 0o700);
const f = actualReleaseInstallation();
const schema = () => inspectSqliteSchemaVersion({ databasePath: f.databasePath });
const json = z.record(z.string(), z.json());
try {
  assertReleasePackaging(f.root, f.host.dashboardDistPath);
  const binaries = compileInstallationExecutables(workspace);
  const baseline = buildProfileBaseline(workspace);
  const previousHost = baseline.host;
  const previousAssets = join(workspace, "previous-dashboard");
  cpSync(baseline.dashboard, previousAssets, { recursive: true });
  secureDashboard(previousAssets);
  const interrupted = join(workspace, "interrupted");
  compileExecutable("smoke/profile-upgrade-interruption.ts", interrupted);
  const ops = (name: string, payload?: object, status = 0, flags: string[] = []) =>
    f.operation(binaries.operations, name, payload, status, flags);
  const admin = (name: string, payload: object) => f.operation(binaries.admin, name, payload);
  admin("center create", { centerId: "center:a", displayName: "Center", expectedVersion: null });
  admin("class create", {
    centerId: "center:a",
    classId: "class:ready",
    displayName: "Ready",
    expectedVersion: null,
  });
  admin("account create", {
    centerId: "center:a",
    userId: "student:profiles",
    displayName: "Former teacher",
    login: "profiles",
    role: "student",
    classId: "class:ready",
    expectedVersion: null,
  });
  const legacyStorage = initializeSqliteStorage({
    databasePath: f.databasePath,
    schema: "retention-audit",
  });
  legacyStorage.database.execute(
    "INSERT INTO marea_run_snapshots (id, public_snapshot_json, provider_route_json, created_at) VALUES (?1, ?2, ?3, ?4)",
    [
      "snapshot:historical",
      '{"project":"historical"}',
      '{"route":"retained"}',
      "2026-09-21T12:00:00Z",
    ],
  );
  legacyStorage.database.execute(
    "INSERT INTO marea_run_teaching_snapshots (snapshot_id, teaching_json) VALUES (?1, ?2)",
    ["snapshot:historical", '{"teaching":"retained"}'],
  );
  legacyStorage.close();
  const snapshot = () =>
    f.query(
      "SELECT s.*, t.teaching_json FROM marea_run_snapshots s JOIN marea_run_teaching_snapshots t ON t.snapshot_id = s.id WHERE s.id = 'snapshot:historical'",
    );
  const historical = snapshot();
  // The host source and browser release are unchanged from the required schema-9 baseline.
  // Starting these real binaries must not activate profiles, even with compatible assets.
  const legacy = await startCompiledHost(binaries.host, f.root, "release:host");
  assert.equal(schema(), 9);
  ops("installation upgrade-profiles", { name: "busy" }, 3);
  await stopCompiledHost(legacy);
  assert.equal(
    json.parse(json.parse(ops("installation status").profileUpgrade).release).ready,
    true,
  );

  for (const boundary of ["backed-up", "migrated"]) {
    const killed = spawnSync(interrupted, [f.root, boundary], {
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(killed.signal, "SIGKILL", killed.stderr);
    assert.equal(schema(), boundary === "backed-up" ? 9 : 10);
    assert.equal(
      inspectSqliteSchemaVersion({
        databasePath: join(f.root, "backups", `crash-${boundary}`, "database.sqlite"),
      }),
      9,
    );
    ops("recovery inspect", {}, 3);
    const recovered = await answeringLockQuestions(
      binaries.operations,
      f.root,
      ["recovery", "inspect", "--input", f.work("inspect.json", {})],
      ["y"],
    );
    assert.equal(recovered.code, 0, recovered.output);
  }
  assert.equal(schema(), 10);
  assert.deepEqual(snapshot(), historical);
  ops("installation upgrade-profiles", { name: "already-active" }, 4);
  const storage = initializeSqliteStorage({
    databasePath: f.databasePath,
    schema: "dashboard-profiles",
  });
  // Synthetic retained preferences on a former teacher account. Current teacher accounts
  // remain protected by the existing deletion policy.
  const profile = {
    schemaVersion: 1,
    revision: "profile:survives",
    updatedAt: "2026-09-22T12:00:00Z",
    serializedValue: JSON.stringify({ themeId: "org.marea.theme.high-contrast", modules: [] }),
  };
  createDashboardProfileStore(storage.database).write("student:profiles", null, profile);
  createDashboardProfileStore(storage.database).write("student:profiles", "class:ready", {
    ...profile,
    revision: "class:survives",
  });
  storage.close();
  const restarted = await startCompiledHost(binaries.host, f.root, "release:host");
  assert.equal((await fetch(`${restarted.origin}/dashboard/`)).status, 200);
  await stopCompiledHost(restarted);
  assert.equal(f.query("SELECT COUNT(*) AS count FROM marea_dashboard_profiles")?.count, 2n);
  ops("backup create", { name: "with-profiles" });
  const saved = join(workspace, "saved-profiles");
  cpSync(join(f.root, "backups", "with-profiles"), saved, { recursive: true });
  const restored = join(workspace, "restored");
  assert.equal(
    ops("backup restore", { bundlePath: saved, destinationRoot: restored }).state,
    "restored",
  );
  const restoredStorage = initializeSqliteStorage({
    databasePath: join(restored, "database.sqlite"),
    schema: "dashboard-profiles",
  });
  assert.deepEqual(
    createDashboardProfileStore(restoredStorage.database).read("student:profiles", null),
    profile,
  );
  restoredStorage.close();

  // Roll back under the same deletion authority: isolated restore first, then database and
  // unchanged baseline binaries/assets as a release unit; never restore the deletion index.
  const rollback = join(workspace, "rollback");
  assert.equal(
    ops("backup restore", {
      bundlePath: join(f.root, "backups", "crash-backed-up"),
      destinationRoot: rollback,
    }).schemaVersion,
    9,
  );
  const upgradedDatabase = join(workspace, "schema10.sqlite");
  const upgradedAssets = join(workspace, "upgraded-dashboard");
  const rollbackOwner = acquireInstallation(f.root);
  try {
    renameSync(f.databasePath, upgradedDatabase);
    renameSync(join(rollback, "database.sqlite"), f.databasePath);
    renameSync(f.host.dashboardDistPath, upgradedAssets);
    renameSync(previousAssets, f.host.dashboardDistPath);
  } finally {
    rollbackOwner.release();
  }
  assert.equal(schema(), 9);
  const rolledBack = await startCompiledHost(previousHost, f.root, "release:host");
  assert.equal(schema(), 9);
  assert.equal(
    f.query("SELECT id FROM marea_users WHERE id = 'student:profiles'")?.id,
    "student:profiles",
  );
  await stopCompiledHost(rolledBack);
  assert.equal(f.operation(baseline.operations, "deletion activate").schemaVersion, 9);
  assert.deepEqual(snapshot(), historical);
  const returnOwner = acquireInstallation(f.root);
  try {
    rmSync(f.databasePath);
    renameSync(upgradedDatabase, f.databasePath);
    rmSync(f.host.dashboardDistPath, { recursive: true });
    renameSync(upgradedAssets, f.host.dashboardDistPath);
  } finally {
    returnOwner.release();
  }

  // Delete the account and all local backups that contain it, including both profile scopes.
  const target = {
    kind: "account",
    key: { userId: "student:profiles" },
    observed: {
      kind: "version",
      version: f.query(
        "SELECT version FROM marea_governance_accounts WHERE user_id = 'student:profiles'",
      )?.version,
    },
  };
  const preview = (targets: object[], name: string) => {
    const output = join(f.root, "work", `${name}.json`);
    ops(
      "deletion preview",
      {
        requestId: `request:${name}`,
        previewId: `preview:${name}`,
        policyRevision: "policy:profiles",
        targets,
      },
      0,
      ["--output", output],
    );
    return output;
  };
  const blocked = f.readJson(preview([target], "blocked"));
  const blockers = z
    .array(z.object({ target: json }))
    .parse(blocked.blockers)
    .map((entry) => entry.target);
  const confirmed = preview([target, ...blockers], "confirmed");
  assert.equal(
    f.operation(binaries.operations, "deletion confirm", undefined, 0, ["--input", confirmed])
      .state,
    "applied",
  );
  assert.equal(f.query("SELECT COUNT(*) AS count FROM marea_dashboard_profiles")?.count, 0n);
  const denied = join(workspace, "denied");
  assert.equal(
    ops("backup restore", { bundlePath: saved, destinationRoot: denied }).state,
    "blocked",
  );
  assert.equal(existsSync(denied), false);
  assert.deepEqual(snapshot(), historical);
  console.log(
    "compiled profile upgrade: actual release, schema9 startup, ownership, SIGKILL/recovery, restart, restore, rollback and profile deletion: pass",
  );
} finally {
  rmSync(f.root, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}
