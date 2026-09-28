import { describe, expect, it, vi } from "vitest";
import { EvaluationResponseSchema } from "@marea/protocol";

import {
  evaluationFixture,
  evaluationRequest,
  reviewRequest,
  EVALUATION_DRAFT,
  NOW,
  teacher,
} from "../../test-support/evaluation-fixture.js";
import { student } from "../../test-support/teaching-integration.fixture.js";
import { EvaluationService } from "../evaluation/evaluation-service.js";
import { TeacherDomainError } from "../identity/errors.js";
import { SqliteNoticeRepository } from "../platform/persistence/sqlite-notice-repository.js";
import {
  createApplication,
  createServices,
  fetchJson,
  RecordingProvider,
  request,
  SESSION_TOKEN,
  TEACHER_TOKEN,
} from "./product-http.fixture.js";

const headers = {
  cookie: `marea_teacher_session=${TEACHER_TOKEN}`,
  origin: "https://dashboard.test",
};
const query = {
  kind: "evaluation-query",
  protocolVersion: "0.1",
  requestId: "request:query",
  runId: "run:b",
};
const path = (action: string) => `/api/v1/dashboard/evaluations/${action}`;

function setup() {
  const fixture = evaluationFixture();
  const base = createServices(new RecordingProvider());
  let id = 0;
  const createId = vi.fn(() => `evaluation:${String(++id)}`);
  const app = createApplication({
    ...base,
    evaluations: new EvaluationService({
      repository: fixture.repository,
      clock: { now: () => NOW },
      ids: { createId },
    }),
    identity: {
      ...base.identity,
      authenticate(token) {
        const identity =
          token === TEACHER_TOKEN ? teacher : token === SESSION_TOKEN ? student : null;
        if (identity === null) throw new TeacherDomainError("auth.invalid");
        return { identity, principal: identity };
      },
    },
  });
  return { ...fixture, app, createId };
}

describe("teacher evaluation HTTP", () => {
  it("rejects a student before invoking a permissive evaluation service", async () => {
    const base = createServices(new RecordingProvider());
    const queryEvaluation = vi.fn();
    const app = createApplication({
      ...base,
      evaluations: { ...base.evaluations, query: queryEvaluation },
      identity: {
        ...base.identity,
        authenticate: () => ({ identity: student, principal: student }),
      },
    });
    expect((await app.fetch(request(path("query"), query, undefined, headers))).status).toBe(403);
    expect(queryEvaluation).not.toHaveBeenCalled();
  });
  it("queries, queues idempotently and sends only edited public feedback after approval", async () => {
    const test = setup();
    try {
      const send = (action: string, body: object) =>
        fetchJson(test.app, request(path(action), body, undefined, headers));
      expect(
        EvaluationResponseSchema.parse(JSON.parse((await send("query", query)).text)).evaluation,
      ).toBeNull();
      const generated = await send("generate", evaluationRequest());
      expect(test.createId).toHaveBeenLastCalledWith("event");
      expect(generated.response.status).toBe(200);
      expect(generated.response.headers.get("cache-control")).toContain("no-store");
      const record = EvaluationResponseSchema.parse(JSON.parse(generated.text)).evaluation;
      expect(record).toMatchObject({ state: "queued", evaluationId: "evaluation:1" });
      expect((await send("generate", evaluationRequest())).text).toBe(generated.text);
      expect((await send("approve", reviewRequest())).response.status).toBe(409);
      const claim = test.repository.claim("worker:1", NOW);
      if (claim === null) throw new Error("Expected evaluation claim");
      test.repository.finish(claim, EVALUATION_DRAFT, NOW);
      const notices = new SqliteNoticeRepository(test.database);
      expect(notices.pending("s1", 32)).toEqual([]);
      const reviewed = {
        ...reviewRequest(),
        draft: {
          ...EVALUATION_DRAFT,
          studentFeedback: "Reviewed public feedback",
          teacherNote: "Private edit",
        },
      };
      const approved = await send("approve", reviewed);
      expect(test.createId).toHaveBeenLastCalledWith("event");
      expect(approved.response.status).toBe(200);
      expect(EvaluationResponseSchema.parse(JSON.parse(approved.text)).evaluation).toMatchObject({
        state: "approved",
        draft: reviewed.draft,
      });
      expect((await send("approve", reviewed)).text).toBe(approved.text);
      expect(notices.pending("s1", 32)).toHaveLength(1);
      expect(notices.pending("s1", 32)[0]).toMatchObject({
        text: reviewed.draft.studentFeedback,
        source: "approved-evaluation",
      });
      expect(JSON.stringify(notices.pending("s1", 32))).not.toContain("Private edit");
      expect((await send("approve", reviewRequest())).response.status).toBe(409);
      const latest = await send("query", query);
      expect(latest.text).not.toContain("providerRoute");
      expect(latest.text).not.toContain("evaluation instructions");
    } finally {
      test.database.close();
    }
  });

  it("requires teacher cookies, allowed mutation origins and exact schemas", async () => {
    const test = setup();
    try {
      for (const [action, body] of [
        ["query", query],
        ["generate", evaluationRequest()],
        ["approve", reviewRequest()],
      ] as const) {
        expect(
          (
            await test.app.fetch(
              request(path(action), body, TEACHER_TOKEN, { origin: headers.origin }),
            )
          ).status,
        ).toBe(401);
        expect(
          (
            await test.app.fetch(
              request(path(action), body, undefined, {
                ...headers,
                cookie: `marea_teacher_session=${SESSION_TOKEN}`,
              }),
            )
          ).status,
        ).toBe(403);
        expect(
          (await test.app.fetch(request(`${path(action)}?extra=1`, body, undefined, headers)))
            .status,
        ).toBe(403);
        expect(
          (
            await test.app.fetch(
              request(path(action), { ...body, studentId: "s2" }, undefined, headers),
            )
          ).status,
        ).toBe(400);
      }
      for (const [action, body] of [
        ["generate", evaluationRequest()],
        ["approve", reviewRequest()],
      ] as const) {
        for (const origin of [undefined, "https://attacker.test"]) {
          expect(
            (
              await test.app.fetch(
                request(path(action), body, undefined, {
                  cookie: headers.cookie,
                  ...(origin === undefined ? {} : { origin }),
                }),
              )
            ).status,
          ).toBe(403);
        }
      }
      expect(
        (
          await test.app.fetch(
            request(path("query"), { ...query, runId: "run:c" }, undefined, headers),
          )
        ).status,
      ).toBe(409);
      expect(test.repository.latest(teacher, "run:b")).toBeNull();
    } finally {
      test.database.close();
    }
  });
});
