import { describe, expect, it } from "vitest";
import { SkillIdSchema } from "@marea/protocol";
import { compactEvidence, ModelSynthesisSchema } from "./report-findings.js";
import { PROMPT_RESERVE_BYTES, type Evidence } from "./reports-model.js";
import { EVALUATION_DRAFT } from "../../test-support/evaluation-fixture.js";

const finding = {
  title: "Loops",
  mode: "tutoring",
  skillIds: ["marea/testing"],
  evaluable: ["A001", "A002"],
  affected: ["A001"],
  evidence: ["run:a"],
  explanation: "Observed",
  recommendation: "Practice",
};
const synthesis = { summary: "Summary", findings: [finding], recommendation: "Next" };

describe("ModelSynthesisSchema", () => {
  it("accepts a well formed synthesis unchanged", () => {
    expect(ModelSynthesisSchema.parse(synthesis)).toEqual({ synthesis, dropped: 0 });
  });
  it("strips unknown keys at every level", () => {
    const parsed = ModelSynthesisSchema.parse({
      ...synthesis,
      extra: 1,
      findings: [{ ...finding, confidence: "high" }],
    });
    expect(parsed).toEqual({ synthesis, dropped: 0 });
  });
  it("clamps long text and lists to the report limits", () => {
    const parsed = ModelSynthesisSchema.parse({
      summary: ` ${"s".repeat(5000)} `,
      recommendation: "r".repeat(4000),
      findings: [
        {
          ...finding,
          title: "t".repeat(300),
          explanation: "e".repeat(5000),
          recommendation: "c".repeat(3000),
          skillIds: Array.from({ length: 70 }, (_v, i) => `s${String(i)}`),
          evaluable: Array.from({ length: 1100 }, (_v, i) => `a${String(i)}`),
          affected: ["x".repeat(300)],
          evidence: Array.from({ length: 1001 }, (_v, i) => `r${String(i)}`),
        },
      ],
    });
    const clamped = parsed.synthesis.findings[0];
    expect(parsed.synthesis.summary).toBe("s".repeat(4000));
    expect(parsed.synthesis.recommendation).toBe("r".repeat(3000));
    expect(clamped?.title).toBe("t".repeat(200));
    expect(clamped?.explanation).toBe("e".repeat(4000));
    expect(clamped?.recommendation).toBe("c".repeat(2000));
    expect(clamped?.skillIds).toHaveLength(64);
    expect(clamped?.evaluable).toHaveLength(1000);
    expect(clamped?.affected).toEqual(["x".repeat(256)]);
    expect(clamped?.evidence).toHaveLength(1000);
    expect(parsed.dropped).toBe(0);
  });
  it("trims titles and drops empty identifiers", () => {
    const parsed = ModelSynthesisSchema.parse({
      ...synthesis,
      findings: [{ ...finding, title: "  Loops  ", evaluable: ["", "A001"] }],
    });
    expect(parsed.synthesis.findings[0]).toMatchObject({ title: "Loops", evaluable: ["A001"] });
  });
  it("drops findings that cannot be read and counts them", () => {
    const parsed = ModelSynthesisSchema.parse({
      ...synthesis,
      findings: [
        finding,
        { ...finding, title: "   " },
        { ...finding, mode: "other" },
        { ...finding, affected: [1] },
        "text",
        null,
      ],
    });
    expect(parsed.synthesis.findings).toEqual([finding]);
    expect(parsed.dropped).toBe(5);
  });
  it("keeps at most one hundred findings and counts the rest as dropped", () => {
    const parsed = ModelSynthesisSchema.parse({
      ...synthesis,
      findings: Array.from({ length: 101 }, () => finding),
    });
    expect(parsed.synthesis.findings).toHaveLength(100);
    expect(parsed.dropped).toBe(1);
  });
  it("defaults missing text and findings", () => {
    expect(ModelSynthesisSchema.parse({})).toEqual({
      synthesis: { summary: "", findings: [], recommendation: "" },
      dropped: 0,
    });
    expect(
      ModelSynthesisSchema.parse({
        findings: [
          { title: "T", mode: "free", skillIds: [], evaluable: [], affected: [], evidence: [] },
        ],
      }).synthesis.findings[0],
    ).toMatchObject({ explanation: "", recommendation: "" });
  });
  it("rejects output that is not an object", () => {
    expect(ModelSynthesisSchema.safeParse([]).success).toBe(false);
    expect(ModelSynthesisSchema.safeParse({ summary: 1 }).success).toBe(false);
  });
});

