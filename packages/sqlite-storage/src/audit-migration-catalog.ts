import { retentionAuditSchema } from "./audit-schema.js";
import {
  calculateMigrationChecksum,
  createMigrationCatalog,
  type MigrationDefinition,
} from "./migration-catalog.js";

export function compareMigrationText(left: string, right: string): number {
  return Number(left > right) - Number(left < right);
}

/** Explicit OPERATIONS catalog; the GOVERNANCE eight-migration catalog remains unchanged. */
export function createAuditMigrationCatalog(): readonly MigrationDefinition[] {
  const base = createMigrationCatalog();
  const previous = base.reduce((_, migrationEntry) => migrationEntry);
  const schemaAfter = [...previous.schemaAfter, ...retentionAuditSchema].sort(
    (left, right) =>
      compareMigrationText(left.type, right.type) || compareMigrationText(left.name, right.name),
  );
  const migration = {
    name: "create_retention_audit",
    schemaAfter,
    statements: retentionAuditSchema.map(({ sql }) => sql),
    version: 9,
  };
  return [...base, { ...migration, checksum: calculateMigrationChecksum(migration) }];
}
