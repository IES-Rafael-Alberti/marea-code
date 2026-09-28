import { expect, it } from "vitest";
import {
  UsageQuerySchema,
  TeacherHealthRequestSchema,
  UsageCostSchema,
  TeacherHealthResponseSchema,
} from "./usage-health.js";
const query = {
  protocolVersion: "0.1",
  requestId: "request:usage",
  classId: "class:one",
  kind: "class-usage-query",
  from: "2026-09-01T00:00:00Z",
  until: "2026-10-02T00:00:00Z",
  limit: 100,
};
it("freezes strict bounded dates, counts, identifiers and version without locale assumptions", () => {
  expect(UsageQuerySchema.parse(query).limit).toBe(100);
  for (const changes of [
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { until: query.from },
    { until: "2026-08-01T00:00:00Z" },
    { until: "2026-10-02T00:00:00.001Z" },
    { protocolVersion: "2.0" },
    { from: "invalid" },
    { afterAttemptId: "../secret" },
    { classId: "" },
    { teacherId: "forged" },
  ])
    expect(UsageQuerySchema.safeParse({ ...query, ...changes }).success).toBe(false);
  expect(UsageQuerySchema.safeParse({ ...query, limit: 1, afterAttemptId: "a" }).success).toBe(
    true,
  );
  expect(
    TeacherHealthRequestSchema.safeParse({
      protocolVersion: "0.1",
      requestId: "r",
      classId: "c",
      kind: "teacher-health-read",
      locale: "eu",
    }).success,
  ).toBe(false);
});
it("requires explicit absent pricing and forbids evidence-free health claims", () => {
  expect(UsageCostSchema.parse({ status: "unavailable" })).toEqual({ status: "unavailable" });
  for (const value of [
    { status: "unavailable", units: 0 },
    { status: "priced", unit: "USD", units: -1 },
    { status: "priced", unit: "private/path", units: 1 },
  ])
    expect(UsageCostSchema.safeParse(value).success).toBe(false);
  const unknown = { status: "unknown", observedAt: null };
  const health = {
    protocolVersion: "0.1",
    requestId: "r",
    classId: "c",
    kind: "teacher-health-result",
    generatedAt: query.from,
    freshnessMs: 300000,
    storage: unknown,
    usageLedger: unknown,
    inference: unknown,
    telemetryDelivery: unknown,
  };
  expect(TeacherHealthResponseSchema.parse(health)).toEqual(health);
  expect(
    TeacherHealthResponseSchema.safeParse({
      ...health,
      storage: { status: "available", observedAt: null },
    }).success,
  ).toBe(false);
  expect(TeacherHealthResponseSchema.safeParse({ ...health, endpoint: "secret" }).success).toBe(
    false,
  );
});

