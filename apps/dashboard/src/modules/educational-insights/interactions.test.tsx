import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MapView } from "./map-view.js";
import { ProgressView } from "./progress-view.js";
import { ReportsView } from "./reports-view.js";
import { button, elements, model, props, criterion, report } from "./interactions.fixture.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("shows loading, empty and disabled maps and reports failed navigation", async () => {
  const state = model();
  const view = () => MapView({ model: state, props, shared: null });
  expect(renderToStaticMarkup(view())).toContain(state.m.loading);
  state.data = { enabled: false, configured: false, entries: [] };
  for (const text of [state.m.empty, state.m.disabled, state.m.unconfigured])
    expect(renderToStaticMarkup(view())).toContain(text);
  state.data = {
    enabled: true,
    configured: true,
    entries: [
      {
        runId: "run",
        student: "Ana",
        project: "P",
        state: "pending",
        reason: "",
        confidence: "low",
        analyzedAt: null,
      },
    ],
  };
  const navigate = vi.mocked(props.navigate);
  for (const ok of [true, false]) {
    navigate.mockResolvedValueOnce(ok);
    button(view(), state.m.session).onClick?.();
    await Promise.resolve();
  }
  expect(navigate).toHaveBeenCalledWith("run");
  expect(state.setError).toHaveBeenCalledExactlyOnceWith(true);
});
it("changes students, pages and adjustment inputs, and confirms whole-skill resets", () => {
  const state = model();
  const view = () => ProgressView({ model: state, props, shared: null });
  expect(elements(view()).some((e) => e.type === "article")).toBe(false);
  state.page = "previous";
  state.students = Array.from({ length: 101 }, (_, i) => ({
    id: `s${String(i)}`,
    displayName: `Student ${String(i)}`,
  }));
  button(view(), state.m.more).onClick?.();
  expect(state.setPage).toHaveBeenLastCalledWith("s100");
  button(view(), state.m.back).onClick?.();
  expect(state.setPage).toHaveBeenLastCalledWith(null);
  state.data = { revision: "v1", entries: [] };
  expect(renderToStaticMarkup(view())).toContain(state.m.noProgress);
  state.data = {
    revision: "v1",
    entries: [criterion, { ...criterion, key: "other", skillId: "other" }],
  };
  const selects = elements(view()).filter((e) => e.type === "select");
  selects[0]?.props.onChange?.({ currentTarget: { value: "s2", checked: false } });
  selects[1]?.props.onChange?.({ currentTarget: { value: "4", checked: false } });
  elements(view())
    .find((e) => e.type === "input")
    ?.props.onChange?.({ currentTarget: { value: "Evidence", checked: false } });
  expect(state.setStudent).toHaveBeenLastCalledWith("s2");
  expect(state.setData).toHaveBeenLastCalledWith(null);
  expect(state.setLevel).toHaveBeenCalledWith(4);
  expect(state.setReason).toHaveBeenCalledWith("Evidence");
  button(view(), state.m.setLevel).onClick?.();
  expect(state.action).toHaveBeenLastCalledWith({
    kind: "adjust",
    studentId: "student",
    keys: ["key"],
    level: 2,
    reason: "Reviewed",
    expectedRevision: "v1",
  });
  const confirm = vi.fn().mockReturnValue(false);
  vi.stubGlobal("window", { confirm });
  button(view(), state.m.resetSkill).onClick?.();
  expect(state.action).toHaveBeenCalledTimes(1);
  confirm.mockReturnValue(true);
  button(view(), state.m.resetSkill).onClick?.();
  expect(state.action).toHaveBeenLastCalledWith(
    expect.objectContaining({ keys: ["key"], level: 0 }),
  );
  state.busy = true;
  expect(button(view(), state.m.setLevel).disabled).toBe(true);
  expect(button(view(), state.m.resetSkill).disabled).toBe(true);
});
it("paginates reports, selects a period and generates with explicit dates", () => {
  const state = model();
  const view = () => ReportsView({ model: state, props, shared: null });
  expect(button(view(), state.m.generate).disabled).toBe(true);
  state.data = { configured: false, entries: [] };
  expect(renderToStaticMarkup(view())).toContain(state.m.unconfigured);
  state.data = {
    configured: true,
    entries: Array.from({ length: 51 }, (_, i) => ({
      id: `r${String(i)}`,
      state: i === 0 ? "future-status" : "queued",
      createdAt: "now",
    })),
  };
  state.page = "previous";
  button(view(), state.m.more).onClick?.();
  expect(state.setPage).toHaveBeenLastCalledWith("r50");
  button(view(), state.m.back).onClick?.();
  expect(state.setPage).toHaveBeenLastCalledWith(null);
  const period = elements(view()).find((e) => e.type === "select");
  period?.props.onChange?.({ currentTarget: { value: "custom", checked: false } });
  expect(state.setFrom).not.toHaveBeenCalled();
  period?.props.onChange?.({ currentTarget: { value: "6", checked: false } });
  expect(state.setFrom).toHaveBeenCalledOnce();
  const inputs = elements(view()).filter((e) => e.type === "input");
  inputs[0]?.props.onChange?.({ currentTarget: { value: "2026-01-01T00:00", checked: false } });
  inputs[1]?.props.onChange?.({ currentTarget: { value: "2026-01-02T00:00", checked: false } });
  expect(state.setTo).toHaveBeenLastCalledWith("2026-01-02T00:00");
  expect(button(view(), state.m.generate).disabled).toBe(false);
  button(view(), state.m.generate).onClick?.();
  expect(state.action).toHaveBeenCalledWith({
    kind: "generate",
    from: new Date(state.from).toISOString(),
    to: new Date(state.to).toISOString(),
    locale: "es",
  });
  elements(view())
    .filter((e) => e.type === "button")
    .at(-1)
    ?.props.onClick?.();
  expect(state.setSelectedReport).toHaveBeenCalledWith("r50");
  expect(state.setReport).toHaveBeenCalledWith(null);
  state.from = state.to;
  expect(button(view(), state.m.generate).disabled).toBe(true);
  state.busy = true;
  expect(button(view(), state.m.generate).disabled).toBe(true);
});
it("loads, cancels, retries and leaves the selected report", () => {
  const state = model();
  state.selectedReport = "report";
  const view = () => ReportsView({ model: state, props, shared: null });
  expect(renderToStaticMarkup(view())).toContain(state.m.loading);
  state.report = { ...report, state: "queued" };
  button(view(), state.m.cancel).onClick?.();
  expect(state.action).toHaveBeenLastCalledWith({ kind: "cancel", reportId: "report" });
  state.report = { ...report, state: "failed" };
  button(view(), state.m.retry).onClick?.();
  expect(state.action).toHaveBeenLastCalledWith({ kind: "retry", reportId: "report" });
  button(view(), state.m.back).onClick?.();
  expect(state.setSelectedReport).toHaveBeenCalledWith(null);
  expect(state.setReport).toHaveBeenCalledWith(null);
});
it("renders findings and downloads a report, revoking its temporary URL", async () => {
  vi.useFakeTimers();
  const state = model();
  state.selectedReport = "report";
  const finding = {
    title: "Loops",
    mode: "tutoring" as const,
    skillIds: [],
    affected: ["A"],
    evaluable: ["A", "B"],
    evidence: [],
    explanation: "Practice",
    recommendation: "Example",
  };
  state.report = {
    ...report,
    result: {
      partial: true,
      synthesis: {
        summary: "Summary",
        recommendation: "Practice",
        findings: [finding, { ...finding, affected: [], evaluable: [] }],
      },
      evidence: ["A", "unknown"].map((alias) => ({
        runId: alias,
        alias,
        mode: "tutoring",
        status: "approved" as const,
        evaluation: null,
      })),
    },
  };
  const view = () => ReportsView({ model: state, props, shared: null });
  expect(renderToStaticMarkup(view())).toContain("50");
  expect(renderToStaticMarkup(view())).toContain("unknown");
  const navigate = vi.mocked(props.navigate);
  for (const ok of [true, false]) {
    navigate.mockResolvedValueOnce(ok);
    button(view(), state.m.session).onClick?.();
    await Promise.resolve();
  }
  expect(state.setError).toHaveBeenCalledExactlyOnceWith(true);
  const anchor = { href: "", download: "", click: vi.fn() };
  vi.stubGlobal("document", { createElement: () => anchor });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:report");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  state.client = (_classId, _input, schema) =>
    Promise.resolve(schema.parse({ html: "<h1>Report</h1>" }));
  button(view(), state.m.download).onClick?.();
  await vi.advanceTimersByTimeAsync(1000);
  expect(anchor.download).toBe("class-report-report.html");
  expect(anchor.click).toHaveBeenCalledOnce();
  expect(revoke).toHaveBeenCalledWith("blob:report");
  state.client = () => Promise.reject(new Error("offline"));
  button(view(), state.m.download).onClick?.();
  await vi.advanceTimersByTimeAsync(1);
  expect(state.setError).toHaveBeenCalledTimes(2);
});
