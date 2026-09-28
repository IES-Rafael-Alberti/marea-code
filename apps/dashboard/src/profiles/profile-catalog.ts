import * as z from "zod";
import {
  createDashboardModuleDescriptorSchema,
  type DashboardModuleCatalogEntry,
  createDashboardThemeDescriptorSchema,
} from "@marea/plugin-api";
import {
  createDashboardModuleSelectionSchema,
  createDashboardProfileCatalogResultSchema,
  createDashboardProfileSchemas,
} from "@marea/protocol";
import {
  dashboardCatalogRevision,
  dashboardModuleDescriptorLoaders,
  dashboardThemeLoaders,
} from "@marea/plugin-runtime/browser";

/** Build-time loaders are the only source of executable settings validators. */
export async function loadProfileCatalog() {
  type Discovered = Awaited<
    ReturnType<
      (typeof dashboardModuleDescriptorLoaders)[keyof typeof dashboardModuleDescriptorLoaders]
    >
  >;
  type PureEntry = [Discovered] extends [never]
    ? {
        default: DashboardModuleCatalogEntry<Record<string, never>>;
        settingsSchema: z.ZodObject<Record<string, never>>;
      }
    : Discovered;
  const loaders: Readonly<Record<string, () => Promise<PureEntry>>> =
    dashboardModuleDescriptorLoaders;
  const modules = await Promise.all(Object.values(loaders).map((load) => load()));
  const themes = await Promise.all(Object.values(dashboardThemeLoaders).map((load) => load()));
  const selections = modules.map(({ default: entry, settingsSchema }) =>
    createDashboardModuleSelectionSchema(
      entry.manifest.id,
      entry.manifest.configurationVersion,
      settingsSchema,
      entry.manifest.supportedPlacements,
    ),
  );
  const schemas = createDashboardProfileSchemas(
    z.union([z.never(), ...selections]),
    z.enum(themes.map((entry) => entry.default.manifest.id)),
  );
  return {
    revision: dashboardCatalogRevision,
    schemas,
    catalog: createDashboardProfileCatalogResultSchema(
      createDashboardModuleDescriptorSchema(),
      createDashboardThemeDescriptorSchema(),
      schemas.personalValue,
    ),
  };
}
export type ProfileCatalog = Awaited<ReturnType<typeof loadProfileCatalog>>;
export type ProfileState = z.infer<ProfileCatalog["schemas"]["state"]>;
export type ProfileValue = z.infer<ProfileCatalog["schemas"]["classValue"]>;
export type ProfileSelection = z.infer<
  ProfileCatalog["schemas"]["personalValue"]
>["modules"][number];
export type AuthorizedCatalog = z.infer<ProfileCatalog["catalog"]>;
