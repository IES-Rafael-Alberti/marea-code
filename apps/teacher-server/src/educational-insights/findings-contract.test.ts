import { expect, it, vi } from "vitest";
import { SkillIdSchema } from "@marea/protocol";
import { validateFindings } from "./reports.js";
import { fixture } from "./insights.fixture.js";
import { input, query, save } from "./reports.fixture.js";
import { teacher, EVALUATION_DRAFT } from "../../test-support/evaluation-fixture.js";

const skill = SkillIdSchema.parse("marea/testing");
const other = SkillIdSchema.parse("marea/other");
const finding = {
  title: "Shared evidence",
  mode: "tutoring" as const,
  skillIds: [skill, other],
  evaluable: ["A001", "A002"],
  affected: ["A001"],
  evidence: ["run:a"],
  explanation: "Observed",
  recommendation: "Practice",
};
const cases: readonly [string, object, string][] = [
  ["valid", {}, "complete"],
  ["mixed unknown evaluable alias", { evaluable: ["A001", "unknown"] }, "failed"],
  [
    "affected outside denominator",
    { evaluable: ["A001"], affected: ["A001", "A002"], evidence: ["run:a", "run:b"] },
    "failed",
  ],
  ["missing evidence without affected students", { affected: [], evidence: [] }, "failed"],
  ["mixed unknown evidence", { evidence: ["run:a", "missing"] }, "failed"],
  ["unsupported second affected student", { affected: ["A001", "A002"] }, "failed"],
  ["wrong mode", { mode: "free" }, "failed"],
  ["partially supported skills", { skillIds: [skill, "marea/missing"] }, "failed"],
];
it.each(cases)(
  "validates %s findings in the persisted report workflow",
  async (_label, changes, state) => {
    const f = fixture();
    const report = f.service.reports.generate(teacher, query(f));
    const frozen = input(f, report.id);
    const first = frozen.sources[0];
    if (first === undefined) throw new Error("source");
    const evaluation = {
      ...EVALUATION_DRAFT,
      criteria: [skill, other].map((skillId) => ({
        skillId,
        code: "C1",
        result: "passed" as const,
        confidence: "high" as const,
        evidence: "Observed",
      })),
    };
    save(f, report.id, {
      ...frozen,
      sources: [
        { ...first, runId: "run:a", alias: "A001", skills: [skill, other], approved: evaluation },
        { ...first, runId: "run:b", alias: "A002", skills: [skill, other], approved: evaluation },
      ],
    });
    const synthesis = {
      summary: "Reviewed",
      recommendation: "Next",
      findings: [{ ...finding, ...changes }],
    };
    vi.spyOn(f.service.inference, "generate").mockImplementation((_r, _a, _s, _m, schema) =>
      Promise.resolve(schema.parse(synthesis)),
    );
    await f.service.reports.tick();
    const result = f.service.reports.read(report.id, "class:one");
    expect(result.state).toBe(state);
    if (state === "complete") expect(result.result?.synthesis).toEqual(synthesis);
    else expect(result).toMatchObject({ error: "analysis-failed", result: null });
  },
);

it("computes denominators only from students assessed on every requested skill", async () => {
  const f = fixture();
  const report = f.service.reports.generate(teacher, query(f));
  const frozen = input(f, report.id);
  const first = frozen.sources[0];
  if (first === undefined) throw new Error("source");
  const criterion = {
    skillId: skill,
    code: "C1",
    result: "passed" as const,
    confidence: "high" as const,
    evidence: "Observed",
  };
  save(f, report.id, {
    ...frozen,
    sources: [
      {
        ...first,
        runId: "run:a",
        alias: "A001",
        skills: [skill, other],
        approved: { ...EVALUATION_DRAFT, criteria: [criterion, { ...criterion, skillId: other }] },
      },
      {
        ...first,
        runId: "run:b",
        alias: "A002",
        skills: [skill, other],
        approved: { ...EVALUATION_DRAFT, criteria: [criterion] },
      },
    ],
  });
  const synthesis = { summary: "Reviewed", recommendation: "Next", findings: [finding] };
  vi.spyOn(f.service.inference, "generate").mockImplementation((_r, _a, _s, _m, schema) =>
    Promise.resolve(schema.parse(synthesis)),
  );
  await f.service.reports.tick();
  expect(
    f.service.reports.read(report.id, "class:one").result?.synthesis.findings[0]?.evaluable,
  ).toEqual(["A001"]);
});

it("rejects findings supported only by evidence from a different learning mode", () => {
  expect(() => {
    validateFindings(
      { summary: "Reviewed", recommendation: "Next", findings: [{ ...finding, mode: "free" }] },
      [
        {
          runId: "run:a",
          alias: "A001",
          mode: "tutoring",
          skills: [skill, other],
          status: "approved",
          evaluation: EVALUATION_DRAFT,
        },
        {
          runId: "run:b",
          alias: "A002",
          mode: "tutoring",
          skills: [skill, other],
          status: "approved",
          evaluation: EVALUATION_DRAFT,
        },
      ],
    );
  }).toThrow("invalid-findings");
});
