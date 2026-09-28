import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createMigrationCatalog } from "../src/migration-catalog.js";
import {
  createDefaultDependencies,
  initializeSqliteStorage,
  initializeSqliteStorageWith,
  restoreSqliteBackup,
} from "../src/storage.js";

interface ProcessResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const packageRoot = resolve(import.meta.dir, "..");
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "marea-sqlite-compiled-"));
const executablePath = resolve(temporaryDirectory, "marea-sqlite-smoke");

function requireSuccess(result: ProcessResult, context: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`${context} failed with ${result.stderr.trim() || "no diagnostic"}.`);
  }
}

function runSync(command: readonly string[]): ProcessResult {
  const result = Bun.spawnSync([...command], {
    cwd: packageRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

function spawn(command: readonly string[]) {
  return Bun.spawn([...command], {
    cwd: packageRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
}

async function finish(subprocess: ReturnType<typeof spawn>): Promise<ProcessResult> {
  const [exitCode, stderr, stdout] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stderr).text(),
    new Response(subprocess.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
}

function expectOutput(result: ProcessResult, mode: string): void {
  requireSuccess(result, mode);
  if (!result.stdout.includes(`"mode":"${mode}"`) || !result.stdout.includes('"version":8')) {
    throw new Error(`${mode} returned an unexpected result.`);
  }
}

async function verifyConcurrentInitialization(): Promise<string> {
  const databasePath = resolve(temporaryDirectory, "concurrent.sqlite");
  const first = spawn([executablePath, "initialize", databasePath]);
  const second = spawn([executablePath, "initialize", databasePath]);
  const [firstResult, secondResult] = await Promise.all([finish(first), finish(second)]);
  expectOutput(firstResult, "initialize");
  expectOutput(secondResult, "initialize");
  return databasePath;
}

function verifyTamperedSchema(databasePath: string): void {
  const database = new Database(databasePath, { strict: true });
  database.run("DROP TABLE marea_metadata");
  database.close(true);
  const result = runSync([executablePath, "initialize", databasePath]);
  if (
    result.exitCode === 0 ||
    !result.stderr.includes('"code":"schema-mismatch"') ||
    result.stderr.includes(databasePath) ||
    result.stderr.includes("DROP TABLE")
  ) {
    throw new Error("The compiled artifact did not safely reject a tampered schema.");
  }
}

function verifyBackupRestore(): void {
  const sourcePath = resolve(temporaryDirectory, "source.sqlite");
  const restoredPath = resolve(temporaryDirectory, "restored.sqlite");
  expectOutput(
    runSync([executablePath, "backup-restore", sourcePath, restoredPath]),
    "backup-restore",
  );
  const noClobber = runSync([executablePath, "backup-restore", sourcePath, restoredPath]);
  if (noClobber.exitCode === 0 || !noClobber.stderr.includes('"code":"restore-failed"')) {
    throw new Error("The compiled artifact overwrote an existing restore target.");
  }
}

function verifyPhaseTwoUpgrade(): void {
  const legacyPath = resolve(temporaryDirectory, "phase-two.sqlite");
  const legacy = initializeSqliteStorageWith(
    { databasePath: legacyPath },
    {
      ...createDefaultDependencies(),
      migrations: createMigrationCatalog().slice(0, 2),
    },
  );
  legacy.database.execute("INSERT INTO marea_metadata (key, value) VALUES (?1, ?2)", [
    "upgrade-marker",
    "preserve-phase-two",
  ]);
  const backup = legacy.createBackup();
  legacy.close();
  expectOutput(runSync([executablePath, "initialize", legacyPath]), "initialize");
  const upgraded = new Database(legacyPath, { strict: true });
  const marker = upgraded
    .query<{ value: string }, []>("SELECT value FROM marea_metadata WHERE key = 'upgrade-marker'")
    .get();
  upgraded.close(true);
  if (marker?.value !== "preserve-phase-two" || backup.schemaVersion !== 2) {
    throw new Error("Upgrading did not preserve the base data and backup.");
  }
  const recovered = restoreSqliteBackup({
    backup,
    databasePath: resolve(temporaryDirectory, "recovered-phase-two.sqlite"),
  });
  const restoredMarker = recovered.database.readOne(
    "SELECT value FROM marea_metadata WHERE key = 'upgrade-marker'",
  );
  const version = recovered.schema.version;
  recovered.close();
  if (version !== 8 || restoredMarker?.value !== "preserve-phase-two") {
    throw new Error("The base backup could not be restored and upgraded.");
  }
}

function verifyGovernanceUpgrade(): void {
  const databasePath = resolve(temporaryDirectory, "schema-six.sqlite");
  const legacy = initializeSqliteStorageWith(
    { databasePath },
    { ...createDefaultDependencies(), migrations: createMigrationCatalog().slice(0, 6) },
  );
  try {
    legacy.database.execute("INSERT INTO marea_classes VALUES (?1, ?2, ?3)", [
      "class-1",
      "legacy:class-1",
      "Class",
    ]);
    legacy.database.execute("INSERT INTO marea_classes VALUES (?1, ?2, ?3)", [
      "class-2",
      "legacy:class-2",
      "Other class",
    ]);
    legacy.database.execute("INSERT INTO marea_users VALUES (?1, ?2, ?3, ?4, ?5, ?6)", [
      "user-1",
      "student@example.test",
      "synthetic-hash",
      "student",
      "Student",
      "class-1",
    ]);
  } finally {
    legacy.close();
  }
  expectOutput(runSync([executablePath, "initialize", databasePath]), "initialize");
  expectOutput(runSync([executablePath, "initialize", databasePath]), "initialize");
  const database = new Database(databasePath, { strict: true });
  try {
    database.run("PRAGMA foreign_keys = ON");
    const user = database
      .query<{ role: string; class_id: string; password_hash: string }, []>(
        "SELECT role, class_id, password_hash FROM marea_users WHERE id = 'user-1'",
      )
      .get();
    if (
      user?.role !== "student" ||
      user.class_id !== "class-1" ||
      user.password_hash !== "synthetic-hash"
    ) {
      throw new Error("Schema 6 to 7 did not preserve the legacy student.");
    }
    for (const table of [
      "marea_centers",
      "marea_governance_accounts",
      "marea_center_memberships",
      "marea_governance_classes",
      "marea_governance_memberships",
      "marea_class_exchange_previews",
      "marea_governance_audit",
    ]) {
      const row = database
        .query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`)
        .get();
      if (row?.count !== 0) throw new Error("Schema migration must not invent governance data.");
    }
    const time = "2026-09-12T08:00:00.000Z";
    for (const number of ["1", "2"]) {
      database.run("INSERT INTO marea_centers VALUES (?1, ?2, 'v1', ?3, ?4)", [
        `center-${number}`,
        `Center ${number}`,
        time,
        time,
      ]);
      database.run("INSERT INTO marea_governance_classes VALUES (?1, ?2, 'v1', ?3, ?4)", [
        `class-${number}`,
        `center-${number}`,
        time,
        time,
      ]);
    }
    database.run(
      "INSERT INTO marea_governance_accounts VALUES ('user-1', 'center-1', 'active', 'v1', ?1, ?2)",
      [time, time],
    );
    for (const center of ["center-1", "center-2"]) {
      database.run(
        "INSERT INTO marea_center_memberships VALUES (?1, 'user-1', 'member', 'active', 'v1', ?2, ?3)",
        [center, time, time],
      );
    }
    database.run(
      "INSERT INTO marea_governance_memberships VALUES ('class-1', 'center-1', 'user-1', 'student', 'active', 'v1', ?1, ?2)",
      [time, time],
    );
    const secondClass = () =>
      database.run(
        "INSERT INTO marea_governance_memberships VALUES ('class-2', 'center-2', 'user-1', 'student', 'active', 'v2', ?1, ?2)",
        [time, time],
      );
    let rejectedByStudentIndex = false;
    try {
      secondClass();
    } catch (error) {
      rejectedByStudentIndex =
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed: marea_governance_memberships.user_id");
    }
    if (!rejectedByStudentIndex)
      throw new Error("Schema 7 did not enforce one active student class across centers.");
    database.run(
      "UPDATE marea_governance_memberships SET state = 'revoked' WHERE class_id = 'class-1'",
    );
    secondClass();
  } finally {
    database.close(true);
  }
}

async function main(): Promise<void> {
  const build = runSync([
    "bun",
    "build",
    "--compile",
    "smoke/compiled-smoke.ts",
    "--outfile",
    executablePath,
  ]);
  requireSuccess(build, "Bun compilation");
  const concurrentDatabase = await verifyConcurrentInitialization();
  verifyTamperedSchema(concurrentDatabase);
  verifyBackupRestore();
  verifyPhaseTwoUpgrade();
  verifyGovernanceUpgrade();
  verifyTeachingAuthorshipRecovery();
  process.stdout.write("Compiled SQLite smoke test passed.\n");
}

function verifyTeachingAuthorshipRecovery(): void {
  const databasePath = resolve(temporaryDirectory, "authorship-seven.sqlite");
  const legacy = initializeSqliteStorageWith(
    { databasePath },
    { ...createDefaultDependencies(), migrations: createMigrationCatalog().slice(0, 7) },
  );
  const configuration = '{ "legacy": "exact bytes preserved" }';
  legacy.database.execute(
    "INSERT INTO marea_classes VALUES ('class:authorship', 'seed:authorship', 'Authorship')",
  );
  legacy.database.execute(
    "INSERT INTO marea_users VALUES ('teacher:authorship', 'authorship-teacher', 'synthetic-hash', 'teacher', 'Teacher', 'class:authorship')",
  );
  legacy.database.execute(
    "INSERT INTO marea_class_teaching_revisions VALUES ('revision:teacher', 'class:authorship', 'teacher:authorship', '2026-09-12T10:00:00.000Z', ?1)",
    [configuration],
  );
  legacy.database.execute(
    "INSERT INTO marea_current_class_teaching VALUES ('class:authorship', 'revision:teacher')",
  );
  const backupSeven = legacy.createBackup();
  legacy.close();
  expectOutput(runSync([executablePath, "initialize", databasePath]), "initialize");
  const upgraded = initializeSqliteStorage({ databasePath });
  upgraded.database.execute(
    "INSERT INTO marea_class_teaching_revisions VALUES ('revision:operator', 'class:authorship', NULL, '2026-09-12T10:01:00.000Z', ?1, 'operator')",
    [configuration],
  );
  upgraded.database.execute(
    "UPDATE marea_current_class_teaching SET revision_id = 'revision:operator' WHERE class_id = 'class:authorship'",
  );
  const backupEight = upgraded.createBackup();
  upgraded.close();
  for (const [backup, expectedCurrent] of [
    [backupSeven, "revision:teacher"],
    [backupEight, "revision:operator"],
  ] as const) {
    const restored = restoreSqliteBackup({
      backup,
      databasePath: resolve(
        temporaryDirectory,
        `restored-authorship-${String(backup.schemaVersion)}.sqlite`,
      ),
    });
    try {
      const teacher = restored.database.readOne(
        "SELECT authority, created_by, configuration_json FROM marea_class_teaching_revisions WHERE id = 'revision:teacher'",
      );
      const current = restored.database.readOne(
        "SELECT revision_id FROM marea_current_class_teaching WHERE class_id = 'class:authorship'",
      );
      if (
        restored.schema.version !== 8 ||
        teacher?.authority !== "teacher" ||
        teacher.created_by !== "teacher:authorship" ||
        teacher.configuration_json !== configuration ||
        current?.revision_id !== expectedCurrent ||
        restored.database.readAll("PRAGMA foreign_key_check").length !== 0
      )
        throw new Error(
          "Authorship recovery did not preserve teaching identity, payload and references.",
        );
      if (backup.schemaVersion === 8) {
        const operator = restored.database.readOne(
          "SELECT authority, created_by, configuration_json FROM marea_class_teaching_revisions WHERE id = 'revision:operator'",
        );
        if (
          operator?.authority !== "operator" ||
          operator.created_by !== null ||
          operator.configuration_json !== configuration
        )
          throw new Error("Operator authorship was not preserved by schema-eight recovery.");
      }
    } finally {
      restored.close();
    }
  }
}

try {
  await main();
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
