import { describe, expect, it, vi } from "vitest";

import {
  EVALUATION_DRAFT,
  evaluationFixture,
  evaluationRequest,
  reviewRequest,
  NOW,
  teacher,
} from "../../../test-support/evaluation-fixture.js";
import { student } from "../../../test-support/teaching-integration.fixture.js";
import { SqliteNoticeRepository } from "./sqlite-notice-repository.js";
import { evaluationDigest } from "../../evaluation/evaluation-input.js";

describe("durable evaluation lifecycle", () => {
  it("rejects changed frozen bytes and cannot finish or approve an uncaptured input", () => {
    const test = evaluationFixture();
    try {
      test.queue();
      const claim = test.repository.claim("worker:1", NOW);
      if (claim === null) throw new Error("Expected claim");
      const input = JSON.stringify({ ...claim.input, content: null });
      test.database.execute(
        "UPDATE marea_evaluations SET input_json = ?1 WHERE id = 'evaluation:1'",
        [input],
      );
      expect(() => test.repository.latest(teacher, "run:b")).toThrow(
        expect.objectContaining({ code: "request.conflict" }),
      );
      test.database.execute(
        "UPDATE marea_evaluations SET input_digest = ?1 WHERE id = 'evaluation:1'",
        [evaluationDigest(input)],
      );
      expect(() => {
        test.repository.finish(claim, EVALUATION_DRAFT, NOW);
      }).toThrow(expect.objectContaining({ code: "request.conflict" }));
      test.database.execute(
        "UPDATE marea_evaluations SET state = 'draft', draft_json = ?1 WHERE id = 'evaluation:1'",
        [JSON.stringify(EVALUATION_DRAFT)],
      );
      expect(() =>
        test.repository.approve({
          identity: teacher,
          request: reviewRequest(),
          now: NOW,
          noticeId: "event:bad",
        }),
      ).toThrow(expect.objectContaining({ code: "request.conflict" }));
      expect(new SqliteNoticeRepository(test.database).pending("s1", 32)).toEqual([]);
    } finally {
      test.database.close();
    }
  });

  it("rolls back generation if the inserted job cannot be read back", () => {
    const test = evaluationFixture();
    try {
      const read = test.database.readOne.bind(test.database);
      vi.spyOn(test.database, "readOne").mockImplementation((sql, parameters) =>
        sql === "SELECT * FROM marea_evaluations WHERE id = ?1" ? undefined : read(sql, parameters),
      );
      expect(() => test.queue()).toThrow(expect.objectContaining({ code: "request.conflict" }));
      expect(test.database.readAll("SELECT id FROM marea_evaluations")).toEqual([]);
    } finally {
      test.database.close();
    }
  });
  it("queues and claims once, freezes inputs and stores a private draft", () => {
    const test = evaluationFixture();
    try {
      expect(test.repository.latest(teacher, "run:b")).toBeNull();
      const queued = test.queue();
      expect(queued).toMatchObject({
        state: "queued",
        generation: 1,
        evaluationId: "evaluation:1",
      });
      expect(test.queue()).toEqual(queued);
      expect(test.repository.latest(teacher, "run:b")).toEqual(queued);
      const claim = test.repository.claim("worker:1", NOW);
      expect(claim).toMatchObject({ evaluationId: queued.evaluationId, workerToken: "worker:1" });
      expect(claim?.input.content?.events).toHaveLength(4);
      expect(claim?.input.content?.teaching.evaluationSkills[0]?.files[0]?.content).toContain(
        "evaluation instructions",
      );
      expect(test.repository.claim("worker:2", NOW)).toBeNull();
      expect(test.repository.latest(teacher, "run:b")).toMatchObject({ state: "running" });
      if (claim === null) throw new Error("Expected claimed work.");
      test.repository.finish(claim, EVALUATION_DRAFT, NOW);
      expect(test.repository.latest(teacher, "run:b")).toMatchObject({
        state: "draft",
        draft: EVALUATION_DRAFT,
      });
      expect(new SqliteNoticeRepository(test.database).pending("s1", 32)).toEqual([]);
      expect(() => {
        test.repository.finish(claim, EVALUATION_DRAFT, NOW);
      }).toThrow(expect.objectContaining({ code: "request.conflict" }));
    } finally {
      test.database.close();
    }
  });

  it("approves and sends exactly the reviewed public feedback atomically", () => {
    const test = evaluationFixture();
    try {
      test.queue();
      const claim = test.repository.claim("worker:1", NOW);
      if (claim === null) throw new Error("Expected claimed work.");
      test.repository.finish(claim, EVALUATION_DRAFT, NOW);
      const request = {
        identity: teacher,
        request: reviewRequest(),
        noticeId: "event:feedback",
        now: NOW,
      };
      const approved = test.repository.approve(request);
      expect(approved).toMatchObject({
        state: "approved",
        noticeId: request.noticeId,
        approvedAt: NOW,
      });
      expect(test.repository.approve({ ...request, noticeId: "event:duplicate" })).toEqual(
        approved,
      );
      const notices = new SqliteNoticeRepository(test.database).pending("s1", 32);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        source: "approved-evaluation",
        text: EVALUATION_DRAFT.studentFeedback,
      });
      expect(JSON.stringify(notices)).not.toContain(EVALUATION_DRAFT.teacherNote);
      expect(JSON.stringify(notices)).not.toContain("difficulties");
      expect(() =>
        test.repository.approve({
          ...request,
          request: { ...request.request, draft: { ...EVALUATION_DRAFT, teacherNote: "changed" } },
        }),
      ).toThrow(expect.objectContaining({ code: "request.conflict" }));
    } finally {
      test.database.close();
    }
  });

  it("retries in a fresh generation without inheriting approval and rejects stale reviews", () => {
    const test = evaluationFixture();
    try {
      const original = test.queue();
      const claim = test.repository.claim("worker:1", NOW);
      if (claim === null) throw new Error("Expected claimed work.");
      test.repository.finish(claim, EVALUATION_DRAFT, NOW);
      test.repository.approve({
        identity: teacher,
        request: reviewRequest(),
        noticeId: "event:feedback",
        now: NOW,
      });
      test.database.execute("DELETE FROM marea_run_teaching_snapshots");
      const next = test.repository.queue({
        identity: teacher,
        request: evaluationRequest(original.evaluationId, "generate:2"),
        evaluationId: "evaluation:2",
        now: NOW,
      });
      expect(next).toMatchObject({
        state: "queued",
        generation: 2,
        inputDigest: original.inputDigest,
      });
      expect(next).not.toHaveProperty("draft");
      expect(next).not.toHaveProperty("noticeId");
      expect(() =>
        test.repository.approve({
          identity: teacher,
          request: reviewRequest(),
          noticeId: "event:stale",
          now: NOW,
        }),
      ).toThrow(expect.objectContaining({ code: "request.conflict" }));
      expect(test.repository.claim("worker:2", NOW)?.input).toEqual(claim.input);
      expect(new SqliteNoticeRepository(test.database).pending("s1", 32)).toHaveLength(1);
    } finally {
      test.database.close();
    }
  });

  it("rejects cross-class, role-confused, stale and concurrent generation requests", () => {
    const test = evaluationFixture();
    try {
      for (const identity of [student, { ...teacher, userId: "t2" }]) {
        expect(() => test.repository.latest(identity, "run:b")).toThrow();
        expect(() =>
          test.repository.queue({
            identity,
            request: evaluationRequest(),
            evaluationId: "evaluation:bad",
            now: NOW,
          }),
        ).toThrow();
        expect(() =>
          test.repository.approve({
            identity,
            request: reviewRequest(),
            noticeId: "event:bad",
            now: NOW,
          }),
        ).toThrow();
      }
      const queued = test.queue();
      for (const request of [
        evaluationRequest(null, "generate:2"),
        evaluationRequest(queued.evaluationId, "generate:2"),
        evaluationRequest(queued.evaluationId),
      ])
        expect(() =>
          test.repository.queue({
            identity: teacher,
            request,
            evaluationId: "evaluation:2",
            now: NOW,
          }),
        ).toThrow(expect.objectContaining({ code: "request.conflict" }));
      expect(() =>
        test.repository.approve({
          identity: teacher,
          request: reviewRequest(),
          noticeId: "event:bad",
          now: NOW,
        }),
      ).toThrow();
      test.database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
      expect(() => test.queue()).toThrow(expect.objectContaining({ code: "run.unavailable" }));
    } finally {
      test.database.close();
    }
  });

  it("preserves failed work, invalidates interrupted worker tokens and permits explicit retry", () => {
    const test = evaluationFixture();
    try {
      const original = test.queue();
      const claim = test.repository.claim("worker:1", NOW);
      if (claim === null) throw new Error("Expected claimed work.");
      test.repository.recoverInterrupted("2026-09-08T00:00:00.000Z");
      test.repository.recoverInterrupted("2026-09-09T00:00:00.000Z");
      expect(test.repository.latest(teacher, "run:b")).toMatchObject({
        state: "failed",
        failure: "interrupted",
        updatedAt: "2026-09-08T00:00:00.000Z",
      });
      expect(() => {
        test.repository.finish(claim, EVALUATION_DRAFT, NOW);
      }).toThrow();
      test.repository.queue({
        identity: teacher,
        request: evaluationRequest(original.evaluationId, "generate:2"),
        evaluationId: "evaluation:2",
        now: NOW,
      });
      const next = test.repository.claim("worker:2", NOW);
      if (next === null) throw new Error("Expected retry work.");
      test.repository.finish(next, "inference-failed", NOW);
      expect(test.repository.latest(teacher, "run:b")).toMatchObject({
        state: "failed",
        failure: "inference-failed",
      });
    } finally {
      test.database.close();
    }
  });

  it("rolls back the notice if the matching approval cannot be stored", () => {
    const test = evaluationFixture();
    try {
      test.queue();
      const claim = test.repository.claim("worker:1", NOW);
      if (claim === null) throw new Error("Expected claimed work.");
      test.repository.finish(claim, EVALUATION_DRAFT, NOW);
      const execute = test.database.execute.bind(test.database);
      vi.spyOn(test.database, "execute").mockImplementation((sql, parameters) => {
        if (sql.includes("SET state = 'approved'")) throw new Error("Synthetic commit failure.");
        execute(sql, parameters);
      });
      expect(() =>
        test.repository.approve({
          identity: teacher,
          request: reviewRequest(),
          noticeId: "event:feedback",
          now: NOW,
        }),
      ).toThrow("Synthetic commit failure.");
      expect(test.repository.latest(teacher, "run:b")).toMatchObject({ state: "draft" });
      expect(new SqliteNoticeRepository(test.database).pending("s1", 32)).toEqual([]);
    } finally {
      test.database.close();
    }
  });
});
