import type { SchemaObjectDefinition } from "./migration-catalog.js";

export function evaluationSchema(): readonly SchemaObjectDefinition[] {
  return [
    {
      name: "marea_evaluations",
      sql: `CREATE TABLE marea_evaluations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES marea_runs(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation > 0),
      action_owner TEXT NOT NULL,
      action_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      input_json TEXT NOT NULL CHECK (json_valid(input_json)),
      input_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'failed', 'draft', 'approved')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      worker_token TEXT,
      draft_json TEXT CHECK (draft_json IS NULL OR json_valid(draft_json)),
      failure_code TEXT,
      notice_id TEXT REFERENCES marea_teacher_notices(id),
      approved_at TEXT,
      review_owner TEXT,
      review_key TEXT,
      review_fingerprint TEXT,
      UNIQUE (run_id, generation),
      UNIQUE (action_owner, action_key)
    ) STRICT`,
      tableName: "marea_evaluations",
      type: "table",
    },
    {
      name: "marea_evaluations_queue",
      sql: `CREATE INDEX marea_evaluations_queue ON marea_evaluations (created_at, id) WHERE state = 'queued'`,
      tableName: "marea_evaluations",
      type: "index",
    },
  ];
}
