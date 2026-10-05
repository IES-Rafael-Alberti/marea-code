import { describe, expect, it } from "vitest";

import {
  CriterionAssessmentSchema,
  EvaluationDraftSchema,
  MAX_EVALUATION_DRAFT_BYTES,
} from "./evaluation-draft.js";

const assessment = {
  skillId: "marea/testing",
  code: "C1",
  result: "no-evidence",
  confidence: "low",
  evidence: "",
};
const draft = {
  studentFeedback: "Public feedback.",
  teacherNote: "",
  difficulties: [],
  criteria: [],
};

describe("private evaluation draft protocol", () => {
  it("bounds the complete serialized UTF-8 draft, including byte-exact limits", () => {
    function payload(bytes: number) {
      const value = {
        ...draft,
        criteria: Array.from({ length: 1_024 }, () => ({ ...assessment })),
      };
      let remaining = bytes - new TextEncoder().encode(JSON.stringify(value)).byteLength;
      for (const criterion of value.criteria) {
        const length = Math.min(remaining, 2_000);
        criterion.evidence = "x".repeat(length);
        remaining -= length;
      }
      expect(remaining).toBe(0);
      return value;
    }
    expect(MAX_EVALUATION_DRAFT_BYTES).toBe(2_097_152);
    expect(EvaluationDraftSchema.safeParse(payload(MAX_EVALUATION_DRAFT_BYTES)).success).toBe(true);
    expect(() => EvaluationDraftSchema.parse(payload(MAX_EVALUATION_DRAFT_BYTES + 1))).toThrow(
      "The evaluation draft exceeds its serialized byte limit.",
    );
    expect(
      EvaluationDraftSchema.safeParse({
        ...draft,
        criteria: Array.from({ length: 1_024 }, () => ({
          ...assessment,
          evidence: "€".repeat(1_000),
        })),
      }).success,
    ).toBe(false);
  });
  it("accepts immutable bounded criterion proposals, never an approval", () => {
    expect(CriterionAssessmentSchema.parse(assessment)).toEqual(assessment);
    expect(Object.isFrozen(CriterionAssessmentSchema.parse(assessment))).toBe(true);
    for (const result of ["passed", "not-passed", "no-evidence"])
      for (const confidence of ["low", "medium", "high"])
        expect(CriterionAssessmentSchema.parse({ ...assessment, result, confidence })).toEqual({
          ...assessment,
          result,
          confidence,
        });
    const full = { ...assessment, code: "c".repeat(64), evidence: "e".repeat(2_000) };
    expect(CriterionAssessmentSchema.parse(full)).toEqual(full);
    expect(
      CriterionAssessmentSchema.parse({ ...assessment, code: "c", evidence: " x " }).evidence,
    ).toBe("x");
    for (const invalid of [
      { skillId: "bad" },
      { code: "" },
      { code: "c".repeat(65) },
      { result: "approved" },
      { confidence: "certain" },
      { evidence: "e".repeat(2_001) },
      { approved: true },
      { level: 4 },
    ])
      expect(CriterionAssessmentSchema.safeParse({ ...assessment, ...invalid }).success).toBe(
        false,
      );
  });

  it("bounds adaptive guidance and accepts every attempted learning level", () => {
    for (const levelAttempted of [1, 2, 3, 4]) {
      const value = { ...assessment, levelAttempted, learningNote: "Practice independently" };
      expect(CriterionAssessmentSchema.parse(value)).toEqual(value);
    }
    expect(
      CriterionAssessmentSchema.parse({ ...assessment, learningNote: "n".repeat(1000) })
        .learningNote,
    ).toHaveLength(1000);
    for (const invalid of [
      { learningNote: "n".repeat(1001) },
      { levelAttempted: 0 },
      { levelAttempted: 5 },
      { levelAttempted: 1.5 },
    ])
      expect(CriterionAssessmentSchema.safeParse({ ...assessment, ...invalid }).success).toBe(
        false,
      );
  });

  it("keeps public feedback separate from bounded private notes and difficulties", () => {
    expect(EvaluationDraftSchema.parse(draft)).toEqual(draft);
    const parsed = EvaluationDraftSchema.parse({
      ...draft,
      studentFeedback: " Public feedback. ",
      teacherNote: " Private note. ",
      difficulties: [" Difficulty. "],
      criteria: [assessment],
    });
    expect(parsed).toEqual({
      ...draft,
      teacherNote: "Private note.",
      difficulties: ["Difficulty."],
      criteria: [assessment],
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.difficulties)).toBe(true);
    expect(Object.isFrozen(parsed.criteria)).toBe(true);
    expect(Object.isFrozen(parsed.criteria[0])).toBe(true);
    const full = {
      ...draft,
      teacherNote: "n".repeat(16_384),
      difficulties: Array.from({ length: 64 }, () => "d".repeat(2_000)),
      criteria: Array.from({ length: 4_096 }, () => assessment),
    };
    expect(EvaluationDraftSchema.parse(full)).toEqual(full);
    for (const invalid of [
      { studentFeedback: "" },
      { teacherNote: "n".repeat(16_385) },
      { difficulties: [""] },
      { difficulties: [" \n"] },
      { difficulties: ["d".repeat(2_001)] },
      { difficulties: Array.from({ length: 65 }, () => "d") },
      { criteria: Array.from({ length: 4_097 }, () => assessment) },
      { criteria: [{}] },
      { approved: true },
      { teacherId: "teacher:1" },
      { noticeId: "notice:1" },
    ])
      expect(EvaluationDraftSchema.safeParse({ ...draft, ...invalid }).success).toBe(false);
    expect(EvaluationDraftSchema.parse({ ...draft, difficulties: ["d"] }).difficulties).toEqual([
      "d",
    ]);
  });
});
