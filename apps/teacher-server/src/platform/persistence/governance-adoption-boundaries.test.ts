import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sha256DigestSchema } from "@marea/protocol";
import * as inventory from "./governance-adoption-inventory.js";
import { governanceFixture } from "./governance-repository.fixture.js";
import { withoutDeletionAuthority } from "./identity-creation-guard.js";
import { createSqliteGovernanceRepository } from "./sqlite-governance-repository.js";
import { GovernanceInventoryBudget } from "./governance-inventory-budget.js";

let f: ReturnType<typeof governanceFixture>;
beforeEach(() => {
  f = governanceFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  f.database.close();
});

it("rejects an inventory whose explicit center cannot be loaded", () => {
  expect(() =>
    inventory.adoptionInventory(f.database, {
      classes: [{ classId: "class:legacy", centerId: "center:missing" }],
      accounts: [],
      administrators: [],
    }),
  ).toThrow(expect.objectContaining({ code: "request.conflict" }));
});

it("hashes explicit center snapshots in binary ID order, independently of class mapping order", () => {
  f.createCenter("center:z");
  f.createCenter("center:a");
  f.database.executeScript(
    "INSERT INTO marea_classes VALUES ('class:a', 'seed:a', 'A'), ('class:z', 'seed:z', 'Z')",
  );
  const include = vi.spyOn(GovernanceInventoryBudget.prototype, "include");
  inventory.adoptionInventory(f.database, {
    classes: [
      { classId: "class:a", centerId: "center:z" },
      { classId: "class:z", centerId: "center:a" },
    ],
    accounts: [],
    administrators: [],
  });
  expect(include.mock.calls.slice(1, 3).map(([row]) => row)).toEqual([
    { id: "center:a", display_name: "Center", version: "revision:2" },
    { id: "center:z", display_name: "Center", version: "revision:1" },
  ]);
});

it("does not fabricate an assignment for a legacy student without a current class", () => {
  f.createCenter("center:a");
  f.database.execute(
    "INSERT INTO marea_users VALUES ('student:unassigned', 'unassigned', 'legacy-hash', 'student', 'Student', NULL)",
  );
  const result = inventory.adoptionInventory(f.database, {
    classes: [],
    accounts: [{ userId: "student:unassigned", ownerCenterId: "center:a" }],
    administrators: [],
  });
  expect(result.relationships).toEqual([]);
  expect(result.receipt).toMatchObject({ memberships: 0, missingClassIds: [], missingUserIds: [] });
});

it("fails closed on an inconsistent prepared inventory instead of writing an unmapped relationship", () => {
  const receipt = {
    digest: Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`),
    classes: 0,
    accounts: 0,
    memberships: 1,
    missingClassIds: [],
    missingUserIds: [],
  };
  vi.spyOn(inventory, "adoptionInventory").mockReturnValue({
    receipt,
    relationships: [{ classId: "class:unmapped", userId: "user:unmapped", role: "teacher" }],
  });
  const repository = createSqliteGovernanceRepository(
    f.database,
    () => false,
    withoutDeletionAuthority(),
  );
  expect(() =>
    repository.commitAdoption({
      context: f.operatorContext(),
      map: { classes: [], accounts: [], administrators: [] },
      expectedInventoryDigest: receipt.digest,
    }),
  ).toThrow(expect.objectContaining({ code: "request.conflict" }));
  expect(f.database.readAll("SELECT * FROM marea_governance_audit")).toEqual([]);
});
