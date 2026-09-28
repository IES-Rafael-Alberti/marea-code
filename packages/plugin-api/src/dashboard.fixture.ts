import * as z from "zod";
import type { DashboardModuleCatalogEntry } from "./dashboard-module.js";

export const moduleFixture = {
  settingsSchema: z.strictObject({ limit: z.number().int().min(1).max(100) }),
  defaultSettings: { limit: 10 },
  manifest: {
    browserEntrypoint: "./src/browser.ts",
    requiredServerCapabilities: ["sessions/v1"],
    requiredPermissions: ["session-read"],
    supportedPlacements: [{ slot: "main", size: "standard" }],
    defaultPlacement: { slot: "main", size: "standard" },
    defaultEnabled: true,
    freshness: { kind: "on-demand" },

    id: "org.marea.fixture-dashboard-module",
    displayNameKey: "plugins.fixture-dashboard-module.name",
    descriptionKey: "plugins.fixture-dashboard-module.description",
    kind: "dashboard-module",
    apiVersion: "2.0",
    implementationVersion: "0.3.0",
    entrypoint: "./src/index.ts",
    configurationVersion: 1,
    requiredDependencies: [],
    optionalDependencies: [],
    conflicts: [],
    capabilities: ["run-read"],
    runtimeTargets: ["dashboard-browser"],
    minimumColumns: 4,
  },
} satisfies DashboardModuleCatalogEntry<{ limit: number }>;

export const fixtureThemeTokens = {
  schemaVersion: 1 as const,
  surfaces: {
    canvas: "#ffffff",
    panel: "#ffffff",
    raised: "#ffffff",
  },
  text: {
    primary: "#111111",
    secondary: "#111111",
    inverse: "#111111",
  },
  borders: {
    default: "#333333",
    strong: "#333333",
  },
  actions: {
    background: "#444444",
    foreground: "#444444",
    hover: "#444444",
    disabled: "#444444",
  },
  states: {
    success: "#222222",
    warning: "#222222",
    error: "#222222",
    info: "#222222",
  },
  focus: {
    color: "#000000",
    width: 2,
    offset: 2,
  },
  typography: {
    fontFamily: "system-sans" as const,
    fontSize: 16,
    lineHeight: 1.5,
  },
  spacing: {
    small: 4,
    medium: 8,
    large: 16,
  },
  radius: {
    small: 2,
    large: 4,
  },
  shadow: {
    color: "#000000",
    x: 0,
    y: 2,
    blur: 4,
    spread: 0,
  },
  chartSeries: ["#000000", "#111111", "#222222", "#333333", "#444444", "#555555"],
};

import type { DashboardThemeCatalogEntry } from "./dashboard-theme.js";

export const themeFixture = {
  tokens: fixtureThemeTokens,
  manifest: {
    colorScheme: "light",
    highContrast: false,
    id: "org.marea.fixture-dashboard-theme",
    displayNameKey: "plugins.fixture-dashboard-theme.name",
    descriptionKey: "plugins.fixture-dashboard-theme.description",
    kind: "dashboard-theme",
    apiVersion: "2.0",
    implementationVersion: "1.0.0+fixture",
    entrypoint: "./src/index.ts",
    configurationVersion: 1,
    requiredDependencies: [],
    optionalDependencies: [],
    conflicts: [],
    capabilities: ["light-color-scheme", "dark-color-scheme"],
    runtimeTargets: ["dashboard-browser"],
  },
} satisfies DashboardThemeCatalogEntry;
