import { defineSettinglessDashboardModule } from "@marea/plugin-api";
import manifest from "../plugin.json";
const { entry, settingsSchema } = defineSettinglessDashboardModule(manifest);
export { settingsSchema };
export default entry;
