import { describe, expect, it } from "vitest";

import {
  GOVERNANCE_NOW,
  governanceFixture,
  seedGovernancePilot,
} from "../../persistence/governance-repository.fixture.js";
import { SqliteExternalIdentityRepository } from "../../persistence/sqlite-external-identity-repository.js";
import { withoutDeletionAuthority } from "../../persistence/identity-creation-guard.js";
import { externalIdentityAccountRows } from "./external-identity-retention.js";
import { inspectAccount } from "./retention-accounts.js";
import { deleteRetentionContent } from "./retention-content.js";

describe("external identity retention", () => {
  it("previews and deletes an external identity together with its account", () => {
    const f = governanceFixture(undefined, "student-identities");
    seedGovernancePilot(f);
    new SqliteExternalIdentityRepository(f.database, withoutDeletionAuthority()).provision({
      providerId: "org.example.idp",
      subject: "subject-1",
      email: "ana@school.test",
      displayName: "Ana",
      admittedClassIds: ["class:a"],
      newUserId: "user:ana",
      newLogin: "x-ana",
      version: "revision:1",
      now: GOVERNANCE_NOW,
    });
    expect(externalIdentityAccountRows(f.database).map(([name]) => name)).toEqual([
      "externalIdentities",
    ]);
    const inspection = inspectAccount(f.database, "user:ana", GOVERNANCE_NOW);
    if (inspection === undefined) throw new Error("Missing account.");
    expect(inspection.blockers).toEqual([]);
    expect(inspection.bytes).toBeGreaterThan(0);
    deleteRetentionContent(
      f.database,
      { runIds: [], snapshotIds: [], accountIds: ["user:ana"], backupNames: [] },
      inspection.rows,
    );
    expect(f.database.readOne("SELECT 1 FROM marea_external_identities")).toBeUndefined();
    expect(f.database.readOne("SELECT 1 FROM marea_users WHERE id = 'user:ana'")).toBeUndefined();
  });

  it("has nothing to retain before schema 12", () => {
    expect(externalIdentityAccountRows(governanceFixture().database)).toEqual([]);
  });
});
