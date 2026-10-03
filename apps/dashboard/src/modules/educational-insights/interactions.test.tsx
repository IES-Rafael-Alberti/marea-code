import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MapView } from "./map-view.js";
import { ProgressView, StudentProgress } from "./progress-view.js";
import { ReportsView } from "./reports-view.js";
import { button, elements, model, props, report } from "./interactions.fixture.js";
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
  const html = renderToStaticMarkup(view());
  // Without a reason or analysis time the card shows neither, and the empty notice is gone.
  expect(html).not.toContain("map-reason");
  expect(html).toContain(`<p class="map-meta">${state.m.low}</p>`);
  expect(html).not.toContain(state.m.empty);
  const navigate = vi.mocked(props.navigate);
  navigate.mockResolvedValueOnce(true);
  button(view(), state.m.session).onClick?.();
  await Promise.resolve();
  expect(state.setError).not.toHaveBeenCalled();
  navigate.mockResolvedValueOnce(false);
  button(view(), state.m.session).onClick?.();
  await Promise.resolve();
  expect(navigate).toHaveBeenCalledWith("run");
  expect(state.setError).toHaveBeenCalledExactlyOnceWith(true);
});
it("lists every student of the page, opening only the first, and pages forward and back", () => {
  const state = model();
  const view = () => ProgressView({ model: state, props, shared: <hr /> });
  expect(renderToStaticMarkup(view())).toBe(
    `<hr/><p class="insight-note">${state.m.adaptationNote}</p><p>${state.m.loading}</p>`,
  );
  state.data = { students: [], next: null };
  expect(renderToStaticMarkup(view())).toContain(`<p>${state.m.noStudents}</p>`);
  expect(renderToStaticMarkup(view())).not.toContain("progress-pages");
  const student = { id: "s1", displayName: "Ana", revision: "v1", entries: [] };
  state.data = { students: [student, { ...student, id: "s2", displayName: "Bea" }], next: "s2" };
  const listed = elements(view()).filter((e) => e.type === StudentProgress);
  expect(listed.map((e) => [e.key, e.props.open, e.props.student?.displayName])).toEqual([
    [expect.stringMatching(/\$s1$/u), true, "Ana"],
    [expect.stringMatching(/\$s2$/u), false, "Bea"],
  ]);
  expect(listed[0]?.props.props).toBe(props);
  expect(listed[0]?.props.model).toBe(state);
  expect(() => button(view(), state.m.back)).toThrow();
  button(view(), state.m.more).onClick?.();
  expect(state.setPage).toHaveBeenLastCalledWith("s2");
  state.page = "s2";
  state.data = { students: [student], next: null };
  expect(() => button(view(), state.m.more)).toThrow();
  button(view(), state.m.back).onClick?.();
  expect(state.setPage).toHaveBeenLastCalledWith(null);
  expect(button(view(), state.m.back).disabled).toBe(false);
  state.busy = true;
  state.data = { students: [student], next: "s3" };
  expect(button(view(), state.m.back).disabled).toBe(true);
  expect(button(view(), state.m.more).disabled).toBe(true);
});
it("selects a period and generates with explicit dates", () => {
  const state = model();
  const view = () => ReportsView({ model: state, props, shared: null });
  expect(button(view(), state.m.generate).disabled).toBe(true);
  state.data = { configured: false, entries: [] };
  expect(renderToStaticMarkup(view())).toContain(state.m.unconfigured);
  state.data = { configured: true, entries: [] };
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
