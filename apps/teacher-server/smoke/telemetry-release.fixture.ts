/** Runs only in a compiled synthetic acceptance binary; uses the production private resolver. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { initializeSqliteStorage } from "@marea/sqlite-storage";
import { CredentialLoginResponseSchema, TelemetryPreviewResponseSchema } from "@marea/protocol";
import { telemetryExporterCatalog } from "@marea/plugin-runtime";
import {
  teacherHostInstallation,
  cleanupTeacherHostInstallations,
} from "../src/platform/teacher-host/teacher-host.fixture.js";
import { startTeacherHost } from "../src/platform/teacher-host/teacher-host.js";
import { bunServe } from "../src/platform/teacher-host/bun-serve.boundary.js";
import { SqliteTeachingConfigurationRepository } from "../src/platform/persistence/sqlite-teaching-configuration-repository.js";
import { teachingConfiguration } from "../test-support/teaching-fixture.js";
import { openRequest } from "../src/product-http/product-http.fixture.js";

const certificate = readFileSync(String(process.argv[2]));
const key = readFileSync(String(process.argv[3]));
assert.deepEqual(
  telemetryExporterCatalog.map((entry) => entry.implementation?.destination),
  ["langfuse", "otlp"],
);

async function journey(mode: "both" | "disabled" | "missing" | "failure" | "timeout") {
  const received: { path: string; body: string; authorization: string | null }[] = [];
  const collector = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: certificate, key },
    async fetch(request) {
      const path = new URL(request.url).pathname;
      received.push({
        path,
        body: await request.text(),
        authorization: request.headers.get("authorization"),
      });
      if (path.includes("traces"))
        assert.equal(request.headers.get("x-langfuse-ingestion-version"), "4");
      if (path.includes("metrics") && mode === "timeout") {
        await new Promise<void>((done) => {
          setTimeout(done, 1000);
        });
      }
      return Response.json(
        {},
        { status: path.includes("metrics") && mode === "failure" ? 503 : 200 },
      );
    },
  });
  const f = teacherHostInstallation({ readyClasses: ["class:one"] });
  const store = initializeSqliteStorage({
    databasePath: f.databasePath,
    schema: "dashboard-profiles",
  });
  store.database.execute("INSERT INTO marea_classes VALUES (?1, ?2, ?3)", [
    "class:one",
    "one",
    "Synthetic class",
  ]);
  store.database.execute("INSERT INTO marea_teacher_classes VALUES (?1, ?2)", [
    "user:teacher",
    "class:one",
  ]);
  store.database.execute(
    "INSERT INTO marea_users (id, login, password_hash, role, display_name, class_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    [
      "private-student",
      "student",
      "hash:student-password",
      "student",
      "Private Learner",
      "class:one",
    ],
  );
  new SqliteTeachingConfigurationRepository(store.database).saveRevision({
    classId: "class:one",
    teacherId: "user:teacher",
    createdAt: "2026-09-22T00:00:00.000Z",
    expectedVersion: null,
    configuration: teachingConfiguration("free"),
  });
  store.close();
  cpSync(resolve("../../apps/dashboard/dist"), f.host.dashboardDistPath, { recursive: true });
  const endpoint = `https://127.0.0.1:${String(collector.port)}`;
  const secret = (name: string, value: object) => {
    writeFileSync(join(f.root, "config", `telemetry-${name}.json`), JSON.stringify(value), {
      mode: 0o600,
    });
  };
  if (mode !== "missing" && mode !== "disabled")
    secret("otlp", { endpoint, headers: { authorization: "Bearer synthetic-otlp-secret" } });
  if (mode !== "disabled")
    secret("langfuse", { endpoint, publicKey: "synthetic-public", secretKey: "synthetic-secret" });
  f.writeHost({
    ...f.host,
    listen: { hostname: "127.0.0.1", port: 5197 },
    allowedHosts: ["teacher.test", "127.0.0.1:5197"],
    allowedOrigins: ["https://dashboard.test", "http://127.0.0.1:5197"],
    telemetry: {
      enabled: mode !== "disabled",
      startupTimeoutMs: 1000,
      maxInFlight: 2,
      exporters: ["otlp", "langfuse"].map((destination) => ({
        destination,
        schemaVersion: "1.0",
        operationTimeoutMs: mode === "timeout" ? 100 : 1000,
        maxRequestBytes: 262144,
        maxResponseBytes: 65536,
      })),
    },
  });
  const host = await startTeacherHost({
    installationRoot: f.root,
    releaseId: "release:host",
    passwords: {
      hash: (value) => Promise.resolve(`hash:${value}`),
      verify: (value, hash) => Promise.resolve(hash === `hash:${value}`),
    },
    serve: bunServe,
    onEvaluationError: () => {
      throw new Error("Unexpected inference");
    },
  });
  if (host.state !== "ready") throw new Error(host.reason);
  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    fetch(`${host.url}${path}`, {
      method: "POST",
      headers: { host: "teacher.test", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const login = (username: string) =>
    post("/v1/auth/login", {
      protocolVersion: "0.1",
      requestId: "request:login",
      kind: "credential-login",
      credentials: { login: username, password: `${username}-password` },
    });
  try {
    const teacher = await login("teacher");
    assert.equal(teacher.status, 200);
    const cookie = String(teacher.headers.get("set-cookie")).split(";")[0] ?? "";
    const preview = async (classId = "class:one") =>
      post(
        "/api/v1/dashboard/telemetry/preview",
        {
          protocolVersion: "0.1",
          requestId: "preview:release",
          kind: "telemetry-preview",
          classId,
        },
        { cookie, origin: "https://dashboard.test" },
      );
    const before = TelemetryPreviewResponseSchema.parse(await (await preview()).json());
    assert.equal(before.enabled, mode !== "disabled");
    assert.equal(before.destinationCount, mode === "disabled" ? 0 : mode === "missing" ? 1 : 2);
    assert.equal((await preview("class:foreign")).status, 403);
    assert.equal(received.length, 0);
    if (mode === "both" && process.env.PLAYWRIGHT_PACKAGE) {
      await new Promise<void>((done, reject) => {
        const child = spawn(
          "node",
          [resolve("../dashboard/browser/enabled-telemetry.mjs"), host.url],
          { stdio: "inherit" },
        );
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) done();
          else reject(new Error("Enabled browser failed"));
        });
      });
      assert.equal(received.length, 0);
    }
    const student = CredentialLoginResponseSchema.parse(await (await login("student")).json());
    const run = await post("/v1/runs/open", openRequest, {
      authorization: `Bearer ${student.session.token}`,
    });
    assert.equal(run.status, 201);
    await run.arrayBuffer();
    assert.equal(received.length, before.destinationCount);
    for (const item of received) {
      assert.doesNotMatch(
        item.body,
        /private-student|Private Learner|class:one|user:teacher|client:one|request:open|synthetic-secret|synthetic-public|synthetic-otlp-secret/,
      );
      assert.match(item.body, /operation.duration-ms/);
      assert.match(item.body, /operation.succeeded/);
      if (item.path === "/v1/metrics") {
        assert.equal(item.authorization, "Bearer synthetic-otlp-secret");
        assert.match(item.body, /resourceMetrics/);
      } else {
        assert.equal(item.path, "/api/public/otel/v1/traces");
        assert.equal(item.authorization, `Basic ${btoa("synthetic-public:synthetic-secret")}`);
        assert.match(item.body, /langfuse.observation.metadata.marea/);
      }
    }
    const after = TelemetryPreviewResponseSchema.parse(await (await preview()).json());
    assert.equal(after.destinationCount, before.destinationCount);
    assert.equal(received.length, before.destinationCount);
    assert.doesNotMatch(
      JSON.stringify(after) + readFileSync(f.host.statusPath, "utf8"),
      /synthetic-secret|synthetic-public|synthetic-otlp-secret/,
    );
  } finally {
    assert.equal((await host.stop()).state, "stopped");
    await collector.stop(true);
    cleanupTeacherHostInstallations();
  }
  console.log(`Compiled generated exporters + private HTTPS resolver: ${mode} passed.`);
}
for (const mode of ["both", "disabled", "missing", "failure", "timeout"] as const)
  await journey(mode);
