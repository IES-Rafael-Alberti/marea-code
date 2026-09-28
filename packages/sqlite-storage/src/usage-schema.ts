import type { SchemaObjectDefinition } from "./migration-catalog.js";

export function usageSchema(): readonly SchemaObjectDefinition[] {
  return [
    {
      name: "marea_usage_accounts",
      sql: `CREATE TABLE marea_usage_accounts (
        run_id TEXT NOT NULL REFERENCES marea_runs(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (purpose IN ('tutoring', 'evaluation')),
        policy_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, purpose)
      ) WITHOUT ROWID, STRICT`,
      tableName: "marea_usage_accounts",
      type: "table",
    },
    {
      name: "marea_usage_attempts",
      sql: `CREATE TABLE marea_usage_attempts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        request_id TEXT NOT NULL,
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'unknown', 'breached')),
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        cost_units INTEGER NOT NULL CHECK (cost_units >= 0),
        created_at TEXT NOT NULL,
        settled_at TEXT,
        FOREIGN KEY (run_id, purpose) REFERENCES marea_usage_accounts(run_id, purpose) ON DELETE CASCADE,
        UNIQUE (run_id, purpose, request_id, attempt)
      ) STRICT`,
      tableName: "marea_usage_attempts",
      type: "table",
    },
    {
      name: "marea_usage_tool_calls",
      sql: `CREATE TABLE marea_usage_tool_calls (
        reservation_id TEXT NOT NULL REFERENCES marea_usage_attempts(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL,
        PRIMARY KEY (reservation_id, call_id)
      ) WITHOUT ROWID, STRICT`,
      tableName: "marea_usage_tool_calls",
      type: "table",
    },
    {
      name: "marea_usage_attempts_account",
      sql: `CREATE INDEX marea_usage_attempts_account
        ON marea_usage_attempts (run_id, purpose, state)`,
      tableName: "marea_usage_attempts",
      type: "index",
    },
  ];
}
