import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { reviewButton, reviewElements } from "../evaluation/react-tree.fixture.js";
import { healthResult } from "../usage-health.fixture.js";
import type { HealthState } from "./health-controller.js";
import { healthMessages } from "./health-messages.js";
import { HealthView } from "./health-view.js";

const render = (state: HealthState, locale: "es" | "en" | "eu" = "en", refresh = vi.fn()) =>
  renderToStaticMarkup(<HealthView locale={locale} state={state} refresh={refresh} />);

it.each(["es", "en", "eu"] as const)("localizes waiting and failure states in %s", (locale) => {
  const m = healthMessages(locale);
  for (const status of ["empty", "loading", "error", "denied"] as const) {
    const html = render({ status }, locale);
    expect(html).toContain(`<p>${m[status]}</p>`);
    expect(html).toContain(m.meaning);
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("<dl>");
  }
});

it.each(["es", "en", "eu"] as const)("preserves available, stale and unknown in %s", (locale) => {
  const m = healthMessages(locale);
  const html = render({ status: "ready", response: healthResult }, locale);
  for (const key of ["storage", "usageLedger", "inference", "telemetryDelivery"] as const)
    expect(html).toContain(`<dt>${m[key]}</dt>`);
  expect(html).toContain(`<dd>${m.available}</dd>`);
  expect(html).toContain(`<dd>${m.stale}</dd>`);
  expect(html.match(new RegExp(`<dd>${m.unknown}</dd>`, "g"))).toHaveLength(2);
  expect(html.match(new RegExp(m.notObserved, "g"))).toHaveLength(2);
  expect(html).toContain('dateTime="2026-09-07T23:00:00.000Z"');
  expect(html).toContain('dateTime="2026-09-08T00:10:00.000Z"');
  expect(html).toContain(m.inferenceNote);
  expect(html).toContain(m.telemetryNote);
  expect(html).toContain(m.staleAfter.replace("{minutes}", "5"));
  expect(html).toContain(`${m.checked}: <time`);
  expect(html).not.toContain(m.empty);
});

it("never presents unknown delivery as available and wires refresh when idle", () => {
  const refresh = vi.fn();
  const m = healthMessages("en");
  const ready = (
    <HealthView locale="en" state={{ status: "ready", response: healthResult }} refresh={refresh} />
  );
  const html = renderToStaticMarkup(ready);
  const delivery = html.slice(html.indexOf(m.telemetryDelivery));
  expect(delivery.indexOf(m.unknown)).toBeLessThan(delivery.indexOf(m.telemetryNote));
  expect(delivery).not.toContain(`<dd>${m.available}</dd>`);
  const button = reviewButton(reviewElements(ready), m.refresh);
  expect(button.props.disabled).toBe(false);
  button.props.onClick?.();
  expect(refresh).toHaveBeenCalledOnce();
  for (const status of ["empty", "loading"] as const)
    expect(render({ status })).toContain('disabled=""');
  for (const status of ["error", "denied"] as const)
    expect(render({ status })).not.toContain('disabled=""');
});

it("attaches each measurement caveat only to its own row and formats times with seconds", () => {
  const m = healthMessages("en");
  const html = render({ status: "ready", response: healthResult });
  expect(html.split(m.inferenceNote)).toHaveLength(2);
  expect(html.split(m.telemetryNote)).toHaveLength(2);
  const rows = html.split("<div>").slice(1);
  expect(rows.map((row) => row.includes(m.inferenceNote))).toEqual([false, false, true, false]);
  expect(rows.map((row) => row.includes(m.telemetryNote))).toEqual([false, false, false, true]);
  const time = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "medium" }).format(
    new Date("2026-09-07T23:00:00.000Z"),
  );
  expect(html).toContain(`>${time}</time>`);
});
