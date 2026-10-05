import type { SchemaObjectDefinition } from "./migration-catalog.js";

const SESSION_CLASS_COLUMN = "class_id TEXT REFERENCES marea_classes(id)";
const MEMBERSHIP_PROVIDER_COLUMN = "external_provider TEXT";

const externalIdentities: SchemaObjectDefinition = {
  name: "marea_external_identities",
  sql: `CREATE TABLE marea_external_identities (
    provider_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL UNIQUE REFERENCES marea_users(id),
    email TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_login_at TEXT NOT NULL,
    PRIMARY KEY (provider_id, subject)
  ) STRICT`,
  tableName: "marea_external_identities",
  type: "table",
};

const admissionRules: SchemaObjectDefinition = {
  name: "marea_external_admission_rules",
  sql: `CREATE TABLE marea_external_admission_rules (
    class_id TEXT NOT NULL REFERENCES marea_governance_classes(class_id),
    provider_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES marea_users(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (class_id, provider_id, kind, value)
  ) STRICT`,
  tableName: "marea_external_admission_rules",
  type: "table",
};

/** SQLite stores an added column right after the last column definition of the table text. */
function withColumn(
  entry: SchemaObjectDefinition,
  lastColumn: string,
  column: string,
): SchemaObjectDefinition {
  return { ...entry, sql: entry.sql.replace(lastColumn, `${lastColumn}, ${column}`) };
}

/**
 * Schema 12: auth sessions name the class they act for, a student may hold several active
 * class memberships, and external identity providers may own accounts and memberships.
 * Live student sessions keep their current class, so no student is signed out by the upgrade.
 */
export function studentIdentityMigration(schema: readonly SchemaObjectDefinition[]) {
  const schemaAfter = [
    ...schema
      .filter(({ name }) => name !== "marea_governance_one_student_class")
      .map((entry) =>
        entry.name === "marea_auth_sessions"
          ? withColumn(entry, "revoked_at TEXT\n      ", SESSION_CLASS_COLUMN)
          : entry.name === "marea_governance_memberships"
            ? withColumn(entry, "updated_at TEXT NOT NULL", MEMBERSHIP_PROVIDER_COLUMN)
            : entry,
      ),
    externalIdentities,
    admissionRules,
  ];
  return {
    name: "student_classes_and_external_identities",
    version: 12,
    schemaAfter,
    statements: [
      `ALTER TABLE marea_auth_sessions ADD COLUMN ${SESSION_CLASS_COLUMN}`,
      `UPDATE marea_auth_sessions SET class_id = (SELECT users.class_id FROM marea_users users
        WHERE users.id = marea_auth_sessions.user_id AND users.role = 'student')`,
      "DROP INDEX marea_governance_one_student_class",
      `ALTER TABLE marea_governance_memberships ADD COLUMN ${MEMBERSHIP_PROVIDER_COLUMN}`,
      externalIdentities.sql,
      admissionRules.sql,
    ],
  };
}
