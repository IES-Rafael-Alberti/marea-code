import { createDashboardHostViewEntries } from "@marea/plugin-api/browser";

/** The host adapter supplies the class-authorized health view; this plugin owns no transport. */
const { entry, typedEntry } = createDashboardHostViewEntries<{ readonly healthRead: true }>();
export { typedEntry };
export default entry;
