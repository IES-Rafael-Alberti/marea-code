import { createAuditMigrationCatalog, compareMigrationText } from "./audit-migration-catalog.js";
import { calculateMigrationChecksum, validateKnownMigrationCatalog } from "./migration-catalog.js";
import { profileSchema } from "./profile-schema.js";

/** Profile schema 10 extends the immutable application 1–8 and retention-audit 9 catalogs. */
export function createProfileMigrationCatalog() {
  const base = createAuditMigrationCatalog();
  const previous = base.reduce((_, migration) => migration);
  const objects = profileSchema();
  const migration = {
    name: "create_dashboard_profiles",
    version: 10,
    schemaAfter: [...previous.schemaAfter, ...objects].sort(
      (left, right) =>
        compareMigrationText(left.type, right.type) || compareMigrationText(left.name, right.name),
    ),
    statements: objects.map(({ sql }) => sql),
  };
  return validateKnownMigrationCatalog([
    ...base,
    { ...migration, checksum: calculateMigrationChecksum(migration) },
  ]);
}
