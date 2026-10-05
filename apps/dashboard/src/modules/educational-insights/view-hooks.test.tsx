import { hooks, mocked, render, content } from "./hooks.fixture.js";
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { MapView } from "./map-view.js";
import { ProgressView } from "./progress-view.js";
import { ReportsView } from "./reports-view.js";
import { InsightView } from "./view.js";
import { button, elements, model, props } from "./interactions.fixture.js";
it.each(["map", "progress", "reports"] as const)("renders %s content and refreshes it", (kind) => {
  const state = model();
  state.error = true;
  mocked.model.mockReturnValue(state);
  const view = render(() => InsightView({ ...props, kind }));
  expect(hooks.values[0]).toBe(false);
  expect(hooks.dependencies).toEqual([[kind]]);
  hooks.effects[0]?.();
  expect(hooks.values[0]).toBe(true);
  const child = elements(view).find((e) => typeof e.type === "function");
  if (!child) throw new Error("Missing content");
  expect(child.key).toContain(`class=2a=2${kind}`);
  const rendered = content(child) as ReactElement<{ shared: ReactElement }>;
  expect(rendered.type).toBe({ map: MapView, progress: ProgressView, reports: ReportsView }[kind]);
  expect(renderToStaticMarkup(rendered.props.shared)).toContain('role="alert"');
  button(rendered.props.shared, state.m.refresh).onClick?.();
  expect(state.load).toHaveBeenCalledOnce();
  state.error = false;
  expect(
    renderToStaticMarkup((content(child) as ReactElement<{ shared: ReactElement }>).props.shared),
  ).not.toContain('role="alert"');
});
it.each([null, {}])("observes map visibility and disconnects on unmount (%s)", (element) => {
  const observe = vi.fn(),
    disconnect = vi.fn();
  let callback: (entries: { isIntersecting: boolean }[]) => void = () => undefined;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: typeof callback) {
        callback = cb;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  render(() => InsightView({ ...props, classId: null }));
  const ref = hooks.refs[0];
  if (!ref) throw new Error("missing ref");
  ref.current = element;
  const dispose = hooks.effects[0]?.();
  expect(observe).toHaveBeenCalledTimes(element === null ? 0 : 1);
  callback([{ isIntersecting: false }]);
  expect(hooks.values[0]).toBe(false);
  callback([{ isIntersecting: false }, { isIntersecting: true }]);
  expect(hooks.values[0]).toBe(true);
  if (typeof dispose === "function") dispose();
  expect(disconnect).toHaveBeenCalledOnce();
});
it.each(["progress", "reports"] as const)("loads %s without waiting for intersection", (kind) => {
  const observer = vi.fn();
  vi.stubGlobal("IntersectionObserver", observer);
  render(() => InsightView({ ...props, kind }));
  hooks.effects[0]?.();
  expect(observer).not.toHaveBeenCalled();
  expect(hooks.values[0]).toBe(true);
});
