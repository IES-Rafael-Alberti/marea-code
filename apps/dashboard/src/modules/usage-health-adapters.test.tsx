import { createReviewedEvidenceAdapters } from "./reviewed-evidence/adapter.js";
import { ReviewedEvidenceView } from "./reviewed-evidence/view.js";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { DashboardHostView, TypedDashboardModuleContext } from "@marea/plugin-api/browser";
import type { UsageHealthPort } from "@marea/protocol";

const mocks = vi.hoisted(() => ({
  contexts: [] as TypedDashboardModuleContext<object, DashboardHostView, never, object>[],
  roots: [] as { render: ReturnType<typeof vi.fn>; unmount: ReturnType<typeof vi.fn> }[],
}));
vi.mock("react-dom/client", () => ({
  createRoot: () => {
    const root = { render: vi.fn(), unmount: vi.fn() };
    mocks.roots.push(root);
    return root;
  },
}));
// The shared host-view mount records each typed context the adapter supplies.
vi.mock("@marea/plugin-api/browser", () => ({
  mountDashboardHostView: vi.fn(
    (
      _element: HTMLElement,
      context: TypedDashboardModuleContext<object, DashboardHostView, never, object>,
    ) => {
      mocks.contexts.push(context);
      return () => undefined;
    },
  ),
}));
vi.mock("@marea/plugin-runtime/browser", async () => {
  const { mountDashboardHostView } = await import("@marea/plugin-api/browser");
  const load = () => Promise.resolve({ typedEntry: { mount: mountDashboardHostView } });
  return {
    dashboardModuleLoaders: {
      "org.marea.module.usage": load,
      "org.marea.module.health": load,
      "org.marea.module.reviewed-evidence": load,
    },
  };
});
import { createUsageHealthAdapters } from "./usage-health-adapters.js";
import { healthResult, usageResult } from "./usage-health.fixture.js";
import { UsageView } from "./usage/usage-view.js";
import { HealthView } from "./health/health-view.js";

afterEach(() => {
  mocks.contexts = [];
  mocks.roots = [];
});
const selection = { settings: {}, placement: { slot: "aside", size: "standard" } } as const;
const element = {} as HTMLElement;
function port() {
  const queryUsage = vi.fn<UsageHealthPort["queryUsage"]>((request) =>
    Promise.resolve({ ...usageResult, requestId: request.requestId }),
  );
  const readHealth = vi.fn<UsageHealthPort["readHealth"]>((request) =>
    Promise.resolve({ ...healthResult, requestId: request.requestId }),
  );
  return { queryUsage, readHealth };
}
async function mounted(moduleId: string, classId: string | null, ports = port()) {
  const adapters = createUsageHealthAdapters(vi.fn(), ports);
  const adapter = adapters.get(moduleId);
  if (adapter === undefined) throw new Error("missing adapter");
  const abort = new AbortController();
  const failed = vi.fn();
  await adapter({ moduleId, ...selection }).mount(
    element,
    { classId, locale: "eu", signal: abort.signal, timeRange: { from: "", to: "" } },
    failed,
  );
  const context = mocks.contexts.at(-1);
  if (context === undefined) throw new Error("not mounted");
  return { context, ports, failed, abort };
}

it("registers exactly the usage and health adapters with the default client", () => {
  expect([...createUsageHealthAdapters(vi.fn()).keys()]).toEqual([
    "org.marea.module.usage",
    "org.marea.module.health",
  ]);
});

it("registers only the optional plugins present in the generated catalog", () => {
  const load = () => Promise.resolve({});
  expect([...createUsageHealthAdapters(vi.fn(), port(), {}).keys()]).toEqual([]);
  expect([
    ...createUsageHealthAdapters(vi.fn(), port(), { "org.marea.module.health": load }).keys(),
  ]).toEqual(["org.marea.module.health"]);
  expect([
    ...createUsageHealthAdapters(vi.fn(), port(), { "org.marea.module.usage": load }).keys(),
  ]).toEqual(["org.marea.module.usage"]);
});

it.each([{}, { typedEntry: { mount: () => () => undefined } }])(
  "fails the module frame when the catalog entry is not the shared host view (%#)",
  async (module) => {
    const adapter = createUsageHealthAdapters(vi.fn(), port(), {
      "org.marea.module.usage": () => Promise.resolve(module),
    }).get("org.marea.module.usage");
    const failed = vi.fn();
    await adapter?.({ moduleId: "org.marea.module.usage", ...selection }).mount(
      element,
      {
        classId: "class:a",
        locale: "en",
        signal: new AbortController().signal,
        timeRange: { from: "", to: "" },
      },
      failed,
    );
    expect(failed).toHaveBeenCalledOnce();
    expect(mocks.contexts).toEqual([]);
  },
);

