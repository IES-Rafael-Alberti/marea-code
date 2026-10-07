import { compareMigrationText } from "./audit-migration-catalog.js";
import { createStudentIdentityMigrationCatalog } from "./student-identity-migration-catalog.js";
import {
  calculateMigrationChecksum,
  validateKnownMigrationCatalog,
  type SchemaObjectDefinition,
} from "./migration-catalog.js";

/** Queue stores references, never a second copy of session content or credentials. */
const objects: readonly SchemaObjectDefinition[] = [
  {
    name: "marea_trace_progress",
    sql: `CREATE TABLE marea_trace_progress (
      run_id TEXT PRIMARY KEY REFERENCES marea_runs(id) ON DELETE CASCADE,
      through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0)
    ) STRICT`,
    tableName: "marea_trace_progress",
    type: "table",
  },
  {
    name: "marea_trace_outbox",
    sql: `CREATE TABLE marea_trace_outbox (
      run_id TEXT NOT NULL REFERENCES marea_runs(id) ON DELETE CASCADE,
      through_sequence INTEGER NOT NULL CHECK (through_sequence > 0),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_at TEXT NOT NULL,
      last_error TEXT,
      PRIMARY KEY (run_id, through_sequence)
    ) STRICT`,
    tableName: "marea_trace_outbox",
    type: "table",
  },
  {
    name: "marea_trace_state",
    sql: `CREATE TABLE marea_trace_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      epoch TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      dropped INTEGER NOT NULL DEFAULT 0,
      last_sent_at TEXT
    ) STRICT`,
    tableName: "marea_trace_state",
    type: "table",
  },
  {
    name: "marea_trace_terminal_events",
    sql: `CREATE INDEX marea_trace_terminal_events ON marea_run_events(run_id, sequence)
      WHERE event_type IN ('turn-ended', 'turn-failed')`,
    tableName: "marea_run_events",
    type: "index",
  },
];
export function createObservabilityMigrationCatalog() {
  const base = createStudentIdentityMigrationCatalog();
  const previous = base.reduce((_, migration) => migration);
  const migration = {
    name: "durable_session_trace_delivery",
    version: 13,
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
