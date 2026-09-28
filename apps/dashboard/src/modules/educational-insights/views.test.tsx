import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { insightsMessages } from "./messages.js";
import { insightsClient } from "./client.js";
import type { useInsightModel, InsightViewProps } from "./model.js";
import { MapView } from "./map-view.js";
import { ProgressView } from "./progress-view.js";
import { ReportsView } from "./reports-view.js";
import { InsightView } from "./view.js";
import { AnalysisBudget } from "./budget-view.js";
function model(): ReturnType<typeof useInsightModel> {
  return {
    m: insightsMessages("es"),
    client: insightsClient(vi.fn()),
    abort: { current: new AbortController() },
    error: false,
    setError: vi.fn(),
    busy: false,
    data: null,
    setData: vi.fn(),
    student: "student",
    setStudent: vi.fn(),
    students: [{ id: "student", displayName: "Ana" }],
    page: null,
    setPage: vi.fn(),
    reason: "Reviewed",
    setReason: vi.fn(),
    level: 2,
    setLevel: vi.fn(),
    selectedReport: null,
    setSelectedReport: vi.fn(),
    report: null,
    setReport: vi.fn(),
    from: "2026-09-27T00:00",
    setFrom: vi.fn(),
    to: "2026-09-28T00:00",
    setTo: vi.fn(),
    load: () => Promise.resolve(),
    action: () => Promise.resolve(),
  };
}
const props: InsightViewProps & { classId: string } = {
  kind: "map",
  classId: "class:a",
  locale: "es",
  fetchRequest: vi.fn(),
  navigate: () => Promise.resolve(true),
};
describe("educational dashboard views", () => {
  it("asks for a class and labels attention without relying on color", () => {
    expect(renderToStaticMarkup(<InsightView {...props} classId={null} />)).toContain(
      "Selecciona una clase",
    );
    const state = model();
    state.data = {
      enabled: true,
      configured: true,
      entries: [
        {
          runId: "run:a",
          student: "Ana",
          project: "Example",
          state: "red",
          reason: "Repeated test failure",
          confidence: "high",
          analyzedAt: "2026-09-28T00:00:00Z",
        },
      ],
    };
    const html = renderToStaticMarkup(<MapView model={state} props={props} shared={null} />);
    expect(html).toContain("Necesita atención");
    expect(html).toContain("Repeated test failure");
    expect(html).toContain("Abrir sesión");
  });
  it("shows the four criteria levels and requires a reason before adjusting", () => {
    const state = model();
    state.reason = "";
    state.data = {
      revision: "revision:1",
      entries: [
        {
          key: "key",
          skillId: "skill",
          code: "C1",
          statement: "Test an empty input",
          level: 2,
          levels: ["One", "Two", "Three", "Four"],
          epoch: 0,
        },
      ],
    };
    const html = renderToStaticMarkup(
      <ProgressView model={state} props={{ ...props, kind: "progress" }} shared={null} />,
    );
    expect(html).toContain("2/4");
    expect(html).toContain("Test an empty input");
    expect(html).toContain('<button disabled="">Fijar nivel</button>');
    expect(html).toContain("Historial");
  });
  it("shows provisional sources and authorized student names in reports", () => {
    const state = model();
    state.selectedReport = "report";
    state.report = {
      id: "report",
      state: "complete",
      from: "from",
      to: "to",
      completed: 1,
      total: 1,
      students: [{ alias: "A001", displayName: "Ana <script>" }],
      result: {
        partial: false,
        synthesis: { summary: "Practice loops", findings: [], recommendation: "Use an example" },
        evidence: [
          {
            runId: "run:a",
            alias: "A001",
            mode: "tutoring",
            status: "provisional",
            evaluation: null,
          },
        ],
      },
    };
    const html = renderToStaticMarkup(
      <ReportsView model={state} props={{ ...props, kind: "reports" }} shared={null} />,
    );
    expect(html).toContain("Provisional");
    expect(html).toContain("Ana &lt;script&gt;");
    expect(html).toContain("Descargar HTML");
  });
  it("shows independent analysis usage and no budget when unconfigured", () => {
    expect(renderToStaticMarkup(<AnalysisBudget locale="es" budget={null} />)).toBe("");
    const html = renderToStaticMarkup(
      <AnalysisBudget
        locale="es"
        budget={{
          requests: 2,
          maxRequests: 10,
          tokens: 20,
          maxTokens: 100,
          costUnits: 30,
          maxCostUnits: 200,
          costUnit: "units",
        }}
      />,
    );
    expect(html).toContain("2/10");
    expect(html).toContain("20/100");
  });
});
