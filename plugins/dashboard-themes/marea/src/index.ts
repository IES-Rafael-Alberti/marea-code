import { createDashboardThemeManifestSchema, DashboardThemeTokensSchema } from "@marea/plugin-api";
import manifest from "../plugin.json";
import tokens from "./tokens.json";

export default {
  manifest: createDashboardThemeManifestSchema().parse(manifest),
  tokens: DashboardThemeTokensSchema.parse(tokens),
};
