import {
  ReviewedEvidenceQuerySchema,
  ReviewedEvidenceResponseSchema,
  ReviewedCriterionKeySchema,
} from "@marea/protocol";
export const criterion = ReviewedCriterionKeySchema.parse({
  skillId: "marea/testing",
  digest: `sha256:${"a".repeat(64)}`,
  code: "boundary",
});
export const query = (extra: object = {}) =>
  ReviewedEvidenceQuerySchema.parse({
    protocolVersion: "0.1",
    requestId: "evidence:test",
    classId: "class:one",
    kind: "students",
    ...extra,
  });
const student = { studentId: "s1", displayName: "Synthetic student" };
export const entry = {
  skillId: criterion.skillId,
  code: criterion.code,
  result: "passed",
  confidence: "high",
  evidence: "Reviewed boundary",
  evaluationId: "evaluation:1",
  runId: "run:1",
  generation: 1,
  approvedAt: "2026-09-07T12:00:00.000Z",
  hasLaterApproval: false,
};
export const page = (extra: object = {}) =>
  ReviewedEvidenceResponseSchema.parse({
    kind: "students",
    query: query(),
    entries: [student],
    next: null,
    ...extra,
  });
