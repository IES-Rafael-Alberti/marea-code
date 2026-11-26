import { ClassSessionsQuerySchema } from "@marea/protocol";
import { afterEach, expect, it, vi } from "vitest";

import { NOW, setup, withLearningHistory } from "../../../test-support/history-fixture.js";
import type { NodeSqliteTestDatabase } from "../../../test-support/node-sqlite-database.boundary.js";
import { student, teacher } from "../../../test-support/teaching-integration.fixture.js";

const open: NodeSqliteTestDatabase[] = [];
afterEach(() => {
  for (const database of open.splice(0)) database.close();
});

function evaluation(
  database: NodeSqliteTestDatabase,
  runId: string,
  generation: number,
  state: string,
  results?: readonly string[],
) {
  const draft =
    results === undefined
      ? null
      : JSON.stringify({
          criteria: results.map((result, index) => ({ code: `C${String(index)}`, result })),
        });
  database.execute(
    `INSERT INTO marea_evaluations (id, run_id, generation, action_owner, action_key,
      request_fingerprint, input_json, input_digest, state, created_at, updated_at, draft_json)
      VALUES (?1, ?2, ?3, 't1', ?1, 'fingerprint', '{}', 'digest', ?4, ?5, ?5, ?6)`,
    [`evaluation:${runId}:${String(generation)}`, runId, generation, state, NOW, draft],
  );
}

function history(
  database: NodeSqliteTestDatabase,
  runId: string | null,
  key: string,
  previous: number,
  level: number,
) {
  database.execute(
    `INSERT INTO marea_learning_history (class_id, student_id, criterion_key, run_id,
      previous_level, level, reason, actor, created_at)
      VALUES ('class:one', 's1', ?1, ?2, ?3, ?4, 'Reviewed', 't1', ?5)`,
    [key, runId, previous, level, NOW],
  );
}

/** run:a is active with no evaluation, run:b has a mixed draft, run:older an empty approval. */
function reviewed() {
  const { database, service } = setup();
  open.push(database);
  withLearningHistory(database);
  evaluation(database, "run:b", 1, "failed");
  evaluation(database, "run:b", 2, "draft", ["passed", "no-evidence", "not-passed"]);
  evaluation(database, "run:older", 1, "approved", ["no-evidence", "no-evidence"]);
  history(database, "run:older", "C0", 0, 1);
  history(database, "run:older", "C1", 1, 1);
  history(database, null, "C2", 0, 3);
  return { database, service };
}

function query(patch: object = {}) {
  return ClassSessionsQuerySchema.parse({
    kind: "session-history-query",
    protocolVersion: "0.1",
    requestId: "request:classes",
    limit: 50,
    classId: "class:one",
    includeReview: true,
    ...patch,
  });
}

const ids = (page: { runs: readonly { runId: string }[] }) => page.runs.map((run) => run.runId);

it("summarizes the latest evaluation and the progress each approval applied", () => {
  const { service } = reviewed();
  const page = service.listClassSessions(teacher, query());
  expect(page.runs.map((run) => [run.runId, run.review])).toEqual([
    ["run:b", { evaluation: "draft", criteria: 3, evidenced: 2, applied: 0, raised: 0 }],
    ["run:a", { evaluation: "none", criteria: 0, evidenced: 0, applied: 0, raised: 0 }],
    ["run:older", { evaluation: "approved", criteria: 2, evidenced: 0, applied: 2, raised: 1 }],
  ]);
  expect(page).toMatchObject({ kind: "class-sessions-response", nextBeforeRunId: null });
});

it("filters by run state, evaluation state and evidence before paginating", () => {
  const { database, service } = reviewed();
  // A queued generation has no criteria yet, so it is neither with nor without evidence.
  evaluation(database, "run:a", 1, "queued");
  const list = (patch: object) => ids(service.listClassSessions(teacher, query(patch)));
  expect(list({ runState: "active" })).toEqual(["run:a"]);
  expect(list({ runState: "closed" })).toEqual(["run:b", "run:older"]);
  expect(list({ evaluation: ["draft"] })).toEqual(["run:b"]);
  expect(list({ evaluation: ["queued", "approved"] })).toEqual(["run:a", "run:older"]);
  expect(list({ evaluation: ["none"] })).toEqual([]);
  expect(list({ evidence: "with" })).toEqual(["run:b"]);
  expect(list({ evidence: "without" })).toEqual(["run:older"]);
  expect(list({ runState: "closed", evaluation: ["approved"], evidence: "with" })).toEqual([]);
  const first = service.listClassSessions(teacher, query({ limit: 1, runState: "closed" }));
  expect([ids(first), first.nextBeforeRunId]).toEqual([["run:b"], "run:b"]);
  const second = service.listClassSessions(
    teacher,
    query({ limit: 1, runState: "closed", beforeRunId: "run:b" }),
  );
  expect([ids(second), second.nextBeforeRunId]).toEqual([["run:older"], null]);
});

