import { expect, it } from "vitest";
import {
  ReviewedEvidenceQuerySchema,
  ReviewedEvidenceResponseSchema,
  ReviewedCriterionKeySchema,
  ReviewedEvidenceEntrySchema,
  ReviewedStudentSchema,
  ReviewedCriterionSchema,
  ReviewedHistoryCursorSchema,
  REVIEWED_EVIDENCE_PATH,
  MAX_REVIEWED_EVIDENCE_REQUEST_BYTES,
  MAX_REVIEWED_EVIDENCE_RESPONSE_BYTES,
} from "./reviewed-evidence.js";

const scope = { protocolVersion: "0.1", requestId: "evidence:test", classId: "class:one" };
const criterion = {
  skillId: "marea/testing",
  digest: `sha256:${"a".repeat(64)}`,
  code: "boundary",
};
const history = { ...scope, kind: "history", studentId: "s1", criterion };
const cursor = { approvedAt: "2026-09-07T12:00:00.000Z", evaluationId: "evaluation:1" };
it("defines bounded read-only routes and pages with a default of 25", () => {
  expect(REVIEWED_EVIDENCE_PATH).toBe("/api/v1/dashboard/reviewed-evidence/");
  expect(MAX_REVIEWED_EVIDENCE_REQUEST_BYTES).toBe(4096);
  expect(MAX_REVIEWED_EVIDENCE_RESPONSE_BYTES).toBe(1048576);
  for (const query of [
    { ...scope, kind: "students" },
    { ...scope, kind: "criteria", studentId: "s1" },
    history,
  ]) {
    expect(ReviewedEvidenceQuerySchema.parse(query).limit).toBe(25);
    for (const limit of [1, 50])
      expect(ReviewedEvidenceQuerySchema.parse({ ...query, limit }).limit).toBe(limit);
    for (const limit of [0, 51, 1.5])
      expect(ReviewedEvidenceQuerySchema.safeParse({ ...query, limit }).success).toBe(false);
    expect(ReviewedEvidenceQuerySchema.safeParse({ ...query, extra: true }).success).toBe(false);
  }
});
it("keeps operations, cursor kinds and criterion versions distinct", () => {
  expect(ReviewedCriterionKeySchema.parse(criterion)).toEqual(criterion);
  for (const code of ["", "a".repeat(65)])
    expect(ReviewedCriterionKeySchema.safeParse({ ...criterion, code }).success).toBe(false);
  expect(
    ReviewedCriterionKeySchema.parse({ ...criterion, code: "a".repeat(64) }).code,
  ).toHaveLength(64);
  expect(ReviewedEvidenceQuerySchema.safeParse({ ...history, after: "foreign" }).success).toBe(
    false,
  );
  const query = ReviewedEvidenceQuerySchema.parse({ ...scope, kind: "students" });
  expect(
    ReviewedEvidenceResponseSchema.parse({ kind: "students", query, entries: [], next: null }),
  ).toMatchObject({ entries: [] });
  expect(
    ReviewedEvidenceResponseSchema.safeParse({ kind: "history", query, entries: [], next: null })
      .success,
  ).toBe(false);
  expect(
    ReviewedEvidenceResponseSchema.safeParse({
      kind: "students",
      query,
      entries: Array.from({ length: 51 }, () => ({ studentId: "s1", displayName: "Student" })),
      next: null,
    }).success,
  ).toBe(false);
});
it("projects only explicitly allowed evidence fields and bounds identities", () => {
  const entry = {
    skillId: criterion.skillId,
    code: criterion.code,
    result: "no-evidence",
    confidence: "low",
    evidence: "",
    evaluationId: "evaluation:1",
    runId: "run:1",
    generation: 1,
    approvedAt: "2026-09-07T12:00:00.000Z",
    hasLaterApproval: false,
  };
  expect(ReviewedEvidenceEntrySchema.parse(entry)).toEqual(entry);
  for (const extra of [
    { teacherNote: "private" },
    { generation: 0 },
    { generation: 1.5 },
    { hasLaterApproval: "false" },
  ])
    expect(ReviewedEvidenceEntrySchema.safeParse({ ...entry, ...extra }).success).toBe(false);
  expect(
    ReviewedStudentSchema.parse({ studentId: "s1", displayName: "a".repeat(256) }).displayName,
  ).toHaveLength(256);
  for (const displayName of ["", "a".repeat(257)])
    expect(ReviewedStudentSchema.safeParse({ studentId: "s1", displayName }).success).toBe(false);
});

it("bounds every response operation and preserves its exact cursor shape", () => {
  const evidence = {
    skillId: criterion.skillId,
    code: criterion.code,
    result: "passed",
    confidence: "high",
    evidence: "Reviewed",
    evaluationId: cursor.evaluationId,
    runId: "run:1",
    generation: 1,
    approvedAt: cursor.approvedAt,
    hasLaterApproval: true,
  };
  for (const [input, entry, next] of [
    [{ ...scope, kind: "students" }, { studentId: "s1", displayName: "Student" }, "s1"],
    [
      { ...scope, kind: "criteria", studentId: "s1" },
      { ...criterion, statement: "Frozen criterion" },
      criterion,
    ],
    [history, evidence, cursor],
  ] as const) {
    const query = ReviewedEvidenceQuerySchema.parse({ ...input, after: next, limit: 50 });
    const response = {
      kind: input.kind,
      query,
      entries: Array.from({ length: 50 }, () => entry),
      next,
    };
    expect(ReviewedEvidenceResponseSchema.parse(response)).toEqual(response);
    expect(
      ReviewedEvidenceResponseSchema.safeParse({
        ...response,
        entries: [...response.entries, entry],
      }).success,
    ).toBe(false);
    expect(ReviewedEvidenceResponseSchema.safeParse({ ...response, extra: true }).success).toBe(
      false,
    );
  }
  expect(
    ReviewedCriterionSchema.parse({ ...criterion, statement: "a".repeat(1024) }).statement,
  ).toHaveLength(1024);
  expect(
    ReviewedCriterionSchema.safeParse({ ...criterion, statement: "a".repeat(1025) }).success,
  ).toBe(false);
  expect(
    ReviewedCriterionSchema.safeParse({ ...criterion, statement: "", teacherNote: "private" })
      .success,
  ).toBe(false);
  expect(ReviewedHistoryCursorSchema.parse(cursor)).toEqual(cursor);
  expect(ReviewedHistoryCursorSchema.safeParse({ ...cursor, studentId: "forged" }).success).toBe(
    false,
  );
});
