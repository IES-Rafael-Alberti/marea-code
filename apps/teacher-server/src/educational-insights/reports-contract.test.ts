import { expect, it, vi } from "vitest";
import { fixture } from "./insights.fixture.js";
import { query, input, save, observedDraft } from "./reports.fixture.js";
import { NOW, teacher, EVALUATION_DRAFT } from "../../test-support/evaluation-fixture.js";
import { teachingConfiguration } from "../../test-support/teaching-fixture.js";
import { EVALUATE, SYNTHESIZE } from "./reports-model.js";

it("freezes exact source identity, approved feedback and anonymous conversation before queuing", () => {
  const f = fixture();
  f.database.execute(
    "UPDATE marea_users SET display_name = 'Ana Example',login = 'ana@example.test' WHERE id = 's1'",
  );
  f.database.execute(
    "UPDATE marea_run_events SET payload_json = ?1 WHERE run_id = 'run:b' AND event_type = 'student-message'",
    [JSON.stringify({ content: "Ana Example tries; ana@example.test asks Ana Example" })],
  );
  const read = f.database.readOne.bind(f.database);
  vi.spyOn(f.database, "readOne").mockImplementation((sql, values) =>
    sql.startsWith("SELECT draft_json") && values?.[0] === "run:b"
      ? {
          draft_json: JSON.stringify({
            ...EVALUATION_DRAFT,
            studentFeedback: "Ana Example practiced",
            teacherNote: "ana@example.test explained",
          }),
        }
      : read(sql, values),
  );
  const report = f.service.reports.generate(teacher, query(f));
  const frozen = input(f, report.id);
  expect(frozen).toMatchObject({
    from: "2026-01-01T00:00:00.000Z",
    to: NOW,
    locale: "en",
    route: f.service.configuration.reports,
  });
  expect(
    frozen.sources.map(({ runId, studentId, alias, mode, skills }) => ({
      runId,
      studentId,
      alias,
      mode,
      skills,
    })),
  ).toEqual(
    ["run:older", "run:a", "run:b"].map((runId) => ({
      runId,
      studentId: "s1",
      alias: "A001",
      mode: "tutoring",
      skills: teachingConfiguration().content.didacticSkills.map((s) => s.id),
    })),
  );
  const source = frozen.sources.find((s) => s.runId === "run:b");
  expect(source?.teaching).toEqual(teachingConfiguration().content);
  expect(JSON.parse(source?.material ?? "null")).toMatchObject({
    events: [
      { content: "A001 tries; A001 asks A001" },
      { eventType: "assistant-message", content: "What should it return?" },
    ],
  });
  expect(source?.approved).toEqual({
    ...EVALUATION_DRAFT,
    studentFeedback: "A001 practiced",
    teacherNote: "A001 explained",
  });
  expect(frozen.sources.filter((s) => s.runId !== "run:b").map((s) => s.approved)).toEqual([
    null,
    null,
  ]);
  expect(report).toMatchObject({
    state: "queued",
    createdAt: NOW,
    from: frozen.from,
    to: NOW,
    locale: "en",
    completed: 0,
    total: 3,
    error: null,
    result: null,
    students: Array.from({ length: 3 }, () => ({
      alias: "A001",
      studentId: "s1",
      displayName: "Ana Example",
    })),
  });
  expect(
    f.database.readAll(
      "SELECT run_id FROM marea_class_report_sources WHERE report_id = ?1 ORDER BY run_id",
      [report.id],
    ),
  ).toEqual([{ run_id: "run:a" }, { run_id: "run:b" }, { run_id: "run:older" }]);
});

it("requires direct class authority to generate and retry and accepts the exact maximum period", () => {
  const f = fixture();
  expect(() => f.service.reports.generate({ ...teacher, userId: "t2" }, query(f))).toThrow(
    "dashboard.forbidden",
  );
  const from = new Date(Date.parse(NOW) - 366 * 86400000).toISOString();
  const report = f.service.reports.generate(teacher, query(f, { from }));
  f.service.reports.cancel(report.id, "class:one");
  expect(() =>
    f.service.reports.generate(
      teacher,
      query(f, { requestId: "over-limit", from: new Date(Date.parse(from) - 1).toISOString() }),
    ),
  ).toThrow("request.conflict");
  expect(() =>
    f.service.reports.retry({ ...teacher, userId: "t2" }, report.id, "class:one"),
  ).toThrow("dashboard.forbidden");
  expect(f.database.readAll("SELECT id FROM marea_class_reports")).toHaveLength(1);
  f.now("2026-09-07T12:00:01.000Z");
  const retried = f.service.reports.retry(teacher, report.id, "class:one");
  expect(retried).toMatchObject({
    state: "queued",
    createdAt: "2026-09-07T12:00:01.000Z",
    completed: 0,
    total: 3,
    result: null,
  });
  expect(retried.id).not.toBe(report.id);
  expect(input(f, retried.id)).toEqual(input(f, report.id));
  expect(
    f.database.readOne("SELECT owner_id,request_id FROM marea_class_reports WHERE id = ?1", [
      retried.id,
    ]),
  ).toEqual({ owner_id: teacher.userId, request_id: retried.id });
  expect(
    f.database.readAll(
      "SELECT run_id FROM marea_class_report_sources WHERE report_id = ?1 ORDER BY run_id",
      [retried.id],
    ),
  ).toHaveLength(3);
});

