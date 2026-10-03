import { expect, it, vi } from "vitest";
import { EvaluationDraftSchema } from "@marea/protocol";
import { EVALUATION_DRAFT, NOW, teacher } from "../../test-support/evaluation-fixture.js";
import { student } from "../../test-support/teaching-integration.fixture.js";
import { fixture } from "./insights.fixture.js";
import {
  adaptiveInput,
  approve,
  capture,
  enabled,
  passedAssessment,
  targetOf,
} from "./progress.fixture.js";

const levels = ["L1", "L2", "L3", "L4"] as const;
const history = (f: ReturnType<typeof fixture>) =>
  f.database.readAll("SELECT level, reason FROM marea_learning_history ORDER BY id");

it("names the forbidden role and runs authorization inside settings and adjustment writes", () => {
  const f = fixture();
  // The session's role is checked even for an account the database knows as a teacher.
  for (const identity of [student, { ...teacher, role: "student" as const }])
    expect(() => {
      f.progress.require(identity, "class:one");
    }).toThrow("dashboard.forbidden");
  f.progress.require(teacher, "class:one");
  const denied = vi.fn(() => {
    throw new Error("denied");
  });
  expect(() =>
    f.progress.configure("class:one", { map: true, adaptive: true }, "initial", denied),
  ).toThrow("denied");
  expect(f.progress.settings("class:one").revision).toBe("initial");
  expect(() => f.progress.configure("class:one", { map: true, adaptive: true }, "stale")).toThrow(
    "request.conflict",
  );
  enabled(f);
  const key = targetOf(capture(f)).key;
  const { revision } = f.progress.read("class:one", "s1");
  const adjust = (expected: string, authorize?: () => void) => {
    f.progress.adjust("class:one", "s1", [key], 3, "Reviewed", expected, "t1", NOW, authorize);
  };
  expect(() => {
    adjust(revision, denied);
  }).toThrow("denied");
  expect(() => {
    adjust("stale");
  }).toThrow("request.conflict");
  expect(history(f)).toEqual([]);
});

it("adapts the prompt to every unconsolidated criterion's next level and reviewed notes", () => {
  const f = fixture();
  enabled(f);
  const criteria = (["C1", "C2", "C3"] as const).map((code) => ({
    code,
    statement: `Statement ${code}`,
    levels,
  }));
  const first = capture(f, "", criteria);
  const [c1, c2] = first.teaching?.adaptive?.targets ?? [];
  f.database.execute(
    "UPDATE marea_learning_progress SET level = 4, memory = 'Consolidated note' WHERE criterion_key = ?1",
    [c1?.key ?? ""],
  );
  f.database.execute(
    "UPDATE marea_learning_progress SET level = 1, memory = 'Practice empty input' WHERE criterion_key = ?1",
    [c2?.key ?? ""],
  );
  const adapted = capture(f, "", criteria);
  const skill = c1?.skillId ?? "";
  const base = first.snapshot.prompt.content.split("\n\nObjetivos pedagógicos")[0] ?? "";
  expect(adapted.snapshot.prompt.content).toBe(
    `${base}\n\nObjetivos pedagógicos revisados para esta sesión. Adapta la ayuda a estos objetivos sin revelar notas privadas ni presentar niveles como calificaciones:\n${skill}/C2: L2\n${skill}/C3: L1\nSíntesis pedagógica revisada:\n${skill}/C1: Consolidated note\n${skill}/C2: Practice empty input`,
  );
});

it("matches assessments by skill and code, and ignores free sessions and earlier epochs", () => {
  const f = fixture();
  enabled(f);
  const captured = capture(f);
  const target = targetOf(captured);
  const adaptive = adaptiveInput(f, captured);
  const assessment = passedAssessment(target);
  const draft = EvaluationDraftSchema.parse({
    ...EVALUATION_DRAFT,
    criteria: [
      { ...assessment, skillId: "marea/other-skill", result: "not-passed" },
      { ...assessment, code: "other", result: "not-passed" },
      assessment,
    ],
  });
  f.progress.apply({ ...adaptive, mode: "free" }, draft, teacher.userId, NOW);
  expect(history(f)).toEqual([]);
  f.progress.apply(adaptive, draft, teacher.userId, NOW);
  expect(history(f)).toEqual([{ level: 1n, reason: "Observed" }]);
  // A snapshot taken before a manual adjustment no longer advances or rewrites notes.
  f.database.execute("DELETE FROM marea_learning_history");
  f.database.execute("UPDATE marea_learning_progress SET level = 0, epoch = 1");
  approve(f, captured);
  expect(history(f)).toEqual([]);
});

it("never lowers a level that is already above the attempted one", () => {
  const f = fixture();
  enabled(f);
  const captured = capture(f);
  f.database.execute("UPDATE marea_learning_progress SET level = 2");
  approve(f, captured);
  expect(history(f)).toEqual([{ level: 2n, reason: "Observed boundary test" }]);
});
