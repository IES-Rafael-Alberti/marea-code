import { SqliteEvaluationRepository } from "../platform/persistence/sqlite-evaluation-repository.js";
import { reviewRequest } from "../../test-support/evaluation-fixture.js";
import { describe, expect, it, vi } from "vitest";
import {
  createEducationalMigrationCatalog,
  createProfileMigrationCatalog,
} from "@marea/sqlite-storage/catalogs";
import { EvaluationDraftSchema, SnapshotIdSchema, StudentRunSnapshotSchema } from "@marea/protocol";
import { EVALUATION_DRAFT, NOW, teacher } from "../../test-support/evaluation-fixture.js";
import { student } from "../../test-support/teaching-integration.fixture.js";
import { teachingConfiguration } from "../../test-support/teaching-fixture.js";
import { renderReport } from "./service.js";
import { validateFindings } from "./reports.js";
import { captureEvaluationInput } from "../platform/persistence/sqlite-evaluation-input.js";

import { fixture } from "./insights.fixture.js";
function capture(f: ReturnType<typeof fixture>, statement = "Validate boundaries") {
  const configuration = teachingConfiguration();
  const skill = configuration.content.didacticSkills[0];
  if (skill === undefined) throw new Error("skill");
  const teaching = {
    ...configuration.content,
    didacticSkills: [{ ...skill, criteria: [{ code: "C1", statement, levels: null }] }],
  };
  const snapshot = StudentRunSnapshotSchema.parse({
    ...configuration.publicTemplate,
    id: SnapshotIdSchema.parse("snapshot:adaptive"),
  });
  return f.progress.capture(
    { snapshot, providerRoute: configuration.providerRoute, teaching },
    student,
  );
}
function targetOf(captured: ReturnType<typeof capture>) {
  const target = captured.teaching?.adaptive?.targets[0];
  if (target === undefined) throw new Error("target");
  return target;
}
function enabled(f: ReturnType<typeof fixture>) {
  f.progress.configure("class:one", { map: true, adaptive: true }, "initial");
}
function approve(
  f: ReturnType<typeof fixture>,
  captured: ReturnType<typeof capture>,
  passed = true,
) {
  const input = captureEvaluationInput(f.database, "run:b");
  const target = targetOf(captured);
  if (input.content === null || captured.teaching === undefined) throw new Error("input");
  const draft = EvaluationDraftSchema.parse({
    ...EVALUATION_DRAFT,
    criteria: [
      {
        skillId: target.skillId,
        code: target.code,
        result: passed ? "passed" : "not-passed",
        confidence: "high",
        evidence: "Observed boundary test",
        levelAttempted: target.target,
        learningNote: "Practice an empty collection next.",
      },
    ],
  });
  f.progress.apply(
    { ...input, mode: "tutoring", content: { ...input.content, teaching: captured.teaching } },
    draft,
    teacher.userId,
    NOW,
  );
}

