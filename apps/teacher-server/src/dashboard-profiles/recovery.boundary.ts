import * as z from "zod";
import {
  createDashboardProfileDocumentSchema,
  DashboardPluginIdSchema,
  DashboardModulePlacementSchema,
  type DashboardModuleSelection,
  type DashboardProfileWarning,
} from "@marea/protocol";
import type { StoredDashboardProfile } from "@marea/sqlite-storage";
import type { validateDashboardProfileRelease } from "./release.js";

const storedModule = z.strictObject({
  moduleId: DashboardPluginIdSchema,
  configurationVersion: z.number().int().positive(),
  enabled: z.boolean(),
  placement: DashboardModulePlacementSchema,
  settings: z.unknown(),
});
const storedValue = z.strictObject({
  themeId: DashboardPluginIdSchema.optional(),
  modules: z
    .array(storedModule)
    .max(32)
    .refine((modules) => new Set(modules.map(({ moduleId }) => moduleId)).size === modules.length)
    .optional(),
});
export function recoverDashboardProfile<S extends DashboardModuleSelection>(
  row: StoredDashboardProfile | null,
  personal: boolean,
  release: ReturnType<typeof validateDashboardProfileRelease<S>>,
  permits: (id: string) => boolean,
) {
  const base = { revision: row?.revision ?? null, updatedAt: row?.updatedAt ?? null };
  const warnings: DashboardProfileWarning[] = [];
  const invalid = (code: "profile-invalid" | "profile-version-unsupported") => ({
    record: { ...base, status: "recovery-required" as const, value: null },
    warnings: [{ code }],
    discarded: false,
  });
  if (row === null)
    return {
      record: { ...base, status: "default" as const, value: null },
      warnings,
      discarded: false,
    };
  if (row.schemaVersion !== 1) return invalid("profile-version-unsupported");
  if (row.serializedValue === null)
    return {
      record: { ...base, status: "default" as const, value: null },
      warnings,
      discarded: false,
    };
  const parsed = createDashboardProfileDocumentSchema(storedValue, "request").safeParse(
    new TextEncoder().encode(row.serializedValue),
  );
  if (!parsed.success) return invalid("profile-invalid");
  const value = parsed.data;
  if (
    personal
      ? value.themeId === undefined || value.modules === undefined
      : value.themeId === undefined && value.modules === undefined
  )
    return invalid("profile-invalid");
  let discarded = false;
  let themeId = value.themeId;
  if (themeId !== undefined && !release.themes.some(({ id }) => id === themeId)) {
    warnings.push({ code: "theme-unavailable", themeId });
    themeId = release.defaults.themeId;
    discarded = true;
  }
  const modules = value.modules?.flatMap((module): S[] => {
    const descriptor = release.modules.find(({ id }) => id === module.moduleId);
    let code: DashboardProfileWarning["code"] | undefined;
    if (descriptor === undefined) code = "module-unavailable";
    else if (descriptor.configurationVersion !== module.configurationVersion)
      code = "module-incompatible";
    else if (!permits(module.moduleId)) code = "module-forbidden";
    else {
      const normalized = release.selection.safeParse(module);
      if (normalized.success) return [normalized.data];
      code = "settings-invalid";
    }
    warnings.push({ code, moduleId: module.moduleId });
    discarded = true;
    return [];
  });
  const normalized = {
    ...(themeId === undefined ? {} : { themeId }),
    ...(modules === undefined ? {} : { modules }),
  };
  return { record: { ...base, status: "valid" as const, value: normalized }, warnings, discarded };
}