describe("compactEvidence", () => {
  const skill = (value: string) => SkillIdSchema.parse(value);
  const criterion = (id: string, result: "passed" | "not-passed" | "no-evidence") => ({
    skillId: skill(id),
    code: "C1",
    result,
    confidence: "high" as const,
    evidence: "Observed",
  });
  const evidence = (overrides: Partial<Evidence> = {}, note = "Line one\nLine two"): Evidence => ({
    runId: "run:a",
    alias: "A001",
    mode: "tutoring",
    skills: ["marea/a", "marea/b", "marea/c"],
    status: "provisional",
    evaluation: {
      ...EVALUATION_DRAFT,
      teacherNote: note,
      studentFeedback: "Private feedback",
      difficulties: ["d1", "d2", "d3", "d4"],
      criteria: [
        criterion("marea/a", "passed"),
        criterion("marea/a", "no-evidence"),
        criterion("marea/b", "passed"),
        criterion("marea/b", "not-passed"),
        criterion("marea/c", "no-evidence"),
      ],
    },
    ...overrides,
  });
  it("summarises each evaluation with the worst result per skill and no student feedback", () => {
    expect(compactEvidence([evidence()], null)).toEqual([
      {
        runId: "run:a",
        alias: "A001",
        mode: "tutoring",
        skills: ["marea/a", "marea/b", "marea/c"],
        status: "provisional",
        results: { "marea/a": "passed", "marea/b": "not-passed", "marea/c": "no-evidence" },
        note: "Line one",
        difficulties: ["d1", "d2", "d3"],
      },
    ]);
    expect(JSON.stringify(compactEvidence([evidence()], null))).not.toContain("Private feedback");
  });
  it("clips the note and each difficulty", () => {
    const base = evidence().evaluation;
    const [dossier] = compactEvidence(
      [
        evidence({
          evaluation: base && {
            ...base,
            teacherNote: "n".repeat(300),
            difficulties: ["d".repeat(200)],
          },
        }),
      ],
      null,
    );
    expect(dossier?.note).toBe("n".repeat(200));
    expect(dossier?.difficulties).toEqual(["d".repeat(120)]);
  });
  it("tolerates evidence without an evaluation", () => {
    expect(compactEvidence([evidence({ evaluation: null })], null)).toEqual([
      {
        runId: "run:a",
        alias: "A001",
        mode: "tutoring",
        skills: ["marea/a", "marea/b", "marea/c"],
        status: "provisional",
        results: {},
        note: "",
        difficulties: [],
      },
    ]);
  });
  describe("when the input ceiling is tight", () => {
    const many = Array.from({ length: 30 }, (_v, i) =>
      evidence({ runId: `run:${String(i)}`, alias: `A${String(i)}` }, "n".repeat(300)),
    );
    const size = (detail: object) => Buffer.byteLength(JSON.stringify(detail));
    const full = compactEvidence(many, null);
    it("reduces detail step by step until the dossiers fit, never losing a student", () => {
      const reserve = PROMPT_RESERVE_BYTES;
      expect(compactEvidence(many, size(full) + reserve)).toEqual(full);
      const reduced = compactEvidence(many, size(full) + reserve - 1);
      expect(reduced).toHaveLength(30);
      expect(reduced[0]).toMatchObject({ note: "n".repeat(100), difficulties: ["d1"] });
      const minimal = compactEvidence(many, 1);
      expect(minimal).toHaveLength(30);
      expect(minimal[0]).not.toHaveProperty("note");
      expect(minimal[0]).not.toHaveProperty("difficulties");
      expect(minimal[0]).toMatchObject({ alias: "A0" });
      expect(minimal[0]?.results).toEqual({
        "marea/a": "passed",
        "marea/b": "not-passed",
        "marea/c": "no-evidence",
      });
    });
    it("uses the middle level exactly when only it fits", () => {
      const reserve = PROMPT_RESERVE_BYTES;
      const mid = size(compactEvidence(many, size(full) + reserve - 1));
      expect(compactEvidence(many, mid + reserve)[0]).toMatchObject({ note: "n".repeat(100) });
      expect(compactEvidence(many, mid + reserve - 1)[0]).not.toHaveProperty("note");
    });
  });
});
