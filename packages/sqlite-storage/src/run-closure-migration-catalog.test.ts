import { expect, it } from "vitest";

import { createRunClosureMigrationCatalog } from "./run-closure-migration-catalog.js";
import { createSkillAssignmentMigrationCatalog } from "./skill-assignment-migration-catalog.js";

it("appends the closing actor column without rewriting already published migrations", () => {
  const catalog = createRunClosureMigrationCatalog();
  const previous = createSkillAssignmentMigrationCatalog();
  expect(catalog).toHaveLength(15);
  expect(catalog.slice(0, 14)).toEqual(previous);
  expect(catalog[14]).toMatchObject({ version: 15, name: "teacher_run_closure_actor" });
  expect(catalog[14]?.statements).toEqual([
    "ALTER TABLE marea_runs ADD COLUMN closed_by TEXT REFERENCES marea_users(id) ON DELETE SET NULL",
  ]);
  const runs = catalog[14]?.schemaAfter.find((object) => object.name === "marea_runs");
  expect(runs?.sql).toContain("close_reason TEXT");
  expect(runs?.sql).toContain("closed_by TEXT REFERENCES marea_users(id) ON DELETE SET NULL");
  expect(catalog[14]?.schemaAfter).toHaveLength(previous[13]?.schemaAfter.length ?? -1);
  const after = catalog[14]?.schemaAfter ?? [];
  const before = previous[13]?.schemaAfter ?? [];
  expect(after.map((object) => [object.type, object.name])).toEqual(
    before.map((object) => [object.type, object.name]),
  );
  for (const [index, object] of after.entries()) {
    if (object.name === "marea_runs") expect(object).not.toEqual(before[index]);
    else expect(object).toEqual(before[index]);
  }
});
