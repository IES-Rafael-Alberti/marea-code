import { expect, it } from "vitest";
import { createSkillAssignmentMigrationCatalog } from "./skill-assignment-migration-catalog.js";
import { createObservabilityMigrationCatalog } from "./observability-migration-catalog.js";
it("appends the assignment table without rewriting already published migration checksums", () => {
  const catalog = createSkillAssignmentMigrationCatalog();
  expect(catalog).toHaveLength(14);
  expect(catalog.slice(0, 13)).toEqual(createObservabilityMigrationCatalog());
  // Schema 13's checksum from the published source before extracting the shared extension helper.
  expect(catalog[12]?.checksum).toBe(
    "6562e0c8c4fe633a4222fb17106f3b258272196079b133f6d45e8dc70be03b67",
  );
  expect(catalog[13]).toMatchObject({ version: 14, name: "individual_didactic_skill_assignments" });
  expect(
    catalog[13]?.schemaAfter.some((object) => object.name === "marea_student_skill_assignments"),
  ).toBe(true);
});
