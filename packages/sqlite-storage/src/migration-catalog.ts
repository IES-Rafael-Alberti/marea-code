import { createHash } from "node:crypto";

import { SqliteStorageError } from "./contracts.js";
import { teachingSchema } from "./teaching-schema.js";
import { noticeSchema } from "./notice-schema.js";
import { usageSchema } from "./usage-schema.js";
import { evaluationSchema } from "./evaluation-schema.js";
import { governanceSchema } from "./governance-schema.js";
import { teachingAuthorshipMigration } from "./teaching-authorship-schema.js";

export interface MigrationDefinition {
  readonly checksum: string;
  readonly name: string;
  readonly schemaAfter: readonly SchemaObjectDefinition[];
  readonly statements: readonly string[];
  readonly version: number;
}

export interface SchemaObjectDefinition {
  readonly name: string;
  readonly sql: string;
  readonly tableName: string;
  readonly type: "index" | "table" | "trigger" | "view";
}

export function calculateMigrationChecksum(
  migration: Pick<MigrationDefinition, "name" | "schemaAfter" | "statements" | "version">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        migration.version,
        migration.name,
        migration.statements,
        migration.schemaAfter,
      ]),
    )
    .digest("hex");
}

function invalidMigration(): never {
  throw new SqliteStorageError("migration-invalid", "The migration catalog is invalid.");
}

function validateStatement(statement: string): void {
  const transactionPattern = /\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/iu;
  const userVersionPattern = /\buser_version\b/iu;
  const trimmed = statement.trim();
  // SQLite trigger bodies are one statement despite their required delimiter.
  const trigger =
    /^CREATE TRIGGER [a-z_]+ BEFORE DELETE ON [a-z_]+ BEGIN (UPDATE [\s\S]+); END$/u.exec(trimmed);
  if (trigger?.[1] !== undefined) {
    validateStatement(trigger[1]);
    return;
  }
  if (
    trimmed.length === 0 ||
    trimmed.includes(";") ||
    transactionPattern.test(trimmed) ||
    userVersionPattern.test(trimmed)
  ) {
    invalidMigration();
  }
}

export function validateKnownMigrationCatalog(
  migrations: readonly MigrationDefinition[],
): readonly MigrationDefinition[] {
  if (migrations.length === 0) {
    invalidMigration();
  }

  const migrationNames = new Set<string>();
  const migrationNamePattern = /^[a-z\d]+(?:_[a-z\d]+)*$/u;
  for (const [index, migration] of migrations.entries()) {
    validateMigration(migration, index + 1, migrationNames, migrationNamePattern);
  }

  return Object.freeze(
    migrations.map((migration) =>
      Object.freeze({
        ...migration,
        schemaAfter: Object.freeze(
          migration.schemaAfter.map((schemaObject) => Object.freeze({ ...schemaObject })),
        ),
        statements: Object.freeze([...migration.statements]),
      }),
    ),
  );
}

function validateMigration(
  migration: MigrationDefinition,
  expectedVersion: number,
  migrationNames: Set<string>,
  migrationNamePattern: RegExp,
): void {
  if (
    migration.version !== expectedVersion ||
    !Number.isSafeInteger(migration.version) ||
    typeof migration.name !== "string" ||
    migration.name.length > 64 ||
    !migrationNamePattern.test(migration.name) ||
    migration.schemaAfter.length === 0 ||
    migration.statements.length === 0 ||
    migrationNames.has(migration.name)
  ) {
    invalidMigration();
  }
  migrationNames.add(migration.name);
  for (const statement of migration.statements) {
    if (typeof statement !== "string") {
      invalidMigration();
    }
    validateStatement(statement);
  }
  validateSchemaObjects(migration.schemaAfter);
  if (calculateMigrationChecksum(migration) !== migration.checksum) {
    invalidMigration();
  }
}

function validateSchemaObjects(schema: readonly SchemaObjectDefinition[]): void {
  const schemaNames = new Set<string>();
  for (const schemaObject of schema) {
    if (
      typeof schemaObject.name !== "string" ||
      schemaObject.name.length === 0 ||
      typeof schemaObject.sql !== "string" ||
      schemaObject.sql.length === 0 ||
      typeof schemaObject.tableName !== "string" ||
      schemaObject.tableName.length === 0 ||
      !isSchemaType(schemaObject.type) ||
      schemaNames.has(schemaObject.name)
    ) {
      invalidMigration();
    }
    schemaNames.add(schemaObject.name);
  }
}

function isSchemaType(value: string): value is SchemaObjectDefinition["type"] {
  return value === "index" || value === "table" || value === "trigger" || value === "view";
}

export function migrationLedgerSql(): string {
  return `CREATE TABLE IF NOT EXISTS marea_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL
  ) STRICT`;
}

