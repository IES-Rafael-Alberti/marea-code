import * as z from "zod";

import {
  createCommonManifestShape,
  hasSafeRelationships,
  safeRelationshipMessage,
} from "./manifest-fields.js";

export function createDashboardThemeManifestSchema() {
  return z
    .object({
      ...createCommonManifestShape(),
      kind: z.literal("dashboard-theme"),
      apiVersion: z.literal("2.0"),
      colorScheme: z.enum(["light", "dark"]),
      highContrast: z.boolean(),
      capabilities: z
        .array(z.enum(["dark-color-scheme", "high-contrast", "light-color-scheme"]))
        .min(1)
        .refine((values) => new Set(values).size === values.length, "Capabilities must be unique.")
        .readonly(),
      runtimeTargets: z.tuple([z.literal("dashboard-browser")]).readonly(),
    })
    .strict()
    .refine(hasSafeRelationships, safeRelationshipMessage())
    .readonly();
}

export type DashboardThemeManifest = z.infer<ReturnType<typeof createDashboardThemeManifestSchema>>;

import { DashboardThemeTokensSchema, type DashboardThemeTokens } from "./dashboard-theme-tokens.js";

export interface DashboardThemeCatalogEntry {
  readonly tokens: DashboardThemeTokens;
  readonly manifest: DashboardThemeManifest;
}

export function defineDashboardThemeCatalogEntry(
  entry: DashboardThemeCatalogEntry,
): DashboardThemeCatalogEntry {
  return { ...entry, tokens: DashboardThemeTokensSchema.parse(entry.tokens) };
}

export function createDashboardThemeDescriptorSchema() {
  return z
    .strictObject({
      ...createDashboardThemeManifestSchema().unwrap().shape,
      tokens: DashboardThemeTokensSchema,
    })
    .omit({ entrypoint: true })
    .refine(hasSafeRelationships, safeRelationshipMessage());
}
export type DashboardThemeDescriptor = z.infer<
  ReturnType<typeof createDashboardThemeDescriptorSchema>
>;
