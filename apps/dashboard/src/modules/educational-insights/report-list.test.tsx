import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReportList } from "./report-list.js";
import { insightsMessages } from "./messages.js";
import { button, elements } from "./interactions.fixture.js";

const m = insightsMessages("es");
const entry = (id: string, state: string, extra: object = {}) => ({
  id,
  state,
  createdAt: "2026-10-02T08:00:00.000Z",
  from: "2026-09-25T08:00:00.000Z",
  to: "2026-10-02T08:00:00.000Z",
  completed: 2,
  total: 5,
  ...extra,
});
function render(entries: ReturnType<typeof entry>[], page: string | null = null) {
  const props = { entries, page, setPage: vi.fn(), select: vi.fn(), m, locale: "es" };
  return { props, node: ReportList(props), html: renderToStaticMarkup(ReportList(props)) };
}

it("explains an empty history and offers no paging", () => {
  const { html } = render([]);
  expect(html).toBe(
    `<section class="report-history"><h3>${m.reportHistory}</h3><p class="insight-note">${m.noReports}</p><div class="report-pages"></div></section>`,
  );
});

it("shows when, which period and how far each report got, and opens one", () => {
  const { html, node, props } = render([
    entry("a", "running"),
    entry("b", "queued"),
    entry("c", "complete"),
    entry("d", "toString", { createdAt: "now", from: "", to: "" }),
    entry("e", "future", { to: "bad" }),
  ]);
  const created = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date("2026-10-02T08:00:00.000Z"),
  );
  const range = new Intl.DateTimeFormat("es", { dateStyle: "medium" }).formatRange(
    new Date("2026-09-25T08:00:00.000Z"),
    new Date("2026-10-02T08:00:00.000Z"),
  );
  const row = (state: string, label: string) =>
    `<button type="button" class="report-row" data-state="${state}"><time class="report-when" dateTime="2026-10-02T08:00:00.000Z">${created}</time><span class="report-period">${m.period}: ${range}</span><span class="report-state">${label}</span></button>`;
  expect(html).toContain(row("running", `${m.running} · 2/5`));
  expect(html).toContain(row("queued", `${m.queued} · 2/5`));
  expect(html).toContain(row("complete", m.complete));
  // Unknown values are shown as sent; inherited object keys are not message names.
  expect(html).toContain(
    `<time class="report-when" dateTime="now">now</time><span class="report-period">${m.period}: —</span><span class="report-state">toString</span>`,
  );
  expect(html).toContain(
    `<span class="report-period">${m.period}: —</span><span class="report-state">future</span>`,
  );
  expect(html).toContain('<div class="report-pages"></div>');
  const rows = elements(node).filter((e) => e.type === "button" && e.props.children !== m.more);
  rows[2]?.props.onClick?.();
  expect(props.select).toHaveBeenCalledExactlyOnceWith("c");
});

it("pages back to the newest reports and forward after the last one shown", () => {
  const full = Array.from({ length: 51 }, (_, index) => entry(`r${String(index)}`, "complete"));
  const first = render(full);
  expect(() => button(first.node, m.back)).toThrow();
  button(first.node, m.more).onClick?.();
  expect(first.props.setPage).toHaveBeenCalledExactlyOnceWith("r50");
  const last = render(full.slice(0, 50), "r50");
  expect(() => button(last.node, m.more)).toThrow();
  button(last.node, m.back).onClick?.();
  expect(last.props.setPage).toHaveBeenCalledExactlyOnceWith(null);
});
