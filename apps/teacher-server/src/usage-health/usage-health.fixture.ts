import { usageHealthTestSecurity } from "./security.fixture.js";
import { beforeEach, afterEach, vi } from "vitest";
vi.mock("bun:sqlite", () => ({
  Database: class {
    readonly mocked = true;
  },
}));
import { createProfileMigrationCatalog } from "@marea/sqlite-storage";
import { UsageQuerySchema, TeacherHealthRequestSchema } from "@marea/protocol";
import { NOW, setup } from "../../test-support/history-fixture.js";
import { USAGE_POLICY } from "../../test-support/usage-fixture.js";
import { IdentityService } from "../identity/identity-service.js";
import { SqliteIdentityRepository } from "../platform/persistence/sqlite-identity-repository.js";
import { SqliteUsageLedger } from "../platform/persistence/sqlite-usage-ledger.js";
import { SqliteUsageHealthRepository } from "../platform/persistence/sqlite-usage-health-repository.js";
import { createTeacherProductHttp } from "../product-http/teacher-product-http.boundary.js";
import { createServices, RecordingProvider } from "../product-http/product-http.fixture.js";
import { UsageHealthService } from "./service.js";

export const usageQuery = (extra: object = {}) =>
  UsageQuerySchema.parse({
    protocolVersion: "0.1",
    requestId: "usage:request",
    classId: "class:one",
    kind: "class-usage-query",
    from: "2026-09-07T00:00:00.000Z",
    until: "2026-09-08T00:00:00.000Z",
    limit: 100,
    ...extra,
  });
export const healthQuery = (extra: object = {}) =>
  TeacherHealthRequestSchema.parse({
    protocolVersion: "0.1",
    requestId: "health:request",
    classId: "class:one",
    kind: "teacher-health-read",
    ...extra,
  });
export function harness(version = 9) {
  const { database } = setup();
  // Base teaching fixtures use schema 7; apply only the synthetic target's remaining migrations.
  for (const migration of createProfileMigrationCatalog().slice(7, version))
    for (const sql of migration.statements) database.execute(sql);
  const time = { value: NOW };
  const clock = { now: () => time.value };
  const repository = new SqliteUsageHealthRepository(database);
  const service = new UsageHealthService(repository, clock);
  const ledger = new SqliteUsageLedger(database);
  const identity = new IdentityService({
    repository: new SqliteIdentityRepository(database),
    clock,
    ...usageHealthTestSecurity,
  });
  for (const user of ["t1", "t2", "s1"])
    database.execute(
      "INSERT INTO marea_auth_sessions VALUES (?1,?1,?1,?2,'2026-09-09T00:00:00.000Z',NULL)",
      [user, NOW],
    );
  const app = (composed = true) =>
    createTeacherProductHttp({
      allowedHosts: ["teacher.test"],
      allowedOrigins: ["https://teacher.test"],
      serverVersion: "0.0.0",
      services: {
        ...createServices(new RecordingProvider()),
        identity,
        ...(composed ? { usageHealth: service } : {}),
      },
    });
  function attempt(
    id: string,
    runId = "run:a",
    purpose: "tutoring" | "evaluation" = "tutoring",
    now = NOW,
  ) {
    ledger.configure({ runId, purpose }, USAGE_POLICY, now);
    ledger.reserve({ runId, purpose, reservationId: id, requestId: id, attempt: 1, now });
  }
  return { database, service, repository, ledger, time, app, attempt, identity };
}
export function http(
  body: object | BodyInit,
  path = "usage/query",
  headers: Record<string, string> = {},
) {
  return new Request(`https://teacher.test/api/v1/dashboard/${path}`, {
    method: "POST",
    body:
      typeof body === "object" && !(body instanceof ReadableStream) && !(body instanceof Uint8Array)
        ? JSON.stringify(body)
        : (body as BodyInit),
    headers: {
      host: "teacher.test",
      origin: "https://teacher.test",
      cookie: "marea_teacher_session=t1",
      "content-type": "application/json",
      ...headers,
    },
    duplex: "half",
  } as RequestInit);
}

export function useUsageHealthHarness() {
  let current: ReturnType<typeof harness>;
  beforeEach(() => {
    current = harness();
  });
  afterEach(() => {
    current.database.close();
  });
  return () => current;
}
