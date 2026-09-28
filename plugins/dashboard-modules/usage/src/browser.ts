import { createDashboardHostViewEntries } from "@marea/plugin-api/browser";

/** The host adapter supplies the class-authorized usage view; this plugin owns no transport. */
const { entry, typedEntry } = createDashboardHostViewEntries<{ readonly usageRead: true }>();
export { typedEntry };
export default entry;
