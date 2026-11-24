import { describe, expect, it } from "vitest";
import { fixture } from "./insights.fixture.js";
import { input, query, type FixtureSource } from "./reports.fixture.js";
import { evaluationSchema } from "./report-evaluation.js";
import { teacher } from "../../test-support/evaluation-fixture.js";

const SKILL = "teacher/t1/testing";

function source(mode: "tutoring" | "free" = "tutoring", codes = ["C1", "C2"]): FixtureSource {
  const f = fixture();
  const report = f.service.reports.generate(teacher, query(f));
  const first = input(f, report.id).sources[0];
  if (first === undefined) throw new Error("source");
  const [skill] = first.teaching.didacticSkills;
  if (skill === undefined) throw new Error("skill");
  return {
    ...first,
    mode,
    teaching: {
      ...first.teaching,
      didacticSkills: [
        { ...skill, criteria: codes.map((code) => ({ code, statement: code, levels: null })) },
      ],
    },
  };
}
const criterion = (code: string, extra: object = {}) => ({
  skillId: SKILL,
  code,
  result: "passed",
  confidence: "high",
  evidence: "Observed",
  ...extra,
});
const draft = (criteria: (object | string)[], extra: object = {}) => ({
  studentFeedback: "Feedback",
  teacherNote: "Note",
  difficulties: ["One"],
  criteria,
  ...extra,
});
const parse = (value: object, s = source()) => evaluationSchema(s).safeParse(value);

describe("evaluationSchema", () => {
  it("accepts a draft that covers exactly the listed criteria", () => {
    const parsed = parse(
      draft([criterion("C1"), criterion("C2", { result: "no-evidence", evidence: "" })]),
    );
    expect(parsed.success).toBe(true);
    expect(parsed.data?.criteria.map((c) => [c.code, c.result])).toEqual([
      ["C1", "passed"],
      ["C2", "no-evidence"],
    ]);
  });
  it("strips unknown keys and clamps long text instead of failing", () => {
    const parsed = parse(
      draft(
        [
          criterion("C1", { extra: 1, evidence: "e".repeat(3000), learningNote: "n".repeat(2000) }),
          criterion("C2"),
        ],
        {
          confidence: 0.9,
          studentFeedback: "f".repeat(20000),
          teacherNote: ` ${"t".repeat(20000)}`,
          difficulties: ["d".repeat(3000), "  ", ...Array.from({ length: 70 }, () => "x")],
        },
      ),
    );
    expect(parsed.success).toBe(true);
    const value = parsed.data;
    expect(value).not.toHaveProperty("confidence");
    expect(value?.studentFeedback).toHaveLength(16384);
    expect(value?.teacherNote).toBe("t".repeat(16384));
    expect(value?.difficulties).toHaveLength(64);
    expect(value?.difficulties[0]).toHaveLength(2000);
    expect(value?.criteria[0]?.evidence).toBe("e".repeat(2000));
    expect(value?.criteria[0]?.learningNote).toBe("n".repeat(1000));
    expect(value?.criteria[0]).not.toHaveProperty("extra");
  });
  it("repairs unreadable optional fields", () => {
    const parsed = parse(
      draft(
        [
          criterion("C1", { confidence: "certain", levelAttempted: 9, learningNote: 4 }),
          criterion("C2", { levelAttempted: 3 }),
        ],
        {
          difficulties: "none",
          teacherNote: 5,
        },
      ),
    );
    expect(parsed.data?.criteria[0]).toMatchObject({ confidence: "low" });
    expect(parsed.data?.criteria[0]?.levelAttempted).toBeUndefined();
    expect(parsed.data?.criteria[0]?.learningNote).toBeUndefined();
    expect(parsed.data?.criteria[1]?.levelAttempted).toBe(3);
    expect(parsed.data).toMatchObject({ difficulties: [], teacherNote: "" });
  });
  it("replaces empty feedback, which is never shown to students in a report", () => {
    expect(
      parse(draft([criterion("C1"), criterion("C2")], { studentFeedback: "  " })).data
        ?.studentFeedback,
    ).toBe("-");
    expect(
      parse(draft([criterion("C1"), criterion("C2")], { studentFeedback: undefined })).data
        ?.studentFeedback,
    ).toBe("-");
  });
  it("drops criteria it cannot read and then asks for the complete list", () => {
    const parsed = parse(draft([criterion("C1"), { code: "C2" }, "text"]));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message)).toEqual([
      "criteria must contain exactly one assessment per listed criterion, with evidence for every passed or not-passed result",
    ]);
  });
  it.each([
    ["a missing criterion", [criterion("C1")]],
    ["an unknown criterion", [criterion("C1"), criterion("C2"), criterion("C3")]],
    ["a duplicated criterion", [criterion("C1"), criterion("C1")]],
    ["a passed result without evidence", [criterion("C1", { evidence: "" }), criterion("C2")]],
    ["an invalid skill identifier", [criterion("C1", { skillId: "Bad Id" }), criterion("C2")]],
    ["a skill that is not listed", [criterion("C1", { skillId: "marea/other" }), criterion("C2")]],
  ])("rejects %s", (_label, criteria) => {
    expect(parse(draft(criteria)).success).toBe(false);
  });
  it("accepts an empty criteria list when the skills define none", () => {
    expect(parse(draft([]), source("tutoring", [])).success).toBe(true);
  });
  it("ignores criteria in free mode, where none are assessed", () => {
    const parsed = parse(draft([criterion("C1"), "junk"]), source("free"));
    expect(parsed.success).toBe(true);
    expect(parsed.data?.criteria).toEqual([]);
  });
  it("rejects output that is not an object", () => {
    expect(parse([] as never).success).toBe(false);
  });
});
