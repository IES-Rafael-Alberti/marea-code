import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSqliteDatabaseFile } from "@marea/sqlite-storage";
import { z } from "zod";

import { teacherHostInstallation } from "../src/platform/teacher-host/teacher-host.fixture.js";
import {
  answeringLockQuestions,
  compileInstallationExecutables,
  startCompiledHost,
  stopCompiledHost,
} from "./compiled-host-process.js";

// W07 transfer rehearsal on compiled executables: a `transfer start` is killed while the source
// authority is quiesced, never leaving two active roots; the recorded handoff continues it; the
// teacher host then starts only on the destination, with the transferred accounts and state file.
const record = z.record(z.string(), z.json());
const workspace = realpathSync(mkdtempSync(join(tmpdir(), "marea-transfer-rehearsal-")));
chmodSync(workspace, 0o700);
const source = teacherHostInstallation({ activate: false });
const destination = teacherHostInstallation({ activate: false });
const binaries = compileInstallationExecutables(workspace);
const PASSWORD = "synthetic-transfer-password";

function invoke(binary: string, root: string, args: readonly string[], status = 0, stdin = "") {
  const result = spawnSync(binary, ["--installation", root, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    input: stdin,
  });
  assert.equal(result.status, status, `${args.join(" ")}: ${result.stderr}`);
  return status === 0 ? record.parse(JSON.parse(result.stdout)) : { stderr: result.stderr };
}

let inputs = 0;
function input(payload: object): string[] {
  inputs += 1;
  return ["--input", source.work(`transfer-${String(inputs)}.json`, payload)];
}

const indexPath = (root: string) => join(root, "state", "deletion-index.sqlite");
function indexState(root: string): string | null {
  if (!existsSync(indexPath(root))) return null;
  try {
    const file = openSqliteDatabaseFile({ databasePath: indexPath(root) });
    try {
      return z
        .object({ state: z.string() })
        .parse(file.database.readOne("SELECT state FROM marea_deletion_index_meta")).state;
    } finally {
      file.close();
    }
  } catch {
    // The index is being replaced or written by the running transfer.
    return null;
  }
}
const active = () =>
  [source.root, destination.root].filter((root) => indexState(root) === "active");

function writeOperations(root: string, rootId: string): void {
  const config = {
    version: 1,
    databasePath: join(root, "marea.sqlite"),
    indexPath: indexPath(root),
    backupRoot: join(root, "backups"),
    authorityLineage: "lineage:host",
    rootId,
    databaseLineage: `sha256:${"a".repeat(64)}`,
    releaseId: "release:host",
    limits: { fileCount: 4, fileBytes: 1_073_741_824, totalBytes: 2_147_483_648 },
    stateFiles: ["state/digest.key"],
  };
  writeFileSync(join(root, "config", "operations.json"), JSON.stringify(config), { mode: 0o600 });
}

