import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { initializeSqliteStorage } from "@marea/sqlite-storage";
import { SqliteIdentityRepository } from "../src/platform/persistence/sqlite-identity-repository.js";
import { verifyCompiledBoundaries } from "./operator-cli-boundaries.fixture.js";
import { verifyCompiledExchange } from "./operator-cli-exchange.fixture.js";
import { readOperatorRows } from "./operator-cli-database.fixture.js";
import {
  installationFixture,
  skillMarkdown,
} from "../src/platform/operator-cli/installation.fixture.js";

const json = z.record(z.string(), z.json());
type Json = z.infer<typeof json>;
const f = installationFixture();
const policyDocument = json.parse(f.document);
const binary = join(f.root, "marea-admin");
const lock = join(f.root, "locks/installation.lock");
const complete = new Set<string>();
const text = (value: Json, key: string) => z.string().min(1).parse(value[key]);
const read = (sql: string) => readOperatorRows(f.databasePath, sql);
const execute = (sql: string) => {
  const storage = initializeSqliteStorage({ databasePath: f.databasePath });
  try {
    // Statements are fixed synthetic fixture SQL, never user input.
    for (const statement of sql.split(";"))
      if (statement.trim()) storage.database.execute(statement);
  } finally {
    storage.close();
  }
};
const identity = () => {
  const storage = initializeSqliteStorage({ databasePath: f.databasePath });
  try {
    const repository = new SqliteIdentityRepository(storage.database);
    return {
      credential: repository.findCredential("teacher"),
      session: repository.resolveSession("private-token", new Date().toISOString()),
    };
  } finally {
    storage.close();
  }
};
const snapshot = () =>
  [
    "marea_centers",
    "marea_users",
    "marea_classes",
    "marea_teacher_classes",
    "marea_auth_sessions",
    "marea_governance_accounts",
    "marea_governance_classes",
    "marea_governance_memberships",
    "marea_center_memberships",
    "marea_governance_audit",
    "marea_class_teaching_revisions",
    "marea_class_exchange_previews",
    "marea_run_snapshots",
    "marea_runs",
    "marea_run_leases",
  ].map((table) => read("SELECT * FROM " + table));
