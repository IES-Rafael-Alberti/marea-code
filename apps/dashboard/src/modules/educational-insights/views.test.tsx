import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MapView } from "./map-view.js";
import { StudentProgress } from "./progress-view.js";
import { ReportsView } from "./reports-view.js";
import { InsightView } from "./view.js";
import { AnalysisBudget } from "./budget-view.js";
import { criterion, model, props } from "./interactions.fixture.js";
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
    const time = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit" }).format(
      new Date("2026-09-28T00:00:00Z"),
    );
    expect(html).toContain(`<p class="map-meta">Confianza alta · ${time}</p>`);
    expect(html).toContain('<p class="map-reason">Repeated test failure</p>');
    // The legend names every attention colour in order.
    for (const label of [
      "Necesita atención",
      "Conviene observar",
      "Progresa",
      "Pendiente de análisis",
    ])
      expect(html).toContain(`<i aria-hidden="true"></i>${label}</li>`);
  });
  it("shows the four criteria levels and requires a reason before adjusting", () => {
    const state = model();
    const html = renderToStaticMarkup(
      <StudentProgress
        student={{
          id: "student",
          displayName: "Ana",
          revision: "revision:1",
          entries: [
            criterion,
            { ...criterion, key: "done", code: "C2", level: 4 },
            // A malformed definition without level texts still names the next level.
            { ...criterion, key: "bare", code: "C3", levels: [] },
            { ...criterion, key: "loops", code: "C4", skillId: "teacher/class:a/loops" },
          ],
        }}
        open
        model={state}
        props={{ ...props, kind: "progress" }}
      />,
    );
    expect(html).toContain(
      '<details class="progress-student" open=""><summary><strong>Ana</strong><span class="progress-summary">4 criterios · 1 consolidados</span></summary>',
    );
    expect(html).toContain('<section class="progress-skill"><h3 title="skill">skill</h3>');
    expect(html).toContain('<h3 title="teacher/class:a/loops">loops</h3>');
    // The adjustment form comes first: a reason is chosen before any criterion is set.
    expect(html.indexOf("progress-adjust")).toBeLessThan(html.indexOf("progress-skill"));
    expect(html).toContain(
      '<p class="progress-statement"><strong>C1</strong> · Test boundaries</p><p class="progress-level">2/4</p><p class="progress-next">Próximo nivel 3/4 · Three</p>',
    );
    expect(html).toContain(
      '<p class="progress-next">Consolidado: deja de ser foco de los ejercicios</p>',
    );
    expect(html).toContain('<button type="button" disabled="">Fijar nivel</button>');
    expect(html).toContain('<p class="progress-next">Próximo nivel 3/4 · </p>');
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
