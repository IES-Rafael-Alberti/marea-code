import * as z from "zod";
import { RequestIdSchema } from "./identifiers.js";
import { RevisionIdSchema } from "./technical.js";
import { CurrentProtocolVersionSchema } from "./version.js";

export const DASHBOARD_PROFILE_SCHEMA_VERSION = 1;
export const MAX_DASHBOARD_PROFILE_REQUEST_BYTES = 65_536;
export const MAX_DASHBOARD_PROFILE_RESPONSE_BYTES = 262_144;
export const MAX_DASHBOARD_MODULE_SETTINGS_BYTES = 4096;
export const DashboardPluginIdSchema = z
  .string()
  .max(160)
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/);
export const DashboardCatalogRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const DashboardProfileScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("teacher") }),
  z.strictObject({ kind: z.literal("class"), classId: RevisionIdSchema }),
]);
export type DashboardProfileScope = z.infer<typeof DashboardProfileScopeSchema>;
export const DashboardModulePlacementSchema = z.strictObject({
  slot: z.enum(["main", "aside"]),
  size: z.enum(["compact", "standard", "wide"]),
});
export interface DashboardModuleSelection<Settings extends object = object> {
  readonly moduleId: string;
  readonly configurationVersion: number;
  readonly enabled: boolean;
  readonly placement: z.infer<typeof DashboardModulePlacementSchema>;
  readonly settings: Settings;
}
/** Bind each installed module to its exact ID, configuration version and strict settings schema. */
export function createDashboardModuleSelectionSchema<
  const Id extends string,
  const Version extends number,
  Shape extends z.ZodRawShape,
>(
  moduleId: Id,
  configurationVersion: Version,
  settings: z.ZodObject<Shape>,
  supportedPlacements: readonly z.infer<typeof DashboardModulePlacementSchema>[],
) {
  DashboardPluginIdSchema.parse(moduleId);
  z.number().int().min(1).max(1_000_000).parse(configurationVersion);
  return z.strictObject({
    moduleId: z.literal(moduleId),
    configurationVersion: z.literal(configurationVersion),
    enabled: z.boolean(),
    placement: DashboardModulePlacementSchema.refine((value) =>
      supportedPlacements.some(
        (allowed) => allowed.slot === value.slot && allowed.size === value.size,
      ),
    ),
    settings: settings
      .strict()
      .refine(
        (value) =>
          new TextEncoder().encode(JSON.stringify(value)).byteLength <=
          MAX_DASHBOARD_MODULE_SETTINGS_BYTES,
      ),
  });
}
const envelope = { protocolVersion: CurrentProtocolVersionSchema, requestId: RequestIdSchema };
const concurrency = {
  expectedRevision: RevisionIdSchema.nullable(),
  expectedPersonalRevision: RevisionIdSchema.nullable(),
  catalogRevision: DashboardCatalogRevisionSchema,
};
function validTeacherRevision(value: {
  scope: DashboardProfileScope;
  expectedRevision: string | null;
  expectedPersonalRevision: string | null;
}): boolean {
  return value.scope.kind === "class" || value.expectedRevision === value.expectedPersonalRevision;
}
export const DashboardProfileReadRequestSchema = z.strictObject({
  ...envelope,
  kind: z.literal("dashboard-profile-read"),
  scope: DashboardProfileScopeSchema,
});
export const DashboardProfileCatalogRequestSchema = z.strictObject({
  ...envelope,
  kind: z.literal("dashboard-profile-catalog"),
  scope: DashboardProfileScopeSchema,
});
export const DashboardProfileResetRequestSchema = z
  .strictObject({
    ...envelope,
    ...concurrency,
    kind: z.literal("dashboard-profile-reset"),
    scope: DashboardProfileScopeSchema,
  })
  .refine(validTeacherRevision);
export const DashboardProfileWarningSchema = z.strictObject({
  code: z.enum([
    "module-unavailable",
    "module-incompatible",
    "module-forbidden",
    "settings-invalid",
    "theme-unavailable",
    "profile-invalid",
    "profile-version-unsupported",
  ]),
  moduleId: DashboardPluginIdSchema.optional(),
  themeId: DashboardPluginIdSchema.optional(),
});
export type DashboardProfileReadRequest = z.infer<typeof DashboardProfileReadRequestSchema>;
export type DashboardProfileCatalogRequest = z.infer<typeof DashboardProfileCatalogRequestSchema>;
export type DashboardProfileResetRequest = z.infer<typeof DashboardProfileResetRequestSchema>;
export type DashboardProfileWarning = z.infer<typeof DashboardProfileWarningSchema>;

