import { dashboardThemeLoaders } from "@marea/plugin-runtime/browser";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import * as catalogModule from "./profile-catalog.js";
import * as hostModule from "./module-host.js";
import { ProfileEditor } from "./profile-editor.js";
import { ProfileShell } from "./profile-shell.js";
import { ModulePlugin } from "./module-plugin.js";
import { SessionPlugin } from "./session-plugin.js";
import { ProfileController } from "./profile-controller.js";
import { SessionsController } from "../modules/sessions/sessions-controller.js";
import { evaluationClientFixture } from "../modules/evaluation/evaluation.fixture.js";
import { clientFixture, catalog, release, selection, state, value } from "./profile.fixture.js";
import type { ProfileRuntime } from "./profile-shell.js";
const hooks = vi.hoisted(() => ({
  values: [] as (object | string | number | boolean | null)[],
  index: 0,
  refs: [] as (object | string | number | boolean | null)[],
  refIndex: 0,
  initials: [] as (object | string | number | boolean | null)[],
  dependencies: [] as (readonly (object | string | number | boolean | null | undefined)[])[],
  effects: [] as (() => undefined | (() => void))[],
  setters: [] as ReturnType<typeof vi.fn>[],
  root: { render: vi.fn(), unmount: vi.fn() },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useMemo: <T,>(create: () => T) => create(),
  useState: <T extends object | string | number | boolean | null>(initial: T) => {
    hooks.initials.push(initial);
    const index = hooks.index++;
    const current = index in hooks.values ? (hooks.values[index] as T) : initial;
    const setter = vi.fn((next: T | ((previous: T) => T)) => {
      hooks.values[index] =
        typeof next === "function"
          ? (next as (previous: T) => T)(
              index in hooks.values ? (hooks.values[index] as T) : current,
            )
          : next;
    });
    hooks.setters[index] = setter;
    return [current, setter];
  },
  useRef: (initial: object | number | boolean | null) => {
    const index = hooks.refIndex++;
    hooks.refs[index] ??= { current: initial };
    return hooks.refs[index];
  },
  useEffect: (
    effect: () => undefined | (() => void),
    dependencies: readonly (object | string | number | boolean | null | undefined)[],
  ) => {
    hooks.dependencies.push(dependencies);
    hooks.effects.push(effect);
  },
}));
vi.mock("../telemetry/preview-panel.js", () => ({
  PreviewPanel: () => <section aria-label="Telemetry preview fixture" />,
}));
vi.mock("react-dom/client", () => ({ createRoot: () => hooks.root }));
vi.mock("@marea/plugin-runtime/browser", async (original) => {
  const runtime = await original<typeof import("@marea/plugin-runtime/browser")>();
  return { ...runtime, dashboardThemeLoaders: { ...runtime.dashboardThemeLoaders } };
});
interface Control {
  readonly value?: string;
  readonly children?: ReactNode;
  readonly onChange?: (event: { currentTarget: { value: string } }) => void;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
}
function elements(node: ReactNode): ReactElement<Control>[] {
  return Children.toArray(node).flatMap((item) =>
    isValidElement<Control>(item) ? [item, ...elements(item.props.children)] : [],
  );
}
function reset(
  values: (object | string | number | boolean | null)[],
  refs: (object | string | number | boolean | null)[],
) {
  hooks.index = 0;
  hooks.refIndex = 0;
  hooks.effects = [];
  hooks.initials = [];
  hooks.dependencies = [];
  hooks.values = values;
  hooks.refs = refs;
}
const runtime: ProfileRuntime = {
  fetch: vi.fn(),
  sessions: {
    ...evaluationClientFixture(),
    classes: vi.fn().mockResolvedValue({ runs: [], nextBeforeRunId: null }),
  },
  notices: { publish: vi.fn(), query: vi.fn() },
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function shell(
  c: ProfileController | null = null,
  classId: string | null = null,
  current: SessionsController | null = null,
  failed = false,
  section = "sessions",
  subsection = "panel",
) {
  reset([c, 0, failed, 0, classId, section, subsection], [{ current }]);
  return ProfileShell({
    locale: "en",
    classes: [
      { classId: "class:a", displayName: "Class A" },
      { classId: "class:b", displayName: "Class B" },
    ],
    runtime,
  });
}
it("boots and disposes profile requests and ignores catalog loads after unmount", async () => {
  const loader = vi.spyOn(catalogModule, "loadProfileCatalog").mockResolvedValue(release);
  vi.mocked(runtime.fetch).mockImplementation((path, init) => {
    const body = JSON.parse(init.body as string) as { requestId: string };
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ...(path.endsWith("catalog") ? catalog() : state()),
          requestId: body.requestId,
        }),
      ),
    );
  });
  shell();
  const lazy = expect.any(Function) as object; // view and settings page come from the URL
  expect(hooks.initials).toEqual([null, 0, false, 0, null, lazy, lazy]);
  expect(hooks.dependencies[0]).toEqual([runtime, 0]);
  const cleanup = hooks.effects[0]?.();
  await vi.waitFor(() => {
    expect(hooks.values[0]).toBeInstanceOf(ProfileController);
  });
  const c = hooks.values[0] as ProfileController;
  await vi.waitFor(() => {
    expect(c.current).not.toBeNull();
  });
  expect(hooks.values[1]).toBe(2);
  const dispose = vi.spyOn(c, "dispose");
  cleanup?.();
  expect(dispose).toHaveBeenCalledOnce();
  const pending = Promise.withResolvers<typeof release>();
  loader.mockReturnValue(pending.promise);
  shell();
  const stop = hooks.effects[0]?.();
  stop?.();
  pending.resolve(release);
  await Promise.resolve();
  expect(hooks.values[0]).toBeNull();
  loader.mockRejectedValue(new Error("load"));
  const node = shell(null, null, null, true);
  hooks.effects[0]?.();
  await vi.waitFor(() => {
    expect(hooks.values[2]).toBe(true);
  });
  elements(node)
    .find((item) => item.type === "button" && item.props.children === "Retry")
    ?.props.onClick?.();
  expect(hooks.values[3]).toBe(1);
  const rejected = Promise.withResolvers<typeof release>();
  loader.mockReturnValue(rejected.promise);
  shell();
  const cancel = hooks.effects[0]?.();
  cancel?.();
  rejected.reject(new Error("late"));
  await Promise.resolve();
  await Promise.resolve();
  expect(hooks.values[2]).toBe(false);
});
it("applies release themes and retains shell controls for empty and unavailable profiles", async () => {
  const setProperty = vi.fn();
  vi.stubGlobal("document", { documentElement: { style: { setProperty, colorScheme: "" } } });
  const c = new ProfileController(clientFixture(), release, vi.fn());
  await c.read();
  c.edit({ ...value, modules: [] });
  const node = shell(c);
  expect(hooks.dependencies[1]).toEqual(["org.marea.theme.marea"]);
  const cleanup = hooks.effects[1]?.();
  await vi.waitFor(() => {
    expect(setProperty).toHaveBeenCalledWith("--color-text", "#101e24");
  });
  expect(document.documentElement.style.colorScheme).toBe("light");
  cleanup?.();
  expect(renderToStaticMarkup(node)).toMatchSnapshot("empty-profile-shell");
  expect(elements(node).filter((item) => item.type === "select")).toHaveLength(2);
  c.edit({ ...value, themeId: "org.marea.theme.high-contrast" });
  shell(c);
  hooks.effects[1]?.();
  await vi.waitFor(() => {
    expect(setProperty).toHaveBeenCalledWith("--color-text", "#000000");
  });
  const loaded = await dashboardThemeLoaders["org.marea.theme.marea"]();
  const pending = Promise.withResolvers<typeof loaded>();
  const loadTheme = vi.spyOn(dashboardThemeLoaders, "org.marea.theme.marea");
  loadTheme.mockReturnValueOnce(pending.promise);
  c.edit({ themeId: "org.marea.missing", modules: [selection] });
  shell(c);
  const stop = hooks.effects[1]?.();
  stop?.();
  setProperty.mockClear();
  pending.resolve(loaded);
  await Promise.resolve();
  expect(setProperty).not.toHaveBeenCalled();
  c.problem = "recovery";
  expect(elements(shell(c)).length).toBeGreaterThan(0);
  c.problem = null;
  c.current = {
    ...state(),
    personal: { revision: "r:1", updatedAt: "2026-09-22T00:00:00.000Z", status: "valid", value },
  };
  c.draft = null;
  expect(elements(shell(c)).length).toBeGreaterThan(0);
  c.catalog = null;
  shell(c);
  c.current = null;
  shell(c);
  setProperty.mockImplementation(() => {
    throw new Error("style");
  });
  shell();
  hooks.effects[1]?.();
  await vi.waitFor(() => {
    expect(hooks.values[2]).toBe(true);
  });
  loadTheme.mockResolvedValueOnce(loaded);
  shell();
  const inactive = hooks.effects[1]?.();
  setProperty.mockImplementation(() => {
    inactive?.();
    throw new Error("late style");
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(hooks.values[2]).toBe(false);
});
it("guards class/scope changes and keeps profile drafts while choosing class scope", async () => {
  const c = new ProfileController(clientFixture(), release, vi.fn());
  await c.read();
  const session = new SessionsController(runtime.sessions, runtime.notices, vi.fn());
  const pending = vi.spyOn(session, "hasUnsavedDrafts", "get").mockReturnValue(true);
  const confirm = vi.fn().mockReturnValue(false);
  vi.stubGlobal("window", {
    confirm,
    location: { href: "http://localhost/dashboard/" },
    history: { replaceState: vi.fn() },
  });
  const select = vi.spyOn(c, "select").mockResolvedValue();
  let controls = elements(shell(c, "class:a", session)).filter((item) => item.type === "select");
  for (const item of controls) item.props.onChange?.({ currentTarget: { value: "class:b" } });
  expect(select).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  controls[0]?.props.onChange?.({ currentTarget: { value: "class:b" } });
  expect(select).toHaveBeenLastCalledWith({ kind: "class", classId: "class:b" });
  expect(hooks.values[4]).toBe("class:b");
  controls[0]?.props.onChange?.({ currentTarget: { value: "" } });
  expect(select).toHaveBeenLastCalledWith({ kind: "class", classId: "class:b" });
  controls[1]?.props.onChange?.({ currentTarget: { value: "class" } });
  expect(select).toHaveBeenLastCalledWith({ kind: "class", classId: "class:a" });
  controls[1]?.props.onChange?.({ currentTarget: { value: "teacher" } });
  expect(select).toHaveBeenLastCalledWith({ kind: "teacher" });
  pending.mockReturnValue(false);
  controls = elements(shell(c)).filter((item) => item.type === "select");
  controls[1]?.props.onChange?.({ currentTarget: { value: "class" } });
  expect(select).toHaveBeenLastCalledWith({ kind: "teacher" });
  elements(shell())
    .find((item) => item.type === "select")
    ?.props.onChange?.({ currentTarget: { value: "class:a" } });
  session.dispose();
});
it("adapts session rendering through the module lifecycle and cleans up even during load", async () => {
  const start = vi.spyOn(SessionsController.prototype, "start");
  const stopModule = vi.fn();
  const mount = vi.spyOn(hostModule, "mountDashboardModule").mockResolvedValue(stopModule);
  const register = vi.fn();
  const render = (target: HTMLElement | null, failed = false) => {
    reset([failed, 0], [{ current: target }]);
    return SessionPlugin({
      module: selection,
      classId: "class:a",
      locale: "en",
      classes: [],
      ports: runtime,
      register,
    });
  };
  render(null);
  expect(hooks.effects[0]?.()).toBeUndefined();
  render({} as HTMLElement);
  expect(hooks.initials).toEqual([false, 0]);
  const dependencies = [selection.moduleId, "class:a", "en", runtime, register, 0];
  expect(hooks.dependencies[0]).toEqual(dependencies);
  const cleanup = hooks.effects[0]?.();
  const context = mount.mock.lastCall?.[2];
  if (context === undefined) throw new Error("missing context");
  expect(context.classId).toBe("class:a");
  expect(context.locale).toBe("en");
  expect(context.settings).toEqual({});
  expect(context.placement).toEqual(selection.placement);
  expect(context.timeRange.from).toBe("1970-01-01T00:00:00.000Z");
  expect(new Date(context.timeRange.to).toISOString()).toBe(context.timeRange.to);
  expect(context.ports.message("loading")).toBe("Loading…");
  expect(await context.ports.navigate("sessions")).toBe(false);
  const view = (await context.ports.read(context.signal)) as (element: HTMLElement) => () => void;
  const dispose = view({} as HTMLElement);
  await vi.waitFor(() => {
    expect(start).toHaveBeenCalled();
  });
  expect(hooks.root.render).toHaveBeenCalled();
  expect(stopModule).not.toHaveBeenCalled();
  expect(hooks.values[0]).toBe(false);
  const controller = register.mock.calls[0]?.[0] as SessionsController;
  expect(controller.state.classId).toBe("class:a");
  const tree = hooks.root.render.mock.lastCall?.[0] as ReactElement<{
    failed: () => void;
    children: ReactNode;
  }>;
  const Boundary = tree.type as object as new (props: typeof tree.props) => {
    state: { failed: boolean };
    render(): ReactNode;
    componentDidCatch(): void;
  };
  expect(
    (tree.props.children as ReactElement<{ classSelection: boolean }>).props.classSelection,
  ).toBe(false);
  const boundary = new Boundary(tree.props);
  expect(boundary.state).toEqual({ failed: false });
  expect(boundary.render()).toBe(tree.props.children);
  boundary.state = { failed: true };
  expect(boundary.render()).toBeNull();
  const staticBoundary = Boundary as typeof Boundary & {
    getDerivedStateFromError(): { failed: boolean };
  };
  expect(staticBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  boundary.componentDidCatch();
  expect(context.signal.aborted).toBe(true);
  const disposeController = vi.spyOn(controller, "dispose");
  dispose();
  expect(disposeController).toHaveBeenCalledOnce();
  expect(register).toHaveBeenLastCalledWith(null);
  await vi.waitFor(() => {
    expect(hooks.root.unmount).toHaveBeenCalled();
  });
  cleanup?.();
  const failedNode = render({} as HTMLElement, true);
  expect(renderToStaticMarkup(failedNode)).toMatchSnapshot("failed-session-plugin");
  elements(failedNode)
    .find((item) => item.type === "button")
    ?.props.onClick?.();
  expect(hooks.values[1]).toBe(1);
  const pending = Promise.withResolvers<() => void>();
  mount.mockReturnValue(pending.promise);
  render({} as HTMLElement);
  const stop = hooks.effects[0]?.();
  stop?.();
  const late = vi.fn();
  pending.resolve(late);
  await Promise.resolve();
  expect(late).toHaveBeenCalled();
});
it("registers the session draft guard, renders aside ordering and cancels before initial read completion", async () => {
  const c = new ProfileController(clientFixture(), release, vi.fn());
  await c.read();
  c.edit({ ...value, modules: [{ ...selection, placement: { slot: "aside", size: "compact" } }] });
  const session = new SessionsController(runtime.sessions, runtime.notices, vi.fn());
  expect(session.hasUnsavedDrafts).toBe(false);
  const node = shell(c);
  expect(renderToStaticMarkup(node)).toMatchSnapshot("aside-profile-shell");
  const child = elements(node).find((item) => item.type === SessionPlugin) as
    ReactElement<{ register: (value: SessionsController | null) => void }> | undefined;
  child?.props.register(session);
  expect(hooks.refs[0]).toEqual({ current: session });
  const mount = vi.spyOn(hostModule, "mountDashboardModule").mockResolvedValue(vi.fn());
  const pending = Promise.withResolvers<undefined>();
  vi.spyOn(SessionsController.prototype, "chooseClass").mockReturnValue(pending.promise);
  const start = vi.spyOn(SessionsController.prototype, "start");
  reset([false, 0], [{ current: {} as HTMLElement }]);
  SessionPlugin({
    module: selection,
    classId: "class:a",
    locale: "en",
    classes: [],
    ports: runtime,
    register: vi.fn(),
  });
  const stop = hooks.effects[0]?.();
  const context = mount.mock.lastCall?.[2];
  if (context === undefined) throw new Error("missing context");
  const render = (await context.ports.read(context.signal)) as (element: HTMLElement) => () => void;
  const dispose = render({} as HTMLElement);
  stop?.();
  pending.resolve(undefined);
  await Promise.resolve();
  expect(start).not.toHaveBeenCalled();
  dispose();
  session.dispose();
});
it("isolates a removed module loader without mounting its data port", () => {
  reset([false, 0], [{ current: {} as HTMLElement }]);
  SessionPlugin({
    module: { ...selection, moduleId: "org.marea.removed" },
    classId: "class:a",
    locale: "en",
    classes: [],
    ports: runtime,
    register: vi.fn(),
  });
  expect(hooks.effects[0]?.()).toBeUndefined();
  expect(hooks.values[0]).toBe(true);
});
it("orders main before aside, filters disabled/unauthorized modules and previews inherited recovery", async () => {
  const c = new ProfileController(clientFixture(), release, vi.fn());
  await c.read();
  const second = { ...selection, moduleId: "org.marea.module.second" };
  c.catalog = {
    ...catalog(),
    modules: [
      ...catalog().modules,
      { ...catalog().modules[0], id: second.moduleId } as ReturnType<
        typeof catalog
      >["modules"][number],
    ],
  };
  const aside = { ...selection, placement: { slot: "aside", size: "compact" } as const };
  c.edit({ ...value, modules: [aside, second, { ...second, moduleId: "org.marea.missing" }] });
  const moduleIds = () =>
    elements(shell(c, "class:a", null, false, "settings"))
      .filter((item) => item.type === SessionPlugin || item.type === ModulePlugin)
      .map((item) => (item as ReactElement<{ module: typeof selection }>).props.module.moduleId);
  expect(moduleIds()).toEqual([second.moduleId, selection.moduleId]);
  expect(
    elements(shell(c, "class:a", null, false, "settings")).find(
      (item) => item.type === ModulePlugin,
    )?.props,
  ).toMatchObject({ module: second, adapter: undefined });
  expect(
    elements(shell(c, "class:a")).find(
      (item) => item.type === "option" && item.props.value === "class",
    )?.props.disabled,
  ).toBe(false);
  c.edit({ ...value, modules: [{ ...selection, enabled: false }] });
  expect(moduleIds()).toEqual([]);
  c.problem = "recovery";
  expect(moduleIds()).toEqual([selection.moduleId]);
  c.problem = null;
  c.current = {
    ...state(),
    personal: {
      revision: "personal:2",
      updatedAt: "2026-09-22T00:00:00.000Z",
      status: "valid",
      value: { ...value, modules: [second] },
    },
  };
  c.draft = {};
  expect(moduleIds()).toEqual([second.moduleId]);
  c.catalog = null;
  expect(moduleIds()).toEqual([]);
  c.catalog = catalog();
  c.current = null;
  expect(moduleIds()).toEqual([]);
});
it("keeps the legacy session workspace available only on an explicit host legacy response", () => {
  const c = new ProfileController(clientFixture(), release, vi.fn());
  c.legacy = true;
  c.problem = "unavailable";
  const node = shell(c);
  const module = elements(node).find((item) => item.type === SessionPlugin);
  expect(module?.props).toMatchObject({
    module: {
      moduleId: "org.marea.module.sessions",
      configurationVersion: 1,
      enabled: true,
      placement: { slot: "main", size: "wide" },
      settings: {},
    },
  });
  expect(
    elements(node).some(
      (item) =>
        item.type === "p" &&
        item.props.children ===
          "Dashboard customization requires an offline server upgrade. Sessions remain available.",
    ),
  ).toBe(true);
  expect(elements(node).some((item) => item.type === ProfileEditor)).toBe(false);
});
