import { expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => ({ Database: vi.fn() }));

import { createAuditMigrationCatalog } from "./audit-migration-catalog.js";
import { createProfileMigrationCatalog } from "./profile-migration-catalog.js";
import { createRunClosureMigrationCatalog } from "./run-closure-migration-catalog.js";
import { createSkillAssignmentMigrationCatalog } from "./skill-assignment-migration-catalog.js";
import { currentSqliteSchema } from "./storage.js";

it("selects the longest release catalog as the current startup target", () => {
  const current = currentSqliteSchema();
  expect(current).toEqual({
    catalog: "run-closure",
    version: createRunClosureMigrationCatalog().length,
  });
  for (const shorter of [
    createAuditMigrationCatalog(),
    createProfileMigrationCatalog(),
    createSkillAssignmentMigrationCatalog(),
  ])
    expect(shorter.length).toBeLessThan(current.version);
});
