/// <reference lib="dom" />
import type { DashboardPlacement } from "./dashboard-contracts.js";

/** Browser-only lifecycle ports. Hosts cancel the signal before changing context. */
export interface DashboardModuleContext<Settings extends object, Data> {
  readonly settings: Settings;
  readonly placement: DashboardPlacement;
  readonly classId: string | null;
  readonly timeRange: { readonly from: string; readonly to: string };
  readonly locale: "es" | "en" | "eu";
  readonly signal: AbortSignal;
  readonly ports: {
    readonly read: (signal: AbortSignal) => Promise<Data>;
    readonly subscribe?: (signal: AbortSignal, receive: (data: Data) => void) => () => void;
    readonly message: (key: string) => string;
    readonly navigate: (
      destination: "sessions" | "evaluations" | "usage" | "health",
    ) => Promise<boolean>;
  };
}
/** Framework-neutral mount adapter; a React implementation owns its root and disposal. */
export interface DashboardModuleBrowserEntry<Settings extends object, Data> {
  readonly mount: (
    element: HTMLElement,
    context: DashboardModuleContext<Settings, Data>,
  ) => () => void;
}

export type {
  DashboardDataPort,
  DashboardNavigationPort,
  DashboardModuleEnvironment,
  DashboardModuleBinding,
  TypedDashboardModuleContext,
  TypedDashboardModuleBrowserEntry,
} from "./typed-dashboard-module.js";
import { mountDashboardHostView, type DashboardHostView } from "./host-view.js";
import type { TypedDashboardModuleBrowserEntry } from "./typed-dashboard-module.js";
export { mountDashboardHostView, type DashboardHostView };

/** Both browser contracts for a module that only mounts its host adapter's view. */
export function createDashboardHostViewEntries<Capabilities extends object>(): {
  readonly entry: DashboardModuleBrowserEntry<object, DashboardHostView>;
  readonly typedEntry: TypedDashboardModuleBrowserEntry<
    object,
    DashboardHostView,
    never,
    Capabilities
  >;
} {
  return {
    entry: {
      mount: (element, context) =>
        mountDashboardHostView(element, {
          signal: context.signal,
          data: context.ports,
          message: context.ports.message,
        }),
    },
    typedEntry: { mount: mountDashboardHostView },
  };
}
