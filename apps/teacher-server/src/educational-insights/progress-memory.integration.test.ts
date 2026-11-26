import { expect, it } from "vitest";
import { EvaluationDraftSchema, RunIdSchema } from "@marea/protocol";
import { EVALUATION_DRAFT, NOW, teacher } from "../../test-support/evaluation-fixture.js";
import { fixture } from "./insights.fixture.js";
import { adaptiveInput, capture, enabled, targetOf } from "./progress.fixture.js";

// Regression scenarios from PR #46 (approvals used to overwrite the reviewed note), adapted to
// the dated, append-only history. Sessions open at midday UTC: the same day in any time zone.
type Result = "passed" | "not-passed" | "no-evidence";

/** Another synthetic session of the fixture student, opened at `openedAt`. */
function session(f: ReturnType<typeof fixture>, id: string, openedAt: string) {
  f.database.execute(
    `INSERT INTO marea_runs (id, student_id, class_id, snapshot_id, client_session_id,
      project_display_name, state, opened_at, closed_at, close_reason)
      SELECT ?1, student_id, class_id, snapshot_id, ?1, project_display_name, state, ?2,
        closed_at, close_reason FROM marea_runs WHERE id = 'run:b'`,
    [id, openedAt],
  );
}

function review(
  f: ReturnType<typeof fixture>,
  captured: ReturnType<typeof capture>,
  runId: string,
  result: Result,
  learningNote?: string,
) {
  const target = targetOf(captured);
  const draft = EvaluationDraftSchema.parse({
    ...EVALUATION_DRAFT,
    criteria: [
      {
        skillId: target.skillId,
        code: target.code,
        result,
        confidence: "high",
        evidence: `Reviewed ${runId}`,
        levelAttempted: target.target,
        ...(learningNote === undefined ? {} : { learningNote }),
      },
    ],
  });
  f.progress.apply(
    { ...adaptiveInput(f, captured), runId: RunIdSchema.parse(runId) },
    draft,
    teacher.userId,
    NOW,
  );
}

const memory = (f: ReturnType<typeof fixture>) =>
  f.database.readOne("SELECT level, memory, memory_run_id FROM marea_learning_progress");

it("adds nothing for no-evidence, blank or absent notes and never erases reviewed notes", () => {
  const f = fixture();
  enabled(f);
  const captured = capture(f);
  session(f, "run:m1", "2026-09-08T12:00:00.000Z");
  session(f, "run:m2", "2026-09-09T12:00:00.000Z");
  session(f, "run:m3", "2026-09-10T12:00:00.000Z");
  session(f, "run:m4", "2026-09-11T12:00:00.000Z");
  review(f, captured, "run:m1", "passed", "Predicts the loop count with support.");
  review(f, captured, "run:m2", "no-evidence", "No answer was recorded.");
  review(f, captured, "run:m3", "passed", "   ");
  review(f, captured, "run:m4", "not-passed");
  expect(memory(f)).toEqual({
    level: 1n,
    memory: "08/09/2026: Predicts the loop count with support.",
    memory_run_id: "run:m1",
  });
  expect(
    f.database.readAll("SELECT run_id, level FROM marea_learning_history ORDER BY run_id"),
  ).toEqual([
    { run_id: "run:m1", level: 1n },
    { run_id: "run:m2", level: 1n },
    { run_id: "run:m3", level: 1n },
    { run_id: "run:m4", level: 1n },
  ]);
});

it("appends every reviewed note in approval order, dated by its own session", () => {
  const f = fixture();
  enabled(f);
  const captured = capture(f);
  session(f, "run:m1", "2026-09-08T12:00:00.000Z");
  session(f, "run:m2", "2026-09-09T12:00:00.000Z");
  session(f, "run:m4", "2026-09-10T12:00:00.000Z");
  review(f, captured, "run:m2", "not-passed", "Confuses find with forEach.");
  // An older session approved later is appended too; its date tells the teacher when it was.
  review(f, captured, "run:m1", "passed", "Older observation.");
  review(f, captured, "run:m4", "not-passed", "  Separates find\n  from forEach.  ");
  expect(memory(f)).toEqual({
    level: 1n,
    memory:
      "09/09/2026: Confuses find with forEach.\n08/09/2026: Older observation.\n10/09/2026: Separates find from forEach.",
    memory_run_id: "run:m4",
  });
  // Approving the same session again is ignored, so nothing is appended twice.
  review(f, captured, "run:m4", "not-passed", "Repeated.");
  expect(memory(f)).toMatchObject({ memory_run_id: "run:m4" });
  expect(String(memory(f)?.memory)).not.toContain("Repeated.");
});

it("keeps the notes through manual level adjustments", () => {
  const f = fixture();
  enabled(f);
  const captured = capture(f);
  review(f, captured, "run:b", "passed", "Reviewed note.");
  const key = targetOf(captured).key;
  f.progress.adjust(
    "class:one",
    "s1",
    [key],
    3,
    "Teacher review",
    f.progress.read("class:one", "s1").revision,
    teacher.userId,
    NOW,
  );
  expect(memory(f)).toEqual({
    level: 3n,
    memory: "07/09/2026: Reviewed note.",
    memory_run_id: "run:b",
  });
  expect(capture(f).snapshot.prompt.content).toContain("07/09/2026: Reviewed note.");
});

it("keeps the notes when the session that wrote them is deleted", () => {
  const f = fixture();
  enabled(f);
  const captured = capture(f);
  session(f, "run:m1", "2026-09-08T12:00:00.000Z");
  review(f, captured, "run:m1", "passed", "Survives retention.");
  f.database.execute("DELETE FROM marea_learning_history WHERE run_id = 'run:m1'");
  f.database.execute("DELETE FROM marea_runs WHERE id = 'run:m1'");
  expect(memory(f)).toEqual({
    level: 1n,
    memory: "08/09/2026: Survives retention.",
    memory_run_id: null,
  });
});
