import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isValidElement, type FunctionComponent, type ReactNode, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MapView } from "./map-view.js";
import { ProgressView } from "./progress-view.js";
import { ReportsView } from "./reports-view.js";
import { CriterionHistory } from "./history-view.js";
import { EducationalSettings } from "./settings.js";
import { InsightView } from "./view.js";
import { button, elements, model, props } from "./interactions.fixture.js";
type HookValue = object | string | number | boolean | null;
const hooks = vi.hoisted(() => ({
  values: [] as HookValue[],
  index: 0,
  refs: [] as { current: HookValue }[],
  refIndex: 0,
  dependencies: [] as (readonly HookValue[] | undefined)[],
  effects: [] as (() => undefined | (() => void))[],
}));
const mocked = vi.hoisted(() => ({ client: vi.fn(), model: vi.fn() }));
vi.mock("./client.js", () => ({ insightsClient: () => mocked.client }));
vi.mock("./model.js", () => ({ useInsightModel: mocked.model }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: HookValue) => {
    const i = hooks.index++;
    if (!(i in hooks.values)) hooks.values[i] = initial;
    return [
      hooks.values[i],
      (value: HookValue) => {
        hooks.values[i] =
          typeof value === "function"
            ? (value as (previous: HookValue) => HookValue)(hooks.values[i] ?? null)
            : value;
      },
    ];
  },
  useRef: (initial: HookValue) => {
    const i = hooks.refIndex++;
    return (hooks.refs[i] ??= { current: initial });
  },
  useEffect: (effect: () => undefined | (() => void), dependencies?: readonly HookValue[]) => {
    hooks.dependencies.push(dependencies);
    hooks.effects.push(effect);
  },
}));
function render<T>(component: () => T): T {
  hooks.index = 0;
  hooks.refIndex = 0;
  hooks.effects = [];
  hooks.dependencies = [];
  return component();
}
function content(element: ReactElement): ReactNode {
  if (typeof element.type !== "function") throw new Error("Expected function component");
  const component = element.type as FunctionComponent<object>;
  const result = component(element.props as object);
  if (result instanceof Promise) throw new Error("Expected synchronous component");
  return result;
}
beforeEach(() => {
  hooks.values = [];
  hooks.refs = [];
  hooks.effects = [];
  hooks.dependencies = [];
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const entry = {
  id: 1,
  runId: null,
  previousLevel: 0,
  level: 1,
  reason: "Practice",
  actor: "teacher",
  createdAt: "now",
};
const history = () =>
  CriterionHistory({
    client: mocked.client,
    classId: "class:a",
    studentId: "student",
    criterionKey: "key",
    locale: "es",
  });
it("loads history, appends another page and replaces it on refresh", async () => {
  const m = model().m;
  mocked.client
    .mockResolvedValueOnce({
      entries: Array.from({ length: 51 }, (_, i) => ({ ...entry, id: i + 1 })),
    })
    .mockResolvedValueOnce({ entries: [{ ...entry, id: 52 }] })
    .mockResolvedValueOnce({ entries: [] });
  let view = render(history);
  expect(hooks.values).toEqual([[], false, false, false, false]);
  expect(hooks.dependencies).toEqual([[]]);
  expect(renderToStaticMarkup(view)).not.toContain('role="alert"');
  expect(renderToStaticMarkup(view)).not.toContain("<ol>");
  const dispose = hooks.effects[0]?.();
  button(view, m.history).onClick?.();
  expect(button(render(history), m.history).disabled).toBe(true);
  expect(mocked.client.mock.lastCall?.[1]).toEqual({
    kind: "history",
    studentId: "student",
    key: "key",
    after: 0,
  });
  await vi.advanceTimersByTimeAsync(1);
  view = render(history);
  expect(elements(view).filter((e) => e.type === "li")).toHaveLength(51);
  button(view, m.more).onClick?.();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocked.client.mock.lastCall?.[1]).toMatchObject({ after: 51 });
  expect(elements(render(history)).filter((e) => e.type === "li")).toHaveLength(52);
  button(render(history), m.history).onClick?.();
  await vi.advanceTimersByTimeAsync(1);
  expect(elements(render(history)).filter((e) => e.type === "li")).toHaveLength(0);
  if (typeof dispose === "function") dispose();
  expect((mocked.client.mock.lastCall?.[3] as AbortSignal).aborted).toBe(true);
});
it.each([false, true])("does not publish history after unmount (failure: %s)", async (failure) => {
  const pending = Promise.withResolvers<object>();
  mocked.client.mockReturnValue(pending.promise);
  const view = render(history);
  const dispose = hooks.effects[0]?.();
  button(view, model().m.history).onClick?.();
  if (typeof dispose === "function") dispose();
  if (failure) pending.reject(new Error("offline"));
  else pending.resolve({ entries: [entry] });
  await vi.advanceTimersByTimeAsync(1);
  expect(hooks.values[0]).toEqual([]);
  expect(hooks.values[3]).toBe(false);
});
it("shows a history failure and permits retry", async () => {
  mocked.client.mockRejectedValue(new Error("offline"));
  button(render(history), model().m.history).onClick?.();
  await vi.advanceTimersByTimeAsync(1);
  expect(hooks.values[3]).toBe(true);
  expect(renderToStaticMarkup(render(history))).toContain('role="alert"');
  expect(button(render(history), model().m.history).disabled).toBe(false);
});
const settings = {
  settings: { map: false, adaptive: false },
  revision: "v1",
  mapConfigured: false,
};
const settingsView = () => {
  const element = EducationalSettings({ ...props });
  if (!isValidElement(element)) throw new Error("Expected settings");
  return content(element);
};
it("loads, edits and saves educational settings", async () => {
  expect(EducationalSettings({ ...props, classId: null })).toBeNull();
  mocked.client.mockResolvedValue(settings);
  expect(renderToStaticMarkup(render(settingsView))).not.toContain('role="alert"');
  expect(hooks.values).toEqual([null, false, false]);
  expect(hooks.dependencies).toEqual([[props.classId, props.fetchRequest]]);
  const dispose = hooks.effects[0]?.();
  expect(mocked.client.mock.lastCall?.[1]).toEqual({ kind: "settings" });
  await vi.advanceTimersByTimeAsync(1);
  let view = render(settingsView);
  for (const checkbox of elements(view).filter((e) => e.type === "input")) {
    checkbox.props.onChange?.({ currentTarget: { checked: true, value: "" } });
    view = render(settingsView);
  }
  // Each event is issued from the latest rendered form.
  elements(view)
    .find((e) => e.type === "input")
    ?.props.onChange?.({ currentTarget: { checked: true, value: "" } });
  view = render(settingsView);
  mocked.client.mockResolvedValueOnce({ ...settings, revision: "v2" });
  const preventDefault = vi.fn();
  elements(view)
    .find((e) => e.type === "form")
    ?.props.onSubmit?.({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(mocked.client.mock.lastCall?.[1]).toMatchObject({
    kind: "configure",
    settings: { map: true, adaptive: true },
    expectedRevision: "v1",
  });
  expect(button(render(settingsView), model().m.save).disabled).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(button(render(settingsView), model().m.save).disabled).toBe(false);
  expect(hooks.values[0]).toEqual({ ...settings, revision: "v2" });
  if (typeof dispose === "function") dispose();
});
it.each([false, true])("ignores settings load after disposal (failure: %s)", async (failure) => {
  const pending = Promise.withResolvers<object>();
  mocked.client.mockReturnValue(pending.promise);
  void render(settingsView);
  const dispose = hooks.effects[0]?.();
  if (typeof dispose === "function") dispose();
  if (failure) pending.reject(new Error("offline"));
  else pending.resolve(settings);
  await vi.advanceTimersByTimeAsync(1);
  expect(hooks.values[0]).toBeNull();
  expect(hooks.values[1]).toBe(false);
});
it("shows settings read and write errors and ignores a disposed save", async () => {
  mocked.client.mockRejectedValueOnce(new Error("offline"));
  void render(settingsView);
  hooks.effects[0]?.();
  await vi.advanceTimersByTimeAsync(1);
  expect(hooks.values[1]).toBe(true);
  expect(renderToStaticMarkup(render(settingsView))).toContain('role="alert"');
  mocked.client.mockResolvedValue(settings);
  void render(settingsView);
  const dispose = hooks.effects[0]?.();
  await vi.advanceTimersByTimeAsync(1);
  mocked.client.mockRejectedValueOnce(new Error("conflict"));
  elements(render(settingsView))
    .find((e) => e.type === "form")
    ?.props.onSubmit?.({ preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(1);
  expect(hooks.values[1]).toBe(true);
  expect(renderToStaticMarkup(render(settingsView))).toContain('role="alert"');
  const pending = Promise.withResolvers<object>();
  mocked.client.mockReturnValueOnce(pending.promise);
  elements(render(settingsView))
    .find((e) => e.type === "form")
    ?.props.onSubmit?.({ preventDefault: vi.fn() });
  expect(hooks.values[1]).toBe(false);
  if (typeof dispose === "function") dispose();
  pending.resolve({ ...settings, revision: "v2" });
  await vi.advanceTimersByTimeAsync(1);
  expect(hooks.values[0]).toEqual(settings);
});
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
it("uses an aborted signal if a settings form outlives its pending controller", async () => {
  mocked.client.mockResolvedValue(settings);
  void render(settingsView);
  hooks.effects[0]?.();
  await vi.advanceTimersByTimeAsync(1);
  const ref = hooks.refs[0];
  if (!ref) throw new Error("missing pending controller");
  ref.current = null;
  mocked.client.mockResolvedValueOnce({ ...settings, revision: "v3" });
  elements(render(settingsView))
    .find((e) => e.type === "form")
    ?.props.onSubmit?.({ preventDefault: vi.fn() });
  expect((mocked.client.mock.lastCall?.[3] as AbortSignal).aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(hooks.values[1]).toBe(false);
  expect(hooks.values[0]).toEqual({ ...settings, revision: "v3" });
});

it.each([false, true, undefined])(
  "warns only when the map is explicitly unconfigured (%s)",
  (configured) => {
    hooks.values = [{ ...settings, mapConfigured: configured }, false, false];
    expect(renderToStaticMarkup(render(settingsView)).includes(model().m.unconfigured)).toBe(
      configured === false,
    );
  },
);
it("clears the previous class settings while loading a new class", () => {
  mocked.client.mockReturnValue(new Promise(() => undefined));
  hooks.values = [settings, true, false];
  void render(settingsView);
  hooks.effects[0]?.();
  expect(hooks.values[0]).toBeNull();
  expect(hooks.values[1]).toBe(false);
});
it.each(["progress", "reports"] as const)("loads %s without waiting for intersection", (kind) => {
  const observer = vi.fn();
  vi.stubGlobal("IntersectionObserver", observer);
  render(() => InsightView({ ...props, kind }));
  hooks.effects[0]?.();
  expect(observer).not.toHaveBeenCalled();
  expect(hooks.values[0]).toBe(true);
});
