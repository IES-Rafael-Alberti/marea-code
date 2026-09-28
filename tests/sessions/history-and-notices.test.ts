import { describe, expect, it } from "vitest";

import { createHttpStudentHistory } from "../../apps/student/src/http-history.boundary.js";
import {
  AcknowledgeNoticeRequestSchema,
  AppendRunEventsRequestSchema,
  CloseRunRequestSchema,
  CredentialLoginRequestSchema,
  OpenRunRequestSchema,
  PendingNoticesRequestSchema,
  PublishTeacherNoticeResponseSchema,
  RunHistoryQuerySchema,
  SessionHistoryQuerySchema,
} from "../../packages/protocol/src/index.js";
import {
  createAcceptanceHarness,
  enrollAcceptanceStudent as enroll,
} from "../../test-support/acceptance/harness.js";

describe("authenticated history and durable teacher delivery", () => {
  it("reads a canonically closed run and acknowledges one teacher message across real network losses", async () => {
    const harness = await createAcceptanceHarness();
    try {
      const ada = await enroll(harness, "ada");
      const bob = await enroll(harness, "bob");
      const opened = await harness.studentServer.openRun(
        ada.session.token,
        OpenRunRequestSchema.parse({
          protocolVersion: "0.1",
          clientVersion: "0.2.0",
          requestId: "request:open",
          idempotencyKey: "open:history",
          clientSessionId: "client:history",
          intent: { kind: "new" },
          project: { displayName: "History project" },
        }),
      );
      await harness.studentServer.appendRunEvents(
        opened.lease.token,
        AppendRunEventsRequestSchema.parse({
          kind: "run-events-append",
          protocolVersion: "0.1",
          requestId: "request:append",
          events: [
            {
              eventType: "student-message",
              messageId: "message:one",
              eventId: "event:student",
              sequence: 2,
              occurredAt: harness.clock.now(),
              content: "Student question.",
            },
            {
              eventType: "assistant-message",
              messageId: "message:one",
              eventId: "event:assistant",
              sequence: 3,
              occurredAt: harness.clock.now(),
              content: "Canonical answer.",
            },
          ],
        }),
      );
      await harness.studentServer.closeRunAuthenticated(
        ada.session.token,
        CloseRunRequestSchema.parse({
          protocolVersion: "0.1",
          requestId: "request:close",
          runId: opened.lease.runId,
          reason: "student-exit",
        }),
      );
      const reader = createHttpStudentHistory({ baseUrl: harness.http.baseUrl });
      const list = SessionHistoryQuerySchema.parse({
        kind: "session-history-query",
        protocolVersion: "0.1",
        requestId: "request:history:list",
        limit: 50,
      });
      expect((await reader.listSessions(ada.session.token, list)).runs).toEqual([
        expect.objectContaining({
          runId: opened.lease.runId,
          state: "closed",
          projectDisplayName: "History project",
        }),
      ]);
      expect((await reader.listSessions(bob.session.token, list)).runs).toEqual([]);
      const query = RunHistoryQuerySchema.parse({
        kind: "run-history-query",
        protocolVersion: "0.1",
        requestId: "request:history:run",
        runId: opened.lease.runId,
        afterSequence: 0,
        limit: 2,
      });
      const first = await reader.readRun(ada.session.token, query);
      expect(first.snapshot).toEqual(opened.snapshot);
      expect(first.events.map((event) => event.eventType)).toEqual([
        "run-activated",
        "student-message",
      ]);
      const final = await reader.readRun(ada.session.token, {
        ...query,
        afterSequence: 2,
        throughSequence: first.throughSequence,
      });
      expect(final.events.map((event) => event.eventType)).toEqual([
        "assistant-message",
        "run-closed",
      ]);
      expect(final.nextSequence).toBeNull();
      expect(final.state).toBe("closed");
      await expect(reader.readRun(bob.session.token, query)).rejects.toMatchObject({
        code: "run.unavailable",
      });
      expect(JSON.stringify(first)).not.toContain("deterministic-upstream");

      const teacher = await harness.studentServer.login(
        CredentialLoginRequestSchema.parse({
          kind: "credential-login",
          protocolVersion: "0.1",
          requestId: "request:teacher",
          credentials: { login: "grace.teacher", password: "teacher-password" },
        }),
      );
      const publish = () =>
        fetch(`${harness.http.baseUrl}/api/v1/dashboard/notices/publish`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "http://127.0.0.1",
            cookie: `marea_teacher_session=${teacher.session.token}`,
          },
          body: JSON.stringify({
            kind: "teacher-notice-publish",
            protocolVersion: "0.1",
            requestId: "request:publish",
            idempotencyKey: "publish:history",
            runId: opened.lease.runId,
            text: "The teacher has reviewed your work.",
          }),
        });
      harness.http.loseNextResponse({ path: "/api/v1/dashboard/notices/publish" });
      await expect(publish()).rejects.toThrow();
      const published = await publish();
      expect(published.status).toBe(200);
      const notice = PublishTeacherNoticeResponseSchema.parse(
        JSON.parse(await published.text()),
      ).notice;
      const pending = PendingNoticesRequestSchema.parse({
        kind: "pending-notices-query",
        protocolVersion: "0.1",
        requestId: "request:pending",
        limit: 32,
      });
      expect((await reader.pendingNotices(ada.session.token, pending)).notices).toEqual([notice]);
      expect((await reader.pendingNotices(bob.session.token, pending)).notices).toEqual([]);
      harness.http.loseNextResponse({ path: "/v1/notices/pending" });
      await expect(reader.pendingNotices(ada.session.token, pending)).rejects.toThrow();
      expect((await reader.pendingNotices(ada.session.token, pending)).notices).toEqual([notice]);
      const receipt = AcknowledgeNoticeRequestSchema.parse({
        kind: "teacher-notice-acknowledge",
        protocolVersion: "0.1",
        requestId: "request:receipt",
        noticeId: notice.noticeId,
      });
      harness.http.loseNextResponse({ path: "/v1/notices/acknowledge" });
      await expect(reader.acknowledgeNotice(ada.session.token, receipt)).rejects.toThrow();
      expect((await reader.acknowledgeNotice(ada.session.token, receipt)).noticeId).toBe(
        notice.noticeId,
      );
      expect((await reader.pendingNotices(ada.session.token, pending)).notices).toEqual([]);
      expect(harness.database.readAll("SELECT id FROM marea_teacher_notices")).toHaveLength(1);
      expect(harness.database.readAll("SELECT id FROM marea_runs")).toHaveLength(1);
      expect(harness.provider.requests).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);
});
