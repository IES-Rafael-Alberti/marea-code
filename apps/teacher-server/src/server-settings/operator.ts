import type { TeachingOperatorConfiguration } from "../teaching/configuration/dashboard-contracts.js";
import type { ServerSettings, ServerSettingsStore } from "./contracts.js";

/** Fresh installations have no class routes to preserve. */
export function usesCommonRoute(
  settings: ServerSettings,
): settings is ServerSettings & { route: NonNullable<ServerSettings["route"]> } {
  return settings.route !== null && (settings.useCommonRoute || settings.legacyRoutes.length === 0);
}

/** Resolve one server-owned policy for class editing, governance and new sessions. */
export function serverSettingsOperator(
  fallback: TeachingOperatorConfiguration,
  store: ServerSettingsStore | undefined,
): TeachingOperatorConfiguration {
  return {
    forClass(classId) {
      const previous = fallback.forClass(classId);
      const settings = store?.read();
      if (!settings || !usesCommonRoute(settings)) return previous;
      const route = settings.route;
      if (!route.budget) return previous;
      return {
        route: {
          version: `server-route:${String(settings.revision)}`,
          modelAlias: previous?.route.modelAlias ?? "marea",
          providerRoute: { ...route, budget: route.budget },
        },
        teacherToolPolicy: previous?.teacherToolPolicy ?? {
          version: "policy:server-default",
          restrictions: [
            { tool: "write_file", effect: "require-approval" },
            { tool: "edit_file", effect: "require-approval" },
            { tool: "execute", effect: "require-approval" },
          ],
        },
      };
    },
  };
}
