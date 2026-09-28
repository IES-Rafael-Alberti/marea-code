import {
  TeacherHealthRequestSchema,
  TeacherHealthResponseSchema,
  UsageQuerySchema,
  UsageResponseSchema,
} from "@marea/protocol";

const envelope = { protocolVersion: "0.1", classId: "class:a" } as const;
export const usageQuery = UsageQuerySchema.parse({
  ...envelope,
  requestId: "usage:test",
  kind: "class-usage-query",
  from: "2026-09-01T00:00:00.000Z",
  until: "2026-09-08T00:00:00.000Z",
  limit: 25,
});
const usageEntry = {
  attemptId: "attempt:1",
  purpose: "tutoring",
  state: "settled",
  createdAt: "2026-09-02T10:00:00.000Z",
  settledAt: "2026-09-02T10:00:05.000Z",
  tokenBasis: "reported",
  inputTokens: 1200,
  outputTokens: 340,
  cost: { status: "priced", unit: "credits", units: 17 },
} as const;
export const usageResult = UsageResponseSchema.parse({
  ...envelope,
  requestId: usageQuery.requestId,
  kind: "class-usage-result",
  generatedAt: "2026-09-08T00:00:01.000Z",
  from: usageQuery.from,
  until: usageQuery.until,
  scope: "page",
  pricing: "partial",
  entries: [
    usageEntry,
    {
      ...usageEntry,
      attemptId: "attempt:2",
      purpose: "evaluation",
      state: "reserved",
      settledAt: null,
      tokenBasis: "reservation",
      cost: { status: "unavailable" },
    },
  ],
  nextAfterAttemptId: "attempt:2",
});
export const healthRequest = TeacherHealthRequestSchema.parse({
  ...envelope,
  requestId: "health:test",
  kind: "teacher-health-read",
});
export const healthResult = TeacherHealthResponseSchema.parse({
  ...envelope,
  requestId: healthRequest.requestId,
  kind: "teacher-health-result",
  generatedAt: "2026-09-08T00:10:00.000Z",
  freshnessMs: 300_000,
  storage: { status: "available", observedAt: "2026-09-08T00:10:00.000Z" },
  usageLedger: { status: "stale", observedAt: "2026-09-07T23:00:00.000Z" },
  inference: { status: "unknown", observedAt: null },
  telemetryDelivery: { status: "unknown", observedAt: null },
});
