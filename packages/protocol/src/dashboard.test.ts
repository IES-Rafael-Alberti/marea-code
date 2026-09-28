import { describe, expect, it } from "vitest";

import { ActiveRunDashboardQuerySchema, ActiveRunDashboardResponseSchema } from "./dashboard.js";

const run = {
  runId: "run-1",
  studentDisplayName: "Ana María",
  classDisplayName: "Programming 1",
  projectDisplayName: "Weather app",
  state: "active",
  startedAt: "2026-09-03T10:00:00Z",
  lastActivityAt: "2026-09-03T10:05:00Z",
  highestDurableSequence: 4,
  pendingApproval: true,
} as const;

const response = {
  kind: "active-runs-response",
  protocolVersion: "0.1",
  requestId: "request-dashboard-1",
  generatedAt: "2026-09-03T10:06:00Z",
  viewer: { role: "teacher", displayName: "Ada Lovelace" },
  runs: [run],
  nextCursor: "next_page_1",
} as const;

describe("active-run dashboard protocol", () => {
  it("queries a bounded page without client-supplied teacher identity", () => {
    const query = ActiveRunDashboardQuerySchema.parse({
      kind: "active-runs-query",
      protocolVersion: "0.1",
      requestId: "request-dashboard-1",
      cursor: "page_1",
      limit: 100,
    });

    expect(query).toMatchObject({ cursor: "page_1", limit: 100 });
    expect(() => ActiveRunDashboardQuerySchema.parse({ ...query, limit: 0 })).toThrow();
    expect(() => ActiveRunDashboardQuerySchema.parse({ ...query, limit: 101 })).toThrow();
    expect(() => ActiveRunDashboardQuerySchema.parse({ ...query, teacherId: "private" })).toThrow();
  });

  it("returns only active student-run summaries to a teacher", () => {
    const parsed = ActiveRunDashboardResponseSchema.parse(response);

    expect(parsed.viewer.role).toBe("teacher");
    expect(parsed.runs).toEqual([run]);
    expect(parsed.nextCursor).toBe("next_page_1");
  });

  it("supports an empty final page", () => {
    const parsed = ActiveRunDashboardResponseSchema.parse({
      ...response,
      runs: [],
      nextCursor: null,
    });

    expect(parsed.runs).toEqual([]);
    expect(parsed.nextCursor).toBeNull();
  });

  it("accepts activity at the exact start instant", () => {
    expect(
      ActiveRunDashboardResponseSchema.parse({
        ...response,
        runs: [{ ...run, lastActivityAt: run.startedAt }],
      }).runs[0]?.lastActivityAt,
    ).toBe(run.startedAt);
  });

  it("rejects activity before the run starts with a stable diagnostic", () => {
    const parsed = ActiveRunDashboardResponseSchema.safeParse({
      ...response,
      runs: [{ ...run, lastActivityAt: "2026-09-03T09:59:59Z" }],
    });

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [{ message: "Run activity cannot predate its start." }] },
    });
  });

  it("requires unique runs per dashboard page", () => {
    const parsed = ActiveRunDashboardResponseSchema.safeParse({
      ...response,
      runs: [run, run],
    });

    expect(parsed).toMatchObject({
      success: false,
      error: { issues: [{ message: "Dashboard run identifiers must be unique." }] },
    });
  });

  it("bounds a dashboard page and durable sequence", () => {
    const maximumRuns = Array.from({ length: 100 }, (_, index) => ({
      ...run,
      runId: `run-${String(index)}`,
    }));

    expect(
      ActiveRunDashboardResponseSchema.parse({ ...response, runs: maximumRuns }).runs,
    ).toHaveLength(100);
    expect(() =>
      ActiveRunDashboardResponseSchema.parse({
        ...response,
        runs: [...maximumRuns, { ...run, runId: "run-100" }],
      }),
    ).toThrow();
    expect(
      ActiveRunDashboardResponseSchema.parse({
        ...response,
        runs: [{ ...run, highestDurableSequence: Number.MAX_SAFE_INTEGER }],
      }).runs[0]?.highestDurableSequence,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(() =>
      ActiveRunDashboardResponseSchema.parse({
        ...response,
        runs: [{ ...run, highestDurableSequence: -1 }],
      }),
    ).toThrow();
    expect(() =>
      ActiveRunDashboardResponseSchema.parse({
        ...response,
        runs: [{ ...run, highestDurableSequence: Number.MAX_SAFE_INTEGER + 1 }],
      }),
    ).toThrow();
  });

  it.each(["provider", "upstreamModel", "apiKey", "studentId", "classId"])(
    "rejects private dashboard field %s",
    (field) => {
      expect(() =>
        ActiveRunDashboardResponseSchema.parse({ ...response, [field]: "private" }),
      ).toThrow();
    },
  );

  it("rejects private nested fields, non-teacher viewers, and closed runs", () => {
    expect(() =>
      ActiveRunDashboardResponseSchema.parse({
        ...response,
        viewer: { role: "student", displayName: "Ana" },
      }),
    ).toThrow();
    expect(() =>
      ActiveRunDashboardResponseSchema.parse({
        ...response,
        runs: [{ ...run, studentId: "private" }],
      }),
    ).toThrow();
    expect(() =>
      ActiveRunDashboardResponseSchema.parse({
        ...response,
        runs: [{ ...run, state: "closed" }],
      }),
    ).toThrow();
  });
});
