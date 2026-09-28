import { expect, it } from "vitest";
import { TeacherNoticeQuerySchema, TeacherNoticeQueryResponseSchema } from "./notices.js";
const query = {
  kind: "teacher-notice-query",
  protocolVersion: "0.1",
  requestId: "request:one",
  runId: "run:one",
  idempotencyKey: "notice:one",
};
it("bounds and strictly validates receipt lookup envelopes", () => {
  expect(TeacherNoticeQuerySchema.parse(query)).toEqual(query);
  for (const patch of [
    { runId: "" },
    { idempotencyKey: "" },
    { requestId: "" },
    { kind: "wrong" },
    { protocolVersion: "2.0" },
    { teacherId: "forged" },
  ])
    expect(TeacherNoticeQuerySchema.safeParse({ ...query, ...patch }).success).toBe(false);
  const response = { ...query, kind: "teacher-notice-status", publication: null };
  expect(TeacherNoticeQueryResponseSchema.parse(response)).toEqual(response);
  expect(TeacherNoticeQueryResponseSchema.safeParse({ ...response, publication: {} }).success).toBe(
    false,
  );
});
