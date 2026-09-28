import { describe, expect, it } from "vitest";
import {
  AcknowledgeNoticeRequestSchema,
  PendingNoticesRequestSchema,
  PublishTeacherNoticeRequestSchema,
} from "@marea/protocol";

import { setup as historySetup, NOW } from "../../../test-support/history-fixture.js";
import { student, teacher } from "../../../test-support/teaching-integration.fixture.js";
import { NoticeService } from "../../sessions/notice-service.js";
import { createHmacSecretDigest } from "../../identity/system-security.boundary.js";
import { SqliteNoticeRepository } from "./sqlite-notice-repository.js";

function publish(key = "one", text = "Teacher feedback.", runId = "run:b") {
  return PublishTeacherNoticeRequestSchema.parse({
    kind: "teacher-notice-publish",
    protocolVersion: "0.1",
    requestId: `request:${key}`,
    runId,
    idempotencyKey: `publish:${key}`,
    text,
  });
}
function pending(limit = 32) {
  return PendingNoticesRequestSchema.parse({
    kind: "pending-notices-query",
    protocolVersion: "0.1",
    requestId: "request:pending",
    limit,
  });
}
function acknowledge(noticeId: string) {
  return AcknowledgeNoticeRequestSchema.parse({
    kind: "teacher-notice-acknowledge",
    protocolVersion: "0.1",
    requestId: "request:ack",
    noticeId,
  });
}
function setup() {
  const { database } = historySetup();
  let index = 0;
  const clock = { now: () => NOW };
  const service = new NoticeService({
    repository: new SqliteNoticeRepository(database),
    clock,
    ids: { createId: (namespace) => `${namespace}:${String(++index)}` },
    digest: createHmacSecretDigest(new Uint8Array(32).fill(7)),
  });
  return { database, service, clock };
}