function hostRefusal(root: string): string {
  const refused = spawnSync(binaries.host, ["--installation", root, "--release", "release:host"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(refused.status, 5, refused.stderr);
  return refused.stderr;
}

try {
  // Source: an upgraded installation with a provisioned teacher and enough data that the copy
  // takes long enough to be interrupted while it runs.
  writeOperations(source.root, "root:source");
  const bulk = openSqliteDatabaseFile({ databasePath: source.databasePath });
  try {
    bulk.database.execute("UPDATE marea_users SET password_hash = ?1 WHERE id = 'user:teacher'", [
      await Bun.password.hash(PASSWORD, { algorithm: "argon2id" }),
    ]);
    bulk.database.transaction(() => {
      for (let row = 0; row < 120_000; row += 1)
        bulk.database.execute(
          "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES (?1, ?1, 'hash:synthetic', 'student', ?2, NULL)",
          [`user:bulk-${String(row)}`, "synthetic ".repeat(40)],
        );
    });
  } finally {
    bulk.close();
  }
  invoke(binaries.operations, source.root, ["deletion", "activate"]);
  const digestKey = readFileSync(join(source.root, "state", "digest.key"));

  // Destination: the same authority under another root, with no database, index or state file.
  rmSync(destination.databasePath);
  rmSync(join(destination.root, "state", "digest.key"));
  writeOperations(destination.root, "root:destination");
  for (const f of [source, destination])
    f.writeHost({ ...f.host, allowedHosts: ["127.0.0.1"], allowedOrigins: ["http://127.0.0.1"] });

  // A real interruption: the transfer process is killed once the source authority is quiesced.
  const start = input({
    handoffId: "handoff:rehearsal",
    destinationInstallation: destination.root,
  });
  const child = spawn(
    binaries.operations,
    ["--installation", source.root, "transfer", "start", ...start],
    {
      stdio: "ignore",
    },
  );
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const deadline = Date.now() + 60_000;
  while (indexState(source.root) !== "transfer-prepared" && Date.now() < deadline)
    await Bun.sleep(1);
  child.kill("SIGKILL");
  await exited;
  assert.equal(indexState(source.root), "transfer-prepared");
  assert.deepEqual(active(), []);
  // The killed process left both installations locked; a person at a terminal removes each lock,
  // and the destination is named before its question.
  const inspected = await answeringLockQuestions(
    binaries.operations,
    source.root,
    ["transfer", "inspect"],
    ["y", "y"],
  );
  assert.equal(inspected.code, 0, inspected.output);
  assert.match(
    inspected.output,
    new RegExp(`Transfer destination ${destination.root}:\nThe installation is locked[.]`, "u"),
  );
  assert.equal(inspected.output.split("The lock was removed.").length, 3, inspected.output);
  const interrupted = z
    .object({ transfer: z.object({ state: z.string() }) })
    .parse(JSON.parse(/\{"transfer".*\}$/mu.exec(inspected.output)?.[0] ?? "")).transfer;
  assert.ok(["prepared", "copied"].includes(interrupted.state), interrupted.state);
  // While quiesced, neither root serves nor accepts governance changes.
  assert.equal(hostRefusal(source.root), "Teacher host did not start: index.\n");
  invoke(
    binaries.admin,
    source.root,
    [
      "center",
      "create",
      ...input({
        centerId: "center:late",
        displayName: "Late",
        expectedVersion: null,
      }),
    ],
    5,
  );

  // Continuation from the exact handoff the source recorded.
  const handoff = z
    .object({
      handoff: z.object({
        handoffId: z.string(),
        authorityLineage: z.string(),
        expectedIndexGeneration: z.number(),
        authorityCheckpointDigest: z.string(),
        sourceRoot: z.string(),
        destinationRoot: z.string(),
      }),
    })
    .parse(
      JSON.parse(readFileSync(join(source.root, "state", "transfer-handoff.json"), "utf8")),
    ).handoff;
  const continued = invoke(binaries.operations, source.root, [
    "recovery",
    "transfer-continue",
    ...input({
      handoffId: handoff.handoffId,
      authorityLineage: handoff.authorityLineage,
      expectedIndexGeneration: handoff.expectedIndexGeneration,
      indexDigest: handoff.authorityCheckpointDigest,
      sourceRoot: handoff.sourceRoot,
      destinationRoot: handoff.destinationRoot,
    }),
  ]);
  assert.deepEqual([continued.state, continued.destinationState], ["destination-active", "active"]);
  assert.deepEqual(active(), [destination.root]);
  assert.equal(indexState(source.root), "retired");
  assert.deepEqual(readFileSync(join(destination.root, "state", "digest.key")), digestKey);

  // Only the destination serves, with the transferred credential; the source stays retired.
  assert.equal(hostRefusal(source.root), "Teacher host did not start: index.\n");
  invoke(binaries.operations, source.root, ["transfer", "start", ...start], 4);
  const host = await startCompiledHost(binaries.host, destination.root, "release:host");
  const login = await fetch(`${host.origin}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1" },
    body: JSON.stringify({
      credentials: { login: "teacher", password: PASSWORD },
      kind: "credential-login",
      protocolVersion: "0.1",
      requestId: "request:transferred-login",
    }),
  });
  assert.equal(login.status, 200, await login.clone().text());
  await stopCompiledHost(host);
  assert.deepEqual(
    invoke(binaries.admin, destination.root, [
      "center",
      "create",
      ...input({
        centerId: "center:after",
        displayName: "After",
        expectedVersion: null,
      }),
    ]).centerId,
    "center:after",
  );
  console.log(`compiled transfer rehearsal (interrupted at ${interrupted.state}): pass`);
} finally {
  for (const root of [source.root, destination.root, workspace])
    rmSync(root, { recursive: true, force: true });
}
