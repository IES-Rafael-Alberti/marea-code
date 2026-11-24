import { expect, it, vi } from "vitest";
import { fixture } from "./insights.fixture.js";
import {
  input,
  query,
  replaceSources,
  observedDraft,
  pendingReportModel,
} from "./reports.fixture.js";
import { InsightsFailure } from "./model-output.boundary.js";
import { EVALUATE } from "./reports-model.js";
import { ClassReports } from "./reports.js";
import { NOW, teacher } from "../../test-support/evaluation-fixture.js";

const at = (ms: number) => new Date(Date.parse(NOW) + ms).toISOString();

/** A queued report over `count` sessions of distinct students, plus the mocked model. */
function queued(count: number, answer: (call: number, prompt: string) => object | Error) {
  const f = fixture();
  const report = f.service.reports.generate(teacher, query(f));
  replaceSources(f, report.id, ([first]) => {
    if (first === undefined) throw new Error("source");
    return Array.from({ length: count }, (_v, i) => ({
      ...first,
      runId: `run:${String(i)}`,
      alias: `A${String(i + 1).padStart(3, "0")}`,
    }));
  });
  let call = 0;
  const generate = vi
    .spyOn(f.service.inference, "generate")
    .mockImplementation((_route, _account, prompt, _material, schema) => {
      const next = answer(++call, prompt);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(schema.parse(next));
    });
  return { f, report, generate };
}
const draft = () => {
  const f = fixture();
  const report = f.service.reports.generate(teacher, query(f));
  const source = input(f, report.id).sources[0];
  if (source === undefined) throw new Error("source");
  return observedDraft(source);
};
const synthesis = { summary: "Done", findings: [], recommendation: "Next" };
const failure = (code: ConstructorParameters<typeof InsightsFailure>[0]) =>
  new InsightsFailure(code);

it("stores the failure code and logs only content-free fields when synthesis fails", async () => {
  const evaluation = draft();
  const { f, report } = queued(1, (_call, prompt) =>
    prompt === EVALUATE ? evaluation : failure("provider"),
  );
  await f.service.reports.tick();
  expect(f.service.reports.read(report.id, "class:one")).toMatchObject({
    state: "failed",
    error: "provider",
    result: null,
  });
  expect(f.diagnostics).toHaveBeenCalledOnce();
  expect(f.diagnostics).toHaveBeenCalledWith({
    event: "report-failed",
    reportId: report.id,
    code: "provider",
    cause: "InsightsFailure",
  });
});

it("keeps the generic code for unexpected errors", async () => {
  const { f, report } = queued(1, () => new Error("student secret"));
  replaceSources(f, report.id, (sources) =>
    sources.map((source) => ({ ...source, approved: observedDraft(source) })),
  );
  await f.service.reports.tick();
  expect(f.service.reports.read(report.id, "class:one")).toMatchObject({
    state: "failed",
    error: "analysis-failed",
  });
  expect(f.diagnostics).toHaveBeenCalledWith({
    event: "report-failed",
    reportId: report.id,
    code: "analysis-failed",
    cause: "Error",
  });
  expect(JSON.stringify(vi.mocked(f.diagnostics).mock.calls)).not.toContain("student secret");
});

it("stops at the first exhausted budget instead of failing every remaining run", async () => {
  const { f, report, generate } = queued(3, () => failure("budget"));
  await f.service.reports.tick();
  expect(generate).toHaveBeenCalledOnce();
  expect(f.service.reports.read(report.id, "class:one")).toMatchObject({
    state: "failed",
    error: "budget",
  });
  expect(f.service.reports.read(report.id, "class:one").completed).toBe(0);
});

it("stops when the model route is not configured", async () => {
  const { f, report, generate } = queued(3, () => failure("unconfigured"));
  await f.service.reports.tick();
  expect(generate).toHaveBeenCalledOnce();
  expect(f.service.reports.read(report.id, "class:one").error).toBe("unconfigured");
});

it("fails after three consecutive provider failures", async () => {
  const { f, report, generate } = queued(5, () => failure("provider"));
  await f.service.reports.tick();
  expect(generate).toHaveBeenCalledTimes(3);
  expect(f.service.reports.read(report.id, "class:one")).toMatchObject({
    state: "failed",
    error: "provider",
    completed: 2,
  });
});

