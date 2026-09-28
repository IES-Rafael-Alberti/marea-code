import {
  createDashboardModuleDescriptorSchema,
  createDashboardThemeDescriptorSchema,
} from "@marea/plugin-api";
import {
  createDashboardProfileCatalogResultSchema,
  createDashboardProfileSchemas,
  type DashboardModuleSelection,
} from "@marea/protocol";
import * as z from "zod";
import type { DashboardProfileRelease } from "./contracts.js";

const REASONS = {
  "descriptor-limit": "descriptor count exceeds limit",
  "duplicate-ids": "duplicate IDs",
  "required-missing": "required artifact missing",
  "dependency-cycle": "dependency cycle",
  "conflicting-artifact": "conflicting artifact",
  "required-unavailable": "required dependency or capability unavailable",
  "response-limit": "response exceeds byte limit",
} as const;
export type DashboardReleaseReason = keyof typeof REASONS;
/** Operator-private startup diagnostic: bounded ID, closed reason and fixed remedy only. */
export interface DashboardReleaseDiagnostic {
  readonly kind: "dashboard-release";
  readonly pluginId: string;
  readonly reason: DashboardReleaseReason;
  readonly remedy: "rebuild-compatible-release";
}
/** Private startup failure; never serialize this message through the public endpoint. */
export class DashboardReleaseError extends Error {
  readonly diagnostic: DashboardReleaseDiagnostic;
  constructor(id: string, reason: DashboardReleaseReason) {
    const pluginId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(id) ? id : "unrecognized";
    super(
      `Dashboard plugin ${pluginId}: ${REASONS[reason]}. Rebuild or enable compatible release artifacts.`,
    );
    this.diagnostic = {
      kind: "dashboard-release",
      pluginId,
      reason,
      remedy: "rebuild-compatible-release",
    };
  }
}
function unavailable(id: string, reason: DashboardReleaseReason): never {
  throw new DashboardReleaseError(id, reason);
}
export function validateDashboardProfileRelease<S extends DashboardModuleSelection>(
  release: DashboardProfileRelease<S>,
) {
  if (release.modules.length > 64 || release.themes.length > 16)
    unavailable("catalog", "descriptor-limit");
  const modules = release.modules.flatMap((module) => {
    const parsed = createDashboardModuleDescriptorSchema().safeParse(module);
    return parsed.success ? [parsed.data] : [];
  });
  const themes = release.themes.flatMap((theme) => {
    const parsed = createDashboardThemeDescriptorSchema().safeParse(theme);
    return parsed.success ? [parsed.data] : [];
  });
  const entries = [...modules, ...themes];
  const ids = new Set(entries.map(({ id }) => id));
  if (ids.size !== entries.length) unavailable("catalog", "duplicate-ids");
  for (const id of [...release.requiredIds, release.defaults.themeId])
    if (!ids.has(id)) unavailable(id, "required-missing");
  const disabled = new Set<string>();
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) unavailable(id, "dependency-cycle");
    const entry = entries.find((candidate) => candidate.id === id);
    if (entry === undefined) {
      disabled.add(id);
      return;
    }
    visiting.add(id);
    for (const dependency of entry.requiredDependencies) {
      visit(dependency);
      if (disabled.has(dependency)) disabled.add(id);
    }
    for (const optional of entry.optionalDependencies) visit(optional);
    if (entry.conflicts.some((conflict) => ids.has(conflict)))
      unavailable(id, "conflicting-artifact");
    if (
      "requiredServerCapabilities" in entry &&
      entry.requiredServerCapabilities.some(
        (capability) => !release.capabilities.includes(capability),
      )
    )
      disabled.add(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
  for (const id of [...release.requiredIds, release.defaults.themeId])
    if (disabled.has(id)) unavailable(id, "required-unavailable");
  const availableModules = modules.filter(({ id }) => !disabled.has(id));
  const availableThemes = themes.filter(({ id }) => !disabled.has(id));
  const themeId = z.string().refine((id) => availableThemes.some((theme) => theme.id === id));
  const selection = release.selection.refine((value) =>
    availableModules.some(
      (module) =>
        module.id === value.moduleId &&
        module.configurationVersion === value.configurationVersion &&
        module.supportedPlacements.some(
          (placement) =>
            placement.slot === value.placement.slot && placement.size === value.placement.size,
        ),
    ),
  );
  const schemas = createDashboardProfileSchemas(selection, themeId);
  const defaults = schemas.personalValue.parse({
    ...release.defaults,
    modules: release.defaults.modules.filter((module) =>
      availableModules.some(({ id }) => id === module.moduleId),
    ),
  });
  const catalogSchema = createDashboardProfileCatalogResultSchema(
    createDashboardModuleDescriptorSchema(),
    createDashboardThemeDescriptorSchema(),
    schemas.personalValue,
  );
  const catalog = catalogSchema.parse({
    protocolVersion: "0.1",
    requestId: "r".repeat(128),
    kind: "dashboard-profile-catalog-result",
    scope: { kind: "class", classId: "c".repeat(128) },
    catalogRevision: release.revision,
    modules: availableModules,
    themes: availableThemes,
    releaseDefaults: defaults,
  });
  if (new TextEncoder().encode(JSON.stringify(catalog)).byteLength > 262_144)
    unavailable("catalog", "response-limit");
  return {
    schemas,
    catalogSchema,
    modules: availableModules,
    themes: availableThemes,
    defaults,
    revision: release.revision,
    selection,
  };
}
