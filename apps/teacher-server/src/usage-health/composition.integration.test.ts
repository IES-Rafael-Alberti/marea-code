import { usageHealthTestSecurity } from "./security.fixture.js";
import { expect, it } from "vitest";
import { UsageResponseSchema, TeacherHealthResponseSchema } from "@marea/protocol";
import { NOW } from "../../test-support/history-fixture.js";
import { withoutDeletionAuthority } from "../platform/persistence/identity-creation-guard.js";
import { composeTeacherServices } from "../platform/teacher-host/teacher-services.js";
import { createTeacherProductHttp } from "../product-http/teacher-product-http.boundary.js";
import { MemorySkillSource } from "../teaching/configuration/dashboard-module.fixture.js";
import { useUsageHealthHarness, http, usageQuery, healthQuery } from "./usage-health.fixture.js";
const current = useUsageHealthHarness();
it("mounts the projections through production service and HTTP composition without telemetry or profiles", async () => {
  const h = current();
  h.attempt("production-composition");
  const composed = await composeTeacherServices({
    database: h.database,
    clock: { now: () => NOW },
    ...usageHealthTestSecurity,
    operator: { forClass: () => null },
    skills: {
      core: new MemorySkillSource([]),
      centers: new Map(),
      teachers: new Map(),
      operatorPersonalOwnerForClass: new Map(),
    },
    providers: {
      resolve: () => {
        throw new Error("No inference permitted");
      },
    },
    retry: { wait: () => Promise.resolve() },
    identities: withoutDeletionAuthority(),
    evaluationIntervalMs: 60000,
    onEvaluationError: () => undefined,
  });
  const server = createTeacherProductHttp({
    allowedHosts: ["teacher.test"],
    allowedOrigins: ["https://teacher.test"],
    serverVersion: "0.0.0",
    services: composed.services,
  });
  const usage = await server.fetch(http(usageQuery()));
  expect(usage.status).toBe(200);
  expect(UsageResponseSchema.parse(await usage.json()).entries[0]?.attemptId).toBe(
    "production-composition",
  );
  const health = await server.fetch(http(healthQuery(), "health/read"));
  expect(health.status).toBe(200);
  expect(TeacherHealthResponseSchema.parse(await health.json()).telemetryDelivery.status).toBe(
    "unknown",
  );
  await composed.evaluations.stop();
});
