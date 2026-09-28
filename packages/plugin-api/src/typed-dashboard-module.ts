/// <reference lib="dom" />
import type { DashboardPlacement } from "./dashboard-contracts.js";

/** Presentation/context only. Neither visibility nor this object grants authority. */
export interface DashboardModuleEnvironment {
  readonly classId: string | null;
  readonly locale: "es" | "en" | "eu";
  readonly timeRange: { readonly from: string; readonly to: string };
  readonly signal: AbortSignal;
}
export interface DashboardDataPort<Data> {
  readonly read: (signal: AbortSignal) => Promise<Data>;
  readonly subscribe?: (signal: AbortSignal, receive: (data: Data) => void) => () => void;
}
export interface DashboardNavigationPort<Destination> {
  /** Must honor cancellation before committing navigation and apply the host draft guard. */
  readonly navigate: (destination: Destination, signal: AbortSignal) => Promise<boolean>;
}
/** Additive browser contract 2.1; each adapter chooses all four domain types. */
export interface TypedDashboardModuleContext<
  Settings extends object,
  Data,
  Destination,
  Capabilities extends object,
> extends DashboardModuleEnvironment {
  readonly settings: Settings;
  readonly placement: DashboardPlacement;
  readonly data: DashboardDataPort<Data>;
  readonly capabilities: Readonly<Capabilities>;
  readonly navigation: DashboardNavigationPort<Destination>;
  readonly message: (key: string) => string;
}
export interface TypedDashboardModuleBrowserEntry<
  Settings extends object,
  Data,
  Destination,
  Capabilities extends object,
> {
  readonly mount: (
    element: HTMLElement,
    context: TypedDashboardModuleContext<Settings, Data, Destination, Capabilities>,
  ) => () => void;
}
/** Close over domain types before putting heterogeneous modules into a registry. */
export interface DashboardModuleBinding {
  readonly mount: (
    element: HTMLElement,
    environment: DashboardModuleEnvironment,
    failed: () => void,
  ) => Promise<() => void>;
}
