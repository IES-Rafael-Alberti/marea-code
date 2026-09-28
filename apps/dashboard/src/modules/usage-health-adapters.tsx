import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import {
  mountDashboardHostView,
  type DashboardHostView,
  type DashboardModuleEnvironment,
  type TypedDashboardModuleBrowserEntry,
} from "@marea/plugin-api/browser";
import type { UsageHealthPort } from "@marea/protocol";
import { dashboardModuleLoaders } from "@marea/plugin-runtime/browser";
import type { ModuleAdapter, ModuleSelection } from "../profiles/module-plugin.js";
import { profileMessages } from "../profiles/profile-messages.js";
import { bindDashboardModule } from "../profiles/typed-module-host.js";
import type { DashboardFetch } from "./active-runs/active-runs-client.boundary.js";
import { HealthController } from "./health/health-controller.js";
import { HealthView } from "./health/health-view.js";
import { createUsageHealthClient } from "./usage-health-client.boundary.js";
import { UsageController } from "./usage/usage-controller.js";
import { UsageView } from "./usage/usage-view.js";

/** A controller owns every request; unmount disposes it before the React root is released. */
export function reactView<
  Controller extends { dispose(): void; start(classId: string | null): Promise<void> },
>(
  environment: DashboardModuleEnvironment,
  create: (changed: () => void) => Controller,
  render: (controller: Controller) => ReactNode,
): DashboardHostView {
  return (container) => {
    const root = createRoot(container);
    const show = () => {
      root.render(render(controller));
    };
    const controller = create(show);
    // The initial state (including "select a class") renders before any request starts.
    show();
    void controller.start(environment.classId);
    return () => {
      controller.dispose();
      queueMicrotask(() => {
        root.unmount();
      });
    };
  };
}

/** Structural view of the generated loaders; an absent optional plugin is simply not listed. */
export type DashboardModuleLoaders = Readonly<
  Record<string, () => Promise<{ readonly typedEntry?: { readonly mount: object } }>>
>;

/**
 * Registers a host-view adapter only when its plugin is in the generated catalog. The plugin's
 * typed entry must be the shared host-view mount, so the adapter pairs its own types with it.
 */
export function hostViewAdapter(
  loaders: DashboardModuleLoaders,
  moduleId: string,
  capabilities: object,
  view: (environment: DashboardModuleEnvironment) => DashboardHostView,
): readonly [string, ModuleAdapter][] {
  const load = Object.entries(loaders).find(([id]) => id === moduleId)?.[1];
  if (load === undefined) return [];
  const entry: TypedDashboardModuleBrowserEntry<object, DashboardHostView, never, object> = {
    mount: mountDashboardHostView,
  };
  const adapter: ModuleAdapter = (selection: ModuleSelection) =>
    bindDashboardModule(
      async () => {
        // Every variant rejects the load, which the host reports identically.
        // Stryker disable next-line OptionalChaining: a missing entry also rejects, with TypeError.
        if ((await load()).typedEntry?.mount !== mountDashboardHostView)
          // Stryker disable next-line StringLiteral: the rejection text is never shown.
          throw new Error(`Dashboard module ${moduleId} is not a host view.`);
        return { default: entry };
      },
      (environment) => ({
        ...environment,
        settings: selection.settings,
        placement: selection.placement,
        capabilities,
        message: () => profileMessages(environment.locale).failed,
        navigation: { navigate: () => Promise.resolve(false) },
        data: { read: () => Promise.resolve(view(environment)) },
      }),
    );
  return [[moduleId, adapter]];
}

/** Registration for ProfileRuntime.moduleAdapters; visibility never replaces server authority. */
export function createUsageHealthAdapters(
  fetchRequest: DashboardFetch,
  port: UsageHealthPort = createUsageHealthClient(fetchRequest),
  loaders: DashboardModuleLoaders = dashboardModuleLoaders,
): ReadonlyMap<string, ModuleAdapter> {
  return new Map([
    ...hostViewAdapter(
      loaders,
      "org.marea.module.usage",
      { usageRead: true as const },
      (environment) =>
        reactView(
          environment,
          (changed) => new UsageController(port, changed),
          (controller) => (
            <UsageView locale={environment.locale} state={controller.state} actions={controller} />
          ),
        ),
    ),
    ...hostViewAdapter(
      loaders,
      "org.marea.module.health",
      { healthRead: true as const },
      (environment) =>
        reactView(
          environment,
          (changed) => new HealthController(port, changed),
          (controller) => (
            <HealthView
              locale={environment.locale}
              state={controller.state}
              refresh={() => void controller.refresh()}
            />
          ),
        ),
    ),
  ]);
}
