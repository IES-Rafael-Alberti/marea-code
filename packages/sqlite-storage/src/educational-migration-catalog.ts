import { createProfileMigrationCatalog } from "./profile-migration-catalog.js";
import { compareMigrationText } from "./audit-migration-catalog.js";
import { calculateMigrationChecksum, validateKnownMigrationCatalog } from "./migration-catalog.js";
import { educationalSchema } from "./educational-schema.js";
export function createEducationalMigrationCatalog() {
  const base = createProfileMigrationCatalog();
  const previous = base.reduce((_, migration) => migration);
  const objects = educationalSchema().map(({ name, sql, tableName, type }) => ({
    name,
    sql,
    tableName,
    type,
  }));
  const migration = {
    name: "create_educational_insights",
    version: 11,
    statements: objects.map(({ sql }) => sql),
    schemaAfter: [...previous.schemaAfter, ...objects].sort(
      (a, b) => compareMigrationText(a.type, b.type) || compareMigrationText(a.name, b.name),
    ),
  };
  return validateKnownMigrationCatalog([
    ...base,
    { ...migration, checksum: calculateMigrationChecksum(migration) },
  ]);
}
