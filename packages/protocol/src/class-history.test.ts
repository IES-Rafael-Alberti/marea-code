import { expect, it } from "vitest";
import {
  ClassSessionsQuerySchema,
  ClassSessionsResponseSchema,
  SessionReviewSchema,
} from "./class-history.js";
const review = { evaluation: "draft", criteria: 3, evidenced: 2, applied: 0, raised: 0 };
const run = {
  runId: "run:one",
  classId: "class:one",
  studentDisplayName: "Ada",
  classDisplayName: "Class",
  projectDisplayName: "Project",
  state: "active",
  openedAt: "2026-09-19T08:00:00.000Z",
  closedAt: null,
  review,
};
const response = {
  kind: "class-sessions-response",
  protocolVersion: "0.1",
  requestId: "request:one",
  runs: [run],
  nextBeforeRunId: null,
};
const query = {
  kind: "session-history-query",
  protocolVersion: "0.1",
  requestId: "request:one",
  limit: 50,
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
it("keeps the review optional so older strict dashboards can ask without it", () => {
  const { review: omitted, ...plain } = run;
  expect(omitted).toBeDefined();
  expect(ClassSessionsResponseSchema.parse({ ...response, runs: [plain] }).runs[0]).toEqual(plain);
});
it("bounds the review summary to known states and the criteria a draft may assess", () => {
  expect(SessionReviewSchema.parse({ ...review, criteria: 4_096 })).toMatchObject({
    criteria: 4_096,
  });
  for (const patch of [
    { evaluation: "consolidated" },
    { criteria: -1 },
    { evidenced: 1.5 },
    { applied: 4_097 },
    { raised: "1" },
    { secret: "no" },
  ])
    expect(SessionReviewSchema.safeParse({ ...review, ...patch }).success).toBe(false);
});
it("accepts optional server-side filters and rejects empty or unknown ones", () => {
  const filtered = {
    ...query,
    includeReview: true,
    runState: "closed",
    evaluation: ["queued", "running"],
    evidence: "without",
    search: "  álvaro  ",
  };
  expect(ClassSessionsQuerySchema.parse(query)).toEqual(query);
  expect(
    ClassSessionsQuerySchema.parse({ ...query, runState: "active", evidence: "with" }),
  ).toMatchObject({ runState: "active", evidence: "with" });
  expect(ClassSessionsQuerySchema.parse(filtered)).toEqual({ ...filtered, search: "álvaro" });
  expect(
    ClassSessionsQuerySchema.parse({
      ...query,
      evaluation: ["none", "queued", "running", "failed", "draft", "approved"],
      search: "a".repeat(80),
    }),
  ).toMatchObject({ search: "a".repeat(80) });
  for (const patch of [
    { includeReview: false },
    { runState: "paused" },
    { evaluation: [] },
    { evaluation: ["none", "none", "none", "none", "none", "none", "none"] },
    { evaluation: ["consolidated"] },
    { evidence: "some" },
    { search: "   " },
    { search: "a".repeat(81) },
    { secret: "no" },
  ])
    expect(ClassSessionsQuerySchema.safeParse({ ...query, ...patch }).success).toBe(false);
});
it("carries the client version only as a strict pair of software versions", () => {
  const versionMismatch = { clientVersion: "0.1.0", serverVersion: "0.2.0-preview.48" };
  const withMismatch = { ...response, runs: [{ ...run, versionMismatch }] };
  expect(ClassSessionsResponseSchema.parse(withMismatch)).toEqual(withMismatch);
  for (const bad of [
    { ...versionMismatch, extra: "no" },
    { clientVersion: "0.1.0" },
    { serverVersion: "0.2.0" },
    { ...versionMismatch, clientVersion: "latest" },
    { ...versionMismatch, serverVersion: "2" },
  ])
    expect(
      ClassSessionsResponseSchema.safeParse({
        ...response,
        runs: [{ ...run, versionMismatch: bad }],
      }).success,
    ).toBe(false);
});