describe("educational persistence and authorization", () => {
  it("preserves the schema-10 migration and appends a single migration", () => {
    expect(createEducationalMigrationCatalog().slice(0, 10)).toEqual(
      createProfileMigrationCatalog(),
    );
    expect(createEducationalMigrationCatalog().at(-1)?.version).toBe(11);
  });
  it("defaults off, checks teacher membership and detects stale settings", () => {
    const f = fixture();
    expect(f.progress.settings("class:one").settings).toEqual({ map: false, adaptive: false });
    expect(() => f.service.read(student, f.query({ kind: "settings" }))).toThrow();
    expect(() =>
      f.service.read({ ...teacher, userId: "t2" }, f.query({ kind: "settings" })),
    ).toThrow();
    expect(
      f.service.read(
        teacher,
        f.query({
          kind: "configure",
          settings: { map: true, adaptive: true },
          expectedRevision: "initial",
        }),
      ),
    ).toMatchObject({ data: { settings: { map: true } } });
    expect(() =>
      f.progress.configure("class:one", { map: false, adaptive: false }, "initial"),
    ).toThrow();
  });
  it("freezes next targets, advances only once and uses reviewed memory", () => {
    const f = fixture();
    enabled(f);
    const first = capture(f);
    expect(targetOf(first)).toMatchObject({ achieved: 0, target: 1 });
    approve(f, first);
    approve(f, first);
    const next = capture(f);
    expect(targetOf(next)).toMatchObject({ achieved: 1, target: 2 });
    expect(next.snapshot.prompt.content).toContain("Practice an empty collection next.");
    expect(targetOf(first).target).toBe(1);
  });
  it("starts a new definition after criterion edits but keeps old history", () => {
    const f = fixture();
    enabled(f);
    const old = capture(f);
    approve(f, old);
    const next = capture(f, "A genuinely different criterion");
    expect(targetOf(next).key).not.toBe(targetOf(old).key);
    expect(targetOf(next).achieved).toBe(0);
    expect(f.database.readAll("SELECT * FROM marea_learning_progress")).toHaveLength(2);
  });
  it("manual adjustments invalidate old snapshots and retain the audit reason", () => {
    const f = fixture();
    enabled(f);
    const old = capture(f);
    const state = f.progress.read("class:one", "s1", null);
    if (state.revision === undefined) throw new Error("revision");
    f.progress.adjust(
      "class:one",
      "s1",
      [targetOf(old).key],
      2,
      "Reviewed practical work",
      state.revision,
      teacher.userId,
      NOW,
    );
    approve(f, old);
    expect(targetOf(capture(f))).toMatchObject({ achieved: 2, target: 3, epoch: 1 });
    expect(f.database.readOne("SELECT reason FROM marea_learning_history")?.reason).toBe(
      "Reviewed practical work",
    );
    expect(() => {
      f.progress.adjust(
        "class:one",
        "s1",
        [targetOf(old).key],
        0,
        "Reset",
        state.revision,
        teacher.userId,
        NOW,
      );
    }).toThrow();
  });
  it("does not backfill or adapt free mode or paused classes", () => {
    const f = fixture();
    expect(capture(f).teaching?.adaptive).toBeUndefined();
    enabled(f);
    const captured = capture(f);
    const free = {
      ...captured,
      snapshot: StudentRunSnapshotSchema.parse({ ...captured.snapshot, agentMode: "free" }),
    };
    expect(f.progress.capture(free, student)).toBe(free);
    const { revision } = f.progress.settings("class:one");
    f.progress.configure("class:one", { map: false, adaptive: false }, revision);
    expect(capture(f).teaching?.adaptive).toBeUndefined();
  });
});

