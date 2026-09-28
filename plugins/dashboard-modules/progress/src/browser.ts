import { createDashboardHostViewEntries } from "@marea/plugin-api/browser";

/** The host adapter supplies the class-authorized progress view; this plugin owns no transport. */
const { entry, typedEntry } = createDashboardHostViewEntries<{ readonly evaluationRead: true }>();
export { typedEntry };
export default entry;
