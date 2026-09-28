import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const json = z.record(z.string(), z.json());
type Json = z.infer<typeof json>;
let binaries: ReturnType<typeof compileInstallationExecutables>;
const f = teacherHostInstallation({ activate: false });
const locks = [join(f.root, ".marea-installation.lock"), join(f.root, "locks/installation.lock")];

function command(binary: string, name: string, payload?: Json, flags: string[] = []) {
  const input =
    payload === undefined ? [] : ["--input", f.work(`${name.replace(" ", "-")}.json`, payload)];
  return spawnSync(binary, ["--installation", f.root, ...name.split(" "), ...input, ...flags], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

function operations(name: string, payload?: Json, flags: string[] = [], status = 0): Json {
  const result = command(binaries.operations, name, payload, flags);
  assert.equal(result.status, status, `${name}: ${result.stderr}`);
  return status === 0 ? json.parse(JSON.parse(result.stdout)) : {};
}

function query(sql: string) {
  const file = openSqliteDatabaseFile({ databasePath: f.databasePath });
  try {
    return file.database.readOne(sql);
  } finally {
    file.close();
  }
}

function hostStatus(): string {
  return z.object({ status: z.string() }).parse(JSON.parse(readFileSync(f.host.statusPath, "utf8")))
    .status;
}

const startHost = () => startCompiledHost(binaries.host, f.root, "release:host");

const UNATTENDED =
  "The installation is locked. If Marea did not shut down correctly, run this command in a terminal to review and remove the lock.\n";

function refusedStart(code: number, reason: string, notice = ""): void {
  const result = spawnSync(binaries.host, ["--installation", f.root, "--release", "release:host"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.status, code, result.stderr);
  assert.equal(result.stderr, `${notice}Teacher host did not start: ${reason}.\n`);
}

const answered = (binary: string, args: string[], answer: string) =>
  answeringLockQuestions(binary, f.root, args, [answer]);

async function teacherLogin(origin: string): Promise<number> {
  const response = await fetch(`${origin}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1" },
    body: JSON.stringify({
      credentials: { login: "teacher", password: "teacher-password" },
      kind: "credential-login",
      protocolVersion: "0.1",
      requestId: "request:interruption-login",
    }),
  });
  return response.status;
}

try {
  binaries = compileInstallationExecutables(f.root);
  const operationsConfig = json.parse(
    JSON.parse(readFileSync(join(f.root, "config", "operations.json"), "utf8")),
  );
  writeFileSync(
    join(f.root, "config", "operations.json"),
    JSON.stringify({
      ...operationsConfig,
      limits: { fileCount: 4, fileBytes: 16_000_000, totalBytes: 32_000_000 },
    }),
    { mode: 0o600 },
  );
  const scope = { centerId: "center:a" };
  for (const [name, payload] of [
    ["center create", { ...scope, displayName: "Center", expectedVersion: null }],
    [
      "class create",
      { ...scope, classId: "class:ready", displayName: "Ready", expectedVersion: null },
    ],
    [
      "account create",
      {
        ...scope,
        userId: "user:student",
        displayName: "Student",
        login: "student",
        role: "student",
        classId: "class:ready",
        expectedVersion: null,
      },
    ],
  ] as const)
    assert.equal(command(binaries.admin, name, payload).status, 0, name);
  const file = openSqliteDatabaseFile({ databasePath: f.databasePath });
  try {
    file.database.execute("UPDATE marea_users SET password_hash = ?1 WHERE id = 'user:teacher'", [
      await Bun.password.hash("teacher-password", { algorithm: "argon2id" }),
    ]);
  } finally {
    file.close();
  }
  f.writeHost({ ...f.host, allowedHosts: ["127.0.0.1"], allowedOrigins: ["http://127.0.0.1"] });
  assert.deepEqual(operations("deletion activate"), { schemaVersion: 9 });

  // A: the host process dies without shutting down. Without a terminal nothing is removed; at a
  // terminal a person decides, warned when the recorded owner still exists.
  const crashed = await startHost();
  assert.equal(await teacherLogin(crashed.origin), 200);
  crashed.child.kill("SIGKILL");
  assert.deepEqual(await crashed.exited, { code: null, signal: "SIGKILL" });
  assert.ok(locks.every((path) => existsSync(path)));
  assert.equal(hostStatus(), "ready");
  refusedStart(3, "lock", UNATTENDED);
  const unattended = command(binaries.operations, "recovery inspect", {});
  assert.deepEqual(
    [unattended.status, unattended.stderr],
    [3, `${UNATTENDED}Installation is busy or its authority is unavailable.\n`],
  );
  const declined = await answered(binaries.host, ["--release", "release:host"], "n");
  assert.equal(declined.code, 3, declined.output);
  assert.match(declined.output, /did not shut down correctly/u);
  assert.match(declined.output, /The lock was kept\.\nTeacher host did not start: lock\.\n/u);
  assert.doesNotMatch(declined.output, /appears to be running/u);
  assert.ok(locks.every((path) => existsSync(path)));
  const accepted = await answered(
    binaries.operations,
    ["recovery", "inspect", "--input", f.work("inspect-idle.json", {})],
    "y",
  );
  assert.equal(accepted.code, 0, accepted.output);
  assert.match(accepted.output, /\[y\/N\] y\nThe lock was removed\.\n/u);
  assert.ok(accepted.output.endsWith('"checkpointState":null,"reasonCode":"idle"}\n'));
  assert.ok(locks.every((path) => !existsSync(path)));
  const restarted = await startHost();
  assert.equal(await teacherLogin(restarted.origin), 200);
  const live = await answered(
    binaries.operations,
    ["recovery", "inspect", "--input", f.work("inspect-live.json", {})],
    "n",
  );
  assert.equal(live.code, 3, live.output);
  assert.ok(
    live.output.includes(
      `Warning: Marea appears to be running (process ${String(restarted.child.pid)}).`,
    ),
    live.output,
  );
  assert.ok(locks.every((path) => existsSync(path)));
  assert.equal(await teacherLogin(restarted.origin), 200);
  await stopCompiledHost(restarted);
  assert.equal(hostStatus(), "stopped");

  // B: a confirmed deletion fails after its content transaction committed (the backup bundle
  // cannot be removed). The host refuses readiness until exact explicit continuation.
  operations("backup create", { name: "backup-a" });
  const account = {
    kind: "account",
    key: { userId: "user:student" },
    observed: {
      kind: "version",
      version: z
        .object({ version: z.string() })
        .parse(
          query("SELECT version FROM marea_governance_accounts WHERE user_id = 'user:student'"),
        ).version,
    },
  };
  const request = (previewId: string, targets: Json[keyof Json][]) => ({
    requestId: `request:${previewId}`,
    previewId,
    policyRevision: "policy:interruption",
    targets,
  });
  const blockedPath = join(f.root, "work/blocked.json");
  operations("deletion preview", request("preview:blocked", [account]), ["--output", blockedPath]);
  const backupTarget =
    z
      .array(z.object({ target: z.json() }))
      .parse(json.parse(JSON.parse(readFileSync(blockedPath, "utf8"))).blockers)[0]?.target ?? null;
  const artifactPath = join(f.root, "work/artifact.json");
  const preview = operations(
    "deletion preview",
    request("preview:account", [account, backupTarget]),
    ["--output", artifactPath],
  );
  const bundle = join(f.root, "backups/backup-a");
  chmodSync(bundle, 0o500);
  try {
    assert.deepEqual(operations("deletion confirm", undefined, ["--input", artifactPath]), {
      operationId: "preview:account",
      requestId: "request:preview:account",
      artifactDigest: preview.artifactDigest,
      state: "uncertain",
    });
  } finally {
    chmodSync(bundle, 0o700);
  }
  const users = () => query("SELECT COUNT(*) AS total FROM marea_users WHERE id = 'user:student'");
  assert.deepEqual(users(), { total: 0n });
  assert.equal(existsSync(bundle), true);
  assert.deepEqual(operations("recovery inspect", { operationId: "preview:account" }), {
    state: "uncertain",
    operationId: "preview:account",
    checkpointState: "uncertain",
    reasonCode: "pending-checkpoint",
  });
  refusedStart(5, "index");
  assert.equal(hostStatus(), "stopped");

  const artifact = z
    .object({ expectedIndexGeneration: z.number(), artifactDigest: z.string() })
    .parse(JSON.parse(readFileSync(artifactPath, "utf8")));
  const continuation = {
    operationId: "preview:account",
    expectedIndexGeneration: artifact.expectedIndexGeneration,
    artifactDigest: artifact.artifactDigest,
  };
  const applied = {
    state: "applied",
    operationId: "preview:account",
    checkpointState: null,
    reasonCode: "applied",
  };
  assert.deepEqual(operations("recovery continue", continuation), applied);
  assert.deepEqual(operations("recovery continue", continuation), applied);
  assert.equal(existsSync(bundle), false);
  assert.deepEqual(operations("recovery inspect", {}), {
    state: "none",
    operationId: null,
    checkpointState: null,
    reasonCode: "idle",
  });
  const served = await startHost();
  assert.equal(await teacherLogin(served.origin), 200);
  await stopCompiledHost(served);
  console.log("compiled interruption rehearsal: pass");
} finally {
  chmodSync(f.root, 0o700);
  rmSync(f.root, { recursive: true, force: true });
}
