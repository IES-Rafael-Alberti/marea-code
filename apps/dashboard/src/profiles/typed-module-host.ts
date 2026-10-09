import type {
  DashboardModuleBinding,
  DashboardModuleEnvironment,
  TypedDashboardModuleBrowserEntry,
  TypedDashboardModuleContext,
} from "@marea/plugin-api/browser";
import { mountDashboardModule } from "./module-host.js";
import { abortScope } from "./abort-scope.js";

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
                      const scope = abortScope([signal, legacy.signal]);
                      try {
                        scope.signal.throwIfAborted();
                        const navigated = await source.navigation.navigate(
                          destination,
                          scope.signal,
                        );
                        scope.signal.throwIfAborted();
                        return navigated;
                      } finally {
                        scope.dispose();
                      }
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
