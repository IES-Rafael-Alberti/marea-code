import { describe, expect, it } from "vitest";
import {
  PublishTeacherNoticeResponseSchema,
  AcknowledgeNoticeResponseSchema,
  PendingNoticesResponseSchema,
} from "@marea/protocol";

import { setup as historySetup, NOW } from "../../test-support/history-fixture.js";
import { student, teacher } from "../../test-support/teaching-integration.fixture.js";
import { createHmacSecretDigest } from "../identity/system-security.boundary.js";
import { TeacherDomainError } from "../identity/errors.js";
import { SqliteNoticeRepository } from "../platform/persistence/sqlite-notice-repository.js";
import { NoticeService } from "../sessions/notice-service.js";
import {
  createApplication,
  createServices,
  fetchJson,
  RecordingProvider,
  request,
  RUN_TOKEN,
  SESSION_TOKEN,
  TEACHER_TOKEN,
} from "./product-http.fixture.js";

const PUBLISH_PATH = "/api/v1/dashboard/notices/publish";
const publishRequest = {
  kind: "teacher-notice-publish",
  protocolVersion: "0.1",
  requestId: "request:publish",
  idempotencyKey: "publish:one",
  runId: "run:b",
  text: "Reviewed teacher feedback.",
};
const pendingRequest = {
  kind: "pending-notices-query",
  protocolVersion: "0.1",
  requestId: "request:pending",
  limit: 32,
};
const teacherHeaders = {
  cookie: `marea_teacher_session=${TEACHER_TOKEN}`,
  origin: "https://dashboard.test",
};

function setup() {
  const { database, service: history } = historySetup();
  const base = createServices(new RecordingProvider());
  let index = 0;
  const notices = new NoticeService({
    repository: new SqliteNoticeRepository(database),
    clock: { now: () => NOW },
    ids: { createId: (namespace) => `${namespace}:${String(++index)}` },
    digest: createHmacSecretDigest(new Uint8Array(32).fill(2)),
  });
  const app = createApplication({
    ...base,
    history,
    notices,
    identity: {
      ...base.identity,
      authenticate(token) {
        if (token === TEACHER_TOKEN) return { identity: teacher, principal: teacher };
        if (token === SESSION_TOKEN) return { identity: student, principal: student };
        throw new TeacherDomainError("auth.invalid");
      },
    },
  });
  return { database, app };
}

