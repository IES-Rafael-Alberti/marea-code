import { assertCompiledTelemetryPreview } from "./telemetry-preview-acceptance.js";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { initializeSqliteStorage } from "@marea/sqlite-storage";

import { teacherHostInstallation } from "../src/platform/teacher-host/teacher-host.fixture.js";
import { compileExecutable } from "./compile-executable.js";

const f = teacherHostInstallation({ activate: false });
const binaries = {
  host: join(f.root, "marea-teacher"),
  operations: join(f.root, "marea-operations"),
};

function operations(group: string, action: string, payload: object, status = 0): void {
  const result = spawnSync(
    binaries.operations,
    ["--installation", f.root, group, action, "--input", f.work(`${action}.json`, payload)],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(result.status, status, result.stderr);
}

try {
  compileExecutable("teacher-host-entry.ts", binaries.host);
  compileExecutable("operations-entry.ts", binaries.operations);
  const storage = initializeSqliteStorage({ databasePath: f.databasePath });
  try {
    storage.database.execute(
      "UPDATE marea_users SET password_hash = ?1 WHERE id = 'user:teacher'",
      [await Bun.password.hash("teacher-password", { algorithm: "argon2id" })],
    );
    storage.database.execute(
      "INSERT INTO marea_classes (id, seed_key, display_name) VALUES ('class:ready', 'ready', 'Synthetic class')",
    );
    storage.database.execute(
      "INSERT INTO marea_teacher_classes (teacher_id, class_id) VALUES ('user:teacher', 'class:ready')",
    );
  } finally {
    storage.close();
  }
  f.writeHost({ ...f.host, allowedHosts: ["127.0.0.1"], allowedOrigins: ["http://127.0.0.1"] });

  const refused = spawnSync(
    binaries.host,
    ["--installation", f.root, "--release", "release:host"],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(refused.status, 5, refused.stderr);
  assert.equal(refused.stderr, "Teacher host did not start: config.\n");
  const activate = spawnSync(
    binaries.operations,
    ["--installation", f.root, "deletion", "activate"],
    {
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  assert.equal(activate.status, 0, activate.stderr);

  const child = spawn(binaries.host, ["--installation", f.root, "--release", "release:host"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      resolve(code);
    });
  });
  const deadline = Date.now() + 30_000;
  while (!stdout.includes("Teacher host ready at ") && Date.now() < deadline) await Bun.sleep(50);
  const origin = /Teacher host ready at (http:\/\/127\.0\.0\.1:\d+)/u.exec(stdout)?.[1];
  assert.ok(origin, `host did not report readiness: ${stderr}`);
  const port = new URL(origin).port;

  const login = await fetch(`${origin}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1" },
    body: JSON.stringify({
      credentials: { login: "teacher", password: "teacher-password" },
      kind: "credential-login",
      protocolVersion: "0.1",
      requestId: "request:compiled-login",
    }),
  });
  assert.equal(login.status, 200, await login.clone().text());
  await assertCompiledTelemetryPreview(
    origin,
    String(login.headers.get("set-cookie")).split(";")[0] ?? "",
  );
  const dashboard = await fetch(`${origin}/dashboard`, { headers: { host: "127.0.0.1" } });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Marea/u);
  assert.match(readFileSync(f.host.statusPath, "utf8"), /"status":"ready"/u);
  operations("recovery", "inspect", {}, 3);

  child.kill("SIGTERM");
  assert.equal(await exited, 0, stderr);
  assert.ok(stdout.endsWith("Teacher host stopped.\n"));
  assert.match(readFileSync(f.host.statusPath, "utf8"), /"status":"stopped"/u);
  operations("recovery", "inspect", {});
  const unreachable = await fetch(`http://127.0.0.1:${port}/dashboard`).catch(() => null);
  assert.equal(unreachable, null);

  // A port already in use is a reported start failure that leaves the installation unlocked.
  const occupant = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("busy") });
  try {
    f.writeHost({
      ...f.host,
      listen: { hostname: "127.0.0.1", port: occupant.port },
      allowedHosts: ["127.0.0.1"],
      allowedOrigins: ["http://127.0.0.1"],
    });
    const taken = spawnSync(
      binaries.host,
      ["--installation", f.root, "--release", "release:host"],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.equal(taken.status, 5, taken.stderr);
    assert.equal(taken.stderr, "Teacher host did not start: listen.\n");
    assert.match(readFileSync(f.host.statusPath, "utf8"), /"status":"stopped"/u);
    operations("recovery", "inspect", {});
  } finally {
    await occupant.stop(true);
  }
  console.log("compiled teacher host rehearsal: pass");
} finally {
  rmSync(f.root, { recursive: true, force: true });
}
