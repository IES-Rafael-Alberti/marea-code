/* global Bun */
/** Synthetic browser fixture only; never mounted by the teacher server. */
import { loadProfileCatalog } from "../src/profiles/profile-catalog.js";
import {
  dashboardModuleDescriptorLoaders,
  dashboardThemeLoaders,
} from "@marea/plugin-runtime/browser";
import {
  createDashboardModuleDescriptorSchema,
  createDashboardThemeDescriptorSchema,
} from "@marea/plugin-api";
const release = await loadProfileCatalog();
const entries = await Promise.all(
  Object.values(dashboardModuleDescriptorLoaders).map((load) => load()),
);
const modules = entries.map(({ default: entry }) => {
  const data = { ...entry.manifest, entrypoint: undefined, browserEntrypoint: undefined };
  delete data.entrypoint;
  delete data.browserEntrypoint;
  return createDashboardModuleDescriptorSchema().parse(data);
});
const themes = await Promise.all(
  Object.values(dashboardThemeLoaders).map(async (load) => {
    const { default: entry } = await load();
    const data = { ...entry.manifest, entrypoint: undefined, tokens: entry.tokens };
    delete data.entrypoint;
    return createDashboardThemeDescriptorSchema().parse(data);
  }),
);
const releaseDefaults = release.schemas.personalValue.parse({
  themeId: "org.marea.theme.marea",
  modules: entries.map(({ default: entry }) => ({
    moduleId: entry.manifest.id,
    enabled: entry.manifest.defaultEnabled,
    placement: entry.manifest.defaultPlacement,
    configurationVersion: entry.manifest.configurationVersion,
    settings: entry.defaultSettings,
  })),
});
const catalog = release.catalog.parse({
  protocolVersion: "0.1",
  requestId: "request:fixture",
  kind: "dashboard-profile-catalog-result",
  scope: { kind: "teacher" },
  catalogRevision: release.revision,
  modules,
  themes,
  releaseDefaults,
});
await Bun.write("/tmp/profiles-dashboard-browser-catalog.json", JSON.stringify(catalog));
