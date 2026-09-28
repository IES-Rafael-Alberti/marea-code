import { describe, expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("../retention/retention-bun-sqlite.fixture.js"));

import { NOW, retentionHarness } from "../retention/retention.fixture.js";
import { createSqliteCreationGate } from "../storage/sqlite-deletion-index.js";
import { createAccountCreationGuard } from "./account-creation-guard.js";

describe("account creation guard", () => {
  it("refuses deleted accounts and every account while a deletion is unsettled", async () => {
    const h = retentionHarness();
    const gate = createSqliteCreationGate(h.indexDatabase, h.configuration);
    const guard = createAccountCreationGuard(gate);
    expect(guard.accountCreatable("student:one")).toBe(true);

    const artifact = await h.service.preview(h.request([h.observe("account", "student:one")]));
    expect(await h.service.confirm({ artifact, now: NOW, drainUntil: NOW })).toMatchObject({
      state: "applied",
    });
    expect(guard.accountCreatable("student:one")).toBe(false);
    expect(guard.accountCreatable("student:new")).toBe(true);
    for (const target of artifact.targets)
      expect(gate.check(target)).toEqual(await h.index.assertCreatable(target));

    await h.index.prepare({
      operationId: "operation:pending",
      authorityLineage: h.configuration.authorityLineage,
      expectedIndexGeneration: 1,
      targets: [h.observe("run", "run:other")],
      artifactDigest: h.configuration.databaseLineage,
    });
    expect(guard.accountCreatable("student:new")).toBe(false);
    expect(gate.check(h.observe("run", "run:other"))).toEqual({
      allowed: false,
      code: "uncertain",
    });
  });
});
