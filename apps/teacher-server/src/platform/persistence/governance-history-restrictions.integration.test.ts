import { beforeEach, afterEach, expect, it } from "vitest";
import {
  governanceFixture,
  seedGovernancePilot,
  seedGovernanceHistory,
} from "./governance-repository.fixture.js";
import type { GovernanceCommitContext } from "../../governance/authority.js";

let f: ReturnType<typeof governanceFixture>;
let administrator: GovernanceCommitContext;
beforeEach(() => {
  f = governanceFixture();
  administrator = seedGovernancePilot(f);
});
afterEach(() => {
  f.database.close();
});

it.each(["class:b", "class:unadopted"])(
  "protects foreign or unmapped historical identity in %s from local account-global edits",
  (historyClass) => {
    f.createAccount("center:a", "student:history", "student", "class:a");
    const account = f.activate("center:a", "student:history");
    if (historyClass === "class:unadopted")
      f.database.execute(
        "INSERT INTO marea_classes VALUES ('class:unadopted', 'legacy:history', 'History')",
      );
    seedGovernanceHistory(f, account.userId, historyClass);
    const projection = f.store.account(administrator, "center:a", account.userId);
    expect(projection.canManageAccount).toBe(false);
    expect(JSON.stringify(projection)).not.toContain(historyClass);
    const input = {
      context: administrator,
      centerId: "center:a",
      userId: account.userId,
      expectedVersion: account.version,
    };
    const before = f.database.readAll("SELECT * FROM marea_governance_audit");
    expect(() => f.accounts.commitRenameAccount({ ...input, displayName: "Denied" })).toThrow(
      expect.objectContaining({ code: "dashboard.forbidden" }),
    );
    expect(() => f.accounts.commitChangeAccountState({ ...input, state: "disabled" })).toThrow(
      expect.objectContaining({ code: "dashboard.forbidden" }),
    );
    expect(() => f.accounts.commitRevokeSessions(input)).toThrow(
      expect.objectContaining({ code: "dashboard.forbidden" }),
    );
    expect(f.database.readAll("SELECT * FROM marea_governance_audit")).toEqual(before);
    expect(
      f.accounts.commitRenameAccount({
        ...input,
        context: f.context(),
        displayName: "Operator reviewed",
      }).displayName,
    ).toBe("Operator reviewed");
  },
);
