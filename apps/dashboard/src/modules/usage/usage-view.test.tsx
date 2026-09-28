import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";
import { reviewButton, reviewElements } from "../evaluation/react-tree.fixture.js";
import { usageResult } from "../usage-health.fixture.js";
import type { UsageState } from "./usage-controller.js";
import { usageMessages } from "./usage-messages.js";
import { UsageView, type UsageActions } from "./usage-view.js";

const range = { from: "2026-09-01", to: "2026-09-07" };
const base = { range, draft: range, page: 1 };
const ready = (response = usageResult, page = 1): UsageState => ({
  ...base,
  page,
  status: "ready",
  response,
});
function actions(): UsageActions {
  return {
    edit: vi.fn(),
    apply: vi.fn(() => Promise.resolve()),
    next: vi.fn(() => Promise.resolve()),
    previous: vi.fn(() => Promise.resolve()),
    refresh: vi.fn(() => Promise.resolve()),
  };
}
const view = (state: UsageState, locale: "es" | "en" | "eu" = "en", handlers = actions()) => (
  <UsageView locale={locale} state={state} actions={handlers} />
);
const disabled = (node: ReactElement, label: string) =>
  reviewButton(reviewElements(node), label).props.disabled;

it.each(["es", "en", "eu"] as const)("localizes every state and the page scope in %s", (locale) => {
  const m = usageMessages(locale);
  for (const status of ["empty", "loading", "error", "denied"] as const) {
    const html = renderToStaticMarkup(view({ ...base, status }, locale));
    expect(html).toContain(m[status]);
    expect(html).toContain(m.scope);
    expect(html).toContain('role="status"');
    expect(html).not.toContain("<table");
  }
  for (const pricing of ["complete", "partial", "unavailable"] as const)
    expect(renderToStaticMarkup(view(ready({ ...usageResult, pricing }), locale))).toContain(
      m[pricing],
    );
  const html = renderToStaticMarkup(view(ready(), locale));
  for (const key of [
    "tutoring",
    "evaluation",
    "settled",
    "reserved",
    "reported",
    "reservation",
  ] as const)
    expect(html).toContain(m[key]);
  expect(html).toContain(m.costUnavailable);
  expect(html).toContain(`${new Intl.NumberFormat(locale).format(1200)}</td>`);
  expect(html).toContain("17 credits");
  expect(html).toContain('dateTime="2026-09-02T10:00:00.000Z"');
  const created = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  expect(html).toContain(`>${created.format(new Date("2026-09-02T10:00:00.000Z"))}</time>`);
  expect(html).toContain('scope="col"');
  expect(renderToStaticMarkup(view(ready({ ...usageResult, entries: [] }), locale))).toContain(
    m.none,
  );
});

it("labels unknown and over-limit attempts and never sums a page total", () => {
  const m = usageMessages("en");
  const [entry] = usageResult.entries;
  if (entry === undefined) throw new Error("fixture");
  const html = renderToStaticMarkup(
    view(
      ready({
        ...usageResult,
        pricing: "complete",
        entries: [
          { ...entry, state: "unknown" },
          { ...entry, attemptId: "attempt:3", state: "breached" },
        ],
      }),
    ),
  );
  expect(html).toContain(m.unknown);
  expect(html).toContain(m.breached);
  expect(html.match(/17 credits/g)).toHaveLength(2);
  expect(html).not.toContain("34 credits");
});

it("validates the draft period and wires period, paging and refresh controls", () => {
  const m = usageMessages("en");
  const handlers = actions();
  const node = view(ready(usageResult, 2), "en", handlers);
  const elements = reviewElements(node);
  const inputs = elements.filter((element) => element.type === "input");
  expect(inputs.map((input) => input.props.value)).toEqual([range.from, range.to]);
  inputs[0]?.props.onChange?.({ currentTarget: { value: "2026-08-30" } });
  inputs[1]?.props.onChange?.({ currentTarget: { value: "2026-09-02" } });
  expect(handlers.edit).toHaveBeenNthCalledWith(1, "from", "2026-08-30");
  expect(handlers.edit).toHaveBeenNthCalledWith(2, "to", "2026-09-02");
  const form = elements.find((element) => element.type === "form") as ReactElement<{
    onSubmit: (event: { preventDefault: () => void }) => void;
  }>;
  const preventDefault = vi.fn();
  form.props.onSubmit({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(handlers.apply).toHaveBeenCalledOnce();
  for (const [label, action] of [
    [m.previous, handlers.previous],
    [m.next, handlers.next],
    [m.refresh, handlers.refresh],
  ] as const) {
    expect(disabled(node, label)).toBe(false);
    reviewButton(elements, label).props.onClick?.();
    expect(action).toHaveBeenCalledOnce();
  }
  expect(disabled(node, m.apply)).toBe(false);
  expect(renderToStaticMarkup(node)).toContain(`${m.page} 2`);
  expect(renderToStaticMarkup(node)).not.toContain('role="alert"');
  expect(renderToStaticMarkup(node)).toContain('aria-invalid="false"');
});

it("disables unavailable actions and explains an invalid period", () => {
  const m = usageMessages("en");
  const first = view(ready({ ...usageResult, nextAfterAttemptId: null }));
  expect([m.previous, m.next, m.refresh, m.apply].map((label) => disabled(first, label))).toEqual([
    true,
    true,
    false,
    false,
  ]);
  const loading = view({ ...base, page: 2, status: "loading" });
  expect([m.previous, m.next, m.refresh, m.apply].map((label) => disabled(loading, label))).toEqual(
    [true, true, true, true],
  );
  const empty = view({ ...base, status: "empty" });
  expect([m.refresh, m.apply].map((label) => disabled(empty, label))).toEqual([true, true]);
  const failed = view({ ...base, page: 2, status: "error" });
  expect([m.previous, m.next, m.refresh].map((label) => disabled(failed, label))).toEqual([
    false,
    true,
    false,
  ]);
  const invalid = view({ ...ready(), draft: { from: "2026-09-08", to: "2026-09-07" } });
  expect(disabled(invalid, m.apply)).toBe(true);
  const html = renderToStaticMarkup(invalid);
  expect(html).toContain(`<p role="alert">${m.invalidRange}</p>`);
  expect(html).toContain('aria-invalid="true"');
});
