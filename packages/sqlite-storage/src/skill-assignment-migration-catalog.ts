import { extendMigrationCatalog } from "./extend-migration-catalog.js";
import { createObservabilityMigrationCatalog } from "./observability-migration-catalog.js";
import { type SchemaObjectDefinition } from "./migration-catalog.js";

const objects: readonly SchemaObjectDefinition[] = [
  {
    name: "marea_student_skill_assignments",
    sql: `CREATE TABLE marea_student_skill_assignments (
    class_id TEXT NOT NULL REFERENCES marea_classes(id) ON DELETE CASCADE,
    student_id TEXT NOT NULL REFERENCES marea_users(id) ON DELETE CASCADE,
    revision TEXT NOT NULL,
    skills_json TEXT NOT NULL CHECK (json_valid(skills_json)),
    updated_by TEXT REFERENCES marea_users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (class_id, student_id)
  ) STRICT`,
    tableName: "marea_student_skill_assignments",
    type: "table",
  },
];

/** Missing row inherits; an empty array explicitly selects no didactic skills. */
export function createSkillAssignmentMigrationCatalog() {
  return extendMigrationCatalog(
    createObservabilityMigrationCatalog(),
    14,
    "individual_didactic_skill_assignments",
    objects,
  );
}
