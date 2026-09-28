import * as z from "zod";
import { describe, expect, it } from "vitest";
import { moduleFixture as moduleEntry, themeFixture as themeEntry } from "./dashboard.fixture.js";
import {
  createDashboardModuleDescriptorSchema,
  createDashboardModuleManifestSchema,
  defineDashboardModuleCatalogEntry,
} from "./dashboard-module.js";
import {
  createDashboardThemeDescriptorSchema,
  createDashboardThemeManifestSchema,
  defineDashboardThemeCatalogEntry,
} from "./dashboard-theme.js";
import {
  DashboardFreshnessSchema,
  DashboardCapabilitySchema,
  supportsDefault,
} from "./dashboard-contracts.js";
import { DashboardThemeTokensSchema } from "./dashboard-theme-tokens.js";

describe("dashboard API 2.0", () => {
  it("shares pure typed settings defaults and validators", () => {
    expect(moduleEntry.settingsSchema.parse({ limit: 100 })).toEqual({ limit: 100 });
    for (const settings of [{ limit: 0 }, { limit: 101 }, { limit: 2, extra: true }])
      expect(moduleEntry.settingsSchema.safeParse(settings).success).toBe(false);
    expect(() =>
      defineDashboardModuleCatalogEntry({
        manifest: moduleEntry.manifest,
        settingsSchema: z.strictObject({ limit: z.number().min(1) }),
        defaultSettings: { limit: 0 },
      }),
    ).toThrow();
    const custom = defineDashboardModuleCatalogEntry({
      manifest: moduleEntry.manifest,
      settingsSchema: z.strictObject({ title: z.string().trim() }),
      defaultSettings: { title: " trimmed " },
    });
    expect(custom.defaultSettings.title).toBe("trimmed");
  });
  it("exposes strict serializable descriptors without build paths", () => {
    const {
      entrypoint: _entrypoint,
      browserEntrypoint: _browser,
      ...moduleDescriptor
    } = moduleEntry.manifest;
    expect(_entrypoint).toBe("./src/index.ts");
    expect(_browser).toBe("./src/browser.ts");
    expect(createDashboardModuleDescriptorSchema().parse(moduleDescriptor)).toEqual(
      moduleDescriptor,
    );
    expect(createDashboardModuleDescriptorSchema().safeParse(moduleEntry.manifest).success).toBe(
      false,
    );
    const { entrypoint: _themeEntry, ...themeDescriptor } = themeEntry.manifest;
    expect(_themeEntry).toBe("./src/index.ts");
    expect(
      createDashboardThemeDescriptorSchema().parse({
        ...themeDescriptor,
        tokens: themeEntry.tokens,
      }).tokens,
    ).toEqual(themeEntry.tokens);
    expect(
      createDashboardThemeDescriptorSchema().safeParse({
        ...themeEntry.manifest,
        tokens: themeEntry.tokens,
      }).success,
    ).toBe(false);
  });
  it("enforces permissions, placement sets, capability versions and release defaults", () => {
    const schema = createDashboardModuleManifestSchema();
    for (const change of [
      { apiVersion: "1.0" },
      { requiredPermissions: ["admin"] },
      { requiredPermissions: ["session-read", "session-read"] },
      { requiredServerCapabilities: ["sessions"] },
      { requiredServerCapabilities: ["sessions/v1", "sessions/v1"] },
      { supportedPlacements: [] },
      {
        supportedPlacements: [
          moduleEntry.manifest.defaultPlacement,
          moduleEntry.manifest.defaultPlacement,
        ],
      },
      { defaultPlacement: { slot: "aside", size: "standard" } },
      { defaultPlacement: { slot: "main", size: "wide" } },
      { browserEntrypoint: "../escape.ts" },
    ])
      expect(schema.safeParse({ ...moduleEntry.manifest, ...change }).success).toBe(false);
    expect(
      supportsDefault({
        supportedPlacements: [{ slot: "main", size: "wide" }],
        defaultPlacement: { slot: "main", size: "wide" },
      }),
    ).toBe(true);
    expect(DashboardCapabilitySchema.parse("sessions/v12")).toBe("sessions/v12");
  });
  it("bounds freshness and rejects unknown fields", () => {
    expect(DashboardFreshnessSchema.parse({ kind: "on-demand" })).toEqual({ kind: "on-demand" });
    for (const intervalMs of [1000, 3_600_000])
      expect(DashboardFreshnessSchema.parse({ kind: "poll", intervalMs })).toEqual({
        kind: "poll",
        intervalMs,
      });
    for (const reconnectMs of [1000, 60_000])
      expect(
        DashboardFreshnessSchema.parse({ kind: "live", reconnectMs, fallbackIntervalMs: 1000 })
          .kind,
      ).toBe("live");
    for (const input of [
      { kind: "poll", intervalMs: 999 },
      { kind: "poll", intervalMs: 3_600_001 },
      { kind: "live", reconnectMs: 60_001, fallbackIntervalMs: 1000 },
      { kind: "on-demand", extra: true },
    ])
      expect(DashboardFreshnessSchema.safeParse(input).success).toBe(false);
  });
  it("accepts complete semantic tokens and rejects CSS, incomplete and out-of-bound tokens", () => {
    expect(DashboardThemeTokensSchema.parse(themeEntry.tokens)).toEqual(themeEntry.tokens);
    expect(defineDashboardThemeCatalogEntry(themeEntry).tokens).toEqual(themeEntry.tokens);
    const tokens = themeEntry.tokens;
    for (const change of [
      { schemaVersion: 2 },
      { surfaces: { ...tokens.surfaces, canvas: "url(https://example.org)" } },
      { typography: { ...tokens.typography, fontFamily: "external" } },
      { spacing: { ...tokens.spacing, small: -1 } },
      { radius: { ...tokens.radius, small: Infinity } },
      { focus: { ...tokens.focus, width: 1 } },
      { chartSeries: ["#aaaaaa", "#AAAAAA", "#222222", "#333333", "#444444", "#555555"] },
      { chartSeries: tokens.chartSeries.slice(0, 5) },
      { text: {} },
      { stylesheet: "body{}" },
    ])
      expect(DashboardThemeTokensSchema.safeParse({ ...tokens, ...change }).success).toBe(false);
  });
});

it("preserves dark theme metadata and actionable default-placement errors", () => {
  expect(
    createDashboardThemeManifestSchema().parse({ ...themeEntry.manifest, colorScheme: "dark" })
      .colorScheme,
  ).toBe("dark");
  expect(() =>
    createDashboardModuleManifestSchema().parse({
      ...moduleEntry.manifest,
      defaultPlacement: { slot: "aside", size: "wide" },
    }),
  ).toThrow("Default placement must be supported.");
});