it.each([
  ["org.marea.module.usage", { usageRead: true }],
  ["org.marea.module.health", { healthRead: true }],
] as const)("binds %s to its capabilities, selection and safe ports", async (id, capabilities) => {
  const { context, failed } = await mounted(id, "class:a");
  expect(context).toMatchObject({
    classId: "class:a",
    locale: "eu",
    settings: {},
    placement: selection.placement,
    capabilities,
  });
  expect(context.message("failed")).toBe("Modulua ez dago erabilgarri. Saiatu berriro kargatzen.");
  expect(await context.navigation.navigate(undefined as never, new AbortController().signal)).toBe(
    false,
  );
  expect(failed).not.toHaveBeenCalled();
});

it("renders the usage controller for the selected class and disposes it before unmounting", async () => {
  const { context, ports } = await mounted("org.marea.module.usage", "class:a");
  const render = await context.data.read(context.signal);
  const dispose = render(element);
  const root = mocks.roots[0];
  await vi.waitFor(() => {
    expect(root?.render).toHaveBeenCalledTimes(3);
  });
  expect(ports.queryUsage).toHaveBeenCalledOnce();
  expect(ports.queryUsage.mock.calls[0]?.[0].classId).toBe("class:a");
  const view = root?.render.mock.lastCall?.[0] as ReactElement<Parameters<typeof UsageView>[0]>;
  expect(view.type).toBe(UsageView);
  expect(view.props.locale).toBe("eu");
  expect(view.props.state).toMatchObject({ status: "ready" });
  const signal = ports.queryUsage.mock.calls[0]?.[1];
  void view.props.actions.refresh();
  dispose();
  expect(ports.queryUsage.mock.calls[1]?.[1]?.aborted).toBe(true);
  expect(signal?.aborted).toBe(true);
  expect(root?.unmount).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(root?.unmount).toHaveBeenCalledOnce();
});

it("renders health with a working refresh and waits for a class before reading", async () => {
  const { context, ports } = await mounted("org.marea.module.health", "class:a");
  const dispose = (await context.data.read(context.signal))(element);
  const root = mocks.roots[0];
  await vi.waitFor(() => {
    expect(root?.render).toHaveBeenCalledTimes(3);
  });
  const view = root?.render.mock.lastCall?.[0] as ReactElement<Parameters<typeof HealthView>[0]>;
  expect(view.type).toBe(HealthView);
  expect(view.props).toMatchObject({ locale: "eu", state: { status: "ready" } });
  view.props.refresh();
  expect(ports.readHealth).toHaveBeenCalledTimes(2);
  dispose();
  const empty = await mounted("org.marea.module.health", null);
  (await empty.context.data.read(empty.context.signal))(element);
  expect(empty.ports.readHealth).not.toHaveBeenCalled();
  expect(mocks.roots[1]?.render).toHaveBeenCalledOnce();
  const idle = mocks.roots[1]?.render.mock.lastCall?.[0] as ReactElement<
    Parameters<typeof HealthView>[0]
  >;
  expect(idle.props.state).toEqual({ status: "empty" });
});

it("renders the usage prompt before a class is selected", async () => {
  const { context, ports } = await mounted("org.marea.module.usage", null);
  (await context.data.read(context.signal))(element);
  expect(ports.queryUsage).not.toHaveBeenCalled();
  const view = mocks.roots[0]?.render.mock.lastCall?.[0] as ReactElement<
    Parameters<typeof UsageView>[0]
  >;
  expect(mocks.roots[0]?.render).toHaveBeenCalledOnce();
  expect(view.props.state).toMatchObject({ status: "empty", page: 1 });
});

it("mounts optional reviewed evidence with a class-bound navigation callback", async () => {
  const navigate = vi.fn().mockResolvedValue(true);
  expect([...createReviewedEvidenceAdapters(vi.fn(), navigate, {}).keys()]).toEqual([]);
  const adapter = createReviewedEvidenceAdapters(vi.fn(), navigate).get(
    "org.marea.module.reviewed-evidence",
  );
  if (adapter === undefined) throw new Error("missing evidence adapter");
  const abort = new AbortController();
  await adapter({ moduleId: "org.marea.module.reviewed-evidence", ...selection }).mount(
    element,
    { classId: null, locale: "es", signal: abort.signal, timeRange: { from: "", to: "" } },
    vi.fn(),
  );
  const context = mocks.contexts.at(-1);
  if (context === undefined) throw new Error("missing context");
  expect(context.capabilities).toEqual({ evaluationRead: true });
  const dispose = (await context.data.read(context.signal))(element);
  const view = mocks.roots.at(-1)?.render.mock.lastCall?.[0] as ReactElement<
    Parameters<typeof ReviewedEvidenceView>[0]
  >;
  expect(view.type).toBe(ReviewedEvidenceView);
  expect(view.props.locale).toBe("es");
  expect(view.props.controller.status).toBe("empty");
  expect(await view.props.openSession("run:1")).toBe(true);
  expect(navigate).toHaveBeenCalledWith(null, "run:1", expect.any(AbortSignal));
  dispose();
});
