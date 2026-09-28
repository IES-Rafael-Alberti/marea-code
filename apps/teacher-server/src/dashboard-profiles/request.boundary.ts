import type { DashboardModuleDescriptor, DashboardThemeDescriptor } from "@marea/plugin-api";
import * as z from "zod";
import {
  createDashboardProfileDocumentSchema,
  createDashboardProfileSchemas,
  DashboardPluginIdSchema,
  DashboardModulePlacementSchema,
  MAX_DASHBOARD_PROFILE_REQUEST_BYTES,
  type DashboardModuleSelection,
} from "@marea/protocol";
import { DashboardProfileError } from "./contracts.js";

// Used only to classify invalid writes. Opaque settings never leave this input boundary.
const structural = createDashboardProfileSchemas(
  z.strictObject({
    moduleId: DashboardPluginIdSchema,
    configurationVersion: z.number().int().positive(),
    enabled: z.boolean(),
    placement: DashboardModulePlacementSchema,
    settings: z.record(z.string(), z.unknown()),
  }),
  DashboardPluginIdSchema,
);
export function parseDashboardProfileRequest<S extends DashboardModuleSelection>(
  schemas: ReturnType<typeof createDashboardProfileSchemas<S>>,
  operation: string,
  bytes: Uint8Array,
  catalog: {
    readonly modules: readonly DashboardModuleDescriptor[];
    readonly themes: readonly DashboardThemeDescriptor[];
  },
) {
  const document = createDashboardProfileDocumentSchema(z.unknown(), "request").safeParse(bytes);
  if (!document.success)
    throw new DashboardProfileError(
      bytes.byteLength > MAX_DASHBOARD_PROFILE_REQUEST_BYTES ? 413 : 400,
    );
  const parsed = schemas.request.safeParse(document.data);
  if (!parsed.success) {
    const shape = structural.save.safeParse(document.data);
    if (operation !== "save" || !shape.success) throw new DashboardProfileError(400);
    const value = shape.data.value;
    const unavailable =
      (value.themeId !== undefined && !catalog.themes.some(({ id }) => id === value.themeId)) ||
      value.modules?.some(
        (selection) =>
          !catalog.modules.some(
            (module) =>
              module.id === selection.moduleId &&
              module.configurationVersion === selection.configurationVersion &&
              module.supportedPlacements.some(
                (placement) =>
                  placement.slot === selection.placement.slot &&
                  placement.size === selection.placement.size,
              ),
          ),
      );
    throw new DashboardProfileError(unavailable ? 422 : 400, shape.data.requestId);
  }
  if (parsed.data.kind !== `dashboard-profile-${operation}`)
    throw new DashboardProfileError(400, parsed.data.requestId);
  return parsed.data;
}
