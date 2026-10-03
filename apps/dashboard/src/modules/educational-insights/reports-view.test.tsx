import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as z from "zod";
import { ReportsView } from "./reports-view.js";
import { ReportList } from "./report-list.js";
import { button, elements, model, props, report } from "./interactions.fixture.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
// Static markup separates adjacent text with comments; the reader sees one string.
const text = (state: ReturnType<typeof model>) =>
  renderToStaticMarkup(ReportsView({ model: state, props, shared: null })).replaceAll(
    "<!-- -->",
    "",
  );
const view = (state: ReturnType<typeof model>) =>
  ReportsView({ model: state, props, shared: null });

it("hands the list its page and opens a chosen report from the start", () => {
  const state = model();
  state.page = "previous";
  const entries = [
    { id: "r", state: "complete", createdAt: "now", from: "", to: "", completed: 1, total: 1 },
  ];
  state.data = { configured: true, entries };
  const list = elements(view(state)).find((e) => e.type === ReportList);
  expect(list?.props).toMatchObject({ entries, page: "previous", locale: "es" });
  expect(list?.props.setPage).toBe(state.setPage);
  expect(list?.props.m).toBe(state.m);
  list?.props.select?.("r");
  expect(state.setSelectedReport).toHaveBeenCalledWith("r");
  expect(state.setReport).toHaveBeenCalledWith(null);
  expect(text(state)).not.toContain(state.m.unconfigured);
  state.data = { configured: false, entries };
  expect(text(state)).toContain(state.m.unconfigured);
});

it("fills the period from the chosen preset and keeps custom dates untouched", () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-01-01T12:00:00.000Z"));
  vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(0);
  const state = model();
  expect(
    elements(view(state))
      .filter((e) => e.type === "option")
      .map((e) => [e.props.value, e.props.children]),
  ).toEqual([
    ["6", state.m.hours6],
    ["24", state.m.hours24],
    ["72", state.m.hours72],
    ["168", state.m.days7],
    ["custom", state.m.custom],
  ]);
  const controls = elements(view(state)).filter((e) => e.props.onChange !== undefined);
  controls[0]?.props.onChange?.({ currentTarget: { value: "6", checked: false } });
  expect(state.setTo).toHaveBeenLastCalledWith("2026-01-01T12:00");
  expect(state.setFrom).toHaveBeenLastCalledWith("2026-01-01T06:00");
  controls[1]?.props.onChange?.({ currentTarget: { value: "2025-12-01T08:00", checked: false } });
  expect(state.setFrom).toHaveBeenLastCalledWith("2025-12-01T08:00");
});

it.each([
  ["queued", true, false],
  ["running", true, false],
  ["failed", false, true],
  ["interrupted", false, true],
  ["cancelled", false, true],
  ["complete", false, false],
])("offers the actions a %s report allows", (value, cancel, retry) => {
  const state = model();
  state.selectedReport = "report";
  state.report = { ...report, state: value };
  const labels = elements(view(state))
    .filter((e) => e.type === "button")
    .map((e) => e.props.children);
  expect(labels.includes(state.m.cancel)).toBe(cancel);
  expect(labels.includes(state.m.retry)).toBe(retry);
});

it("explains partial results, finding ratios and evidence, and reports failed navigation", async () => {
  const state = model();
  state.selectedReport = "report";
  const finding = {
    title: "Loops",
    mode: "tutoring" as const,
    skillIds: [],
    affected: ["A", "B", "C"],
    evaluable: ["A", "B", "C", "D"],
    evidence: [],
    explanation: "Practice",
    recommendation: "Example",
  };
  const result = {
    partial: false,
    synthesis: {
      summary: "Summary",
      recommendation: "Practice",
      findings: [finding, { ...finding, affected: [], evaluable: [] }],
    },
    evidence: [
      { runId: "run", alias: "A", mode: "tutoring", status: "approved" as const, evaluation: null },
    ],
  };
  state.report = { ...report, result };
  const html = text(state);
  expect(html).not.toContain(state.m.partial);
  expect(html).toContain(`<p>tutoring · ${state.m.affected}: 3/4 (75%)</p>`);
  expect(html).toContain(`<p>tutoring · ${state.m.affected}: 0/0 (0%)</p>`);
  expect(html).toContain(`<p>Ana · ${state.m.approved} <button>${state.m.session}</button></p>`);
  state.report = { ...report, result: { ...result, partial: true } };
  expect(text(state)).toContain(`<p role="status">${state.m.partial}</p>`);
  const navigate = vi.mocked(props.navigate);
  navigate.mockResolvedValueOnce(true);
  button(view(state), state.m.session).onClick?.();
  await Promise.resolve();
  expect(state.setError).not.toHaveBeenCalled();
  navigate.mockResolvedValueOnce(false);
  button(view(state), state.m.session).onClick?.();
  await Promise.resolve();
  expect(state.setError).toHaveBeenCalledExactlyOnceWith(true);
});

it("downloads the report's HTML as a named file and reports failures", async () => {
  vi.useFakeTimers();
  const state = model();
  state.selectedReport = "report";
  state.report = {
    ...report,
    result: {
      partial: false,
      synthesis: { summary: "", recommendation: "", findings: [] },
      evidence: [],
    },
  };
  const requests: { classId: string; input: object; schema: z.ZodType }[] = [];
  state.client = (classId, input, schema) => {
    requests.push({ classId, input, schema });
    return Promise.resolve(schema.parse({ html: "<h1>Report</h1>" }));
  };
  const anchor = { href: "", download: "", click: vi.fn() };
  const createElement = vi.fn(() => anchor);
  vi.stubGlobal("document", { createElement });
  const blobs: Blob[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    if (blob instanceof Blob) blobs.push(blob);
    return "blob:report";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  button(view(state), state.m.download).onClick?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(requests[0]?.classId).toBe("class:a");
  expect(requests[0]?.input).toEqual({ kind: "download", reportId: "report" });
  expect(requests[0]?.schema.safeParse({ html: 1 }).success).toBe(false);
  expect(createElement).toHaveBeenCalledWith("a");
  expect(anchor.href).toBe("blob:report");
  expect(blobs[0]?.type).toBe("text/html;charset=utf-8");
  expect(await blobs[0]?.text()).toBe("<h1>Report</h1>");
  state.client = () => Promise.reject(new Error("offline"));
  button(view(state), state.m.download).onClick?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(state.setError).toHaveBeenCalledExactlyOnceWith(true);
});