it("fails after three consecutive deadline failures", async () => {
  const { f, report, generate } = queued(4, () => failure("deadline"));
  await f.service.reports.tick();
  expect(generate).toHaveBeenCalledTimes(3);
  expect(f.service.reports.read(report.id, "class:one").error).toBe("deadline");
});

it("continues past isolated provider failures and records why each run is unavailable", async () => {
  const evaluation = draft();
  const script = ["provider", "provider", "ok", "provider", "provider", "ok", "synthesis"];
  const { f, report, generate } = queued(6, (call) => {
    const step = script[call - 1];
    return step === "provider" ? failure("provider") : step === "ok" ? evaluation : synthesis;
  });
  await f.service.reports.tick();
  expect(generate).toHaveBeenCalledTimes(7);
  const stored = f.service.reports.read(report.id, "class:one");
  expect(stored).toMatchObject({ state: "complete", completed: 6, error: null });
  expect(stored.result?.partial).toBe(true);
  expect(stored.result?.evidence.map((e) => [e.status, e.reason])).toEqual([
    ["unavailable", "provider"],
    ["unavailable", "provider"],
    ["provisional", undefined],
    ["unavailable", "provider"],
    ["unavailable", "provider"],
    ["provisional", undefined],
  ]);
  expect(f.diagnostics).toHaveBeenCalledWith({
    event: "report-run-unavailable",
    reportId: report.id,
    runId: "run:0",
    reason: "provider",
  });
});

it("fails with the first cause when no run could be evaluated", async () => {
  const { f, report, generate } = queued(2, (call) =>
    failure(call === 1 ? "output-invalid" : "input-too-large"),
  );
  await f.service.reports.tick();
  expect(generate).toHaveBeenCalledTimes(2);
  expect(f.service.reports.read(report.id, "class:one")).toMatchObject({
    state: "failed",
    error: "output-invalid",
  });
});

it("completes a partial report when only some runs have unusable output", async () => {
  const evaluation = draft();
  const { f, report } = queued(3, (call) =>
    call === 2 ? failure("output-invalid") : call === 4 ? synthesis : evaluation,
  );
  await f.service.reports.tick();
  const stored = f.service.reports.read(report.id, "class:one");
  expect(stored.state).toBe("complete");
  expect(stored.result?.partial).toBe(true);
  expect(stored.result?.evidence.map((e) => e.reason)).toEqual([
    undefined,
    "output-invalid",
    undefined,
  ]);
  expect(stored.completed).toBe(3);
});

it.each([
  ["no-material", (s: object) => ({ ...s, material: "" })],
  ["material-too-large", (s: object) => ({ ...s, material: "", skip: "material-too-large" })],
  [
    "no-criteria",
    (s: { teaching: object }) => ({ ...s, teaching: { ...s.teaching, evaluationSkills: [] } }),
  ],
] as const)("records %s without calling the model", async (reason, change) => {
  const { f, report, generate } = queued(1, () => synthesis);
  replaceSources(f, report.id, (sources) => sources.map((s) => change(s as never) as never));
  await f.service.reports.tick();
  expect(generate).not.toHaveBeenCalled();
  const stored = f.service.reports.read(report.id, "class:one");
  expect(stored).toMatchObject({ state: "complete", error: null });
  expect(stored.result?.evidence[0]).toMatchObject({ status: "unavailable", reason });
  expect(f.diagnostics).toHaveBeenCalledWith({
    event: "report-run-unavailable",
    reportId: report.id,
    runId: "run:0",
    reason,
  });
});

