import { SkillIdSchema } from "@marea/protocol";
import { expect, it, vi } from "vitest";
import { fixture } from "./insights.fixture.js";
import { teacher, NOW, EVALUATION_DRAFT } from "../../test-support/evaluation-fixture.js";
import { ClassReports, validateFindings, computedDenominators } from "./reports.js";
import { InputSchema } from "./reports-model.js";
import { renderReport } from "./report-html.js";
function query(f: ReturnType<typeof fixture>, extra: object = {}) {
  const q = f.query({
    kind: "generate",
    from: "2026-01-01T00:00:00.000Z",
    to: NOW,
    locale: "en",
    ...extra,
  });
  if (q.kind !== "generate") throw new Error("query");
  return q;
}
function input(f: ReturnType<typeof fixture>, id: string) {
  return InputSchema.parse(
    JSON.parse(
      String(
        f.database.readOne("SELECT input_json FROM marea_class_reports WHERE id = ?1", [id])
          ?.input_json,
      ),
    ),
  );
}
function save(f: ReturnType<typeof fixture>, id: string, value: ReturnType<typeof input>) {
  f.database.execute("UPDATE marea_class_reports SET input_json = ?2 WHERE id = ?1", [
    id,
    JSON.stringify(value),
  ]);
}
it("validates report periods, deduplicates requests and rejects competing work", () => {
  const f = fixture(),
    reports = f.service.reports;
  const unconfigured = new ClassReports(
    f.progress,
    f.service.inference,
    f.service.clock,
    undefined,
  );
  expect(() => unconfigured.generate(teacher, query(f))).toThrow();
  for (const range of [
    { from: NOW },
    { to: "2027-01-01T00:00:00.000Z" },
    { from: "2020-01-01T00:00:00.000Z" },
  ])
    expect(() => reports.generate(teacher, query(f, range))).toThrow();
  expect(() => reports.read("missing", "class:one")).toThrow();
  const report = reports.generate(teacher, query(f));
  expect(reports.generate(teacher, query(f)).id).toBe(report.id);
  for (const change of [
    { from: "2026-01-02T00:00:00.000Z" },
    { to: "2026-09-06T00:00:00.000Z" },
    { requestId: "other" },
  ])
    expect(() => reports.generate(teacher, query(f, change))).toThrow();
  expect(() => reports.retry(teacher, report.id, "class:one")).toThrow();
  f.database.execute("UPDATE marea_class_reports SET state = 'complete'");
  expect(() => reports.retry(teacher, report.id, "class:one")).toThrow();
  expect(() => renderReport(reports.read(report.id, "class:one"))).toThrow();
});
it.each(["es", "eu", "en"])("completes an unavailable-evidence report in %s", async (locale) => {
  const f = fixture(),
    reports = f.service.reports;
  const report = reports.generate(teacher, query(f, { locale }));
  const frozen = input(f, report.id);
  save(f, report.id, {
    ...frozen,
    sources: frozen.sources.map((s, i) =>
      i === 0
        ? { ...s, material: "" }
        : { ...s, teaching: { ...s.teaching, evaluationSkills: [] } },
    ),
  });
  const generate = vi.spyOn(f.service.inference, "generate");
  await reports.tick();
  const result = reports.read(report.id, "class:one");
  expect(result.state).toBe("complete");
  expect(result.result?.partial).toBe(true);
  expect(result.result?.evidence.every((e) => e.status === "unavailable")).toBe(true);
  expect(generate).not.toHaveBeenCalled();
  expect(renderReport(result)).toContain(`lang="${locale}"`);
  await reports.tick();
});
it.each(["cancel", "stop", "revoke", "invalidate"] as const)(
  "discards late analysis on %s",
  async (operation) => {
    const f = fixture(),
      reports = f.service.reports;
    const report = reports.generate(teacher, query(f));
    const pending = Promise.withResolvers<never>();
    const generate = vi.spyOn(f.service.inference, "generate").mockReturnValue(pending.promise);
    const tick = reports.tick();
    await reports.tick();
    expect(generate).toHaveBeenCalledOnce();
    if (operation === "cancel") reports.cancel(report.id, "class:one");
    if (operation === "stop") reports.stop();
    if (operation === "invalidate")
      f.database.execute("UPDATE marea_class_reports SET state = 'invalidated' WHERE id = ?1", [
        report.id,
      ]);
    if (operation === "revoke") {
      f.database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
      await reports.tick();
    }
    pending.reject(new Error("aborted"));
    await tick;
    expect(reports.read(report.id, "class:one").state).not.toBe("complete");
    if (operation === "revoke")
      expect(reports.read(report.id, "class:one").error).toBe("access-revoked");
  },
);
it("fails a queued report whose owner lost access", async () => {
  const f = fixture(),
    reports = f.service.reports;
  const report = reports.generate(teacher, query(f));
  f.database.execute("DELETE FROM marea_teacher_classes WHERE teacher_id = 't1'");
  await reports.tick();
  expect(reports.read(report.id, "class:one")).toMatchObject({
    state: "failed",
    error: "analysis-failed",
  });
});
it.each([false, true])(
  "uses approved dossiers and discards cancelled synthesis (%s)",
  async (cancel) => {
    const f = fixture(),
      reports = f.service.reports;
    const report = reports.generate(teacher, query(f));
    const frozen = input(f, report.id);
    save(f, report.id, {
      ...frozen,
      sources: frozen.sources.map((s) => ({ ...s, approved: EVALUATION_DRAFT })),
    });
    const pending = Promise.withResolvers<object>();
    const generate = vi
      .spyOn(f.service.inference, "generate")
      .mockImplementation((_r, _a, _s, _m, schema) =>
        pending.promise.then((value) => schema.parse(value)),
      );
    const tick = reports.tick();
    await vi.waitFor(() => {
      expect(generate).toHaveBeenCalledOnce();
    });
    if (cancel) reports.cancel(report.id, "class:one");
    pending.resolve({ summary: "Summary", findings: [], recommendation: "Practice" });
    await tick;
    const result = reports.read(report.id, "class:one");
    expect(result.state).toBe(cancel ? "cancelled" : "complete");
    if (!cancel) expect(result.result?.evidence.every((e) => e.status === "approved")).toBe(true);
  },
);
const finding = {
  title: "<Loops>",
  mode: "tutoring" as const,
  skillIds: ["skill"],
  evaluable: ["A", "B"],
  affected: ["A"],
  evidence: ["run:a"],
  explanation: "<script>",
  recommendation: "Practice",
};
const evidence = ["A", "B"].map((alias) => ({
  runId: `run:${alias.toLowerCase()}`,
  alias,
  mode: "tutoring" as const,
  skills: ["skill"],
  status: "approved" as const,
  evaluation: EVALUATION_DRAFT,
}));
it.each([
  { evaluable: ["A", "A"] },
  { affected: ["A", "A"] },
  { evaluable: ["unknown"] },
  { affected: ["unknown"] },
  { evidence: [] },
  { evidence: ["missing"] },
  { evidence: ["run:b"] },
  { skillIds: ["missing"] },
])("rejects unsupported report findings %#", (changes) => {
  expect(() => {
    validateFindings(
      { summary: "", recommendation: "", findings: [{ ...finding, ...changes }] },
      evidence,
    );
  }).toThrow("invalid-findings");
});
it("validates supported findings and computes assessed skill denominators", () => {
  const synthesis = { summary: "", recommendation: "", findings: [finding] };
  expect(() => {
    validateFindings(synthesis, evidence);
  }).not.toThrow();
  const criterion = {
    skillId: SkillIdSchema.parse("marea/testing"),
    code: "C1",
    result: "passed" as const,
    confidence: "high" as const,
    evidence: "Observed",
  };
  const skillId = criterion.skillId;
  const [first, second] = evidence;
  if (!first || !second) throw new Error("missing evidence");
  const sources = [
    {
      ...first,
      evaluation: { ...EVALUATION_DRAFT, criteria: [{ ...criterion, result: "passed" as const }] },
    },
    { ...second, evaluation: null },
    {
      ...second,
      evaluation: {
        ...EVALUATION_DRAFT,
        criteria: [{ ...criterion, result: "no-evidence" as const }],
      },
    },
  ];
  expect(
    computedDenominators({ ...synthesis, findings: [{ ...finding, skillIds: [skillId] }] }, sources)
      .findings[0]?.evaluable,
  ).toEqual(["A"]);
});
it("escapes report findings and renders zero denominators and missing names", () => {
  const f = fixture(),
    reports = f.service.reports;
  const report = reports.generate(teacher, query(f));
  const result = {
    partial: false,
    synthesis: {
      summary: "Summary",
      recommendation: "Practice",
      findings: [finding, { ...finding, evaluable: [], affected: [] }],
    },
    evidence,
  };
  f.database.execute(
    "UPDATE marea_class_reports SET state = 'complete',result_json = ?2 WHERE id = ?1",
    [report.id, JSON.stringify(result)],
  );
  const html = renderReport(reports.read(report.id, "class:one"));
  expect(html).toContain("50%");
  expect(html).toContain("0%");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
});
it.each(["runs", "aggregate"] as const)(
  "rejects oversized %s before persisting a report",
  (kind) => {
    const f = fixture();
    const readAll = f.database.readAll.bind(f.database);
    const spy = vi.spyOn(f.database, "readAll").mockImplementation((sql, values) => {
      const rows = readAll(sql, values);
      if (sql.startsWith("SELECT r.id, r.student_id")) {
        const first = rows[0];
        if (!first) throw new Error("missing run");
        return Array.from({ length: kind === "runs" ? 201 : 40 }, () => first);
      }
      if (kind === "aggregate" && sql.startsWith("SELECT payload_json"))
        return [{ payload_json: JSON.stringify({ text: "x".repeat(230000) }) }];
      return rows;
    });
    expect(() => f.service.reports.generate(teacher, query(f))).toThrow("request.conflict");
    expect(f.database.readAll("SELECT * FROM marea_class_reports")).toEqual([]);
    spy.mockRestore();
  },
);
it.each(["events", "bytes"] as const)("marks excessive source %s unavailable", async (kind) => {
  const f = fixture();
  const readAll = f.database.readAll.bind(f.database);
  const spy = vi.spyOn(f.database, "readAll").mockImplementation((sql, values) => {
    if (sql.startsWith("SELECT payload_json"))
      return Array.from({ length: kind === "events" ? 2001 : 1 }, () => ({
        payload_json: JSON.stringify({ text: kind === "bytes" ? "x".repeat(262145) : "event" }),
      }));
    return readAll(sql, values);
  });
  const report = f.service.reports.generate(teacher, query(f));
  expect(input(f, report.id).sources.every((s) => s.material === "")).toBe(true);
  await f.service.reports.tick();
  expect(f.service.reports.read(report.id, "class:one").result?.partial).toBe(true);
  spy.mockRestore();
});
it.each([false, true])(
  "freezes approved evaluations with optional identity data (%s)",
  (missing) => {
    const f = fixture();
    const readOne = f.database.readOne.bind(f.database);
    const spy = vi.spyOn(f.database, "readOne").mockImplementation((sql, values) => {
      if (sql.startsWith("SELECT draft_json"))
        return { draft_json: JSON.stringify(EVALUATION_DRAFT) };
      if (sql.startsWith("SELECT display_name,login"))
        return missing ? undefined : { display_name: "A", login: "s" };
      if (missing && sql.startsWith("SELECT display_name FROM")) return undefined;
      return readOne(sql, values);
    });
    const report = f.service.reports.generate(teacher, query(f));
    expect(input(f, report.id).sources.every((s) => s.approved !== null)).toBe(true);
    if (missing) expect(report.students?.every((s) => s.displayName === s.alias)).toBe(true);
    spy.mockRestore();
  },
);
it("does not publish when evidence is invalidated during synthesis", async () => {
  const f = fixture();
  const report = f.service.reports.generate(teacher, query(f));
  const frozen = input(f, report.id);
  save(f, report.id, {
    ...frozen,
    sources: frozen.sources.map((s) => ({ ...s, approved: EVALUATION_DRAFT })),
  });
  vi.spyOn(f.service.inference, "generate").mockImplementation((_r, _a, _s, _m, schema) => {
    f.database.execute("UPDATE marea_class_reports SET state = 'invalidated' WHERE id = ?1", [
      report.id,
    ]);
    return Promise.resolve(schema.parse({ summary: "Late", findings: [], recommendation: "" }));
  });
  await f.service.reports.tick();
  expect(f.service.reports.read(report.id, "class:one").state).toBe("invalidated");
});
it.each(["evaluation", "synthesis"] as const)(
  "stops while awaiting the last %s operation",
  async (stage) => {
    const f = fixture();
    const report = f.service.reports.generate(teacher, query(f));
    const frozen = input(f, report.id);
    save(f, report.id, {
      ...frozen,
      sources: frozen.sources
        .slice(0, 1)
        .map((s) => ({ ...s, approved: stage === "synthesis" ? EVALUATION_DRAFT : null })),
    });
    const pending = Promise.withResolvers<never>();
    const generate = vi.spyOn(f.service.inference, "generate").mockReturnValue(pending.promise);
    const tick = f.service.reports.tick();
    await vi.waitFor(() => {
      expect(generate).toHaveBeenCalledOnce();
    });
    f.service.reports.cancel(report.id, "class:one");
    pending.reject(new Error("cancelled"));
    await tick;
    expect(f.service.reports.read(report.id, "class:one")).toMatchObject({
      state: "cancelled",
      result: null,
    });
  },
);
