import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, cpSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

import { openSqliteDatabaseFile } from "@marea/sqlite-storage";
import { z } from "zod";

import { teacherHostInstallation } from "../src/platform/teacher-host/teacher-host.fixture.js";
import {
  compileInstallationExecutables,
  startCompiledHost,
  stopCompiledHost,
} from "./compiled-host-process.js";

// Combined GOVERNANCE/OPERATIONS acceptance on one synthetic installation served by the compiled host:
// governance seeded through `marea-admin`, browser administration, permanent deletion through
// `marea-operations` while the host is stopped, then browser and HTTP proof after restart.
const repository = resolve(import.meta.dir, "../../..");
const json = z.record(z.string(), z.json());
type Json = z.infer<typeof json>;
let binaries: ReturnType<typeof compileInstallationExecutables>;
const f = teacherHostInstallation({
  activate: false,
  teacher: false,
  readyClasses: ["class:a"],
});
const PASSWORDS = {
  admin: "synthetic-admin-password",
  teacher: "synthetic-teacher-password",
  student: "synthetic-student-password",
};

function execute(binary: string, args: string[], stdin?: string): Json {
  const result = spawnSync(binary, ["--installation", f.root, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    ...(stdin === undefined ? {} : { input: stdin }),
  });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return json.parse(JSON.parse(result.stdout));
}

function command(binary: string, name: string, payload: Json, flags: string[] = []): Json {
  const input = f.work(`${name.replace(" ", "-")}-${String(Date.now())}.json`, payload);
  return execute(binary, [...name.split(" "), "--input", input, ...flags]);
}

function version(sql: string): string {
  const file = openSqliteDatabaseFile({ databasePath: f.databasePath });
  try {
    return z.object({ version: z.string() }).parse(file.database.readOne(sql)).version;
  } finally {
    file.close();
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") reject(new Error("no port"));
        else resolvePort(address.port);
      });
    });
  });
}

function privateTree(path: string): void {
  if (statSync(path).isDirectory()) {
    chmodSync(path, 0o700);
    for (const entry of readdirSync(path)) privateTree(join(path, entry));
  } else chmodSync(path, 0o600);
}

function browserPhase(phase: "before" | "after", origin: string): void {
  const result = spawnSync(
    "node",
    ["apps/dashboard/browser/installation-lifecycle-acceptance.mjs"],
    {
      cwd: repository,
      encoding: "utf8",
      timeout: 180_000,
      env: {
        ...process.env,
        NODE_PATH: process.env.PLAYWRIGHT_NODE_PATH ?? process.env.NODE_PATH ?? "",
        OPERATIONS_ACCEPTANCE_URL: `${origin}/dashboard/index.html`,
        OPERATIONS_ACCEPTANCE_PHASE: phase,
      },
    },
  );
  assert.equal(result.status, 0, `${phase} browser phase: ${result.stdout}${result.stderr}`);
  assert.ok(result.stdout.includes(`OPERATIONS_BROWSER_${phase.toUpperCase()}_PASSED`));
}

async function post(origin: string, path: string, body: object, token?: string) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ protocolVersion: "0.1", requestId: `request:${randomUUID()}`, ...body }),
  });
  return { status: response.status, body: json.parse(await response.json()) };
}

function login(origin: string, name: string, password: string) {
  return post(origin, "/v1/auth/login", {
    kind: "credential-login",
    credentials: { login: name, password },
  });
}

