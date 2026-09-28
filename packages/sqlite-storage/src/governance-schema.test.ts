import { describe, expect, it } from "vitest";

import { governanceSchema } from "./governance-schema.js";

describe("GOVERNANCE governance schema definition", () => {
  it("declares the complete additive schema-7 object set", () => {
    const schema = governanceSchema();
    expect(schema.filter(({ type }) => type === "table").map(({ name }) => name)).toEqual([
      "marea_centers",
      "marea_governance_accounts",
      "marea_center_memberships",
      "marea_governance_classes",
      "marea_governance_memberships",
      "marea_class_exchange_previews",
      "marea_governance_audit",
    ]);
    expect(schema.filter(({ type }) => type === "index").map(({ name }) => name)).toEqual([
      "marea_center_memberships_user",
      "marea_governance_classes_center",
      "marea_governance_memberships_user",
      "marea_governance_one_student_class",
      "marea_class_exchange_previews_session",
      "marea_governance_audit_center",
    ]);
  });

  it("encodes strict, no-action, empty-on-migration and lifecycle invariants", () => {
    const schema = governanceSchema();
    const tables = schema.filter(({ type }) => type === "table");
    expect(tables.every(({ sql }) => sql.endsWith("STRICT"))).toBe(true);
    expect(
      tables
        .filter(({ sql }) => sql.includes("REFERENCES"))
        .every(({ sql }) => sql.includes("ON DELETE NO ACTION ON UPDATE NO ACTION")),
    ).toBe(true);
    const previews = schema.find(({ name }) => name === "marea_class_exchange_previews");
    expect(previews?.sql).toContain("state = 'pending' AND package_json IS NOT NULL");
    expect(previews?.sql).toContain("state = 'consumed' AND package_json IS NULL");
    expect(previews?.sql).toContain("authority = 'administrator' AND user_id IS NOT NULL");
    expect(previews?.sql).toContain("authority = 'operator' AND user_id IS NULL");
    const studentIndex = schema.find(({ name }) => name === "marea_governance_one_student_class");
    expect(studentIndex?.sql).toContain("UNIQUE INDEX");
    expect(studentIndex?.sql).toContain("role = 'student' AND state = 'active'");
  });
});
