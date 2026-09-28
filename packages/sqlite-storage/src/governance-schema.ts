import type { SchemaObjectDefinition } from "./migration-catalog.js";

/** Additive GOVERNANCE governance storage; migration creates these tables empty. */
export function governanceSchema(): readonly SchemaObjectDefinition[] {
  return [
    {
      name: "marea_centers",
      sql: `CREATE TABLE marea_centers (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,
      tableName: "marea_centers",
      type: "table",
    },
    {
      name: "marea_governance_accounts",
      sql: `CREATE TABLE marea_governance_accounts (
        user_id TEXT PRIMARY KEY REFERENCES marea_users(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
        owner_center_id TEXT NOT NULL REFERENCES marea_centers(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
        state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'disabled')),
        version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT`,
      tableName: "marea_governance_accounts",
      type: "table",
    },
    {
      name: "marea_center_memberships",
      sql: `CREATE TABLE marea_center_memberships (
        center_id TEXT NOT NULL REFERENCES marea_centers(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
        user_id TEXT NOT NULL REFERENCES marea_governance_accounts(user_id) ON DELETE NO ACTION ON UPDATE NO ACTION,
        capability TEXT NOT NULL CHECK (capability IN ('member', 'administrator')),
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (center_id, user_id)
      ) STRICT`,
      tableName: "marea_center_memberships",
      type: "table",
    },
    {
      name: "marea_governance_classes",
      sql: `CREATE TABLE marea_governance_classes (
        class_id TEXT PRIMARY KEY REFERENCES marea_classes(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
        center_id TEXT NOT NULL REFERENCES marea_centers(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
        version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (class_id, center_id)
      ) STRICT`,
      tableName: "marea_governance_classes",
      type: "table",
    },
    {
      name: "marea_governance_memberships",
      sql: `CREATE TABLE marea_governance_memberships (
        class_id TEXT NOT NULL,
        center_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
        state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
        version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (class_id, user_id),
        FOREIGN KEY (class_id, center_id)
          REFERENCES marea_governance_classes(class_id, center_id)
          ON DELETE NO ACTION ON UPDATE NO ACTION,
        FOREIGN KEY (center_id, user_id)
          REFERENCES marea_center_memberships(center_id, user_id)
          ON DELETE NO ACTION ON UPDATE NO ACTION
      ) STRICT`,
      tableName: "marea_governance_memberships",
      type: "table",
    },
    {
      name: "marea_class_exchange_previews",
      sql: `CREATE TABLE marea_class_exchange_previews (
        id TEXT PRIMARY KEY,
        center_id TEXT NOT NULL,
        class_id TEXT NOT NULL,
        authority TEXT NOT NULL CHECK (authority IN ('operator', 'administrator')),
        user_id TEXT REFERENCES marea_governance_accounts(user_id) ON DELETE NO ACTION ON UPDATE NO ACTION,
        session_id TEXT REFERENCES marea_auth_sessions(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
        expected_teaching_version TEXT,
        expected_class_version TEXT NOT NULL,
        operator_fingerprint TEXT NOT NULL,
        package_digest TEXT NOT NULL,
        package_json TEXT,
        settings_json TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'consumed', 'cancelled', 'expired')),
        result_revision_id TEXT REFERENCES marea_class_teaching_revisions(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
        FOREIGN KEY (class_id, center_id)
          REFERENCES marea_governance_classes(class_id, center_id)
          ON DELETE NO ACTION ON UPDATE NO ACTION,
        CHECK (expires_at > created_at),
        CHECK (package_json IS NULL OR json_valid(package_json)),
        CHECK (settings_json IS NULL OR json_valid(settings_json)),
        CHECK (
          (authority = 'administrator' AND user_id IS NOT NULL AND session_id IS NOT NULL)
          OR (authority = 'operator' AND user_id IS NULL AND session_id IS NULL)
        ),
        CHECK (
          (state = 'pending' AND package_json IS NOT NULL AND settings_json IS NOT NULL AND result_revision_id IS NULL)
          OR (state = 'consumed' AND package_json IS NULL AND settings_json IS NULL AND result_revision_id IS NOT NULL)
          OR (state IN ('cancelled', 'expired') AND package_json IS NULL AND settings_json IS NULL AND result_revision_id IS NULL)
        )
      ) STRICT`,
      tableName: "marea_class_exchange_previews",
      type: "table",
    },
    {
      name: "marea_governance_audit",
      sql: `CREATE TABLE marea_governance_audit (
        sequence INTEGER PRIMARY KEY,
        request_id TEXT NOT NULL,
        actor_user_id TEXT REFERENCES marea_users(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
        authority TEXT NOT NULL CHECK (authority IN ('operator', 'administrator')),
        center_id TEXT NOT NULL REFERENCES marea_centers(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
        operation TEXT NOT NULL,
        target_id TEXT NOT NULL,
        result_version TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        CHECK (
          (authority = 'administrator' AND actor_user_id IS NOT NULL)
          OR (authority = 'operator' AND actor_user_id IS NULL)
        )
      ) STRICT`,
      tableName: "marea_governance_audit",
      type: "table",
    },
    {
      name: "marea_center_memberships_user",
      sql: "CREATE INDEX marea_center_memberships_user ON marea_center_memberships (user_id, center_id)",
      tableName: "marea_center_memberships",
      type: "index",
    },
    {
      name: "marea_governance_classes_center",
      sql: "CREATE INDEX marea_governance_classes_center ON marea_governance_classes (center_id, class_id)",
      tableName: "marea_governance_classes",
      type: "index",
    },
    {
      name: "marea_governance_memberships_user",
      sql: "CREATE INDEX marea_governance_memberships_user ON marea_governance_memberships (user_id, state, class_id)",
      tableName: "marea_governance_memberships",
      type: "index",
    },
    {
      name: "marea_governance_one_student_class",
      sql: "CREATE UNIQUE INDEX marea_governance_one_student_class ON marea_governance_memberships (user_id) WHERE role = 'student' AND state = 'active'",
      tableName: "marea_governance_memberships",
      type: "index",
    },
    {
      name: "marea_class_exchange_previews_session",
      sql: "CREATE INDEX marea_class_exchange_previews_session ON marea_class_exchange_previews (session_id, state, expires_at, id)",
      tableName: "marea_class_exchange_previews",
      type: "index",
    },
    {
      name: "marea_governance_audit_center",
      sql: "CREATE INDEX marea_governance_audit_center ON marea_governance_audit (center_id, sequence)",
      tableName: "marea_governance_audit",
      type: "index",
    },
  ] as const satisfies readonly SchemaObjectDefinition[];
}
