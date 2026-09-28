import { ActiveRunDashboardQuerySchema, DashboardCursorSchema, RunIdSchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { ActiveRunsService } from "./active-runs-service.js";

const TEACHER: AuthenticatedIdentity = {
  classId: null,
  displayName: "Teacher Ada",
  role: "teacher",
  userId: "teacher:ada",
};
const QUERY = ActiveRunDashboardQuerySchema.parse({
  cursor: "run_previous",
  kind: "active-runs-query",
  limit: 20,
  protocolVersion: "0.1",
  requestId: "request:dashboard",
});

describe("active runs service", () => {
  it("queries only the authenticated teacher scope and returns a validated page", () => {
    const listActiveRuns = vi.fn(() => ({
      nextCursor: DashboardCursorSchema.parse("run_next"),
      runs: [
        {
          classDisplayName: "Physics",
          highestDurableSequence: 3,
          lastActivityAt: "2026-09-03T10:01:00.000Z",
          pendingApproval: true,
          projectDisplayName: "Wave lab",
          runId: RunIdSchema.parse("run:1"),
          startedAt: "2026-09-03T10:00:00.000Z",
          state: "active" as const,
          studentDisplayName: "Student Alice",
        },
      ],
    }));
    const service = new ActiveRunsService(
      { listActiveRuns },
      { now: () => "2026-09-03T10:02:00.000Z" },
    );

    const response = service.query({ identity: TEACHER }, QUERY);

    expect(response.viewer).toEqual({ displayName: "Teacher Ada", role: "teacher" });
    expect(response.runs).toHaveLength(1);
    expect(listActiveRuns).toHaveBeenCalledWith({
      cursor: "run_previous",
      limit: 20,
      teacherId: "teacher:ada",
    });
  });

  it("rejects a student before reading dashboard state", () => {
    const listActiveRuns = vi.fn(() => ({ nextCursor: null, runs: [] }));
    const service = new ActiveRunsService(
      { listActiveRuns },
      { now: () => "2026-09-03T10:02:00.000Z" },
    );

    expect(() => service.query({ identity: { ...TEACHER, role: "student" } }, QUERY)).toThrow(
      expect.objectContaining({ code: "dashboard.forbidden" }),
    );
    expect(listActiveRuns).not.toHaveBeenCalled();
  });
});
