import { expect, it } from "vitest";
import { DatabaseFake } from "../../../test-support/database-fake.js";
import { GovernanceInventoryBudget } from "./governance-inventory-budget.js";
import { GovernanceResourceError } from "../../governance/errors.js";

it("bounds every inventory query, total relational rows and accumulated bytes", () => {
  const database = new DatabaseFake();
  const budget = new GovernanceInventoryBudget(database);
  const rows = Array.from({ length: 10000 }, () => ({ id: "synthetic" }));
  for (let index = 0; index < 10; index++) {
    database.allRows.push(rows);
    expect(budget.read("SELECT id FROM identities WHERE id = ?1", "synthetic")).toHaveLength(10000);
  }
  database.allRows.push([{ id: "extra" }]);
  expect(() => budget.read("SELECT id FROM identities WHERE id = ?1", "synthetic")).toThrow(
    GovernanceResourceError,
  );
  const next = new GovernanceInventoryBudget(database);
  database.allRows.push([...rows, { id: "extra" }]);
  expect(() => next.read("SELECT id FROM identities WHERE id = ?1", "synthetic")).toThrow(
    GovernanceResourceError,
  );
  const bytes = new GovernanceInventoryBudget(database);
  bytes.include("x".repeat(16_777_214));
  expect(() => {
    bytes.include(0);
  }).toThrow(GovernanceResourceError);
});