describe("durable teacher notice delivery", () => {
  it("publishes one scoped notice per action, retries without duplication and keeps reads non-destructive", () => {
    const { database, service, clock } = setup();
    try {
      const result = service.publish(teacher, publish());
      expect(result).toEqual({
        kind: "teacher-notice-published",
        protocolVersion: "0.1",
        requestId: "request:one",
        notice: {
          noticeId: "event:1",
          runId: "run:b",
          source: "teacher-message",
          text: "Teacher feedback.",
          teacherDisplayName: teacher.displayName,
          createdAt: NOW,
        },
      });
      clock.now = () => "2026-09-08T12:00:00.000Z";
      expect(
        service.publish(teacher, { ...publish(), requestId: publish("retry").requestId }).notice,
      ).toEqual(result.notice);
      expect(service.pending(student, pending()).notices).toEqual([result.notice]);
      expect(service.pending(student, pending()).notices).toEqual([result.notice]);
      expect(
        database.readOne(
          "SELECT student_id, class_id, teacher_id, acknowledged_at FROM marea_teacher_notices WHERE id = 'event:1'",
        ),
      ).toEqual({
        student_id: "s1",
        class_id: "class:one",
        teacher_id: "t1",
        acknowledged_at: null,
      });
      expect(() => service.publish(teacher, publish("one", "Changed"))).toThrow("request.conflict");
      expect(() => service.publish(teacher, publish("one", "Teacher feedback.", "run:a"))).toThrow(
        "request.conflict",
      );
      expect(database.readAll("SELECT id FROM marea_teacher_notices")).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("acknowledges only the addressed student, preserves receipt time and never recreates an acknowledged notice on retry", () => {
    const { database, service, clock } = setup();
    try {
      const notice = service.publish(teacher, publish()).notice;
      expect(() =>
        service.acknowledge({ ...student, userId: "s2" }, acknowledge(notice.noticeId)),
      ).toThrow("run.unavailable");
      expect(() => service.acknowledge(student, acknowledge("event:missing"))).toThrow(
        "run.unavailable",
      );
      const receipt = service.acknowledge(student, acknowledge(notice.noticeId));
      expect(receipt).toEqual({
        kind: "teacher-notice-acknowledged",
        protocolVersion: "0.1",
        requestId: "request:ack",
        noticeId: notice.noticeId,
        acknowledgedAt: NOW,
      });
      clock.now = () => "2026-09-08T12:00:00.000Z";
      expect(service.acknowledge(student, acknowledge(notice.noticeId))).toEqual(receipt);
      expect(service.pending(student, pending()).notices).toEqual([]);
      expect(service.publish(teacher, publish()).notice).toEqual(notice);
      expect(service.pending(student, pending()).notices).toEqual([]);
      expect(database.readAll("SELECT id FROM marea_teacher_notices")).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("orders and bounds pending notices while excluding other students and preserving unacknowledged messages", () => {
    const { database, service, clock } = setup();
    try {
      service.publish({ ...teacher, userId: "t2" }, publish("other", "Other class.", "run:c"));
      const first = service.publish(teacher, publish("first")).notice;
      const second = service.publish(teacher, publish("second")).notice;
      clock.now = () => "2026-09-08T12:00:00.000Z";
      const third = service.publish(teacher, publish("third")).notice;
      expect(service.pending(student, pending(1)).notices).toEqual([first]);
      expect(service.pending(student, pending()).notices).toEqual([first, second, third]);
      service.acknowledge(student, acknowledge(first.noticeId));
      expect(service.pending(student, pending()).notices).toEqual([second, third]);
      expect(
        service
          .pending({ ...student, userId: "s2" }, pending())
          .notices.map((notice) => notice.text),
      ).toEqual(["Other class."]);
      expect(service.pending({ ...student, userId: "missing" }, pending()).notices).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("denies unauthorized publishing and role confusion, including retries after membership revocation", () => {
    const { database, service } = setup();
    try {
      expect(() => service.publish(student, publish())).toThrow("dashboard.forbidden");
      expect(() => service.pending(teacher, pending())).toThrow("dashboard.forbidden");
      expect(() => service.acknowledge(teacher, acknowledge("event:one"))).toThrow(
        "dashboard.forbidden",
      );
      for (const runId of ["run:c", "run:missing"])
        expect(() => service.publish(teacher, publish("other", "Unauthorized", runId))).toThrow(
          "run.unavailable",
        );
      const notice = service.publish(teacher, publish()).notice;
      database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
      expect(() => service.publish(teacher, publish())).toThrow("run.unavailable");
      expect(service.pending(student, pending()).notices).toEqual([notice]);
    } finally {
      database.close();
    }
  });
});

it("reads publication and durable receipt by the original key without exposing another teacher or class", () => {
  const { database, service } = setup();
  const query = {
    kind: "teacher-notice-query" as const,
    protocolVersion: "0.1" as const,
    requestId: publish().requestId,
    runId: publish().runId,
    idempotencyKey: publish().idempotencyKey,
  };
  try {
    expect(service.lookup(teacher, query).publication).toBeNull();
    const result = service.publish(teacher, publish());
    expect(service.lookup(teacher, query)).toMatchObject({
      kind: "teacher-notice-status",
      runId: "run:b",
      idempotencyKey: "publish:one",
      publication: { notice: result.notice, acknowledgedAt: null },
    });
    service.acknowledge(student, acknowledge(result.notice.noticeId));
    expect(service.lookup(teacher, query).publication?.acknowledgedAt).toBe(NOW);
    expect(() => service.lookup(student, query)).toThrow("dashboard.forbidden");
    expect(() =>
      service.lookup(teacher, { ...query, runId: publish("other", "Message", "run:c").runId }),
    ).toThrow("run.unavailable");
    expect(() => service.lookup({ ...teacher, userId: "t2" }, query)).toThrow("run.unavailable");
    database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
    expect(() => service.lookup(teacher, query)).toThrow("run.unavailable");
  } finally {
    database.close();
  }
});