try {
  const build = spawnSync("bun", ["run", "--cwd", "apps/dashboard", "build"], {
    cwd: repository,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(build.status, 0, build.stderr);
  rmSync(join(f.root, "dashboard"), { recursive: true });
  cpSync(join(repository, "apps/dashboard/dist"), join(f.root, "dashboard"), { recursive: true });
  privateTree(join(f.root, "dashboard"));
  binaries = compileInstallationExecutables(f.root);

  // Governance seeded through the compiled GOVERNANCE executable on schema 8.
  const admin = (name: string, payload: Json) => command(binaries.admin, name, payload);
  for (const [centerId, displayName] of [
    ["center:a", "North Center"],
    ["center:b", "South Center"],
  ] as const)
    admin("center create", { centerId, displayName, expectedVersion: null });
  admin("class create", {
    centerId: "center:a",
    classId: "class:a",
    displayName: "Physics",
    expectedVersion: null,
  });
  admin("class create", {
    centerId: "center:b",
    classId: "class:b",
    displayName: "Biology",
    expectedVersion: null,
  });
  for (const [userId, displayName, login, role, classId, password] of [
    ["user:admin", "Ada Admin", "admin1", "teacher", null, PASSWORDS.admin],
    ["user:teacher", "Tomas Teacher", "teacher1", "teacher", "class:a", PASSWORDS.teacher],
    ["user:student", "Sam Student", "student1", "student", "class:a", PASSWORDS.student],
  ] as const) {
    const created = admin("account create", {
      centerId: "center:a",
      userId,
      displayName,
      login,
      role,
      classId,
      expectedVersion: null,
    });
    execute(
      binaries.admin,
      [
        "credential",
        "provision",
        "--user",
        userId,
        "--expected-version",
        z.string().parse(created.version),
        "--password-stdin",
      ],
      `${password}\n`,
    );
  }
  admin("administrator grant", {
    centerId: "center:a",
    userId: "user:admin",
    expectedVersion: version(
      "SELECT version FROM marea_center_memberships WHERE center_id = 'center:a' AND user_id = 'user:admin'",
    ),
  });
  const associated = admin("account associate", {
    centerId: "center:b",
    userId: "user:admin",
    expectedVersion: null,
  });
  admin("administrator grant", {
    centerId: "center:b",
    userId: "user:admin",
    expectedVersion: associated.version ?? null,
  });

  const port = await freePort();
  const origin = `http://127.0.0.1:${String(port)}`;
  f.writeHost({
    ...f.host,
    listen: { hostname: "127.0.0.1", port },
    allowedHosts: [`127.0.0.1:${String(port)}`],
    allowedOrigins: [origin],
  });
  assert.deepEqual(execute(binaries.operations, ["deletion", "activate"]), { schemaVersion: 9 });

  const first = await startCompiledHost(binaries.host, f.root, "release:host");
  assert.equal(first.origin, origin);
  browserPhase("before", origin);
  await stopCompiledHost(first);

  // The account created in the browser is permanently deleted while no host owns the installation.
  const account = {
    kind: "account",
    key: { userId: "user:leaver" },
    observed: {
      kind: "version",
      version: version(
        "SELECT version FROM marea_governance_accounts WHERE user_id = 'user:leaver'",
      ),
    },
  };
  const artifactPath = join(f.root, "work", "leaver-artifact.json");
  const preview = command(
    binaries.operations,
    "deletion preview",
    {
      requestId: "request:leaver",
      previewId: "preview:leaver",
      policyRevision: "policy:combined",
      targets: [account],
    },
    ["--output", artifactPath],
  );
  assert.equal(preview.blockers, 0);
  assert.equal(
    execute(binaries.operations, ["deletion", "confirm", "--input", artifactPath]).state,
    "applied",
  );

  const second = await startCompiledHost(binaries.host, f.root, "release:host");
  browserPhase("after", origin);
  assert.equal((await login(origin, "leaver1", PASSWORDS.student)).status, 401);
  assert.equal((await login(origin, "teacher1", PASSWORDS.teacher)).status, 200);
  const student = await login(origin, "student1", PASSWORDS.student);
  assert.equal(student.status, 200);
  const session = z.object({ session: z.object({ token: z.string() }) }).parse(student.body);
  const bootstrap = await post(
    origin,
    "/v1/classes/bootstrap",
    { kind: "class-bootstrap" },
    session.session.token,
  );
  assert.equal(bootstrap.status, 200);
  assert.deepEqual(
    [bootstrap.body.classroom, bootstrap.body.activeRun],
    [{ displayName: "Physics" }, null],
  );
  const opened = await post(
    origin,
    "/v1/runs/open",
    {
      clientSessionId: "client:combined",
      clientVersion: "0.2.0",
      idempotencyKey: "open:combined",
      intent: { kind: "new" },
      project: { displayName: "Wave lab" },
    },
    session.session.token,
  );
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const lease = z
    .object({ lease: z.object({ token: z.string(), runId: z.string() }) })
    .parse(opened.body).lease;
  const closed = await post(origin, "/v1/runs/close", { reason: "student-exit" }, lease.token);
  assert.deepEqual(
    [closed.status, closed.body.state, closed.body.runId],
    [200, "closed", lease.runId],
  );
  await stopCompiledHost(second);
  writeFileSync(join(f.root, "work", "done"), "");
  console.log("OPERATIONS combined acceptance: pass");
} finally {
  rmSync(f.root, { recursive: true, force: true });
}