describe("notice publication and receipt HTTP", () => {
  it("survives lost publication, read and acknowledgement responses without consuming or duplicating the notice", async () => {
    const { database, app } = setup();
    try {
      const input = () => request(PUBLISH_PATH, publishRequest, undefined, teacherHeaders);
      expect((await app.fetch(input())).status).toBe(200);
      const published = await fetchJson(app, input());
      expect(published.response.status).toBe(200);
      const notice = PublishTeacherNoticeResponseSchema.parse(JSON.parse(published.text)).notice;
      expect(notice.noticeId).toBe("event:1");
      expect(notice.source).toBe("teacher-message");
      expect(published.response.headers.get("cache-control")).toContain("no-store");
      const pending = () => request("/v1/notices/pending", pendingRequest, SESSION_TOKEN);
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await fetchJson(app, pending());
        expect(result.response.status).toBe(200);
        expect(PendingNoticesResponseSchema.parse(JSON.parse(result.text)).notices).toEqual([
          notice,
        ]);
      }
      const receiptRequest = {
        kind: "teacher-notice-acknowledge",
        protocolVersion: "0.1",
        requestId: "request:ack",
        noticeId: notice.noticeId,
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await fetchJson(
          app,
          request("/v1/notices/acknowledge", receiptRequest, SESSION_TOKEN),
        );
        expect(result.response.status).toBe(200);
        expect(AcknowledgeNoticeResponseSchema.parse(JSON.parse(result.text)).acknowledgedAt).toBe(
          NOW,
        );
      }
      const empty = await fetchJson(app, pending());
      expect(PendingNoticesResponseSchema.parse(JSON.parse(empty.text)).notices).toEqual([]);
      expect(database.readAll("SELECT id FROM marea_teacher_notices")).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("requires an allowed origin plus teacher cookie for publication and rejects forged approval provenance", async () => {
    const { database, app } = setup();
    try {
      expect(
        (
          await app.fetch(
            request(`${PUBLISH_PATH}?extra=value`, publishRequest, undefined, teacherHeaders),
          )
        ).status,
      ).toBe(403);
      for (const headers of [
        { cookie: teacherHeaders.cookie },
        { ...teacherHeaders, origin: "https://attacker.test" },
        { ...teacherHeaders, cookie: `marea_teacher_session=${SESSION_TOKEN}` },
      ])
        expect(
          (await app.fetch(request(PUBLISH_PATH, publishRequest, undefined, headers))).status,
        ).toBe(403);
      expect(
        (
          await app.fetch(
            request(PUBLISH_PATH, publishRequest, TEACHER_TOKEN, { origin: teacherHeaders.origin }),
          )
        ).status,
      ).toBe(401);
      for (const extra of [{ source: "approved-evaluation" }, { studentId: "s2" }, { text: " " }])
        expect(
          (
            await app.fetch(
              request(PUBLISH_PATH, { ...publishRequest, ...extra }, undefined, teacherHeaders),
            )
          ).status,
        ).toBe(400);
      expect(
        (
          await app.fetch(
            request(PUBLISH_PATH, { ...publishRequest, runId: "run:c" }, undefined, teacherHeaders),
          )
        ).status,
      ).toBe(409);
      expect(database.readAll("SELECT id FROM marea_teacher_notices")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("requires student session credentials and valid bounded receipt queries", async () => {
    const { database, app } = setup();
    try {
      for (const token of [undefined, RUN_TOKEN])
        expect(
          (await app.fetch(request("/v1/notices/pending", pendingRequest, token))).status,
        ).toBe(401);
      expect(
        (await app.fetch(request("/v1/notices/pending", pendingRequest, TEACHER_TOKEN))).status,
      ).toBe(403);
      expect(
        (
          await app.fetch(
            request("/v1/notices/pending", { ...pendingRequest, limit: 33 }, SESSION_TOKEN),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await app.fetch(
            request(
              "/v1/notices/acknowledge",
              {
                kind: "teacher-notice-acknowledge",
                protocolVersion: "0.1",
                requestId: "request:ack",
                noticeId: "event:missing",
              },
              SESSION_TOKEN,
            ),
          )
        ).status,
      ).toBe(409);
    } finally {
      database.close();
    }
  });
});

it("reads receipt status through the teacher cookie and hides it from students or unrelated teachers", async () => {
  const { database, app } = setup();
  const query = {
    kind: "teacher-notice-query",
    protocolVersion: "0.1",
    requestId: "request:lookup",
    runId: "run:b",
    idempotencyKey: "publish:one",
  };
  try {
    const input = () =>
      request("/api/v1/dashboard/notices/query", query, undefined, teacherHeaders);
    const absent = await fetchJson(app, input());
    expect(absent.response.status).toBe(200);
    expect(JSON.parse(absent.text)).toMatchObject({ publication: null });
    await app.fetch(request(PUBLISH_PATH, publishRequest, undefined, teacherHeaders));
    const published = await fetchJson(app, input());
    expect(JSON.parse(published.text)).toMatchObject({
      publication: { acknowledgedAt: null, notice: { noticeId: "event:1" } },
    });
    await app.fetch(
      request(
        "/v1/notices/acknowledge",
        {
          kind: "teacher-notice-acknowledge",
          protocolVersion: "0.1",
          requestId: "request:receipt",
          noticeId: "event:1",
        },
        SESSION_TOKEN,
      ),
    );
    const received = await fetchJson(app, input());
    expect(JSON.parse(received.text)).toMatchObject({ publication: { acknowledgedAt: NOW } });
    expect(received.response.headers.get("cache-control")).toContain("no-store");
    expect((await app.fetch(request("/api/v1/dashboard/notices/query", query))).status).toBe(401);
    expect(
      (
        await app.fetch(
          request("/api/v1/dashboard/notices/query", query, undefined, {
            ...teacherHeaders,
            cookie: `marea_teacher_session=${SESSION_TOKEN}`,
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.fetch(
          request(
            "/api/v1/dashboard/notices/query",
            { ...query, runId: "run:c" },
            undefined,
            teacherHeaders,
          ),
        )
      ).status,
    ).not.toBe(200);
  } finally {
    database.close();
  }
});

it("keeps legacy history responses unchanged and exposes class identity only through the teacher projection", async () => {
  const { database, app } = setup();
  const query = {
    kind: "session-history-query",
    protocolVersion: "0.1",
    requestId: "request:classes",
    limit: 1,
    classId: "class:one",
  };
  try {
    const response = await fetchJson(
      app,
      request("/api/v1/dashboard/history/classes", query, undefined, teacherHeaders),
    );
    expect(response.response.status).toBe(200);
    expect(JSON.parse(response.text)).toMatchObject({
      kind: "class-sessions-response",
      runs: [{ classId: "class:one", runId: "run:b" }],
      nextBeforeRunId: "run:b",
    });
    const legacy = await fetchJson(app, request("/v1/history/sessions", query, SESSION_TOKEN));
    expect(legacy.response.status).toBe(200);
    expect(legacy.text).not.toContain('"classId"');
    expect(
      (
        await app.fetch(
          request("/api/v1/dashboard/history/classes", query, undefined, {
            ...teacherHeaders,
            cookie: `marea_teacher_session=${SESSION_TOKEN}`,
          }),
        )
      ).status,
    ).toBe(403);
    const other = await fetchJson(
      app,
      request(
        "/api/v1/dashboard/history/classes",
        { ...query, classId: "class:two" },
        undefined,
        teacherHeaders,
      ),
    );
    expect(JSON.parse(other.text)).toMatchObject({ runs: [], nextBeforeRunId: null });
  } finally {
    database.close();
  }
});
