import {
  createDashboardModuleDescriptorSchema,
  createDashboardThemeDescriptorSchema,
} from "@marea/plugin-api";
import * as z from "zod";
import {
  createDashboardModuleSelectionSchema,
  createDashboardProfileSchemas,
} from "@marea/protocol";
import {
  moduleFixture,
  themeFixture,
} from "../../../../packages/plugin-api/src/dashboard.fixture.js";
const module = createDashboardModuleDescriptorSchema().parse(
  Object.fromEntries(
    Object.entries(moduleFixture.manifest).filter(
      ([key]) => !["entrypoint", "browserEntrypoint"].includes(key),
    ),
  ),
);
const theme = createDashboardThemeDescriptorSchema().parse({
  ...Object.fromEntries(
    Object.entries(themeFixture.manifest).filter(([key]) => key !== "entrypoint"),
  ),
  tokens: themeFixture.tokens,
});
const selection = createDashboardModuleSelectionSchema(
  module.id,
  1,
  moduleFixture.settingsSchema,
  module.supportedPlacements,
);
export const selected = selection.parse({
  moduleId: module.id,
  configurationVersion: 1,
  placement: module.defaultPlacement,
  enabled: true,
  settings: { limit: 10 },
});
export const release = {
  revision: "a".repeat(64),
  selection,
  modules: [module] as const,
  themes: [{ ...theme, tokens: themeFixture.tokens }] as const,
  defaults: { themeId: theme.id, modules: [selected] },
  capabilities: ["sessions/v1"],
  requiredIds: [theme.id],
};
export const schemas = createDashboardProfileSchemas(selection, z.literal(theme.id));
