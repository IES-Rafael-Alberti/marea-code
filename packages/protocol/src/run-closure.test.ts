import { describe, expect, it } from "vitest";

import {
  ClassRunsCloseRequestSchema,
  MAX_CLASS_CLOSE_RUNS,
  RunsCloseResponseSchema,
  TeacherRunCloseRequestSchema,
} from "./run-closure.js";

const envelope = { protocolVersion: "0.1", requestId: "request-1" } as const;

describe("teacher run closure protocol", () => {
  it("closes one run with a stable idempotency key", () => {
    const request = {
      ...envelope,
      kind: "teacher-run-close",
      runId: "run-1",
      idempotencyKey: "close-1",
    };
    expect(TeacherRunCloseRequestSchema.parse(request)).toEqual(request);
    expect(() => TeacherRunCloseRequestSchema.parse({ ...request, runId: "" })).toThrow();
    expect(() =>
      TeacherRunCloseRequestSchema.parse({ ...request, idempotencyKey: undefined }),
    ).toThrow();
    expect(() => TeacherRunCloseRequestSchema.parse({ ...request, closedBy: "me" })).toThrow();
    expect(() =>
      TeacherRunCloseRequestSchema.parse({ ...request, kind: "class-runs-close" }),
    ).toThrow();
  });

  it("closes only the listed runs of a class and bounds the list", () => {
    const request = {
      ...envelope,
      kind: "class-runs-close",
      classId: "class-1",
      runIds: ["run-1", "run-2"],
      idempotencyKey: "close-1",
    };
    expect(ClassRunsCloseRequestSchema.parse(request).runIds).toEqual(["run-1", "run-2"]);
    expect(() => ClassRunsCloseRequestSchema.parse({ ...request, runIds: [] })).toThrow();
    expect(() => ClassRunsCloseRequestSchema.parse({ ...request, classId: "" })).toThrow();
    expect(() =>
      ClassRunsCloseRequestSchema.parse({ ...request, runIds: ["run-1", "run-1"] }),
    ).toThrow();
    const many = Array.from({ length: MAX_CLASS_CLOSE_RUNS }, (_, index) => `run-${String(index)}`);
    expect(ClassRunsCloseRequestSchema.parse({ ...request, runIds: many }).runIds).toHaveLength(
      MAX_CLASS_CLOSE_RUNS,
    );
    expect(() =>
      ClassRunsCloseRequestSchema.parse({ ...request, runIds: [...many, "run-extra"] }),
    ).toThrow();
  });

  it("reports which runs were closed and which were left unchanged", () => {
    const response = {
      ...envelope,
      kind: "runs-close-response",
      closed: ["run-1"],
      unchanged: ["run-2"],
    };
    expect(RunsCloseResponseSchema.parse(response)).toEqual(response);
    expect(() => RunsCloseResponseSchema.parse({ ...response, closed: ["run-1", ""] })).toThrow();
    expect(() => RunsCloseResponseSchema.parse({ ...response, extra: true })).toThrow();
  });
});
