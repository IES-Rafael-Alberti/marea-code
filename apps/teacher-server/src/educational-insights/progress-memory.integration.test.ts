import { expect, it } from "vitest";
import { EvaluationDraftSchema, RunIdSchema } from "@marea/protocol";
import { EVALUATION_DRAFT, NOW, teacher } from "../../test-support/evaluation-fixture.js";
import { fixture } from "./insights.fixture.js";
import { adaptiveInput, capture, enabled, targetOf } from "./progress.fixture.js";

type Result = "passed" | "not-passed" | "no-evidence";

/** Another session of the fixture student, opened at `openedAt`. */
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

it("keeps the reviewed memory when a later approval adds no evidence or an empty note", () => {
  const f = fixture();
  enabled(f);
  const captured = capture(f);
  session(f, "run:m1", "2026-09-08T00:00:00.000Z");
  session(f, "run:m2", "2026-09-09T00:00:00.000Z");
  session(f, "run:m3", "2026-09-10T00:00:00.000Z");
  session(f, "run:m4", "2026-09-11T00:00:00.000Z");
  review(f, captured, "run:m1", "passed", "Predicts the loop count with support.");
  review(f, captured, "run:m2", "no-evidence", "No answer was recorded.");
  review(f, captured, "run:m3", "passed", "   ");
  review(f, captured, "run:m4", "not-passed");
  expect(memory(f)).toEqual({
    level: 1n,
    memory: "Predicts the loop count with support.",
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

it("never lets an older session overwrite the memory written by a newer one", () => {
  const f = fixture();
  enabled(f);
  const captured = capture(f);
  session(f, "run:m1", "2026-09-08T00:00:00.000Z");
  session(f, "run:m2", "2026-09-09T00:00:00.000Z");
  session(f, "run:m3", "2026-09-09T00:00:00.000Z");
  session(f, "run:m4", "2026-09-10T00:00:00.000Z");
  review(f, captured, "run:m2", "not-passed", "Confuses find with forEach.");
  review(f, captured, "run:m1", "passed", "Older observation.");
  expect(memory(f)).toMatchObject({
    memory: "Confuses find with forEach.",
    memory_run_id: "run:m2",
  });
  // A session opened at the same instant is not older, so its reviewed note applies.
  review(f, captured, "run:m3", "not-passed", "Same-time observation.");
  expect(memory(f)).toMatchObject({ memory: "Same-time observation.", memory_run_id: "run:m3" });
  review(f, captured, "run:m4", "not-passed", "  Separates find from forEach.  ");
  expect(memory(f)).toMatchObject({
    memory: "Separates find from forEach.",
    memory_run_id: "run:m4",
  });
});
