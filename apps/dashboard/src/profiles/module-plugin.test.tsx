import { renderToStaticMarkup } from "react-dom/server";
import type { DashboardModuleBinding } from "@marea/plugin-api/browser";
import { Children, isValidElement, type ReactNode } from "react";
import { expect, it, vi, afterEach } from "vitest";
import { ModulePlugin } from "./module-plugin.js";
import { SessionPlugin } from "./session-plugin.js";
const hooks = vi.hoisted(() => ({
  target: null as HTMLElement | null,
  values: [false, 0] as (boolean | number)[],
  initials: [] as (boolean | number)[],
  index: 0,
  effect: () => undefined as undefined | (() => void),
  dependencies: [] as readonly (object | string | number | null | undefined)[],
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: () => ({ current: hooks.target }),
  useState: (initial: boolean | number) => {
    hooks.initials.push(initial);
    const index = hooks.index++;
    return [
      hooks.values[index],
      (next: boolean | number) => {
        hooks.values[index] = next;
      },
    ];
  },
  useEffect: (effect: typeof hooks.effect, dependencies: typeof hooks.dependencies) => {
    hooks.effect = effect;
    hooks.dependencies = dependencies;
  },
}));
const selection = {
  moduleId: "synthetic.library",
  settings: {},
  placement: { slot: "main", size: "wide" },
} as const;
function render(
  adapter: Parameters<typeof ModulePlugin>[0]["adapter"],
  target: HTMLElement | null = {} as HTMLElement,
) {
  hooks.index = 0;
  hooks.initials = [];
  hooks.target = target;
  return ModulePlugin({ module: selection, adapter, classId: "library:a", locale: "en" });
}
afterEach(() => {
  hooks.values = [false, 0];
  vi.clearAllMocks();
});
it("mounts a domain binding, retains presentation identity and aborts on unmount", async () => {
  const stop = vi.fn();
  const mount = vi.fn<DashboardModuleBinding["mount"]>().mockResolvedValue(stop);
  const adapter = vi.fn().mockReturnValue({ mount });
  const initial = render(adapter, null);
  expect(renderToStaticMarkup(initial)).not.toContain('role="alert"');
  expect(hooks.initials).toEqual([false, 0]);
  expect(hooks.effect()).toBeUndefined();
  hooks.values[0] = true;
  render(adapter);
  expect(hooks.dependencies).toEqual([adapter, selection.moduleId, "{}", "library:a", "en", 0]);
  const cleanup = hooks.effect();
  expect(hooks.values[0]).toBe(false);
  await Promise.resolve();
  expect(stop).not.toHaveBeenCalled();
  expect(adapter).toHaveBeenCalledWith(selection);
  expect(mount.mock.lastCall?.[1]).toMatchObject({ classId: "library:a", locale: "en" });
  cleanup?.();
  expect(mount.mock.lastCall?.[1].signal.aborted).toBe(true);
});
it("stops a binding resolved after disable and ignores a rejected late mount", async () => {
  const pending = Promise.withResolvers<() => void>();
  const stop = vi.fn();
  render(() => ({ mount: () => pending.promise }));
  hooks.effect()?.();
  pending.resolve(stop);
  await Promise.resolve();
  expect(stop).toHaveBeenCalledOnce();
  const rejected = Promise.withResolvers<() => void>();
  render(() => ({ mount: () => rejected.promise }));
  hooks.effect()?.();
  rejected.reject(new Error("late"));
  await Promise.resolve();
  await Promise.resolve();
  expect(hooks.values[0]).toBe(false);
});
function clickRetry(node: ReactNode): void {
  for (const item of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(item)) continue;
    if (item.type === "button") item.props.onClick?.();
    clickRetry(item.props.children);
  }
}
it("isolates absent, throwing and rejecting adapters and offers localized retry", async () => {
  for (const adapter of [
    () => {
      throw new Error("settings");
    },
    () => ({ mount: () => Promise.reject(new Error("load")) }),
  ]) {
    render(adapter);
    hooks.effect();
    await Promise.resolve();
    await Promise.resolve();
    expect(hooks.values[0]).toBe(true);
    const node = render(adapter);
    clickRetry(node);
    expect(hooks.values[1]).toBeGreaterThan(0);
  }
});

it("bridges the generated session entry to typed data and closed navigation", async () => {
  const host = await import("./module-host.js");
  const { dashboardModuleLoaders } = await import("@marea/plugin-runtime/browser");
  const { typedEntry } = await dashboardModuleLoaders["org.marea.module.sessions"]();
  const { sessionPorts } = await import("../../browser/typed-host-data.fixture.js");
  const mount = vi.spyOn(host, "mountDashboardModule").mockResolvedValue(vi.fn());
  hooks.index = 0;
  hooks.target = {} as HTMLElement;
  SessionPlugin({
    module: {
      ...selection,
      moduleId: "org.marea.module.sessions",
      configurationVersion: 1,
      enabled: true,
    },
    classId: "class:a",
    locale: "en",
    classes: [],
    ports: sessionPorts,
    register: vi.fn(),
  });
  const cleanup = hooks.effect();
  const call = mount.mock.lastCall;
  if (!call) throw new Error("missing session binding");
  let navigation: Promise<boolean> | undefined;
  const typedMount = vi.spyOn(typedEntry, "mount").mockImplementation((_target, context) => {
    expect(context.capabilities).toEqual({ sessionReview: true });
    expect(context.message("loading")).toBe("Loading…");
    expect(context.message("selectClass")).toBe("Select a class");
    expect(context.message("failed")).toBe("Module unavailable. Retry loading.");
    // @ts-expect-error The session bridge deliberately advertises no destinations.
    navigation = context.navigation.navigate("sessions", context.signal);
    return vi.fn();
  });
  const loaded = await call[1]();
  loaded.default.mount(call[0], call[2]);
  await expect(navigation).resolves.toBe(false);
  expect(typedMount).toHaveBeenCalledOnce();
  cleanup?.();
  vi.restoreAllMocks();
});

it("shows missing adapters immediately without creating a failed lifetime", () => {
  const tree = render(undefined);
  expect(hooks.effect()).toBeUndefined();
  expect(hooks.values[0]).toBe(false);
  clickRetry(tree);
  expect(hooks.values[1]).toBe(1);
});
it("aborts the binding lifetime when it reports failure", async () => {
  const mount = vi
    .fn<DashboardModuleBinding["mount"]>()
    .mockImplementation((_target, _environment, failed) => {
      failed();
      return Promise.resolve(vi.fn());
    });
  render(() => ({ mount }));
  hooks.effect();
  await Promise.resolve();
  expect(hooks.values[0]).toBe(true);
  expect(mount.mock.lastCall?.[1].signal.aborted).toBe(true);
});