function teacherServerSchema(): readonly SchemaObjectDefinition[] {
  const objects = [
    {
      name: "marea_active_runs_activity",
      sql: "CREATE INDEX marea_active_runs_activity ON marea_active_runs (last_activity_at DESC, run_id DESC)",
      tableName: "marea_active_runs",
      type: "index",
    },
    {
      name: "marea_auth_sessions_token",
      sql: "CREATE UNIQUE INDEX marea_auth_sessions_token ON marea_auth_sessions (token_hash)",
      tableName: "marea_auth_sessions",
      type: "index",
    },
    {
      name: "marea_run_events_sequence",
      sql: "CREATE UNIQUE INDEX marea_run_events_sequence ON marea_run_events (run_id, sequence)",
      tableName: "marea_run_events",
      type: "index",
    },
    {
      name: "marea_run_leases_token",
      sql: "CREATE UNIQUE INDEX marea_run_leases_token ON marea_run_leases (token_hash)",
      tableName: "marea_run_leases",
      type: "index",
    },
    {
      name: "marea_runs_student_state",
      sql: "CREATE INDEX marea_runs_student_state ON marea_runs (student_id, state, opened_at DESC)",
      tableName: "marea_runs",
      type: "index",
    },
    {
      name: "marea_active_runs",
      sql: `CREATE TABLE marea_active_runs (
        run_id TEXT PRIMARY KEY REFERENCES marea_runs(id) ON DELETE CASCADE,
        student_id TEXT NOT NULL REFERENCES marea_users(id),
        class_id TEXT NOT NULL REFERENCES marea_classes(id),
        project_display_name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        highest_durable_sequence INTEGER NOT NULL CHECK (highest_durable_sequence >= 0),
        pending_approval INTEGER NOT NULL CHECK (pending_approval IN (0, 1))
      ) STRICT`,
      tableName: "marea_active_runs",
      type: "table",
    },
    {
      name: "marea_auth_sessions",
      sql: `CREATE TABLE marea_auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES marea_users(id),
        token_hash TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT`,
      tableName: "marea_auth_sessions",
      type: "table",
    },
    {
      name: "marea_bootstrap_markers",
      sql: `CREATE TABLE marea_bootstrap_markers (
        seed_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      ) STRICT`,
      tableName: "marea_bootstrap_markers",
      type: "table",
    },
    {
      name: "marea_classes",
      sql: `CREATE TABLE marea_classes (
        id TEXT PRIMARY KEY,
        seed_key TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL
      ) STRICT`,
      tableName: "marea_classes",
      type: "table",
    },
    {
      name: "marea_invitations",
      sql: `CREATE TABLE marea_invitations (
        code_hash TEXT PRIMARY KEY,
        class_id TEXT NOT NULL REFERENCES marea_classes(id),
        consumed_at TEXT,
        consumed_by TEXT REFERENCES marea_users(id)
      ) STRICT`,
      tableName: "marea_invitations",
      type: "table",
    },
    {
      name: "marea_metadata",
      sql: `CREATE TABLE marea_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT`,
      tableName: "marea_metadata",
      type: "table",
    },
    {
      name: "marea_run_events",
      sql: `CREATE TABLE marea_run_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES marea_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        occurred_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      ) STRICT`,
      tableName: "marea_run_events",
      type: "table",
    },
    {
      name: "marea_run_leases",
      sql: `CREATE TABLE marea_run_leases (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES marea_runs(id) ON DELETE CASCADE,
        student_id TEXT NOT NULL REFERENCES marea_users(id),
        token_hash TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      ) STRICT`,
      tableName: "marea_run_leases",
      type: "table",
    },
    {
      name: "marea_run_open_requests",
      sql: `CREATE TABLE marea_run_open_requests (
        student_id TEXT NOT NULL REFERENCES marea_users(id),
        idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES marea_runs(id),
        PRIMARY KEY (student_id, idempotency_key)
      ) WITHOUT ROWID, STRICT`,
      tableName: "marea_run_open_requests",
      type: "table",
    },
    {
      name: "marea_run_snapshots",
      sql: `CREATE TABLE marea_run_snapshots (
        id TEXT PRIMARY KEY,
        public_snapshot_json TEXT NOT NULL,
        provider_route_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT`,
      tableName: "marea_run_snapshots",
      type: "table",
    },
    {
      name: "marea_runs",
      sql: `CREATE TABLE marea_runs (
        id TEXT PRIMARY KEY,
        student_id TEXT NOT NULL REFERENCES marea_users(id),
        class_id TEXT NOT NULL REFERENCES marea_classes(id),
        snapshot_id TEXT NOT NULL REFERENCES marea_run_snapshots(id),
        client_session_id TEXT NOT NULL,
        project_display_name TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'closed')),
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        close_reason TEXT
      ) STRICT`,
      tableName: "marea_runs",
      type: "table",
    },
    {
      name: "marea_schema_migrations",
      sql: migrationLedgerSql(),
      tableName: "marea_schema_migrations",
      type: "table",
    },
    {
      name: "marea_teacher_classes",
      sql: `CREATE TABLE marea_teacher_classes (
        teacher_id TEXT NOT NULL REFERENCES marea_users(id),
        class_id TEXT NOT NULL REFERENCES marea_classes(id),
        PRIMARY KEY (teacher_id, class_id)
      ) WITHOUT ROWID, STRICT`,
      tableName: "marea_teacher_classes",
      type: "table",
    },
    {
      name: "marea_users",
      sql: `CREATE TABLE marea_users (
        id TEXT PRIMARY KEY,
        login TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('student', 'teacher')),
        display_name TEXT NOT NULL,
        class_id TEXT REFERENCES marea_classes(id)
      ) STRICT`,
      tableName: "marea_users",
      type: "table",
    },
  ] as const satisfies readonly SchemaObjectDefinition[];
  return objects;
}