it("evaluates provisional dossiers with their frozen model route and persists complete synthesis", async () => {
  const f = fixture();
  const report = f.service.reports.generate(teacher, query(f));
  const frozen = input(f, report.id);
  const source = frozen.sources[0];
  if (source === undefined) throw new Error("source");
  const draft = observedDraft(source);
  const synthesis = {
    summary: "Reviewed evidence",
    findings: [],
    recommendation: "Practice boundaries",
  };
  const generate = vi
    .spyOn(f.service.inference, "generate")
    .mockImplementation((_route, _account, prompt, _material, schema) =>
      Promise.resolve(schema.parse(prompt === EVALUATE ? draft : synthesis)),
    );
  await f.service.reports.tick();
  expect(generate).toHaveBeenCalledTimes(4);
  for (const [index, current] of frozen.sources.entries()) {
    expect(generate.mock.calls[index]?.slice(0, 4)).toEqual([
      frozen.route,
      `report:${report.id}`,
      EVALUATE,
      { mode: current.mode, material: current.material, locale: "en" },
    ]);
  }
  const evidence = frozen.sources.map((s) => ({
    runId: s.runId,
    alias: s.alias,
    mode: s.mode,
    skills: s.skills,
    status: "provisional",
    evaluation: draft,
  }));
  expect(generate.mock.calls[3]?.slice(0, 4)).toEqual([
    frozen.route,
    `report:${report.id}`,
    SYNTHESIZE,
    { locale: "en", evidence },
  ]);
  expect(f.service.reports.read(report.id, "class:one")).toMatchObject({
    state: "complete",
    completed: 3,
    total: 3,
    result: { synthesis, evidence, partial: false },
  });
  expect(f.database.readAll("SELECT id FROM marea_evaluations")).toEqual([]);
  expect(f.database.readAll("SELECT id FROM marea_teacher_notices")).toEqual([]);
});

it.each([
  ["es", "No hay evidencia suficiente para generar el informe."],
  ["eu", "Ez dago txostena sortzeko nahikoa ebidentziarik."],
  ["en", "Insufficient evidence to generate a report."],
])(
  "persists exact unavailable evidence and localized empty synthesis in %s",
  async (locale, summary) => {
    const f = fixture();
    const report = f.service.reports.generate(teacher, query(f, { locale }));
    const frozen = input(f, report.id);
    save(f, report.id, {
      ...frozen,
      sources: frozen.sources.map((source) => ({ ...source, material: "" })),
    });
    await f.service.reports.tick();
    expect(f.service.reports.read(report.id, "class:one")).toMatchObject({
      state: "complete",
      completed: 3,
      result: {
        synthesis: { summary, findings: [], recommendation: "" },
        partial: true,
        evidence: frozen.sources.map((s) => ({
          runId: s.runId,
          alias: s.alias,
          mode: s.mode,
          skills: s.skills,
          status: "unavailable",
          evaluation: null,
        })),
      },
    });
  },
);

it("exposes only the deletion marker after a report loses its evidence", () => {
  const f = fixture();
  const report = f.service.reports.generate(teacher, query(f));
  f.database.execute(
    "UPDATE marea_class_reports SET state = 'invalidated',input_json = '{}' WHERE id = ?1",
    [report.id],
  );
  expect(f.service.reports.read(report.id, "class:one")).toEqual({
    id: report.id,
    state: "invalidated",
    createdAt: NOW,
    from: "",
    to: "",
    completed: 0,
    total: 0,
    error: "evidence-deleted",
    result: null,
  });
});

it.each([false, true])(
  "synthesizes supported findings from mixed available evidence and releases completed work (%s)",
  async (invalid) => {
    const f = fixture();
    const report = f.service.reports.generate(teacher, query(f));
    const frozen = input(f, report.id);
    const first = frozen.sources[0];
    if (first === undefined) throw new Error("source");
    save(f, report.id, {
      ...frozen,
      sources: frozen.sources.map((s, i) => ({
        ...s,
        material: "",
        approved: i === 1 ? null : EVALUATION_DRAFT,
      })),
    });
    const finding = {
      title: "Boundary",
      mode: "tutoring",
      skillIds: [],
      evaluable: ["A001"],
      affected: ["A001"],
      evidence: [invalid ? "missing-run" : first.runId],
      explanation: "Observed",
      recommendation: "Practice",
    };
    const synthesis = { summary: "Reviewed", recommendation: "Next", findings: [finding] };
    const generate = vi
      .spyOn(f.service.inference, "generate")
      .mockImplementation((_r, _a, _s, _m, schema) => Promise.resolve(schema.parse(synthesis)));
    await f.service.reports.tick();
    expect(generate).toHaveBeenCalledOnce();
    const result = f.service.reports.read(report.id, "class:one");
    expect(result).toMatchObject(
      invalid
        ? { state: "failed", error: "analysis-failed", result: null }
        : {
            state: "complete",
            result: {
              partial: true,
              synthesis,
              evidence: [
                { runId: first.runId, status: "approved", evaluation: EVALUATION_DRAFT },
                { status: "unavailable", evaluation: null },
                { status: "approved", evaluation: EVALUATION_DRAFT },
              ],
            },
          },
    );
    const second = f.service.reports.generate(teacher, query(f, { requestId: "next-report" }));
    const next = input(f, second.id);
    save(f, second.id, { ...next, sources: [] });
    await f.service.reports.tick();
    expect(f.service.reports.read(second.id, "class:one").state).toBe("complete");
  },
);