it("releases a stalled report so it cannot block new ones", async () => {
  const f = fixture();
  const first = f.service.reports.generate(teacher, query(f));
  const { pending, generate, tick } = await pendingReportModel(f);
  const threshold = 4 * f.service.inference.deadlineMs;
  f.now(at(threshold));
  await f.service.reports.tick();
  expect(f.service.reports.read(first.id, "class:one").state).toBe("running");
  expect(f.diagnostics).not.toHaveBeenCalled();
  f.now(at(threshold + 1));
  await f.service.reports.tick();
  expect(f.service.reports.read(first.id, "class:one")).toMatchObject({
    state: "interrupted",
    error: "deadline",
  });
  expect(generate.mock.calls[0]?.[5].aborted).toBe(true);
  expect(f.diagnostics).toHaveBeenCalledWith({
    event: "report-stalled",
    reportId: first.id,
    code: "deadline",
  });
  // The class is free again: a new report is accepted and started.
  const second = f.service.reports.generate(
    teacher,
    query(f, { requestId: "next", to: at(threshold + 1) }),
  );
  const next = Promise.withResolvers<never>();
  generate.mockReturnValue(next.promise);
  const secondTick = f.service.reports.tick();
  await vi.waitFor(() => {
    expect(generate).toHaveBeenCalledTimes(2);
  });
  // The abandoned work finishing late neither revives nor releases the new report.
  pending.reject(new Error("late"));
  await tick;
  expect(f.service.reports.read(first.id, "class:one").state).toBe("interrupted");
  expect(f.service.reports.read(second.id, "class:one").state).toBe("running");
  f.service.reports.cancel(second.id, "class:one");
  expect(generate.mock.calls[1]?.[5].aborted).toBe(true);
  next.reject(new Error("cancelled"));
  await secondTick;
});

it("measures staleness from the last progress of the running report", async () => {
  const evaluation = draft();
  const f = fixture();
  const report = f.service.reports.generate(teacher, query(f));
  const gate = Promise.withResolvers<object>();
  const threshold = 4 * f.service.inference.deadlineMs;
  let calls = 0;
  const generate = vi
    .spyOn(f.service.inference, "generate")
    .mockImplementation((_r, _a, _p, _m, schema) => {
      if (++calls > 1) return gate.promise.then((value) => schema.parse(value));
      f.now(at(1_000_000));
      return Promise.resolve(schema.parse(evaluation));
    });
  const tick = f.service.reports.tick();
  await vi.waitFor(() => {
    expect(generate).toHaveBeenCalledTimes(2);
  });
  f.now(at(1_000_000 + threshold));
  await f.service.reports.tick();
  expect(f.service.reports.read(report.id, "class:one").state).toBe("running");
  f.now(at(1_000_000 + threshold + 1));
  await f.service.reports.tick();
  expect(f.service.reports.read(report.id, "class:one").state).toBe("interrupted");
  gate.reject(new Error("stop"));
  await tick;
});

it("writes diagnostics to stderr as one JSON line by default", async () => {
  const f = fixture();
  const reports = new ClassReports(f.progress, f.service.inference, f.service.clock, f.route);
  const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const report = f.service.reports.generate(teacher, query(f));
  vi.spyOn(f.service.inference, "generate").mockRejectedValue(failure("budget"));
  await reports.tick();
  expect(write).toHaveBeenCalledWith(
    `${JSON.stringify({
      component: "class-reports",
      event: "report-run-unavailable",
      reportId: report.id,
      runId: "run:older",
      reason: "budget",
    })}\n`,
  );
  write.mockRestore();
});

it("sends full dossiers when the route has no input ceiling", async () => {
  const f = fixture();
  f.service.reports.route = {
    ...f.route,
    budget: { ...f.route.budget, unlimited: true },
    inputTokenCeiling: 1,
  };
  const report = f.service.reports.generate(teacher, query(f));
  replaceSources(f, report.id, (sources) =>
    sources.map((source) => ({ ...source, approved: observedDraft(source) })),
  );
  const generate = vi
    .spyOn(f.service.inference, "generate")
    .mockImplementation((_r, _a, _p, _m, schema) => Promise.resolve(schema.parse(synthesis)));
  await f.service.reports.tick();
  expect(generate).toHaveBeenCalledOnce();
  const sent = generate.mock.calls[0]?.[3] as { evidence: { note?: string }[] };
  expect(sent.evidence).toHaveLength(3);
  expect(sent.evidence.map((e) => e.note)).toEqual(
    Array(3).fill("Private pedagogical observation."),
  );
});

it("describes a thrown non-error as unknown", async () => {
  const { f, report, generate } = queued(1, () => synthesis);
  replaceSources(f, report.id, (sources) =>
    sources.map((source) => ({ ...source, approved: observedDraft(source) })),
  );
  generate.mockRejectedValue("text");
  await f.service.reports.tick();
  expect(f.diagnostics).toHaveBeenCalledWith({
    event: "report-failed",
    reportId: report.id,
    code: "analysis-failed",
    cause: "unknown",
  });
});
