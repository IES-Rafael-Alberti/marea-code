import { compareMigrationText } from "./audit-migration-catalog.js";
import {
  calculateMigrationChecksum,
  validateKnownMigrationCatalog,
  type MigrationDefinition,
  type SchemaObjectDefinition,
} from "./migration-catalog.js";

/** Append objects while preserving every previous migration and its checksum byte-for-byte. */
export function extendMigrationCatalog(
  base: readonly MigrationDefinition[],
  version: number,
  name: string,
  objects: readonly SchemaObjectDefinition[],
) {
  const previous = base.reduce((_, migration) => migration);
  const migration = {
    name,
    version,
    schemaAfter: [...previous.schemaAfter, ...objects].sort(
      (a, b) => compareMigrationText(a.type, b.type) || compareMigrationText(a.name, b.name),
    ),
    statements: objects.map(({ sql }) => sql),
  };
  return validateKnownMigrationCatalog([
    ...base,
    { ...migration, checksum: calculateMigrationChecksum(migration) },
  ]);
}
