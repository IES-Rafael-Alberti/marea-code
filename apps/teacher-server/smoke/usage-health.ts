import { usageHealthTestSecurity } from "../src/usage-health/security.fixture.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeSqliteStorage, inspectSqliteSchemaVersion } from "@marea/sqlite-storage";
import {
  UsageQuerySchema,
  UsageResponseSchema,
  TeacherHealthRequestSchema,
  TeacherHealthResponseSchema,
} from "@marea/protocol";
import { SqliteUsageHealthRepository } from "../src/platform/persistence/sqlite-usage-health-repository.js";
import { SqliteUsageLedger } from "../src/platform/persistence/sqlite-usage-ledger.js";
import { SqliteIdentityRepository } from "../src/platform/persistence/sqlite-identity-repository.js";
import { IdentityService } from "../src/identity/identity-service.js";
import { UsageHealthService } from "../src/usage-health/service.js";
import { createTeacherProductHttp } from "../src/product-http/teacher-product-http.boundary.js";
import { createServices, RecordingProvider } from "../src/product-http/product-http.fixture.js";
import { USAGE_POLICY } from "../test-support/usage-fixture.js";

const now = "2026-09-22T12:00:00.000Z";
const root = mkdtempSync(join(tmpdir(), "marea-usage-health-"));
try {
  for (const schema of ["retention-audit", "dashboard-profiles"] as const) {
    const databasePath = join(root, `${schema}.sqlite`);
    const storage = initializeSqliteStorage({ databasePath, schema });
    try {
      const database = storage.database;
      const version = inspectSqliteSchemaVersion({ databasePath });
      assert.equal(version, schema === "retention-audit" ? 9 : 10);
      database.execute("INSERT INTO marea_classes VALUES ('class','seed','Synthetic')");
      database.execute(
        "INSERT INTO marea_users VALUES ('teacher','teacher','synthetic','teacher','Teacher',NULL), ('student','student','synthetic','student','Student','class')",
      );
      database.execute("INSERT INTO marea_teacher_classes VALUES ('teacher','class')");
      database.execute(
        "INSERT INTO marea_auth_sessions VALUES ('session','teacher','synthetic-token',?1,'2026-09-23T00:00:00.000Z',NULL)",
        [now],
      );
      database.execute("INSERT INTO marea_run_snapshots VALUES ('snapshot','{}','{}',?1)", [now]);
      database.execute(
        "INSERT INTO marea_runs VALUES ('run','student','class','snapshot','client','Synthetic','closed',?1,?1,'student-requested')",
        [now],
      );
      const ledger = new SqliteUsageLedger(database);
      ledger.configure({ runId: "run", purpose: "tutoring" }, USAGE_POLICY, now);
      ledger.reserve({
        runId: "run",
        purpose: "tutoring",
        reservationId: "attempt",
        requestId: "request",
        attempt: 1,
        now,
      });
      ledger.settle("attempt", { inputTokens: 2, outputTokens: 3 }, now);
      const clock = { now: () => now };
      const identity = new IdentityService({
        repository: new SqliteIdentityRepository(database),
        clock,
        ...usageHealthTestSecurity,
      });
      const server = createTeacherProductHttp({
        allowedHosts: ["teacher.test"],
        allowedOrigins: ["https://teacher.test"],
        serverVersion: "0.0.0",
        services: {
          ...createServices(new RecordingProvider()),
          identity,
          usageHealth: new UsageHealthService(new SqliteUsageHealthRepository(database), clock),
        },
      });
      const send = (path: string, body: object) =>
        server.fetch(
          new Request(`https://teacher.test/api/v1/dashboard/${path}`, {
            method: "POST",
            headers: {
              host: "teacher.test",
              origin: "https://teacher.test",
              cookie: "marea_teacher_session=synthetic-token",
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }),
        );
      const query = UsageQuerySchema.parse({
        protocolVersion: "0.1",
        requestId: "r",
        classId: "class",
        kind: "class-usage-query",
        from: "2026-09-22T00:00:00Z",
        until: "2026-09-23T00:00:00Z",
        limit: 1,
      });
      const usage = await send("usage/query", query);
      assert.equal(usage.status, 200);
      assert.deepEqual(UsageResponseSchema.parse(await usage.json()).entries[0]?.cost, {
        status: "priced",
        unit: "synthetic-unit",
        units: 13,
      });
      const health = await send(
        "health/read",
        TeacherHealthRequestSchema.parse({
          protocolVersion: "0.1",
          requestId: "h",
          classId: "class",
          kind: "teacher-health-read",
        }),
      );
      assert.equal(health.status, 200);
      assert.equal(
        TeacherHealthResponseSchema.parse(await health.json()).telemetryDelivery.status,
        "unknown",
      );
      database.execute("DELETE FROM marea_teacher_classes");
      assert.equal((await send("usage/query", query)).status, 403);
      assert.equal(inspectSqliteSchemaVersion({ databasePath }), version);
    } finally {
      storage.close();
    }
  }
  console.log("Usage/health native SQLite HTTP smoke passed on schema 9 and 10.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
