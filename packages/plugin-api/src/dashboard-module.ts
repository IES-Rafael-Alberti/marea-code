import * as z from "zod";

import {
  createCommonManifestShape,
  createPluginEntrypointSchema,
  hasSafeRelationships,
  safeRelationshipMessage,
} from "./manifest-fields.js";

import { dashboardDescriptorShape, supportsDefault } from "./dashboard-contracts.js";

export function createDashboardModuleManifestSchema() {
  return z
    .object({
      ...createCommonManifestShape(),
      kind: z.literal("dashboard-module"),
      apiVersion: z.literal("2.0"),
      browserEntrypoint: createPluginEntrypointSchema(),
      ...dashboardDescriptorShape(),
      capabilities: z
        .array(z.enum(["class-read", "evaluation-read", "run-read", "usage-read", "health-read"]))
        .min(1)
        .refine((values) => new Set(values).size === values.length, "Capabilities must be unique.")
        .readonly(),
      runtimeTargets: z.tuple([z.literal("dashboard-browser")]).readonly(),
      minimumColumns: z.number().int().min(1).max(12),
    })
    .strict()
    .refine(hasSafeRelationships, safeRelationshipMessage())
    .refine(supportsDefault, "Default placement must be supported.")
    .readonly();
}

export type DashboardModuleManifest = z.infer<
  ReturnType<typeof createDashboardModuleManifestSchema>
>;

export interface DashboardModuleCatalogEntry<Settings = object> {
  readonly manifest: DashboardModuleManifest;
  readonly settingsSchema: z.ZodType<Settings>;
  readonly defaultSettings: Settings;
}

export function defineDashboardModuleCatalogEntry<Shape extends z.ZodRawShape>(entry: {
  readonly manifest: DashboardModuleManifest;
  readonly settingsSchema: z.ZodObject<Shape>;
  readonly defaultSettings: z.infer<z.ZodObject<Shape>>;
}): DashboardModuleCatalogEntry<z.infer<z.ZodObject<Shape>>> {
  const settingsSchema = entry.settingsSchema
    .strict()
    .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 4096);
  return {
    manifest: createDashboardModuleManifestSchema().parse(entry.manifest),
    settingsSchema,
    defaultSettings: settingsSchema.parse(entry.defaultSettings),
  };
}

/** Pure catalog entry for a module whose only valid settings are the empty object. */
export function defineSettinglessDashboardModule(manifest: object) {
  const settingsSchema = z.strictObject({});
  return {
    settingsSchema,
    entry: defineDashboardModuleCatalogEntry({
      manifest: createDashboardModuleManifestSchema().parse(manifest),
      settingsSchema,
      defaultSettings: {},
    }),
  };
}

/** Serializable public descriptor: build paths and executable validators never cross HTTP. */
export function createDashboardModuleDescriptorSchema() {
  return z
    .strictObject(createDashboardModuleManifestSchema().unwrap().shape)
    .omit({ entrypoint: true, browserEntrypoint: true })
    .refine(hasSafeRelationships, safeRelationshipMessage())
    .refine(supportsDefault);
}
export type DashboardModuleDescriptor = z.infer<
  ReturnType<typeof createDashboardModuleDescriptorSchema>
>;
