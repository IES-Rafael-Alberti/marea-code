import { describe, expect, it } from "vitest";

import {
  ApproveEvaluationRequestSchema,
  EvaluationFailureSchema,
  EvaluationQuerySchema,
  EvaluationResponseSchema,
  GenerateEvaluationRequestSchema,
  TeacherEvaluationSchema,
} from "./evaluations.js";

const digest = `sha256:${"a".repeat(64)}`;
const reference = { id: "marea/review", digest };
const record = {
  evaluationId: "evaluation:one",
  runId: "run:one",
  generation: 1,
  snapshotId: "snapshot:one",
  inputDigest: digest,
  evaluator: reference,
  didacticSkills: [],
  createdAt: "2026-09-08T08:00:00.000Z",
  updatedAt: "2026-09-08T08:00:00.000Z",
};
const draft = {
  studentFeedback: "Reviewed text",
  teacherNote: "Private note",
  difficulties: [],
  criteria: [],
};
const envelope = { protocolVersion: "0.1", requestId: "request:one" };
const query = { ...envelope, kind: "evaluation-query", runId: "run:one" };
const generate = {
  ...envelope,
  kind: "evaluation-generate",
  runId: "run:one",
  expectedEvaluationId: null,
  idempotencyKey: "generate:one",
};
const approve = {
  ...envelope,
  kind: "evaluation-approve-send",
  runId: "run:one",
  evaluationId: "evaluation:one",
  idempotencyKey: "review:one",
  draft,
};

describe("teacher evaluation wire contracts", () => {
  it("models immutable distinct lifecycle states and exposes approval provenance only after approval", () => {
    const states = [
      { state: "queued" },
      { state: "running" },
      { state: "failed", failure: "interrupted" },
      { state: "draft", draft },
      { state: "approved", draft, noticeId: "notice:one", approvedAt: record.updatedAt },
    ];
    for (const state of states) {
      const parsed = TeacherEvaluationSchema.parse({ ...record, ...state });
      expect(parsed).toEqual({ ...record, ...state });
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed.evaluator)).toBe(true);
      expect(Object.isFrozen(parsed.didacticSkills)).toBe(true);
      for (const extra of [{ providerRoute: {} }, { input: {} }, { studentId: "student:other" }])
        expect(TeacherEvaluationSchema.safeParse({ ...parsed, ...extra }).success).toBe(false);
    }
    for (const invalid of [
      { state: "queued", draft },
      { state: "running", failure: "interrupted" },
      { state: "failed" },
      { state: "draft" },
      { state: "draft", draft, noticeId: "notice:one" },
      { state: "approved", draft },
      { state: "approved", draft, noticeId: "notice:one", approvedAt: "today" },
      { state: "published", draft },
    ])
      expect(TeacherEvaluationSchema.safeParse({ ...record, ...invalid }).success).toBe(false);
  });

  it("validates frozen versions, bounded references and sanitized failure categories", () => {
    for (const failure of [
      "interrupted",
      "inference-failed",
      "invalid-draft",
      "input-too-large",
      "unconfigured",
    ]) {
      expect(EvaluationFailureSchema.parse(failure)).toBe(failure);
      expect(TeacherEvaluationSchema.parse({ ...record, state: "failed", failure })).toMatchObject({
        failure,
      });
    }
    expect(EvaluationFailureSchema.safeParse("provider says private key").success).toBe(false);
    const full = TeacherEvaluationSchema.parse({
      ...record,
      state: "queued",
      didacticSkills: Array.from({ length: 64 }, () => reference),
    });
    expect(full.didacticSkills).toHaveLength(64);
    expect(Object.isFrozen(full.didacticSkills[0])).toBe(true);
    for (const patch of [
      { evaluationId: "bad/id" },
      { runId: "" },
      { generation: 0 },
      { generation: 1.5 },
      { snapshotId: "" },
      { inputDigest: "wrong" },
      { evaluator: { ...reference, digest: "wrong" } },
      { evaluator: { ...reference, id: "invalid" } },
      { evaluator: { ...reference, files: [] } },
      { didacticSkills: Array.from({ length: 65 }, () => reference) },
      { createdAt: "today" },
      { updatedAt: "today" },
    ])
      expect(
        TeacherEvaluationSchema.safeParse({ ...record, state: "queued", ...patch }).success,
      ).toBe(false);
  });

  it("requires explicit generation preconditions and whole reviewed drafts with stable action keys", () => {
    expect(EvaluationQuerySchema.parse(query)).toEqual(query);
    expect(GenerateEvaluationRequestSchema.parse(generate)).toEqual(generate);
    expect(
      GenerateEvaluationRequestSchema.parse({
        ...generate,
        expectedEvaluationId: "evaluation:previous",
      }).expectedEvaluationId,
    ).toBe("evaluation:previous");
    expect(ApproveEvaluationRequestSchema.parse(approve)).toEqual(approve);
    expect(Object.isFrozen(EvaluationQuerySchema.parse(query))).toBe(true);
    expect(Object.isFrozen(GenerateEvaluationRequestSchema.parse(generate))).toBe(true);
    expect(Object.isFrozen(ApproveEvaluationRequestSchema.parse(approve))).toBe(true);
    for (const [schema, value] of [
      [EvaluationQuerySchema, query],
      [GenerateEvaluationRequestSchema, generate],
      [ApproveEvaluationRequestSchema, approve],
    ] as const) {
      for (const invalid of [
        { protocolVersion: "future" },
        { requestId: "" },
        { kind: "" },
        { runId: "bad/id" },
        { teacherId: "teacher:other" },
        { approved: true },
      ])
        expect(schema.safeParse({ ...value, ...invalid }).success).toBe(false);
    }
    for (const invalid of [
      { expectedEvaluationId: undefined },
      { expectedEvaluationId: "bad/id" },
      { idempotencyKey: "" },
    ])
      expect(GenerateEvaluationRequestSchema.safeParse({ ...generate, ...invalid }).success).toBe(
        false,
      );
    for (const invalid of [
      { evaluationId: "" },
      { idempotencyKey: "" },
      { draft: undefined },
      { draft: { ...draft, approved: true } },
    ])
      expect(ApproveEvaluationRequestSchema.safeParse({ ...approve, ...invalid }).success).toBe(
        false,
      );
  });

  it("returns an explicit nullable evaluation with a strict versioned response envelope", () => {
    const response = { ...envelope, kind: "evaluation-response", evaluation: null };
    expect(EvaluationResponseSchema.parse(response)).toEqual(response);
    expect(Object.isFrozen(EvaluationResponseSchema.parse(response))).toBe(true);
    expect(
      EvaluationResponseSchema.parse({
        ...response,
        evaluation: { ...record, state: "draft", draft },
      }).evaluation,
    ).toMatchObject({ state: "draft", draft });
    for (const invalid of [
      { kind: "" },
      { requestId: "" },
      { protocolVersion: "future" },
      { evaluation: undefined },
      { evaluation: {} },
      { input: "private" },
    ])
      expect(EvaluationResponseSchema.safeParse({ ...response, ...invalid }).success).toBe(false);
  });
});
