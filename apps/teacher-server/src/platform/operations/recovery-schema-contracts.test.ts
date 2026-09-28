import { describe, expect, it } from "vitest";

import { parseRecoveryInput } from "./validators.js";
import { RecoveryInputSchema } from "./recovery-schemas.js";

const hash = `sha256:${"a".repeat(64)}`;
const marker = {
  format: "marea-fresh-install:1" as const,
  rootId: "root-1",
  authorityLineage: "lineage-1",
  releaseId: "release-1",
  canonicalRootDigest: hash,
};

describe("OPERATIONS executable recovery input schemas", () => {
  it("accepts every typed action and rejects extra or missing fields", () => {
    const actions = [
      { action: "inspect" as const },
      { action: "inspect" as const, operationId: "operation-1" },
      {
        action: "continue-exact" as const,
        operationId: "operation-1",
        authorityLineage: "lineage-1",
        expectedIndexGeneration: 1,
        artifactDigest: hash,
        drainUntil: "2026-09-13T10:15:00Z",
      },
      {
        action: "mark-failed" as const,
        operationId: "operation-1",
        authorityLineage: "lineage-1",
        expectedIndexGeneration: 1,
      },
      {
        action: "transfer-continue" as const,
        handoffId: "handoff-1",
        authorityLineage: "lineage-1",
        expectedIndexGeneration: 1,
        indexDigest: hash,
        sourceRoot: "/private/source",
        destinationRoot: "/private/destination",
      },
      {
        action: "retire-root" as const,
        mode: "marker-only" as const,
        marker,
        currentRootId: "root-1",
        currentAuthorityLineage: "lineage-1",
        currentReleaseId: "release-1",
      },
      {
        action: "retire-root" as const,
        mode: "handoff" as const,
        handoff: {
          handoffId: "handoff-1",
          authorityLineage: "lineage-1",
          sourceRoot: "root-1",
          destinationRoot: "root-2",
          expectedIndexGeneration: 1,
          authorityCheckpointDigest: hash,
          copiedFileDigest: hash,
          destinationState: "inactive" as const,
          state: "prepared" as const,
        },
        marker: { ...marker, rootId: "root-2" },
        currentRootId: "root-2",
        currentAuthorityLineage: "lineage-1",
        currentReleaseId: "release-1",
      },
      {
        action: "continue-bootstrap" as const,
        marker,
        destinationRoot: "root-1",
        releaseId: "release-1",
        missing: "database" as const,
        expectedAuthorityLineage: "lineage-1",
      },
    ];
    for (const action of actions) {
      expect(RecoveryInputSchema.parse(action)).toMatchObject({ action: action.action });
      expect(parseRecoveryInput(new TextEncoder().encode(JSON.stringify(action)))).toMatchObject({
        action: action.action,
      });
    }
    expect(RecoveryInputSchema.safeParse({ action: "inspect", extra: true }).success).toBe(false);
    expect(
      RecoveryInputSchema.safeParse({ action: "mark-failed", operationId: "operation-1" }).success,
    ).toBe(false);
    expect(RecoveryInputSchema.safeParse({ action: "destroy" }).success).toBe(false);
  });
});
