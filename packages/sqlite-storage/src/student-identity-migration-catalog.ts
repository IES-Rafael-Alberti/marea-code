import { compareMigrationText } from "./audit-migration-catalog.js";
import { createEducationalMigrationCatalog } from "./educational-migration-catalog.js";
import { calculateMigrationChecksum, validateKnownMigrationCatalog } from "./migration-catalog.js";
import { studentIdentityMigration } from "./student-identity-schema.js";

/** Schema 12 extends the immutable educational catalog 1–11. */
export function createStudentIdentityMigrationCatalog() {
  const base = createEducationalMigrationCatalog();
  const previous = base.reduce((_, migration) => migration);
  const migration = studentIdentityMigration(previous.schemaAfter);
  const sorted = {
    ...migration,
    schemaAfter: [...migration.schemaAfter].sort(
      (left, right) =>
        compareMigrationText(left.type, right.type) || compareMigrationText(left.name, right.name),
    ),
  };
  return validateKnownMigrationCatalog([
    ...base,
    { ...sorted, checksum: calculateMigrationChecksum(sorted) },
  ]);
}