it("keeps the public transport constants and strict response boundaries stable", async () => {
  const protocol = await import("./usage-health.js");
  expect(protocol.USAGE_QUERY_PATH).toBe("/api/v1/dashboard/usage/query");
  expect(protocol.TEACHER_HEALTH_PATH).toBe("/api/v1/dashboard/health/read");
  expect(protocol.MAX_USAGE_HEALTH_REQUEST_BYTES).toBe(2048);
  expect(protocol.MAX_USAGE_HEALTH_RESPONSE_BYTES).toBe(131072);
  expect(protocol.TEACHER_HEALTH_FRESHNESS_MS).toBe(300000);
  const entry = {
    attemptId: "a",
    purpose: "tutoring",
    state: "settled",
    createdAt: query.from,
    settledAt: query.until,
    tokenBasis: "reported",
    inputTokens: 1,
    outputTokens: 2,
    cost: { status: "priced", unit: "unit_1.a-b", units: 8 },
  };
  expect(protocol.UsageEntrySchema.parse(entry)).toEqual(entry);
  for (const change of [
    { inputTokens: -1 },
    { outputTokens: 0.5 },
    { state: "failed" },
    { purpose: "other" },
    { tokenBasis: "actual" },
    { settledAt: "invalid" },
    { private: true },
  ])
    expect(protocol.UsageEntrySchema.safeParse({ ...entry, ...change }).success).toBe(false);
  for (const unit of ["", "a".repeat(65), " space", "é", "/path", "-unit", "a!", "a\n"])
    expect(protocol.UsageCostSchema.safeParse({ status: "priced", unit, units: 1 }).success).toBe(
      false,
    );
  for (const unit of ["a", "a".repeat(64), "Z-0._"])
    expect(protocol.UsageCostSchema.parse({ status: "priced", unit, units: 0 })).toEqual({
      status: "priced",
      unit,
      units: 0,
    });
  const result = {
    protocolVersion: "0.1",
    requestId: "r",
    classId: "c",
    kind: "class-usage-result",
    generatedAt: query.from,
    from: query.from,
    until: query.until,
    scope: "page",
    pricing: "complete",
    entries: Array.from({ length: 100 }, () => entry),
    nextAfterAttemptId: null,
  };
  expect(protocol.UsageResponseSchema.parse(result).entries).toHaveLength(100);
  expect(
    protocol.UsageResponseSchema.safeParse({ ...result, entries: [...result.entries, entry] })
      .success,
  ).toBe(false);
  expect(protocol.UsageResponseSchema.safeParse({ ...result, extra: true }).success).toBe(false);
  expect(protocol.UsageResponseSchema.safeParse({ ...result, scope: "class" }).success).toBe(false);
});

it("accepts every frozen ledger and health state and explains invalid date windows", async () => {
  const protocol = await import("./usage-health.js");
  const entry = {
    attemptId: "a",
    purpose: "evaluation",
    state: "reserved",
    createdAt: query.from,
    settledAt: null,
    tokenBasis: "reservation",
    inputTokens: 10,
    outputTokens: 10,
    cost: { status: "unavailable" },
  };
  for (const state of ["reserved", "unknown", "breached", "settled"])
    expect(protocol.UsageEntrySchema.parse({ ...entry, state }).state).toBe(state);
  const result = {
    protocolVersion: "0.1",
    requestId: "r",
    classId: "c",
    kind: "class-usage-result",
    generatedAt: query.from,
    from: query.from,
    until: query.until,
    scope: "page",
    entries: [entry],
    nextAfterAttemptId: "a",
  };
  for (const pricing of ["complete", "partial", "unavailable"])
    expect(protocol.UsageResponseSchema.parse({ ...result, pricing }).pricing).toBe(pricing);
  const read = {
    protocolVersion: "0.1",
    requestId: "r",
    classId: "c",
    kind: "teacher-health-read",
  };
  expect(protocol.TeacherHealthRequestSchema.parse(read)).toEqual(read);
  for (const status of ["available", "stale"]) {
    const observation = { status, observedAt: query.from };
    const health = {
      ...read,
      kind: "teacher-health-result",
      generatedAt: query.from,
      freshnessMs: 300000,
      storage: observation,
      usageLedger: observation,
      inference: observation,
      telemetryDelivery: observation,
    };
    expect(protocol.TeacherHealthResponseSchema.parse(health)).toEqual(health);
  }
  expect(() => UsageQuerySchema.parse({ ...query, until: query.from })).toThrow(
    "Usage windows must be positive and at most 31 days.",
  );
});

it("limits query instants to the ledger's millisecond precision", () => {
  expect(UsageQuerySchema.parse({ ...query, from: "2026-09-01T00:00:00.123Z" }).from).toBe(
    "2026-09-01T00:00:00.123Z",
  );
  for (const field of ["from", "until"]) {
    expect(
      UsageQuerySchema.safeParse({ ...query, [field]: "2026-09-02T00:00:00.1234Z" }).success,
    ).toBe(false);
  }
});
