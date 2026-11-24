import { ClassRunsCloseRequestSchema, TeacherRunCloseRequestSchema } from "@marea/protocol";
import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedIdentity } from "../identity/contracts.js";
import type { RunClosureRepository } from "./run-closure-contracts.js";
import { ABANDONED_RUN_IDLE_MS, RunClosureService } from "./run-closure-service.js";

const NOW = "2026-09-12T12:00:00.000Z";
const TEACHER: AuthenticatedIdentity = {
  classId: null,
  displayName: "Ada",
  role: "teacher",
  userId: "user:teacher",
};
const STUDENT: AuthenticatedIdentity = { ...TEACHER, classId: "class:a", role: "student" };

function setup(result = { closed: ["run-1"], unchanged: ["run-2"] }) {
  const repository = {
    closeAbandoned: vi.fn<RunClosureRepository["closeAbandoned"]>(() => 3),
    closeRuns: vi.fn<RunClosureRepository["closeRuns"]>(() => result),
  };
  let id = 0;
  const service = new RunClosureService({
    clock: { now: () => NOW },
    ids: { createId: (namespace) => `${namespace}:${String(++id)}` },
    repository,
  });
  return { repository, service };
}

const envelope = { protocolVersion: "0.1", requestId: "request-1" } as const;
const single = TeacherRunCloseRequestSchema.parse({
  ...envelope,
  kind: "teacher-run-close",
  runId: "run-1",
  idempotencyKey: "close-1",
});
const group = ClassRunsCloseRequestSchema.parse({
  ...envelope,
  kind: "class-runs-close",
  classId: "class-a",
  runIds: ["run-1", "run-2"],
  idempotencyKey: "close-2",
});

describe("run closure service", () => {
  it("treats an hour without a connection and the eight-hour sign-in cap as abandonment", () => {
    expect(ABANDONED_RUN_IDLE_MS).toBe(3_600_000);
    const { repository, service } = setup();
    expect(service.closeAbandoned()).toBe(3);
    const input = repository.closeAbandoned.mock.calls[0]?.[0];
    if (input === undefined) throw new Error("Expected the abandoned-run scan");
    expect(input).toMatchObject({
      idleBefore: "2026-09-12T11:00:00.000Z",
      now: NOW,
      sessionOpenedBefore: "2026-09-12T04:00:00.000Z",
    });
    expect(input.createEventId()).toBe("event:1");
    expect(input.createEventId()).toBe("event:2");
  });

  it("ends one run as teacher-ended on behalf of the authenticated teacher", () => {
    const { repository, service } = setup();
    const response = service.closeRun(TEACHER, single);
    expect(response).toEqual({
      closed: ["run-1"],
      kind: "runs-close-response",
      protocolVersion: "0.1",
      requestId: "request-1",
      unchanged: ["run-2"],
    });
    const input = repository.closeRuns.mock.calls[0]?.[0];
    if (input === undefined) throw new Error("Expected the closing request");
    expect(input).toMatchObject({
      classId: null,
      closedAt: NOW,
      reason: "teacher-ended",
      runIds: ["run-1"],
      teacherId: "user:teacher",
    });
    expect(input.createEventId()).toBe("event:1");
  });

  it("ends the listed runs of a class as class-ended", () => {
    const { repository, service } = setup();
    expect(service.closeClassRuns(TEACHER, group).closed).toEqual(["run-1"]);
    expect(repository.closeRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        classId: "class-a",
        closedAt: NOW,
        reason: "class-ended",
        runIds: ["run-1", "run-2"],
        teacherId: "user:teacher",
      }),
    );
  });

  it("refuses students and malformed requests before touching storage", () => {
    const { repository, service } = setup();
    expect(() => service.closeRun(STUDENT, single)).toThrow(
      expect.objectContaining({ code: "dashboard.forbidden" }),
    );
    expect(() => service.closeClassRuns(STUDENT, group)).toThrow(
      expect.objectContaining({ code: "dashboard.forbidden" }),
    );
    expect(() =>
      service.closeRun(TEACHER, { ...single, runId: "" as typeof single.runId }),
    ).toThrow();
    expect(() => service.closeClassRuns(TEACHER, { ...group, runIds: [] })).toThrow();
    expect(repository.closeRuns).not.toHaveBeenCalled();
  });
});