const diagnostics = new Map([
  [2, "Invalid command or input.\n"],
  [3, "Installation is busy or its authority is unavailable.\n"],
  [4, "Operator command conflicts with the current state.\n"],
  [5, "Operator prerequisites are unavailable.\n"],
  [6, "Operator command failed or its outcome is uncertain.\n"],
]);
function run(name: string, flags: string[], status = 0, input = ""): Json {
  const result = spawnSync(binary, ["--installation", f.root, ...name.split(" "), ...flags], {
    cwd: f.root,
    input,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 2_000_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, status, name + ": " + result.stderr);
  assert.equal(result.stderr, status === 0 ? "" : diagnostics.get(status));
  assert.equal(existsSync(lock), false);
  if (status !== 0) {
    assert.equal(result.stdout, "");
    return {};
  }
  assert.ok(result.stdout.endsWith("\n"));
  assert.ok(!result.stdout.includes(f.root));
  assert.ok(!result.stdout.includes("password"));
  complete.add(name);
  return json.parse(JSON.parse(result.stdout));
}
function invoke(name: string, payload: Json, options: string[] = [], status = 0) {
  return run(name, ["--input", f.work("request.json", payload), ...options], status);
}
function fails(name: string, payload: Json, options: string[] = [], status = 2) {
  const before = snapshot();
  invoke(name, payload, options, status);
  assert.deepEqual(snapshot(), before, name + " must be atomic on rejection");
}
const scope = { centerId: "center:a" };
const account = { ...scope, userId: "user:teacher" };
const target = { ...scope, classId: "class:ready" };
try {
  const build = spawnSync("bun", ["build", "cli-entry.ts", "--compile", "--outfile", binary], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(build.status, 0, build.stderr);
  chmodSync(binary, 0o700);
  const center = invoke("center create", {
    ...scope,
    displayName: "Center A",
    expectedVersion: null,
  });
  assert.deepEqual(Object.keys(center).sort(), ["centerId", "displayName", "version"]);
  invoke("center rename", {
    ...scope,
    displayName: "Renamed A",
    expectedVersion: text(center, "version"),
  });
  invoke("center create", { centerId: "center:b", displayName: "B", expectedVersion: null });
  const teacher = invoke("account create", {
    ...account,
    displayName: "Teacher",
    login: "teacher",
    role: "teacher",
    classId: null,
    expectedVersion: null,
  });
  assert.equal(teacher.state, "pending");
  assert.equal(identity().credential, undefined);
  const credentialFlags = [
    "--user",
    "user:teacher",
    "--expected-version",
    text(teacher, "version"),
    "--password-stdin",
  ];
  const credential = run(
    "credential provision",
    credentialFlags,
    0,
    "synthetic-private-password\n",
  );
  const user = read("SELECT password_hash FROM marea_users WHERE id = 'user:teacher'")[0];
  assert.ok(user);
  assert.equal(
    await Bun.password.verify("synthetic-private-password", text(user, "password_hash")),
    true,
  );
  assert.equal(
    read("SELECT state FROM marea_governance_accounts WHERE user_id = 'user:teacher'")[0]?.state,
    "active",
  );
  assert.equal(identity().credential?.passwordHash, text(user, "password_hash"));
  const association = invoke("account associate", {
    centerId: "center:b",
    userId: "user:teacher",
    expectedVersion: null,
  });
  const grant = invoke("administrator grant", {
    centerId: "center:b",
    userId: "user:teacher",
    expectedVersion: text(association, "version"),
  });
  const revoke = invoke("administrator revoke", {
    centerId: "center:b",
    userId: "user:teacher",
    expectedVersion: text(grant, "version"),
  });
  assert.equal(revoke.capability, "member");
  const renamed = invoke("account rename", {
    ...account,
    displayName: "Renamed teacher",
    expectedVersion: text(credential, "version"),
  });
  const active = invoke("account state", {
    ...account,
    state: "active",
    expectedVersion: text(renamed, "version"),
  });
  const classroom = invoke("class create", {
    ...target,
    displayName: "Ready",
    expectedVersion: null,
  });
  assert.equal(classroom.operatorReady, true);
  invoke("class rename", {
    ...target,
    displayName: "Renamed class",
    expectedVersion: text(classroom, "version"),
  });
  const member = invoke("membership change", {
    ...target,
    userId: "user:teacher",
    state: "active",
    expectedVersion: null,
  });
  assert.equal(member.role, "teacher");
  const student = invoke("account create", {
    ...scope,
    userId: "user:student",
    displayName: "Student",
    login: "student",
    role: "student",
    classId: "class:ready",
    expectedVersion: null,
  });
  const provisionedStudent = run(
    "credential provision",
    ["--user", "user:student", "--expected-version", text(student, "version"), "--password-stdin"],
    0,
    "synthetic-student-password\n",
  );
  execute(
    "INSERT INTO marea_auth_sessions VALUES ('session:synthetic','user:teacher','private-token','2026-09-12T09:00:00.000Z','2099-09-12T12:00:00.000Z',NULL);" +
      "INSERT INTO marea_run_snapshots VALUES ('snapshot:history','{\"private\":\"frozen teaching\"}','{\"private\":\"frozen route\"}','2026-09-12T09:00:00.000Z');" +
      "INSERT INTO marea_runs VALUES ('run:history','user:student','class:ready','snapshot:history','client:history','Historical','closed','2026-09-12T09:00:00.000Z','2026-09-12T09:01:00.000Z','student-requested');" +
      "INSERT INTO marea_runs VALUES ('run:active','user:student','class:ready','snapshot:history','client:active','Active','active','2026-09-12T09:00:00.000Z',NULL,NULL);" +
      "INSERT INTO marea_run_leases VALUES ('lease:synthetic','run:active','user:student','private-lease','2026-09-12T09:00:00.000Z','2099-09-12T12:00:00.000Z',NULL);",
  );
  const history = read("SELECT * FROM marea_run_snapshots");
  assert.equal(identity().session?.userId, "user:teacher");
  invoke("sessions revoke", { ...account, expectedVersion: text(active, "version") });
  assert.equal(identity().session, undefined);
  invoke("sessions revoke", {
    ...scope,
    userId: "user:student",
    expectedVersion: text(provisionedStudent, "version"),
  });
  assert.equal(typeof read("SELECT revoked_at FROM marea_auth_sessions")[0]?.revoked_at, "string");
  assert.equal(typeof read("SELECT revoked_at FROM marea_run_leases")[0]?.revoked_at, "string");
  const exchange = {
    format: "marea-class-exchange:1",
    source: { displayName: "Source" },
    agentMode: "free",
    classInstructions: { tutoring: "Imported tutoring", free: "Imported free" },
    selection: { didactic: [], evaluation: [] },
  };
  const preview = invoke("class import-preview", {
    ...target,
    expectedTeachingVersion: null,
    package: exchange,
  });
  const imported = invoke("class import-confirm", {
    ...target,
    previewId: text(preview, "previewId"),
  });
  fails("class import-confirm", { ...target, previewId: text(preview, "previewId") }, [], 4);
  const output = join(f.root, "work/export.json");
  invoke(
    "class export",
    { ...target, expectedTeachingVersion: text(imported, "teachingVersion") },
    ["--output", output],
  );
  assert.deepEqual(
    json.parse(JSON.parse(readFileSync(output, "utf8"))).classInstructions,
    exchange.classInstructions,
  );
  assert.equal(statSync(output).mode & 0o777, 0o600);
  assert.deepEqual(read("SELECT authority, created_by FROM marea_class_teaching_revisions"), [
    { authority: "operator", created_by: null },
  ]);
  const next = invoke("class import-preview", {
    ...target,
    expectedTeachingVersion: text(imported, "teachingVersion"),
    package: exchange,
  });
  invoke("class import-cancel", { ...target, previewId: text(next, "previewId") });
  fails("class import-confirm", { ...target, previewId: text(next, "previewId") }, [], 4);
  const policyBytes = readFileSync(f.operatorPolicyPath);
  invoke("policy validate", { document: policyDocument });
  const published = join(f.root, "work/policy.json");
  invoke("policy publish", { document: policyDocument }, ["--output", published]);
  assert.deepEqual(readFileSync(f.operatorPolicyPath), policyBytes);
  assert.deepEqual(json.parse(JSON.parse(readFileSync(published, "utf8"))), f.document);
  for (const owner of [
    { source: "teacher", id: "user:teacher" },
    { source: "center", id: "center:a" },
  ]) {
    const request = {
      kind: "didactic",
      slug: "example",
      files: [{ path: "SKILL.md", content: skillMarkdown("example") }],
    };
    invoke("skill validate", { owner, request });
    const skill = invoke("skill save", { owner, request: { ...request, expectedDigest: null } });
    const listing = invoke("skill list", { owner, kind: "didactic" });
    assert.deepEqual(listing.skills, [skill]);
    const path = join(f.root, "work/" + owner.source + "-skill.json");
    invoke("skill read", { owner, skillId: text(skill, "id") }, ["--output", path]);
    assert.equal(json.parse(JSON.parse(readFileSync(path, "utf8"))).digest, skill.digest);
    fails("skill save", { owner, request: { ...request, expectedDigest: null } }, [], 4);
  }
  assert.deepEqual(read("SELECT * FROM marea_run_snapshots"), history);
  verifyCompiledExchange(f, invoke, fails, read, text(imported, "teachingVersion"));
  execute(
    "INSERT INTO marea_classes VALUES ('legacy:a','legacy-seed:a','Legacy A');" +
      "INSERT INTO marea_users VALUES ('legacy:teacher','legacy-teacher','original-hash','teacher','Legacy teacher','legacy:a');" +
      "INSERT INTO marea_teacher_classes VALUES ('legacy:teacher','legacy:a');",
  );
  const map = {
    classes: [{ classId: "legacy:a", centerId: "center:a" }],
    accounts: [{ userId: "legacy:teacher", ownerCenterId: "center:a" }],
    administrators: [{ userId: "legacy:teacher", centerId: "center:a" }],
  };
  const beforeAdoption = snapshot();
  const partial = { ...map, accounts: [], administrators: [] };
  const incomplete = invoke("adoption preview", { map: partial });
  assert.equal(incomplete.missingUsers, 1);
  fails("adoption confirm", { map: partial }, ["--digest", text(incomplete, "digest")], 4);
  const adoption = invoke("adoption preview", { map });
  assert.deepEqual(snapshot(), beforeAdoption);
  assert.deepEqual(
    { ...adoption, digest: "redacted" },
    {
      digest: "redacted",
      classes: 1,
      accounts: 1,
      memberships: 1,
      missingClasses: 0,
      missingUsers: 0,
    },
  );
  invoke("adoption confirm", { map }, ["--digest", text(adoption, "digest")]);
  assert.deepEqual(snapshot().slice(0, 4), beforeAdoption.slice(0, 4));
  fails("adoption confirm", { map }, ["--digest", text(adoption, "digest")], 4);
  const adopted = snapshot();
  const fresh = invoke("adoption preview", { map });
  invoke("adoption confirm", { map }, ["--digest", text(fresh, "digest")]);
  assert.deepEqual(snapshot(), adopted);
  assert.equal(complete.size, 25, [...complete].join(", "));
  for (const name of complete) {
    if (name === "credential provision") {
      const before = snapshot();
      run(name, credentialFlags, 2, "short\n");
      assert.deepEqual(snapshot(), before);
      continue;
    }
    const flags = ["class export", "skill read", "policy publish"].includes(name)
      ? ["--output", join(f.root, "work/rejected.json")]
      : name === "adoption confirm"
        ? ["--digest", text(fresh, "digest")]
        : [];
    fails(name, { unexpected: "private-untrusted" }, flags);
  }
  fails("policy publish", { document: policyDocument }, ["--output", published]);
  for (const suffix of ["-wal", "-shm", "-journal"])
    fails("policy publish", { document: policyDocument }, ["--output", f.databasePath + suffix]);
  fails(
    "center rename",
    { ...scope, displayName: "Stale", expectedVersion: text(center, "version") },
    [],
    4,
  );
  await verifyCompiledBoundaries(f, binary, snapshot);
  console.log(
    "compiled operator CLI: all 25 real commands, negative matrix, SQLite invariants and immutable artifacts passed",
  );
} finally {
  rmSync(f.root, { recursive: true, force: true });
}
