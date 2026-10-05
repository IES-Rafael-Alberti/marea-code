import { expect, it } from "vitest";
import { fixture } from "./insights.fixture.js";
import { NOW, teacher, EVALUATION_DRAFT } from "../../test-support/evaluation-fixture.js";
import { renderReport } from "./report-html.js";

it("renders every finding and evidence row, resolves names, rounds rates and escapes all HTML metacharacters", () => {
  const f = fixture();
  const query = f.query({
    kind: "generate",
    from: "2026-01-01T00:00:00.000Z",
    to: NOW,
    locale: "en",
  });
  if (query.kind !== "generate") throw new Error("query");
  const report = f.service.reports.generate(teacher, query);
  const finding = {
    title: `A&B<>"'`,
    mode: "tutoring" as const,
    skillIds: [],
    evaluable: ["A001", "A002", "A003"],
    affected: ["A001"],
    evidence: ["run:one", "run:two"],
    explanation: `A&B<>"'`,
    recommendation: `A&B<>"'`,
  };
  const result = {
    partial: false,
    synthesis: {
      summary: "Summary",
      recommendation: "Next",
      findings: [finding, { ...finding, title: "Second", affected: ["A002", "unknown"] }],
    },
    evidence: [
      {
        runId: `run:<one>&"'`,
        alias: "A001",
        mode: "tutoring" as const,
        skills: [],
        status: "approved" as const,
        evaluation: EVALUATION_DRAFT,
      },
      {
        runId: "run:two",
        alias: "unknown",
        mode: "free" as const,
        skills: [],
        status: "unavailable" as const,
        evaluation: null,
      },
    ],
  };
  const rendered = {
    ...report,
    state: "complete",
    locale: "en" as const,
    students: [
      { alias: "A002", studentId: "s2", displayName: "Second student" },
      { alias: "A001", studentId: "s1", displayName: `A&B<>"'` },
    ],
    result,
  };
  const html = renderReport(rendered);
  const escaped = "A&amp;B&lt;&gt;&quot;&#39;";
  expect(html).toContain(
    `<article><h2>${escaped}</h2><p>Tutoring · 1/3 (33%)</p><p>${escaped}</p><p>${escaped}</p><p>${escaped}</p><p>run:one, run:two</p></article>`,
  );
  expect(html).toContain("<article><h2>Second</h2><p>Tutoring · 2/3 (67%)</p>");
  expect(html).toContain("<p>Second student, unknown</p>");
  expect(html).toContain("</article><article>");
  expect(html).toContain(
    `<tr><td>run:&lt;one&gt;&amp;&quot;&#39;</td><td>${escaped}</td><td>Tutoring</td><td>Approved</td></tr><tr><td>run:two</td><td>unknown</td><td>Free</td><td>Unavailable</td></tr>`,
  );
  expect(html).toContain("<p>Complete</p><p>Summary</p>");
  expect(html).toContain("<p>Next</p><h2>Evidence</h2>");
  expect(() => renderReport({ ...rendered, state: "failed" })).toThrow("request.conflict");
  expect(() => renderReport({ ...rendered, result: null })).toThrow("request.conflict");
});
