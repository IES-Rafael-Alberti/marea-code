import { describe, expect, it } from "vitest";

import {
  AcknowledgeNoticeRequestSchema,
  AcknowledgeNoticeResponseSchema,
  PendingNoticesRequestSchema,
  PendingNoticesResponseSchema,
  PublishTeacherNoticeRequestSchema,
  PublishTeacherNoticeResponseSchema,
  TeacherNoticeSchema,
  NoticeTextSchema,
} from "./notices.js";

const envelope = { protocolVersion: "0.1", requestId: "request:notice" };
const notice = {
  noticeId: "event:notice",
  runId: "run:one",
  source: "teacher-message",
  teacherDisplayName: "Synthetic teacher",
  text: "Reviewed guidance.",
  createdAt: "2026-09-08T00:00:00.000Z",
};
const publish = {
  ...envelope,
  kind: "teacher-notice-publish",
  runId: notice.runId,
  text: notice.text,
  idempotencyKey: "publish:one",
};

describe("teacher notice protocol", () => {
  it("bounds nonempty normalized notice content and freezes server-owned provenance", () => {
    expect(NoticeTextSchema.parse("  Teacher guidance. \n")).toBe("Teacher guidance.");
    expect(NoticeTextSchema.parse("x")).toBe("x");
    expect(NoticeTextSchema.parse("x".repeat(16_384))).toHaveLength(16_384);
    for (const text of ["", " \n", "x".repeat(16_385)])
      expect(NoticeTextSchema.safeParse(text).success).toBe(false);
    for (const source of ["teacher-message", "approved-evaluation"]) {
      const input = { ...notice, source };
      expect(TeacherNoticeSchema.parse(input)).toEqual(input);
    }
    expect(Object.isFrozen(TeacherNoticeSchema.parse(notice))).toBe(true);
    for (const invalid of [
      { source: "draft" },
      { noticeId: "bad/id" },
      { runId: "" },
      { createdAt: "today" },
      { teacherDisplayName: "" },
      { text: "" },
      { privateNotes: "secret" },
    ])
      expect(TeacherNoticeSchema.safeParse({ ...notice, ...invalid }).success).toBe(false);
  });

  it("allows publishing text, not recipient authority or evaluation approval status", () => {
    expect(PublishTeacherNoticeRequestSchema.parse(publish)).toEqual(publish);
    expect(Object.isFrozen(PublishTeacherNoticeRequestSchema.parse(publish))).toBe(true);
    for (const invalid of [
      { source: "approved-evaluation" },
      { studentId: "other" },
      { classId: "other" },
      { teacherId: "other" },
      { approved: true },
      { idempotencyKey: "" },
      { runId: "bad/id" },
      { text: "" },
      { kind: "" },
      { requestId: "bad/id" },
      { protocolVersion: "future" },
    ])
      expect(PublishTeacherNoticeRequestSchema.safeParse({ ...publish, ...invalid }).success).toBe(
        false,
      );
    const published = { ...envelope, kind: "teacher-notice-published", notice };
    expect(PublishTeacherNoticeResponseSchema.parse(published)).toEqual(published);
    expect(Object.isFrozen(PublishTeacherNoticeResponseSchema.parse(published))).toBe(true);
    for (const invalid of [{ kind: "" }, { notice: {} }, { privateDraft: "secret" }])
      expect(
        PublishTeacherNoticeResponseSchema.safeParse({ ...published, ...invalid }).success,
      ).toBe(false);
  });

  it("reads a bounded immutable pending page without client-supplied student identity", () => {
    const pending = { ...envelope, kind: "pending-notices-query", limit: 32 };
    expect(PendingNoticesRequestSchema.parse(pending)).toEqual(pending);
    expect(PendingNoticesRequestSchema.parse({ ...pending, limit: 1 }).limit).toBe(1);
    expect(Object.isFrozen(PendingNoticesRequestSchema.parse(pending))).toBe(true);
    for (const invalid of [
      { limit: 0 },
      { limit: 33 },
      { limit: 1.5 },
      { studentId: "s2" },
      { kind: "" },
    ])
      expect(PendingNoticesRequestSchema.safeParse({ ...pending, ...invalid }).success).toBe(false);
    const page = { ...envelope, kind: "pending-notices-response", notices: [] };
    expect(PendingNoticesResponseSchema.parse(page)).toEqual(page);
    const full = { ...page, notices: Array.from({ length: 32 }, () => notice) };
    expect(PendingNoticesResponseSchema.parse(full).notices).toHaveLength(32);
    expect(Object.isFrozen(PendingNoticesResponseSchema.parse(full))).toBe(true);
    expect(Object.isFrozen(PendingNoticesResponseSchema.parse(full).notices)).toBe(true);
    for (const invalid of [
      { notices: [...full.notices, notice] },
      { kind: "" },
      { privateNotes: "secret" },
    ])
      expect(PendingNoticesResponseSchema.safeParse({ ...page, ...invalid }).success).toBe(false);
  });

  it("acknowledges one notice with a server timestamp, never a caller-chosen recipient or receipt time", () => {
    const request = { ...envelope, kind: "teacher-notice-acknowledge", noticeId: notice.noticeId };
    expect(AcknowledgeNoticeRequestSchema.parse(request)).toEqual(request);
    expect(Object.isFrozen(AcknowledgeNoticeRequestSchema.parse(request))).toBe(true);
    for (const invalid of [
      { noticeId: "bad/id" },
      { kind: "" },
      { studentId: "s2" },
      { acknowledgedAt: notice.createdAt },
    ])
      expect(AcknowledgeNoticeRequestSchema.safeParse({ ...request, ...invalid }).success).toBe(
        false,
      );
    const response = {
      ...envelope,
      kind: "teacher-notice-acknowledged",
      noticeId: notice.noticeId,
      acknowledgedAt: notice.createdAt,
    };
    expect(AcknowledgeNoticeResponseSchema.parse(response)).toEqual(response);
    expect(Object.isFrozen(AcknowledgeNoticeResponseSchema.parse(response))).toBe(true);
    for (const invalid of [
      { noticeId: "bad/id" },
      { kind: "" },
      { privateNotes: "secret" },
      { acknowledgedAt: "today" },
    ])
      expect(AcknowledgeNoticeResponseSchema.safeParse({ ...response, ...invalid }).success).toBe(
        false,
      );
  });
});
