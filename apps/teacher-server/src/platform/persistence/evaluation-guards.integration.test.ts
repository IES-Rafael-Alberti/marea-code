import { describe, expect, it } from "vitest";
import { IdempotencyKeySchema } from "@marea/protocol";
import {
  evaluationFixture,
  evaluationRequest,
  reviewRequest,
  EVALUATION_DRAFT,
  NOW,
  teacher,
} from "../../../test-support/evaluation-fixture.js";
import { student } from "../../../test-support/teaching-integration.fixture.js";
import { evaluationDigest } from "../../evaluation/evaluation-input.js";

function finish(test: ReturnType<typeof evaluationFixture>, failure = false) {
  const claim = test.repository.claim("worker:guard", NOW);
  if (claim === null) throw new Error("Expected claim");
  test.repository.finish(claim, failure ? "inference-failed" : EVALUATION_DRAFT, NOW);
}
function approve(test: ReturnType<typeof evaluationFixture>, evaluationId = "evaluation:1") {
  return test.repository.approve({
    identity: teacher,
    request: reviewRequest(evaluationId),
    noticeId: `event:${evaluationId}`,
    now: NOW,
  });
}

describe("evaluation ownership and generation guards", () => {
  it("checks permissions independently of draft state", () => {
    const test = evaluationFixture();
    try {
      test.queue();
      finish(test);
      for (const identity of [student, { ...teacher, userId: "t2" }]) {
        const denied = {
          code: identity.role === "teacher" ? "run.unavailable" : "dashboard.forbidden",
        };
        expect(() => test.repository.latest(identity, "run:b")).toThrow(
          expect.objectContaining(denied),
        );
        expect(() =>
          test.repository.queue({
            identity,
            request: evaluationRequest("evaluation:1", "generate:other"),
            evaluationId: "evaluation:other",
            now: NOW,
          }),
        ).toThrow(expect.objectContaining(denied));
        expect(() =>
          test.repository.approve({
            identity,
            request: reviewRequest(),
            noticeId: "event:denied",
            now: NOW,
          }),
        ).toThrow(expect.objectContaining(denied));
      }
    } finally {
      test.database.close();
    }
  });

  it("requires the expected generation before, during and after work", () => {
    const test = evaluationFixture();
    const queue = (expected: string | null) =>
      test.repository.queue({
        identity: teacher,
        request: evaluationRequest(expected, "generate:new"),
        evaluationId: "evaluation:new",
        now: NOW,
      });
    try {
      expect(() => approve(test)).toThrow(expect.objectContaining({ code: "request.conflict" }));
      expect(() => queue("evaluation:missing")).toThrow(
        expect.objectContaining({ code: "request.conflict" }),
      );
      test.queue();
      const claim = test.repository.claim("worker:guard", NOW);
      if (claim === null) throw new Error("Expected claim");
      expect(() => queue("evaluation:1")).toThrow(
        expect.objectContaining({ code: "request.conflict" }),
      );
      test.repository.finish(claim, EVALUATION_DRAFT, NOW);
      expect(() => queue(null)).toThrow(expect.objectContaining({ code: "request.conflict" }));
      queue("evaluation:1");
      finish(test);
      expect(() => approve(test)).toThrow(expect.objectContaining({ code: "request.conflict" }));
      expect(approve(test, "evaluation:new").state).toBe("approved");
    } finally {
      test.database.close();
    }
  });

  it("scopes action keys to authorized teachers and keeps failures SQL-null", () => {
    const test = evaluationFixture();
    try {
      test.queue();
      finish(test, true);
      expect(
        test.database.readOne("SELECT draft_json, failure_code FROM marea_evaluations"),
      ).toEqual({ draft_json: null, failure_code: "inference-failed" });
      test.database.execute(
        "INSERT INTO marea_teacher_classes (teacher_id, class_id) SELECT 't2', class_id FROM marea_teacher_classes WHERE teacher_id = 't1'",
      );
      test.repository.queue({
        identity: { ...teacher, userId: "t2" },
        request: evaluationRequest("evaluation:1"),
        evaluationId: "evaluation:2",
        now: NOW,
      });
      expect(
        test.database.readAll("SELECT action_owner FROM marea_evaluations ORDER BY generation"),
      ).toEqual([{ action_owner: "teacher:t1" }, { action_owner: "teacher:t2" }]);
    } finally {
      test.database.close();
    }
  });

  it("binds approved replays to the reviewing teacher and key, and publishes distinct generations", () => {
    const test = evaluationFixture();
    try {
      test.queue();
      finish(test);
      approve(test);
      test.database.execute(
        "INSERT INTO marea_teacher_classes (teacher_id, class_id) SELECT 't2', class_id FROM marea_teacher_classes WHERE teacher_id = 't1'",
      );
      const review = {
        identity: teacher,
        request: reviewRequest(),
        noticeId: "event:replay",
        now: NOW,
      };
      expect(() =>
        test.repository.approve({ ...review, identity: { ...teacher, userId: "t2" } }),
      ).toThrow(expect.objectContaining({ code: "request.conflict" }));
      expect(() =>
        test.repository.approve({
          ...review,
          request: {
            ...review.request,
            idempotencyKey: IdempotencyKeySchema.parse("review:other"),
          },
        }),
      ).toThrow(expect.objectContaining({ code: "request.conflict" }));
      expect(
        test.database.readOne("SELECT idempotency_key, fingerprint FROM marea_teacher_notices"),
      ).toEqual({
        idempotency_key: `evaluation:${evaluationDigest("evaluation:1").slice(7)}`,
        fingerprint: evaluationDigest(JSON.stringify(["evaluation:1", EVALUATION_DRAFT])),
      });
      test.repository.queue({
        identity: teacher,
        request: evaluationRequest("evaluation:1", "generate:2"),
        evaluationId: "evaluation:2",
        now: NOW,
      });
      finish(test);
      approve(test, "evaluation:2");
      expect(test.database.readAll("SELECT id FROM marea_teacher_notices")).toHaveLength(2);
    } finally {
      test.database.close();
    }
  });
});
