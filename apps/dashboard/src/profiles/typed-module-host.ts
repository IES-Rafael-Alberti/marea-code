import type {
  DashboardModuleBinding,
  DashboardModuleEnvironment,
  TypedDashboardModuleBrowserEntry,
  TypedDashboardModuleContext,
} from "@marea/plugin-api/browser";
import { mountDashboardModule } from "./module-host.js";

/** Domain types are paired here, never erased with a cast in the module registry. */
export function bindDashboardModule<
  Settings extends object,
  Data,
  Destination,
  Capabilities extends object,
>(
  load: () => Promise<{
    default: TypedDashboardModuleBrowserEntry<Settings, Data, Destination, Capabilities>;
  }>,
  context: (
    environment: DashboardModuleEnvironment,
  ) => TypedDashboardModuleContext<Settings, Data, Destination, Capabilities>,
): DashboardModuleBinding {
  return {
    mount(element, environment, failed) {
      const source = { ...context(environment), ...environment };
      return mountDashboardModule(
        element,
        async () => {
          const entry = await load();
          return {
            default: {
              mount(target, legacy) {
                return entry.default.mount(target, {
                  ...source,
                  signal: legacy.signal,
                  data: {
                    read: legacy.ports.read,
                    ...(legacy.ports.subscribe === undefined
                      ? {}
                      : { subscribe: legacy.ports.subscribe }),
                  },
                  navigation: {
                    async navigate(destination, signal) {
                      const combined = AbortSignal.any([signal, legacy.signal]);
                      combined.throwIfAborted();
                      const navigated = await source.navigation.navigate(destination, combined);
                      combined.throwIfAborted();
                      return navigated;
                    },
                  },
                });
              },
            },
          };
        },
        {
          ...source,
          ports: {
            ...source.data,
            message: source.message,
            navigate: () => Promise.resolve(false),
          },
        },
        failed,
      );
    },
  };
}
