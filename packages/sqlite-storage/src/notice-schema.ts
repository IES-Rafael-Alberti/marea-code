import type { SchemaObjectDefinition } from "./migration-catalog.js";

export function noticeSchema(): readonly SchemaObjectDefinition[] {
  return [
    {
      name: "marea_teacher_notices",
      sql: `CREATE TABLE marea_teacher_notices (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES marea_runs(id) ON DELETE CASCADE,
        student_id TEXT NOT NULL REFERENCES marea_users(id),
        class_id TEXT NOT NULL REFERENCES marea_classes(id),
        teacher_id TEXT NOT NULL REFERENCES marea_users(id),
        teacher_display_name TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('teacher-message', 'approved-evaluation')),
        text TEXT NOT NULL CHECK (length(text) > 0),
        created_at TEXT NOT NULL,
        acknowledged_at TEXT,
        idempotency_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        UNIQUE (teacher_id, idempotency_key)
      ) STRICT`,
      tableName: "marea_teacher_notices",
      type: "table",
    },
    {
      name: "marea_pending_notices_idx",
      sql: `CREATE INDEX marea_pending_notices_idx
        ON marea_teacher_notices (student_id, created_at, id)
        WHERE acknowledged_at IS NULL`,
      tableName: "marea_teacher_notices",
      type: "index",
    },
  ];
}
