import { describe, expect, it, vi } from "vitest";
import {
  AcknowledgeNoticeRequestSchema,
  PendingNoticesRequestSchema,
  RunHistoryQuerySchema,
  SessionHistoryQuerySchema,
  SessionTokenSchema,
} from "@marea/protocol";

import { createHttpStudentHistory } from "./http-history.boundary.js";
import { snapshot } from "./student-snapshot.fixture.js";

const token = SessionTokenSchema.parse("s".repeat(32));
const envelope = { protocolVersion: "0.1", requestId: "request:history" };
const query = RunHistoryQuerySchema.parse({
  ...envelope,
  kind: "run-history-query",
  runId: "run:one",
  afterSequence: 0,
  limit: 1,
});
const list = SessionHistoryQuerySchema.parse({
  ...envelope,
  kind: "session-history-query",
  limit: 1,
});
const pending = PendingNoticesRequestSchema.parse({
  ...envelope,
  kind: "pending-notices-query",
  limit: 1,
});
const ack = AcknowledgeNoticeRequestSchema.parse({
  ...envelope,
  kind: "teacher-notice-acknowledge",
  noticeId: "notice:one",
});
const event = {
  eventId: "event:one",
  eventType: "assistant-message",
  sequence: 1,
  occurredAt: "2026-09-08T00:00:00.000Z",
  content: "Canonical response.",
};
const page = {
  ...envelope,
  kind: "run-history-response",
  runId: query.runId,
  snapshot,
  state: "closed",
  afterSequence: 0,
  throughSequence: 1,
  nextSequence: null,
  events: [event],
};
const item = {
  runId: "run:one",
  state: "closed",
  studentDisplayName: "Student",
  classDisplayName: "Class",
  projectDisplayName: "Project",
  openedAt: event.occurredAt,
  closedAt: event.occurredAt,
};
const sessions = {
  ...envelope,
  kind: "session-history-response",
  runs: [item],
  nextBeforeRunId: null,
};
const notice = {
  noticeId: ack.noticeId,
  runId: query.runId,
  source: "teacher-message",
  teacherDisplayName: "Teacher",
  text: "Teacher guidance.",
  createdAt: event.occurredAt,
};
const notices = { ...envelope, kind: "pending-notices-response", notices: [notice] };
const receipt = {
  ...envelope,
  kind: "teacher-notice-acknowledged",
  noticeId: ack.noticeId,
  acknowledgedAt: event.occurredAt,
};

function server(value: object, headers: Record<string, string> = {}) {
  const fetch = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json", ...headers },
      }),
    ),
  );
  return { client: createHttpStudentHistory({ baseUrl: "https://school.example", fetch }), fetch };
}

describe("student history and notice HTTP client", () => {
  it("uses the authenticated session, correct endpoint and strict request body for every read and acknowledgement", async () => {
    for (const [path, input, output, call] of [
      [
        "/v1/history/run",
        query,
        page,
        (client: ReturnType<typeof createHttpStudentHistory>) => client.readRun(token, query),
      ],
      [
        "/v1/history/sessions",
        list,
        sessions,
        (client: ReturnType<typeof createHttpStudentHistory>) => client.listSessions(token, list),
      ],
      [
        "/v1/notices/pending",
        pending,
        notices,
        (client: ReturnType<typeof createHttpStudentHistory>) =>
          client.pendingNotices(token, pending),
      ],
      [
        "/v1/notices/acknowledge",
        ack,
        receipt,
        (client: ReturnType<typeof createHttpStudentHistory>) =>
          client.acknowledgeNotice(token, ack),
      ],
    ] as const) {
      const requests: Request[] = [];
      const client = createHttpStudentHistory({
        baseUrl: "https://school.example",
        fetch: (request) => {
          requests.push(request);
          return Promise.resolve(
            new Response(JSON.stringify(output), {
              headers: { "content-type": "application/json" },
            }),
          );
        },
      });
      expect(await call(client)).toEqual(output);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(`https://school.example${path}`);
      expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${token}`);
      expect(await requests[0]?.json()).toEqual(input);
    }
  });

  it("binds transcript responses to the exact run, position, boundary and requested page size", async () => {
    expect(await server(page).client.readRun(token, { ...query, throughSequence: 1 })).toEqual(
      page,
    );
    for (const value of [
      { ...page, runId: "run:other" },
      { ...page, afterSequence: 1, throughSequence: 2, events: [{ ...event, sequence: 2 }] },
      {
        ...page,
        throughSequence: 2,
        events: [event, { ...event, eventId: "event:two", sequence: 2 }],
      },
    ])
      await expect(server(value).client.readRun(token, query)).rejects.toMatchObject({
        code: "response.invalid",
      });
    await expect(
      server(page).client.readRun(token, { ...query, throughSequence: 2 }),
    ).rejects.toMatchObject({ code: "response.invalid" });
  });

  it("rejects oversized pages, unrelated cursors and mismatched receipts", async () => {
    const next = { ...sessions, nextBeforeRunId: item.runId };
    expect(await server(next).client.listSessions(token, list)).toEqual(next);
    const empty = { ...sessions, runs: [], nextBeforeRunId: null };
    expect(await server(empty).client.listSessions(token, list)).toEqual(empty);
    for (const value of [
      { ...sessions, runs: [item, item] },
      { ...sessions, nextBeforeRunId: "run:other" },
      { ...sessions, runs: [], nextBeforeRunId: "run:one" },
    ])
      await expect(server(value).client.listSessions(token, list)).rejects.toMatchObject({
        code: "response.invalid",
      });
    await expect(
      server({ ...notices, notices: [notice, notice] }).client.pendingNotices(token, pending),
    ).rejects.toMatchObject({ code: "response.invalid" });
    await expect(
      server({ ...receipt, noticeId: "notice:other" }).client.acknowledgeNotice(token, ack),
    ).rejects.toMatchObject({ code: "response.invalid" });
  });

  it("validates every request before network I/O", () => {
    const { client, fetch } = server(page);
    expect(() => client.readRun(token, { ...query, limit: 33 })).toThrow();
    expect(() => client.listSessions(token, { ...list, limit: 51 })).toThrow();
    expect(() => client.pendingNotices(token, { ...pending, limit: 33 })).toThrow();
    expect(() =>
      client.acknowledgeNotice(token, {
        ...ack,
        // @ts-expect-error Intentionally cross the untrusted transport boundary.
        noticeId: "bad/id",
      }),
    ).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts bounded history and notices above the default one-megabyte limit", async () => {
    const largePage = {
      ...page,
      throughSequence: 32,
      events: Array.from({ length: 32 }, (_, index) => ({
        ...event,
        eventId: `event:${String(index)}`,
        sequence: index + 1,
        content: "é".repeat(65_536),
      })),
    };
    expect(
      (await server(largePage).client.readRun(token, { ...query, limit: 32 })).events,
    ).toHaveLength(32);
    const largeNotices = {
      ...notices,
      notices: Array.from({ length: 32 }, (_, index) => ({
        ...notice,
        noticeId: `notice:${String(index)}`,
        text: "é".repeat(16_384),
      })),
    };
    expect(
      (await server(largeNotices).client.pendingNotices(token, { ...pending, limit: 32 })).notices,
    ).toHaveLength(32);
    await expect(
      server(page, { "content-length": String(16 * 1_048_576 + 1) }).client.readRun(token, query),
    ).rejects.toMatchObject({ code: "response.too-large" });
    await expect(
      server(notices, { "content-length": String(4 * 1_048_576 + 1) }).client.pendingNotices(
        token,
        pending,
      ),
    ).rejects.toMatchObject({ code: "response.too-large" });
  });
});