it("searches student and project names ignoring case and accents, across pages", () => {
  const { database, service } = reviewed();
  database.execute("UPDATE marea_users SET display_name = 'Álvaro Núñez' WHERE id = 's1'");
  database.execute("UPDATE marea_runs SET project_display_name = 'Diseño web' WHERE id = 'run:a'");
  const list = (search: string, patch: object = {}) =>
    service.listClassSessions(teacher, query({ search, ...patch }));
  expect(ids(list("alvaro nunez"))).toEqual(["run:b", "run:a", "run:older"]);
  expect(ids(list("NÚÑEZ"))).toEqual(["run:b", "run:a", "run:older"]);
  expect(ids(list("diseno"))).toEqual(["run:a"]);
  // The student and the project name are searched apart, never as one joined text.
  expect(ids(list("nunez diseno"))).toEqual([]);
  expect(ids(list("z d"))).toEqual([]);
  expect(ids(list("DISEÑO"))).toEqual(["run:a"]);
  expect(ids(list("nobody"))).toEqual([]);
  const first = list("alvaro", { limit: 2 });
  expect([ids(first), first.nextBeforeRunId]).toEqual([["run:b", "run:a"], "run:a"]);
  const second = list("alvaro", { limit: 2, beforeRunId: "run:a" });
  expect([ids(second), second.nextBeforeRunId]).toEqual([["run:older"], null]);
});

it("keeps the listing to accessible classes and refuses foreign cursors", () => {
  const { service } = reviewed();
  expect(ids(service.listClassSessions(teacher, query({ classId: undefined })))).toEqual([
    "run:b",
    "run:a",
    "run:older",
  ]);
  expect(ids(service.listClassSessions(teacher, query({ classId: "class:two" })))).toEqual([]);
  expect(ids(service.listClassSessions(student, query({ classId: "class:two" })))).toEqual([]);
  expect(() =>
    service.listClassSessions(teacher, query({ classId: undefined, beforeRunId: "run:c" })),
  ).toThrow("run.unavailable");
  expect(() =>
    service.listClassSessions(teacher, query({ classId: "class:two", beforeRunId: "run:b" })),
  ).toThrow("run.unavailable");
  expect(
    ids(service.listClassSessions(teacher, query({ classId: undefined, beforeRunId: "run:b" }))),
  ).toEqual(["run:a", "run:older"]);
});

it("summarizes only the name matches of a search, even past the first page of candidates", () => {
  const { database, service } = reviewed();
  database.execute("UPDATE marea_runs SET project_display_name = 'Único' WHERE id = 'run:older'");
  const reads = vi.spyOn(database, "readAll");
  // The only match is past the first page of candidates, so the limit must follow the search.
  const page = service.listClassSessions(teacher, query({ limit: 1, search: "unico" }));
  expect([ids(page), page.nextBeforeRunId]).toEqual([["run:older"], null]);
  expect(reads.mock.calls.at(-1)?.[1]?.slice(-2)).toEqual([2, JSON.stringify(["run:older"])]);
  expect(ids(service.listClassSessions(teacher, query({ search: "nobody" })))).toEqual([]);
  expect(reads.mock.calls.at(-1)?.[1]?.at(-1)).toBe("[]");
});

it("keeps the original row shape for dashboards that do not ask for the review", () => {
  const { service } = reviewed();
  const page = service.listClassSessions(teacher, query({ includeReview: undefined }));
  expect(page.runs.map((run) => Object.hasOwn(run, "review"))).toEqual([false, false, false]);
});

it("summarizes a draft with as many criteria as an evaluation may assess", () => {
  const { database, service } = reviewed();
  evaluation(
    database,
    "run:a",
    1,
    "draft",
    Array.from({ length: 4_096 }, () => "passed"),
  );
  expect(service.listClassSessions(teacher, query({ runState: "active" })).runs[0]?.review).toEqual(
    { evaluation: "draft", criteria: 4_096, evidenced: 4_096, applied: 0, raised: 0 },
  );
});

it("summarizes evaluations without educational storage, where no progress can apply", () => {
  const { database, service } = setup();
  open.push(database);
  evaluation(database, "run:b", 1, "approved", ["passed"]);
  expect(service.listClassSessions(teacher, query({ runState: "closed" })).runs[0]).toMatchObject({
    runId: "run:b",
    review: { evaluation: "approved", criteria: 1, evidenced: 1, applied: 0, raised: 0 },
  });
});
