import { compareMigrationText } from "./audit-migration-catalog.js";
import {
  calculateMigrationChecksum,
  validateKnownMigrationCatalog,
  type SchemaObjectDefinition,
} from "./migration-catalog.js";
import { createSkillAssignmentMigrationCatalog } from "./skill-assignment-migration-catalog.js";
import { withColumn } from "./student-identity-schema.js";

const CLOSED_BY_COLUMN = "closed_by TEXT REFERENCES marea_users(id) ON DELETE SET NULL";

/**
 * Schema 15 records which teacher ended a run. Runs closed by the student or by the server
 * itself keep it null, and every earlier row stays valid without a data rewrite.
 */
export function createRunClosureMigrationCatalog() {
  const base = createSkillAssignmentMigrationCatalog();
  const previous = base.reduce((_, migration) => migration);
  const schemaAfter: SchemaObjectDefinition[] = previous.schemaAfter
    .map((entry) =>
      entry.name === "marea_runs"
        ? withColumn(entry, "close_reason TEXT\n      ", CLOSED_BY_COLUMN)
        : entry,
    )
    .sort(
      (left, right) =>
        compareMigrationText(left.type, right.type) || compareMigrationText(left.name, right.name),
    );
  const migration = {
    name: "teacher_run_closure_actor",
    version: 15,
    schemaAfter,
    statements: [`ALTER TABLE marea_runs ADD COLUMN ${CLOSED_BY_COLUMN}`],
  };
  return validateKnownMigrationCatalog([
    ...base,
    { ...migration, checksum: calculateMigrationChecksum(migration) },
  ]);
}
