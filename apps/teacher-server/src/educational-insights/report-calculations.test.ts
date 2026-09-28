import { SkillIdSchema } from "@marea/protocol";
import { it, expect } from "vitest";
import { computedDenominators } from "./reports.js";
import { anonymizeDraft } from "./anonymize.js";
import { EVALUATION_DRAFT } from "../../test-support/evaluation-fixture.js";
it("counts students once by assessed mode and rejects unobserved affected learners", () => {
  const synthesis = {
    summary: "Summary",
    recommendation: "Practice",
    findings: [
      {
        title: "Problem",
        mode: "tutoring" as const,
        skillIds: [],
        evaluable: ["A"],
        affected: ["A"],
        evidence: ["run:one"],
        explanation: "Evidence",
        recommendation: "Example",
      },
    ],
  };
  const finding = synthesis.findings[0];
  if (finding === undefined) throw new Error("finding");
  const source = {
    runId: "run:one",
    alias: "A",
    mode: "tutoring" as const,
    skills: [],
    status: "approved" as const,
    evaluation: EVALUATION_DRAFT,
  };
  const evidence = [
    source,
    { ...source, runId: "run:two" },
    { ...source, runId: "run:three", alias: "B" },
    { ...source, runId: "run:free", alias: "C", mode: "free" as const },
  ];
  expect(computedDenominators(synthesis, evidence).findings[0]?.evaluable).toEqual(["A", "B"]);
  expect(() => computedDenominators(synthesis, [{ ...source, status: "unavailable" }])).toThrow(
    "invalid-denominator",
  );
  expect(
    computedDenominators(
      {
        ...synthesis,
        findings: [{ ...finding, skillIds: ["skill:a"], affected: [] }],
      },
      evidence,
    ).findings[0]?.evaluable,
  ).toEqual([]);
});
it("pseudonymizes feedback without changing skill and criterion identifiers", () => {
  const draft = {
    ...EVALUATION_DRAFT,
    studentFeedback: "Ana needs help",
    teacherNote: "Ana practiced",
    difficulties: ["Ana: loops"],
    criteria: [
      {
        skillId: SkillIdSchema.parse("marea/ana"),
        code: "Ana",
        result: "passed" as const,
        confidence: "high" as const,
        evidence: "Ana explained",
        learningNote: "Ana: practice",
      },
    ],
  };
  expect(anonymizeDraft(draft, ["Ana", "marea/ana", ""], "A001")).toMatchObject({
    studentFeedback: "A001 needs help",
    teacherNote: "A001 practiced",
    difficulties: ["A001: loops"],
    criteria: [
      {
        skillId: SkillIdSchema.parse("marea/ana"),
        code: "Ana",
        evidence: "A001 explained",
        learningNote: "A001: practice",
      },
    ],
  });
});

it("preserves legacy assessments without a learning note and ignores single-letter identifiers", () => {
  const draft = {
    ...EVALUATION_DRAFT,
    studentFeedback: "A solved this",
    criteria: [
      {
        skillId: SkillIdSchema.parse("marea/testing"),
        code: "C1",
        result: "passed" as const,
        confidence: "high" as const,
        evidence: "A explained",
      },
    ],
  };
  expect(anonymizeDraft(draft, ["A", ""], "A001")).toStrictEqual(draft);
});
