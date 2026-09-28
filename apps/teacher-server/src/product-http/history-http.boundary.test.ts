import { describe, expect, it } from "vitest";
import {
  OpenRunRequestSchema,
  RunHistoryResponseSchema,
  SessionHistoryResponseSchema,
} from "@marea/protocol";

import type { AuthenticatedIdentity } from "../identity/contracts.js";
import { TeacherDomainError } from "../identity/errors.js";
import {
  createApplication,
  createServices,
  fetchJson,
  openRequest,
  RecordingProvider,
  request,
  RUN_TOKEN,
  SESSION_TOKEN,
  TEACHER_TOKEN,
  teacher,
} from "./product-http.fixture.js";

const runQuery = {
  kind: "run-history-query",
  protocolVersion: "0.1",
  requestId: "request:history",
  runId: "run:one",
  afterSequence: 0,
  limit: 32,
};
const sessionsQuery = {
  kind: "session-history-query",
  protocolVersion: "0.1",
  requestId: "request:list",
  limit: 50,
};

function setup() {
  const services = createServices(new RecordingProvider());
  const identities: AuthenticatedIdentity[] = [];
  const snapshot = services.runs.open(teacher, OpenRunRequestSchema.parse(openRequest)).snapshot;
  const app = createApplication({
    ...services,
    history: {
      listClassSessions: services.history.listClassSessions,
      readRun(identity, query) {
        identities.push(identity);
        if (query.runId !== "run:one") throw new TeacherDomainError("run.unavailable");
        return RunHistoryResponseSchema.parse({
          requestId: query.requestId,
          runId: query.runId,
          afterSequence: query.afterSequence,
          protocolVersion: "0.1",
          kind: "run-history-response",
          snapshot,
          state: "closed",
          throughSequence: 0,
          nextSequence: null,
          events: [],
        });
      },
      listSessions(identity, query) {
        identities.push(identity);
        return SessionHistoryResponseSchema.parse({
          kind: "session-history-response",
          protocolVersion: "0.1",
          requestId: query.requestId,
          runs: [],
          nextBeforeRunId: null,
        });
      },
    },
  });
  return { app, identities };
}

describe("history HTTP session authentication", () => {
  it("uses bearer sessions for read-only student history and a teacher cookie for dashboard history", async () => {
    const { app, identities } = setup();
    for (const prefix of ["/v1/history", "/api/v1/dashboard/history"]) {
      const dashboard = prefix.includes("dashboard");
      for (const [suffix, query] of [
        ["run", runQuery],
        ["sessions", sessionsQuery],
      ] as const) {
        const result = await fetchJson(
          app,
          request(
            `${prefix}/${suffix}`,
            query,
            dashboard ? undefined : SESSION_TOKEN,
            dashboard ? { cookie: `marea_teacher_session=${TEACHER_TOKEN}` } : undefined,
          ),
        );
        expect(result.response.status).toBe(200);
        expect(result.text).toContain(query.requestId);
        expect(result.response.headers.get("cache-control")).toContain("no-store");
        expect(identities.at(-1)?.role).toBe(dashboard ? "teacher" : "student");
      }
    }
    expect(identities).toHaveLength(4);
  });

  it("rejects run leases, absent credentials, student cookies and malformed queries", async () => {
    const { app, identities } = setup();
    for (const token of [RUN_TOKEN, undefined]) {
      const result = await fetchJson(app, request("/v1/history/run", runQuery, token));
      expect(result.response.status).toBe(401);
    }
    for (const [cookie, status] of [
      [`marea_teacher_session=${SESSION_TOKEN}`, 403],
      ["", 401],
    ] as const) {
      const result = await fetchJson(
        app,
        request("/api/v1/dashboard/history/run", runQuery, undefined, { cookie }),
      );
      expect(result.response.status).toBe(status);
    }
    for (const body of [
      { ...runQuery, teacherId: "t2" },
      { ...runQuery, limit: 33 },
    ]) {
      const result = await fetchJson(app, request("/v1/history/run", body, SESSION_TOKEN));
      expect(result.response.status).toBe(400);
    }
    expect(identities).toEqual([]);
    const unavailable = await fetchJson(
      app,
      request("/v1/history/run", { ...runQuery, runId: "run:other" }, SESSION_TOKEN),
    );
    expect(unavailable.response.status).toBe(409);
    expect(unavailable.text).toContain("run.unavailable");
  });
});

it("authenticates live notifications with a same-origin teacher cookie", async () => {
  const { app } = setup();
  for (const [token, origin, expected] of [
    [TEACHER_TOKEN, "https://dashboard.test", 204],
    [SESSION_TOKEN, "https://dashboard.test", 401],
    ["", "https://dashboard.test", 401],
    [TEACHER_TOKEN, "https://other.invalid", 403],
  ] as const) {
    const response = await app.fetch(
      new Request("https://teacher.test/api/v1/dashboard/live", {
        headers: { host: "teacher.test", origin, cookie: `marea_teacher_session=${token}` },
      }),
    );
    expect(response.status).toBe(expected);
    expect(response.headers.get("cache-control")).toBe("no-store");
    if (expected === 401)
      expect(await response.json()).toMatchObject({
        error: { code: "auth.invalid", retryable: false },
      });
  }
});

it("requires Origin and rejects query parameters on the live authorization route", async () => {
  const { app } = setup();
  for (const [url, headers] of [
    [
      "https://teacher.test/api/v1/dashboard/live",
      { host: "teacher.test", cookie: `marea_teacher_session=${TEACHER_TOKEN}` },
    ],
    [
      "https://teacher.test/api/v1/dashboard/live?unexpected=value",
      {
        host: "teacher.test",
        origin: "https://dashboard.test",
        cookie: `marea_teacher_session=${TEACHER_TOKEN}`,
      },
    ],
  ] as const) {
    expect((await app.fetch(new Request(url, { headers }))).status).toBe(403);
  }
});
