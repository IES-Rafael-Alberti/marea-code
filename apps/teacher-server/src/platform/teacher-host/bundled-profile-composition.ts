import * as z from "zod";
import {
  createDashboardModuleDescriptorSchema,
  createDashboardThemeDescriptorSchema,
} from "@marea/plugin-api";
import {
  dashboardCatalogRevision,
  dashboardModuleCatalog,
  dashboardThemeCatalog,
} from "@marea/plugin-runtime";
import {
  createDashboardModuleSelectionSchema,
  type DashboardModuleSelection,
} from "@marea/protocol";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import type {
  DashboardProfileAuthority,
  DashboardProfileRelease,
} from "../../dashboard-profiles/contracts.js";
import { systemClock, cryptoIdGenerator } from "../../identity/system-security.boundary.js";
import { composeDashboardProfiles } from "./profile-composition.js";

/** Pure generated entries are the authority for validators, defaults and public descriptors. */
export function bundledDashboardProfileRelease(): DashboardProfileRelease<DashboardModuleSelection> {
  const selections = dashboardModuleCatalog.map(({ manifest, settingsSchema }) =>
    createDashboardModuleSelectionSchema(
      manifest.id,
      manifest.configurationVersion,
      z.strictObject({}),
      manifest.supportedPlacements,
    ).extend({ settings: settingsSchema }),
  );
  return {
    revision: dashboardCatalogRevision,
    selection: z.union([z.never(), ...selections]),
    modules: dashboardModuleCatalog.map(({ manifest }) =>
      createDashboardModuleDescriptorSchema().strip().parse(manifest),
    ),
    themes: dashboardThemeCatalog.map(({ manifest, tokens }) =>
      createDashboardThemeDescriptorSchema()
        .strip()
        .parse({ ...manifest, tokens }),
    ),
    defaults: {
      themeId: "org.marea.theme.marea",
      modules: dashboardModuleCatalog.map(({ manifest, defaultSettings }) => ({
        moduleId: manifest.id,
        configurationVersion: manifest.configurationVersion,
        enabled: manifest.defaultEnabled,
        placement: manifest.defaultPlacement,
        settings: defaultSettings,
      })),
    },
    requiredIds: ["org.marea.theme.marea"],
    capabilities: ["sessions/v1", "usage/v1", "health/v1", "reviewed-evidence/v1"],
  };
}

/**
 * Visibility only: class membership is checked transactionally by composeDashboardProfiles, and
 * each usage/health read is independently authorized by its endpoint. Unknown permissions deny.
 */
export const bundledDashboardProfileAuthority: DashboardProfileAuthority = {
  permits: (identity, _scope, module) =>
    identity.role === "teacher" &&
    module.requiredPermissions.every((permission) =>
      ["class-read", "session-read", "evaluation-read", "usage-read", "health-read"].includes(
        permission,
      ),
    ),
};

export function composeBundledDashboardProfiles(database: SqliteApplicationDatabase) {
  return composeDashboardProfiles({
    database,
    release: bundledDashboardProfileRelease(),
    authority: bundledDashboardProfileAuthority,
    clock: systemClock,
    ids: cryptoIdGenerator,
    currentCatalogRevision: () => dashboardCatalogRevision,
  });
}
