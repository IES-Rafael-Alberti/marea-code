import { expect, it } from "vitest";
import { ClassSessionsResponseSchema } from "./class-history.js";
const run = {
  runId: "run:one",
  classId: "class:one",
  studentDisplayName: "Ada",
  classDisplayName: "Class",
  projectDisplayName: "Project",
  state: "active",
  openedAt: "2026-09-19T08:00:00.000Z",
  closedAt: null,
};
const response = {
  kind: "class-sessions-response",
  protocolVersion: "0.1",
  requestId: "request:one",
  runs: [run],
  nextBeforeRunId: null,
};
it("bounds the dashboard projection and requires class identity without private fields", () => {
  expect(ClassSessionsResponseSchema.parse(response)).toEqual(response);
  expect(
    ClassSessionsResponseSchema.safeParse({
      ...response,
      runs: Array.from({ length: 50 }, () => run),
    }).success,
  ).toBe(true);
  for (const patch of [
    { kind: "session-history-response" },
    { requestId: "" },
    { protocolVersion: "2.0" },
    { nextBeforeRunId: "" },
    { runs: Array.from({ length: 51 }, () => run) },
    { secret: "no" },
    { runs: [{ ...run, classId: "" }] },
    { runs: [{ ...run, secret: "no" }] },
  ])
    expect(ClassSessionsResponseSchema.safeParse({ ...response, ...patch }).success).toBe(false);
});