function compareSchemaText(left: string, right: string): number {
  if (left === right) return 0;
  // Stryker disable next-line EqualityOperator: Equality has already returned, so < and <= are equivalent here.
  return left < right ? -1 : 1;
}

export function createMigrationCatalog(): readonly MigrationDefinition[] {
  const metadataTableSql = `CREATE TABLE marea_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT`;
  const initialMigration = {
    checksum: "fbad05a3a1a844c8c04a9944a7cce8ff049a147b9090a5c1b7b7bc930ac7666a",
    name: "create_metadata",
    schemaAfter: [
      {
        name: "marea_metadata",
        sql: metadataTableSql,
        tableName: "marea_metadata",
        type: "table",
      },
      {
        name: "marea_schema_migrations",
        sql: migrationLedgerSql(),
        tableName: "marea_schema_migrations",
        type: "table",
      },
    ],
    statements: [metadataTableSql],
    version: 1,
  } as const satisfies MigrationDefinition;
  const schemaAfter = teacherServerSchema();
  const migrationObjects = schemaAfter.filter(
    ({ name }) => name !== "marea_metadata" && name !== "marea_schema_migrations",
  );
  const statements = [
    ...migrationObjects.filter(({ type }) => type === "table"),
    ...migrationObjects.filter(({ type }) => type === "index"),
  ].map(({ sql }) => sql);
  const teacherMigration = {
    name: "create_teacher_runtime",
    schemaAfter,
    statements,
    version: 2,
  };
  const teachingObjects = teachingSchema();
  const teachingMigration = {
    name: "create_teaching_snapshots",
    schemaAfter: [...schemaAfter, ...teachingObjects].sort(
      (left, right) =>
        compareSchemaText(left.type, right.type) || compareSchemaText(left.name, right.name),
    ),
    statements: teachingObjects.map(({ sql }) => sql),
    version: 3,
  };
  const noticeObjects = noticeSchema();
  const noticeMigration = {
    name: "create_teacher_notices",
    schemaAfter: [...teachingMigration.schemaAfter, ...noticeObjects].sort(
      (left, right) =>
        compareSchemaText(left.type, right.type) || compareSchemaText(left.name, right.name),
    ),
    statements: noticeObjects.map(({ sql }) => sql),
    version: 4,
  };
  const usageObjects = usageSchema();
  const usageMigration = {
    name: "create_usage_reservations",
    schemaAfter: [...noticeMigration.schemaAfter, ...usageObjects].sort(
      (left, right) =>
        compareSchemaText(left.type, right.type) || compareSchemaText(left.name, right.name),
    ),
    statements: usageObjects.map(({ sql }) => sql),
    version: 5,
  };
  const evaluationObjects = evaluationSchema();
  const evaluationMigration = {
    name: "create_evaluation_queue",
    schemaAfter: [...usageMigration.schemaAfter, ...evaluationObjects].sort(
      (left, right) =>
        compareSchemaText(left.type, right.type) || compareSchemaText(left.name, right.name),
    ),
    statements: evaluationObjects.map(({ sql }) => sql),
    version: 6,
  };
  const governanceObjects = governanceSchema();
  const governanceMigration = {
    name: "create_governance_schema",
    schemaAfter: [...evaluationMigration.schemaAfter, ...governanceObjects].sort(
      (left, right) =>
        compareSchemaText(left.type, right.type) || compareSchemaText(left.name, right.name),
    ),
    statements: [
      ...governanceObjects.filter(({ type }) => type === "table"),
      ...governanceObjects.filter(({ type }) => type === "index"),
    ].map(({ sql }) => sql),
    version: 7,
  };
  const authorshipMigration = teachingAuthorshipMigration(governanceMigration.schemaAfter);
  return validateKnownMigrationCatalog([
    initialMigration,
    {
      ...teacherMigration,
      checksum: calculateMigrationChecksum(teacherMigration),
    },
    {
      ...teachingMigration,
      checksum: calculateMigrationChecksum(teachingMigration),
    },
    {
      ...noticeMigration,
      checksum: calculateMigrationChecksum(noticeMigration),
    },
    {
      ...usageMigration,
      checksum: calculateMigrationChecksum(usageMigration),
    },
    {
      ...evaluationMigration,
      checksum: calculateMigrationChecksum(evaluationMigration),
    },
    {
      ...governanceMigration,
      checksum: calculateMigrationChecksum(governanceMigration),
    },
    {
      ...authorshipMigration,
      checksum: calculateMigrationChecksum(authorshipMigration),
    },
  ]);
}
