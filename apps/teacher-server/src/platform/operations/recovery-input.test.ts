import { describe, expect, it } from "vitest";

import {
  MAX_INPUT_BYTES,
  OperationsBoundaryError,
  parseRecoveryInput,
  validateBootstrapContinuation,
} from "./index.js";
import { BootstrapMarkerSchema } from "./schemas.js";

const protocolHash = `sha256:${"a".repeat(64)}`;

function expectBoundary(
  operation: () => unknown,
  code: OperationsBoundaryError["code"],
  message: string,
): void {
  try {
    operation();
    throw new Error("expected boundary error");
  } catch (error) {
    expect(error).toMatchObject({
      name: "OperationsBoundaryError",
      code,
      message,
      safeMessage: message,
    });
  }
}

describe("OPERATIONS recovery input", () => {
  it("accepts typed exact actions and rejects unknown keys/arbitrary replay payloads", () => {
    const valid = parseRecoveryInput(
      new TextEncoder().encode(
        JSON.stringify({
          action: "continue-exact",
          operationId: "operation-1",
          authorityLineage: "lineage-1",
          expectedIndexGeneration: 1,
          artifactDigest: protocolHash,
          drainUntil: "2026-09-12T10:15:00Z",
        }),
      ),
    );
    expect(valid.action).toBe("continue-exact");
    const markerOnlyRetirement = parseRecoveryInput(
      new TextEncoder().encode(
        JSON.stringify({
          action: "retire-root",
          mode: "marker-only",
          marker: {
            format: "marea-fresh-install:1",
            rootId: "root-1",
            authorityLineage: "lineage-1",
            releaseId: "release-1",
            canonicalRootDigest: protocolHash,
          },
          currentRootId: "root-1",
          currentAuthorityLineage: "lineage-1",
          currentReleaseId: "release-1",
        }),
      ),
    );
    expect(markerOnlyRetirement).toMatchObject({ action: "retire-root", mode: "marker-only" });
    expect(
      parseRecoveryInput(new TextEncoder().encode(JSON.stringify({ action: "inspect" }))).action,
    ).toBe("inspect");
    expectBoundary(
      () =>
        parseRecoveryInput(
          new TextEncoder().encode(JSON.stringify({ action: "inspect", sql: "DELETE" })),
        ),
      "invalid-input",
      "recovery input is invalid",
    );
    expectBoundary(
      () =>
        parseRecoveryInput(
          new TextEncoder().encode(JSON.stringify({ action: "destroy", path: "/tmp" })),
        ),
      "invalid-input",
      "recovery input is invalid",
    );
    expectBoundary(
      () => parseRecoveryInput(new Uint8Array(MAX_INPUT_BYTES + 1)),
      "limit",
      "input byte limit exceeded",
    );

    const marker = BootstrapMarkerSchema.parse({
      format: "marea-fresh-install:1",
      rootId: "root-1",
      authorityLineage: "lineage-1",
      releaseId: "release-1",
      canonicalRootDigest: protocolHash,
    });
    const action = {
      action: "continue-bootstrap" as const,
      marker,
      destinationRoot: "root-1",
      releaseId: "release-1",
      missing: "index" as const,
      expectedAuthorityLineage: "lineage-1",
    };
    expect(validateBootstrapContinuation(action, marker)).toBe(true);
    expect(validateBootstrapContinuation({ ...action, destinationRoot: "root-2" }, marker)).toBe(
      false,
    );
    expect(
      validateBootstrapContinuation(
        { ...action, expectedAuthorityLineage: "other-lineage" },
        marker,
      ),
    ).toBe(false);
    expect(validateBootstrapContinuation({ ...action, releaseId: "release-2" }, marker)).toBe(
      false,
    );
    expect(
      validateBootstrapContinuation(
        { ...action, marker: { ...marker, canonicalRootDigest: `sha256:${"c".repeat(64)}` } },
        marker,
      ),
    ).toBe(false);
  });
});
