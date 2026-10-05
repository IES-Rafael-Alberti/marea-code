import { expect, it } from "vitest";
import { AuditTestDatabase } from "./audit-test-support.fixture.js";
import { educationalSchema } from "./educational-schema.js";

it("accounts for educational reports without requiring a student run", () => {
  const database = new AuditTestDatabase();
  try {
    database.execute("PRAGMA foreign_keys = ON");
    database.execute("CREATE TABLE marea_runs (id TEXT PRIMARY KEY) STRICT");
    for (const entry of educationalSchema().filter((item) =>
      item.name.startsWith("marea_educational_usage"),
    )) {
      database.execute(entry.sql);
    }
    database.execute(
      "INSERT INTO marea_educational_usage_accounts (run_id, purpose, policy_json, created_at) VALUES ('report:class', 'evaluation', '{}', 'now')",
    );
    expect(database.readOne("SELECT run_id FROM marea_educational_usage_accounts")).toEqual({
      run_id: "report:class",
    });
  } finally {
    database.close();
  }
});