describe("class report lifecycle", () => {
  it("queues a frozen report and rejects other classes", () => {
    const f = fixture();
    const report = f.service.reports.generate(
      teacher,
      f.query({
        kind: "generate",
        from: "2026-01-01T00:00:00.000Z",
        to: NOW,
        locale: "es",
      }) as Extract<ReturnType<typeof f.query>, { kind: "generate" }>,
    );
    expect(report.state).toBe("queued");
    expect(report.total).toBeGreaterThan(0);
    expect(() =>
      f.service.read(
        { ...teacher, userId: "t2" },
        f.query({ kind: "report", reportId: report.id }),
      ),
    ).toThrow();
  });
  it("marks provisional evidence, calculates findings only from valid aliases and persists results", async () => {
    const f = fixture();
    vi.spyOn(f.service.inference, "generate").mockImplementation(
      (_route, _account, system, _material, schema) =>
        Promise.resolve(
          schema.parse(
            system.startsWith("Draft")
              ? EVALUATION_DRAFT
              : {
                  summary: "One group needs practice",
                  findings: [],
                  recommendation: "Practice boundaries",
                },
          ),
        ),
    );
    const q = f.query({
      kind: "generate",
      from: "2026-01-01T00:00:00.000Z",
      to: NOW,
      locale: "es",
    });
    if (q.kind !== "generate") throw new Error("query");
    const report = f.service.reports.generate(teacher, q);
    await f.service.reports.tick();
    const result = f.service.reports.read(report.id, "class:one");
    expect(result.state).toBe("complete");
    expect(result.result?.evidence[0]?.status).toBe("provisional");
    expect(f.database.readAll("SELECT * FROM marea_evaluations")).toHaveLength(0);
    expect(renderReport(result)).toContain("Provisional");
  });
  it("cancels queued work and marks outstanding jobs interrupted after restart", () => {
    const f = fixture();
    const q = f.query({
      kind: "generate",
      from: "2026-01-01T00:00:00.000Z",
      to: NOW,
      locale: "en",
    });
    if (q.kind !== "generate") throw new Error("query");
    const report = f.service.reports.generate(teacher, q);
    f.service.reports.cancel(report.id, "class:one");
    expect(f.service.reports.read(report.id, "class:one").state).toBe("cancelled");
    const retry = f.service.reports.retry(teacher, report.id, "class:one");
    f.service.recover();
    expect(f.service.reports.read(retry.id, "class:one").state).toBe("interrupted");
  });
  it("rejects invented aliases and cross-mode evidence", () => {
    expect(() => {
      validateFindings(
        {
          summary: "",
          recommendation: "",
          findings: [
            {
              title: "x",
              mode: "tutoring",
              skillIds: [],
              evaluable: ["invented"],
              affected: ["invented"],
              evidence: ["run:b"],
              explanation: "",
              recommendation: "",
            },
          ],
        },
        [
          {
            runId: "run:b",
            alias: "A001",
            mode: "free",
            skills: [],
            status: "provisional",
            evaluation: EVALUATION_DRAFT,
          },
        ],
      );
    }).toThrow();
  });
  it("invalidates report payloads when their source is removed", () => {
    const f = fixture();
    const q = f.query({
      kind: "generate",
      from: "2026-01-01T00:00:00.000Z",
      to: NOW,
      locale: "es",
    });
    if (q.kind !== "generate") throw new Error("query");
    const r = f.service.reports.generate(teacher, q);
    f.database.execute("DELETE FROM marea_class_report_sources WHERE report_id = ?1", [r.id]);
    expect(f.service.reports.read(r.id, "class:one")).toMatchObject({
      state: "invalidated",
      result: null,
    });
    expect(
      f.database.readOne("SELECT input_json FROM marea_class_reports WHERE id = ?1", [r.id])
        ?.input_json,
    ).toBe("{}");
  });
});

it("commits reviewed progress atomically with approval and never advances on a draft", () => {
  const f = fixture();
  enabled(f);
  const captured = capture(f),
    target = targetOf(captured);
  f.database.execute("UPDATE marea_run_teaching_snapshots SET teaching_json = ?1", [
    JSON.stringify(captured.teaching),
  ]);
  f.queue();
  let fail = true;
  const repository = new SqliteEvaluationRepository(f.database, (input, draft, actor, now) => {
    f.progress.apply(input, draft, actor, now);
    if (fail) throw new Error("atomic failure");
  });
  const claim = repository.claim("worker:adaptive", NOW);
  if (claim === null) throw new Error("claim");
  const draft = EvaluationDraftSchema.parse({
    ...EVALUATION_DRAFT,
    criteria: [
      {
        skillId: target.skillId,
        code: target.code,
        result: "passed",
        confidence: "high",
        evidence: "Explained boundary",
        levelAttempted: target.target,
        learningNote: "Practice independently",
      },
    ],
  });
  expect(() => {
    repository.finish(
      claim,
      { ...draft, criteria: draft.criteria.map((c) => ({ ...c, levelAttempted: 4 })) },
      NOW,
    );
  }).toThrow();
  repository.finish(claim, draft, NOW);
  expect(targetOf(capture(f)).achieved).toBe(0);
  const request = {
    identity: teacher,
    request: { ...reviewRequest(), draft },
    noticeId: "notice:adaptive",
    now: NOW,
  };
  expect(() => repository.approve(request)).toThrow("atomic failure");
  expect(targetOf(capture(f)).achieved).toBe(0);
  expect(f.database.readAll("SELECT * FROM marea_learning_history")).toHaveLength(0);
  expect(f.database.readAll("SELECT * FROM marea_teacher_notices")).toHaveLength(0);
  fail = false;
  repository.approve(request);
  repository.approve(request);
  expect(targetOf(capture(f)).achieved).toBe(1);
  expect(f.database.readAll("SELECT * FROM marea_teacher_notices")).toHaveLength(1);
});
