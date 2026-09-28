import type { SchemaObjectDefinition } from "./migration-catalog.js";
import { usageSchema } from "./usage-schema.js";
export function educationalSchema(): readonly SchemaObjectDefinition[] {
  const definitions: Record<string, string> = {
    marea_learning_settings: `class_id TEXT PRIMARY KEY REFERENCES marea_classes(id) ON DELETE CASCADE, revision TEXT NOT NULL, value_json TEXT NOT NULL`,
    marea_learning_progress: `class_id TEXT NOT NULL REFERENCES marea_classes(id) ON DELETE CASCADE, student_id TEXT NOT NULL REFERENCES marea_users(id) ON DELETE CASCADE, criterion_key TEXT NOT NULL, definition_json TEXT NOT NULL, level INTEGER NOT NULL CHECK(level BETWEEN 0 AND 4), epoch INTEGER NOT NULL, revision TEXT NOT NULL, memory TEXT NOT NULL DEFAULT '', memory_run_id TEXT REFERENCES marea_runs(id) ON DELETE SET NULL, PRIMARY KEY(class_id, student_id, criterion_key)`,
    marea_learning_history: `id INTEGER PRIMARY KEY, class_id TEXT NOT NULL REFERENCES marea_classes(id) ON DELETE CASCADE, student_id TEXT NOT NULL REFERENCES marea_users(id) ON DELETE CASCADE, criterion_key TEXT NOT NULL, run_id TEXT REFERENCES marea_runs(id) ON DELETE CASCADE, previous_level INTEGER NOT NULL, level INTEGER NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id, criterion_key)`,
    marea_class_reports: `id TEXT PRIMARY KEY, class_id TEXT NOT NULL REFERENCES marea_classes(id) ON DELETE CASCADE, owner_id TEXT NOT NULL REFERENCES marea_users(id) ON DELETE CASCADE, request_id TEXT NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT, completed INTEGER NOT NULL DEFAULT 0, error TEXT, UNIQUE(owner_id, request_id)`,
    marea_class_report_sources: `report_id TEXT NOT NULL REFERENCES marea_class_reports(id) ON DELETE CASCADE, run_id TEXT NOT NULL REFERENCES marea_runs(id) ON DELETE CASCADE, PRIMARY KEY(report_id, run_id)`,
  };
  return [
    ...Object.entries(definitions).map(([name, columns]) => ({
      name,
      tableName: name,
      type: "table" as const,
      sql: `CREATE TABLE ${name} (${columns}) STRICT`,
    })),
    {
      name: "marea_class_report_source_deleted",
      tableName: "marea_class_report_sources",
      type: "trigger",
      sql: `CREATE TRIGGER marea_class_report_source_deleted BEFORE DELETE ON marea_class_report_sources BEGIN UPDATE marea_class_reports SET state = 'invalidated', input_json = '{}', result_json = NULL, error = 'evidence-deleted' WHERE id = OLD.report_id; END`,
    },
    {
      name: "marea_learning_memory_deleted",
      tableName: "marea_runs",
      type: "trigger",
      sql: `CREATE TRIGGER marea_learning_memory_deleted BEFORE DELETE ON marea_runs BEGIN UPDATE marea_learning_progress SET memory = '', memory_run_id = NULL WHERE memory_run_id = OLD.id; END`,
    },
    ...usageSchema().map((entry) => ({
      ...entry,
      name: entry.name.replace("marea_usage", "marea_educational_usage"),
      tableName: entry.tableName.replace("marea_usage", "marea_educational_usage"),
      sql: entry.sql
        .replaceAll("marea_usage", "marea_educational_usage")
        .replace(" REFERENCES marea_runs(id) ON DELETE CASCADE", ""),
    })),
  ];
}
