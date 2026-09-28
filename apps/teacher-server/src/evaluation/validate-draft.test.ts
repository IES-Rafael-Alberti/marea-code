import { EvaluationDraftSchema, SkillBundleSchema } from "@marea/protocol";
import { describe, expect, it } from "vitest";

import { validateEvaluationDraft } from "./validate-draft.js";

const skill = SkillBundleSchema.parse({
  id: "marea/testing",
  name: "testing",
  description: "Test reasoning.",
  kind: "didactic",
  source: "marea",
  digest: `sha256:${"a".repeat(64)}`,
  license: null,
  compatibility: null,
  criteria: [
    { code: "C1", statement: "Explain a boundary.", levels: null },
    { code: "C2", statement: "Verify a failure.", levels: null },
  ],
  files: [{ path: "SKILL.md", content: "x", sizeBytes: 1 }],
});
const draft = EvaluationDraftSchema.parse({
  studentFeedback: "You explained the empty input case.",
  teacherNote: "Private observation.",
  difficulties: ["No failure case was discussed."],
  criteria: [
    {
      skillId: skill.id,
      code: "C1",
      result: "passed",
      confidence: "high",
      evidence: "Empty input",
    },
    { skillId: skill.id, code: "C2", result: "no-evidence", confidence: "low", evidence: "" },
  ],
});

describe("evaluation evidence validation", () => {
  it("accepts exactly one assessment per frozen criterion, preserving private fields", () => {
    const result = validateEvaluationDraft(draft, "tutoring", [skill]);
    expect(result).toEqual(draft);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.criteria)).toBe(true);
    expect(Object.isFrozen(result.criteria[0])).toBe(true);
    expect(validateEvaluationDraft({ ...draft, criteria: [] }, "tutoring", [])).toEqual({
      ...draft,
      criteria: [],
    });
  });

  it("rejects duplicate, missing, unknown and unsubstantiated criteria", () => {
    const first = draft.criteria[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new Error("Missing fixture criterion.");
    for (const criteria of [
      [],
      [first],
      [...draft.criteria, first],
      [{ ...first, skillId: skill.id, code: "C3" }, ...draft.criteria.slice(1)],
      [
        {
          ...first,
          skillId: SkillBundleSchema.parse({
            ...skill,
            id: "teacher/other/testing",
            source: "teacher",
          }).id,
        },
        ...draft.criteria.slice(1),
      ],
      [{ ...first, evidence: " \n" }, ...draft.criteria.slice(1)],
      [{ ...first, result: "not-passed" as const, evidence: "" }, ...draft.criteria.slice(1)],
    ])
      expect(() => validateEvaluationDraft({ ...draft, criteria }, "tutoring", [skill])).toThrow(
        expect.objectContaining({ code: "request.conflict" }),
      );
    expect(
      validateEvaluationDraft(
        {
          ...draft,
          criteria: [
            { ...first, result: "not-passed", evidence: "Incorrect boundary" },
            ...draft.criteria.slice(1),
          ],
        },
        "tutoring",
        [skill],
      ).criteria[0]?.result,
    ).toBe("not-passed");
  });

  it("never introduces didactic criteria into a free-mode evaluation", () => {
    const free = { ...draft, criteria: [] };
    expect(validateEvaluationDraft(free, "free", [skill])).toEqual(free);
    expect(() => validateEvaluationDraft(draft, "free", [skill])).toThrow(
      expect.objectContaining({ code: "request.conflict" }),
    );
  });
});
