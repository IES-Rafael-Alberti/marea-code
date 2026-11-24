import { expect, it, vi } from "vitest";
import { SkillIdSchema } from "@marea/protocol";
import { validateFindings } from "./report-findings.js";
import { queuedReport, save } from "./reports.fixture.js";
import { EVALUATION_DRAFT } from "../../test-support/evaluation-fixture.js";

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
const cases: readonly [string, object, object | null][] = [
  ["valid", {}, {}],
  ["mixed unknown evaluable alias", { evaluable: ["A001", "unknown"] }, {}],
  [
    "affected outside denominator",
    { evaluable: ["A001"], affected: ["A001", "A002"], evidence: ["run:a", "run:b"] },
    { evidence: ["run:a", "run:b"] },
  ],
  ["missing evidence without affected students", { affected: [], evidence: [] }, null],
  ["mixed unknown evidence", { evidence: ["run:a", "missing"] }, {}],
  ["unsupported second affected student", { affected: ["A001", "A002"] }, {}],
  ["wrong mode", { mode: "free" }, null],
  ["partially supported skills", { skillIds: [skill, "marea/missing"] }, null],
];
const assessed = (skillId: typeof skill) => ({
  skillId,
  code: "C1",
  result: "passed" as const,
  confidence: "high" as const,
  evidence: "Observed",
});
/** Runs a report over two approved sessions, each assessed on the given skills. */
async function completed(
  assessments: readonly [(typeof skill)[], (typeof skill)[]],
  findings: object[],
) {
  const { f, report, frozen, first } = queuedReport();
  save(f, report.id, {
    ...frozen,
    sources: assessments.map((skills, index) => ({
      ...first,
      runId: index === 0 ? "run:a" : "run:b",
      alias: index === 0 ? "A001" : "A002",
      skills: [skill, other],
      approved: { ...EVALUATION_DRAFT, criteria: skills.map(assessed) },
    })),
  });
  const synthesis = { summary: "Reviewed", recommendation: "Next", findings };
  vi.spyOn(f.service.inference, "generate").mockImplementation((_r, _a, _s, _m, schema) =>
    Promise.resolve(schema.parse(synthesis)),
  );
  await f.service.reports.tick();
  return { f, synthesis, report: f.service.reports.read(report.id, "class:one") };
}
const adjustments = (f: Awaited<ReturnType<typeof completed>>["f"]) =>
  vi
    .mocked(f.diagnostics)
    .mock.calls.filter(([entry]) => entry.event === "report-findings-adjusted");

it.each(cases)(
  "repairs %s findings in the persisted report workflow",
  async (label, changes, expected) => {
    const { f, synthesis, report } = await completed(
      [
        [skill, other],
        [skill, other],
      ],
      [{ ...finding, ...changes }],
    );
    expect(report).toMatchObject({ state: "complete", error: null });
    expect(report.result?.synthesis).toEqual({
      ...synthesis,
      findings: expected === null ? [] : [{ ...finding, ...expected }],
    });
    expect(report.result?.partial).toBe(label !== "valid");
    expect(adjustments(f).length > 0).toBe(label !== "valid");
  },
);

it.each([
  ["a student assessed on every skill", {}, ["A001"], undefined],
  [
    "a student dropped by the computed denominator",
    { affected: ["A001", "A002"], evidence: ["run:a", "run:b"] },
    ["A001"],
    1,
  ],
])(
  "computes denominators only from students assessed on every requested skill: %s",
  async (_label, changes, affected, adjusted) => {
    const { f, report } = await completed([[skill, other], [skill]], [{ ...finding, ...changes }]);
    expect(report.result?.synthesis.findings[0]).toMatchObject({ evaluable: ["A001"], affected });
    expect(report.result?.partial).toBe(adjusted !== undefined);
    expect(adjustments(f).map(([entry]) => entry.adjusted)).toEqual(
      adjusted === undefined ? [] : [adjusted],
    );
  },
);

it("drops findings supported only by evidence from a different learning mode", () => {
  expect(
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
    ),
  ).toMatchObject({ adjusted: 1, synthesis: { findings: [] } });
});
