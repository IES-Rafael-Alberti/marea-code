import { expect, it } from "vitest";
import {
  dashboardCatalogRevision as browserRevision,
  dashboardModuleLoaders,
  dashboardModuleDescriptorLoaders,
  dashboardThemeLoaders,
} from "./generated/dashboard-browser-catalog.js";
import {
  dashboardCatalogRevision,
  dashboardModuleCatalog,
  dashboardThemeCatalog,
  inferenceProviderCatalog,
  telemetryExporterCatalog,
} from "./index.js";

it("keeps the release browser/server revisions aligned for production dashboard plugins", () => {
  expect(browserRevision).toBe(dashboardCatalogRevision);
  expect(browserRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.keys(dashboardModuleLoaders)).toEqual([
    "org.marea.module.health",
    "org.marea.module.map",
    "org.marea.module.progress",
    "org.marea.module.reports",
    "org.marea.module.reviewed-evidence",
    "org.marea.module.sessions",
    "org.marea.module.usage",
  ]);
  expect(Object.keys(dashboardModuleDescriptorLoaders)).toEqual([
    "org.marea.module.health",
    "org.marea.module.map",
    "org.marea.module.progress",
    "org.marea.module.reports",
    "org.marea.module.reviewed-evidence",
    "org.marea.module.sessions",
    "org.marea.module.usage",
  ]);
  expect(Object.keys(dashboardThemeLoaders)).toEqual([
    "org.marea.theme.high-contrast",
    "org.marea.theme.marea",
  ]);
  expect(Object.isFrozen(dashboardModuleLoaders)).toBe(true);
  expect(Object.isFrozen(dashboardThemeLoaders)).toBe(true);
  expect(dashboardModuleCatalog.map((entry) => entry.manifest.id)).toEqual(
    Object.keys(dashboardModuleLoaders),
  );
  expect(dashboardThemeCatalog.map((entry) => entry.manifest.id)).toEqual(
    Object.keys(dashboardThemeLoaders),
  );
  expect(
    telemetryExporterCatalog.map((entry) => ({
      id: entry.manifest.id,
      destination: entry.implementation?.destination,
      create: typeof entry.implementation?.create,
    })),
  ).toEqual([
    { id: "org.marea.langfuse", destination: "langfuse", create: "function" },
    { id: "org.marea.otlp", destination: "otlp", create: "function" },
  ]);
  expect(inferenceProviderCatalog.map((entry) => entry.manifest.id)).toEqual([
    "org.marea.openrouter",
  ]);
});

it.each(["org.marea.module.map", "org.marea.module.progress", "org.marea.module.reports"] as const)(
  "loads the educational browser entry and matching descriptor for %s",
  async (id) => {
    const load = dashboardModuleLoaders[id],
      describe = dashboardModuleDescriptorLoaders[id];
    expect(await load()).toHaveProperty("default.mount");
    expect(await describe()).toHaveProperty("default.manifest.id", id);
  },
);
