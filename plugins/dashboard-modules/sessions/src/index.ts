import {
  createDashboardModuleManifestSchema,
  defineDashboardModuleCatalogEntry,
} from "@marea/plugin-api";
import * as z from "zod";
import manifest from "../plugin.json";
export const settingsSchema = z.strictObject({});
export default defineDashboardModuleCatalogEntry({
  manifest: createDashboardModuleManifestSchema().parse(manifest),
  settingsSchema,
  defaultSettings: {},
});
