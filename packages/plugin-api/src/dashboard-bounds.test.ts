import * as z from "zod";
import { expect, it } from "vitest";
import { moduleFixture, fixtureThemeTokens } from "./dashboard.fixture.js";
import {
  createDashboardModuleManifestSchema,
  defineDashboardModuleCatalogEntry,
} from "./dashboard-module.js";
import {
  DashboardCapabilitySchema,
  DashboardFreshnessSchema,
  DashboardPermissionSchema,
  DashboardPlacementSchema,
} from "./dashboard-contracts.js";
import { DashboardThemeTokensSchema } from "./dashboard-theme-tokens.js";

it("accepts every supported slot, size, permission and freshness boundary", () => {
  const placements = (["main", "aside"] as const).flatMap((slot) =>
    (["compact", "standard", "wide"] as const).map((size) => ({ slot, size })),
  );
  for (const placement of placements)
    expect(DashboardPlacementSchema.parse(placement)).toEqual(placement);
  const permissions = [
    "class-read",
    "session-read",
    "evaluation-read",
    "evaluation-review",
    "usage-read",
    "health-read",
  ];
  for (const permission of permissions)
    expect(DashboardPermissionSchema.parse(permission)).toBe(permission);
  const manifest = {
    ...moduleFixture.manifest,
    requiredPermissions: permissions,
    supportedPlacements: placements,
    requiredServerCapabilities: Array.from(
      { length: 32 },
      (_, index) => `capability-${String(index)}/v1`,
    ),
  };
  expect(createDashboardModuleManifestSchema().parse(manifest)).toEqual(manifest);
  expect(
    createDashboardModuleManifestSchema().safeParse({
      ...manifest,
      requiredServerCapabilities: [...manifest.requiredServerCapabilities, "extra/v1"],
    }).success,
  ).toBe(false);
  for (const kind of ["poll", "live"] as const) {
    const valid =
      kind === "poll"
        ? { kind, intervalMs: 3_600_000 }
        : { kind, reconnectMs: 60_000, fallbackIntervalMs: 3_600_000 };
    expect(DashboardFreshnessSchema.parse(valid)).toEqual(valid);
  }
  expect(
    DashboardFreshnessSchema.safeParse({ kind: "live", reconnectMs: 999, fallbackIntervalMs: 1000 })
      .success,
  ).toBe(false);
});
it("requires an anchored bounded versioned capability identifier", () => {
  const maximal = `${"a".repeat(157)}/v1`;
  for (const valid of ["a/v1", "session-1.x/v23", maximal])
    expect(DashboardCapabilitySchema.parse(valid)).toBe(valid);
  for (const invalid of ["!a/v1", "a/v1!", "A/v1", "a/v0", "a/v01", maximal + "1"])
    expect(DashboardCapabilitySchema.safeParse(invalid).success).toBe(false);
});
it("normalizes settings while preserving the exact serialized byte boundary", () => {
  const schema = z.strictObject({ label: z.string() });
  const entry = defineDashboardModuleCatalogEntry({
    manifest: moduleFixture.manifest,
    settingsSchema: schema,
    defaultSettings: { label: "x".repeat(4084) },
  });
  expect(entry.defaultSettings.label).toHaveLength(4084);
  expect(() =>
    defineDashboardModuleCatalogEntry({
      manifest: moduleFixture.manifest,
      settingsSchema: schema,
      defaultSettings: { label: "x".repeat(4085) },
    }),
  ).toThrow();
  expect(entry.settingsSchema.safeParse({ label: "é".repeat(2043) }).success).toBe(false);
});
it("normalizes opaque hex colors and rejects prefixed, suffixed or short colors", () => {
  const schema = DashboardThemeTokensSchema;
  expect(
    schema.parse({
      ...fixtureThemeTokens,
      surfaces: { ...fixtureThemeTokens.surfaces, panel: "#ABCDEF" },
    }).surfaces.panel,
  ).toBe("#abcdef");
  for (const invalid of ["x#123456", "#123456x", "#123", "#gggggg"])
    expect(
      schema.safeParse({
        ...fixtureThemeTokens,
        surfaces: { ...fixtureThemeTokens.surfaces, panel: invalid },
      }).success,
    ).toBe(false);
});
it("validates both ends of theme numeric ranges and every system font", () => {
  for (const fontFamily of ["system-sans", "system-serif", "system-mono"] as const) {
    const tokens = {
      ...fixtureThemeTokens,
      typography: { fontFamily, fontSize: 24, lineHeight: 2 },
      spacing: { small: 0, medium: 32, large: 64 },
      focus: { color: "#123456", width: 8, offset: 64 },
      shadow: { color: "#123456", x: -64, y: 64, blur: 0, spread: 64 },
      chartSeries: Array.from(
        { length: 12 },
        (_, index) => `#${index.toString(16).padStart(6, "0")}`,
      ),
    };
    expect(DashboardThemeTokensSchema.parse(tokens)).toEqual(tokens);
  }
  const low = {
    ...fixtureThemeTokens,
    typography: { fontFamily: "system-sans", fontSize: 12, lineHeight: 1.2 },
    shadow: { ...fixtureThemeTokens.shadow, x: 64, y: -64 },
  };
  expect(DashboardThemeTokensSchema.parse(low)).toEqual(low);
});