/** The release supplies a typed union of installed module selections, never opaque settings. */
export function createDashboardProfileSchemas<Selection extends DashboardModuleSelection>(
  selection: z.ZodType<Selection>,
  themeId: z.ZodType<string>,
) {
  const modules = z
    .array(selection)
    .max(32)
    .refine((values) => new Set(values.map((value) => value.moduleId)).size === values.length);
  const personalValue = z.strictObject({
    themeId: themeId.refine((id) => DashboardPluginIdSchema.safeParse(id).success),
    modules,
  });
  const classValue = personalValue
    .partial()
    .refine((value) => value.themeId !== undefined || value.modules !== undefined);
  const save = z
    .union([
      z.strictObject({
        ...envelope,
        ...concurrency,
        kind: z.literal("dashboard-profile-save"),
        scope: z.strictObject({ kind: z.literal("teacher") }),
        value: personalValue,
        discardUnavailable: z.boolean(),
      }),
      z.strictObject({
        ...envelope,
        ...concurrency,
        kind: z.literal("dashboard-profile-save"),
        scope: z.strictObject({ kind: z.literal("class"), classId: RevisionIdSchema }),
        value: classValue,
        discardUnavailable: z.boolean(),
      }),
    ])
    .refine(validTeacherRevision);
  const personal = profileRecord(personalValue);
  const override = profileRecord(classValue);
  const state = z
    .strictObject({
      ...envelope,
      kind: z.literal("dashboard-profile-state"),
      schemaVersion: z.literal(1),
      scope: DashboardProfileScopeSchema,
      generatedAt: z.iso.datetime(),
      catalogRevision: DashboardCatalogRevisionSchema,
      personal,
      override: override.nullable(),
      effective: personalValue.refine((value) => value.modules.every((module) => module.enabled)),
      warnings: z.array(DashboardProfileWarningSchema).max(64),
    })
    .refine((value) =>
      value.scope.kind === "class" ? value.override !== null : value.override === null,
    );
  return {
    personalValue,
    classValue,
    personal,
    override,
    save,
    state,
    request: z.union([
      DashboardProfileReadRequestSchema,
      DashboardProfileCatalogRequestSchema,
      DashboardProfileResetRequestSchema,
      save,
    ]),
  };
}
function profileRecord<Value>(value: z.ZodType<Value>) {
  return z
    .strictObject({
      revision: RevisionIdSchema.nullable(),
      updatedAt: z.iso.datetime().nullable(),
      status: z.enum(["default", "valid", "recovery-required"]),
      value: value.nullable(),
    })
    .refine((record) => (record.revision === null) === (record.updatedAt === null))
    .refine((record) =>
      record.status === "valid"
        ? record.value !== null && record.revision !== null
        : record.value === null,
    )
    .refine((record) => record.status !== "recovery-required" || record.revision !== null);
}
export function createDashboardProfileCatalogResultSchema<Module, Theme, Defaults>(
  module: z.ZodType<Module>,
  theme: z.ZodType<Theme>,
  defaults: z.ZodType<Defaults>,
) {
  return z.strictObject({
    ...envelope,
    kind: z.literal("dashboard-profile-catalog-result"),
    scope: DashboardProfileScopeSchema,
    catalogRevision: DashboardCatalogRevisionSchema,
    modules: z.array(module).max(64),
    themes: z.array(theme).max(16),
    releaseDefaults: defaults,
  });
}

export type DashboardProfileSaveRequest<Selection extends DashboardModuleSelection> = z.infer<
  ReturnType<typeof createDashboardProfileSchemas<Selection>>["save"]
>;
export type DashboardProfileState<Selection extends DashboardModuleSelection> = z.infer<
  ReturnType<typeof createDashboardProfileSchemas<Selection>>["state"]
>;
export type DashboardPersonalProfileValue<Selection extends DashboardModuleSelection> = z.infer<
  ReturnType<typeof createDashboardProfileSchemas<Selection>>["personalValue"]
>;
export type DashboardClassProfileValue<Selection extends DashboardModuleSelection> = z.infer<
  ReturnType<typeof createDashboardProfileSchemas<Selection>>["classValue"]
>;
