import { describe, expect, it } from "vitest";
import { Sha256DigestSchema } from "@marea/protocol";

import {
  authorityCheckpointDigest,
  canRetireRoot,
  copiedFileDigest,
  transitionTransfer,
} from "./authority.js";
import {
  AuthorityCheckpointSchema,
  AuthorityLineageSchema,
  BootstrapMarkerSchema,
  ManifestSha256Schema,
  RootIdSchema,
  TransferHandoffSchema,
  type TransferHandoff,
} from "./schemas.js";

const databaseDigest = Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`);
const manifestDigest = ManifestSha256Schema.parse("b".repeat(64));
const sourceCheckpoint = AuthorityCheckpointSchema.parse({
  authorityLineage: "lineage-1",
  rootId: "root-1",
  indexGeneration: 4,
  databaseLineage: databaseDigest,
  bundleManifestDigest: manifestDigest,
});
const sourceCheckpointDigest = authorityCheckpointDigest(sourceCheckpoint);
const copiedDigest = copiedFileDigest(new TextEncoder().encode("sqlite"));
const baseHandoff = TransferHandoffSchema.parse({
  handoffId: "handoff-1",
  authorityLineage: sourceCheckpoint.authorityLineage,
  sourceRoot: sourceCheckpoint.rootId,
  destinationRoot: "root-2",
  expectedIndexGeneration: sourceCheckpoint.indexGeneration,
  authorityCheckpointDigest: sourceCheckpointDigest,
  authorityCheckpoint: sourceCheckpoint,
  copiedFileDigest: copiedDigest,
  destinationState: "inactive",
  state: "copied",
});
const retirementEvidence: NonNullable<TransferHandoff["sourceRetirementEvidence"]> = {
  handoffId: baseHandoff.handoffId,
  authorityLineage: baseHandoff.authorityLineage,
  rootId: baseHandoff.sourceRoot,
  indexGeneration: baseHandoff.expectedIndexGeneration,
  databaseLineage: sourceCheckpoint.databaseLineage,
  bundleManifestDigest: sourceCheckpoint.bundleManifestDigest,
  checkpointDigest: sourceCheckpointDigest,
  copiedFileDigest: baseHandoff.copiedFileDigest,
  state: "retired",
};
const marker = BootstrapMarkerSchema.parse({
  format: "marea-fresh-install:1",
  rootId: "root-2",
  authorityLineage: "lineage-1",
  releaseId: "release-1",
  canonicalRootDigest: databaseDigest,
});

function retirementInput(handoff: TransferHandoff, retirementMarker = marker) {
  return {
    mode: "handoff" as const,
    handoff,
    marker: retirementMarker,
    currentRootId: "root-2",
    currentAuthorityLineage: "lineage-1",
    currentReleaseId: "release-1",
  };
}

describe("OPERATIONS transfer retirement entry guards", () => {
  it("rejects a self-transfer at both retirement entry points with valid evidence", () => {
    const sameRootCheckpoint = { ...sourceCheckpoint, rootId: RootIdSchema.parse("root-2") };
    const sameRootDigest = authorityCheckpointDigest(sameRootCheckpoint);
    const sameRootHandoff = {
      ...baseHandoff,
      sourceRoot: RootIdSchema.parse("root-2"),
      authorityCheckpoint: sameRootCheckpoint,
      authorityCheckpointDigest: sameRootDigest,
    };
    const sameRootEvidence = {
      ...retirementEvidence,
      rootId: RootIdSchema.parse("root-2"),
      checkpointDigest: sameRootDigest,
    };
    expect(
      transitionTransfer(sameRootHandoff, {
        type: "source-retired",
        evidence: sameRootEvidence,
      }),
    ).toMatchObject({ accepted: false, state: "copied", reason: "invalid-state" });
    expect(
      canRetireRoot(
        retirementInput({
          ...sameRootHandoff,
          state: "source-retired",
          sourceRetirementEvidence: sameRootEvidence,
        }),
      ),
    ).toBe(false);
  });

  it("rejects blocked or inconsistent destination states while preserving valid pairs", () => {
    for (const destinationState of ["blocked", "active"] as const)
      expect(
        transitionTransfer(
          { ...baseHandoff, destinationState },
          { type: "source-retired", evidence: retirementEvidence },
        ),
      ).toMatchObject({ accepted: false, state: "copied", reason: "invalid-state" });

    expect(
      canRetireRoot(
        retirementInput({
          ...baseHandoff,
          state: "source-retired",
          sourceRetirementEvidence: retirementEvidence,
        }),
      ),
    ).toBe(true);
    expect(
      canRetireRoot(
        retirementInput({
          ...baseHandoff,
          destinationRoot: RootIdSchema.parse("root-3"),
          state: "source-retired",
          sourceRetirementEvidence: retirementEvidence,
        }),
      ),
    ).toBe(false);
    for (const retirementMarker of [
      { ...marker, rootId: RootIdSchema.parse("root-3") },
      { ...marker, authorityLineage: AuthorityLineageSchema.parse("lineage-2") },
      { ...marker, releaseId: "release-2" },
    ])
      expect(
        canRetireRoot(
          retirementInput(
            {
              ...baseHandoff,
              state: "source-retired",
              sourceRetirementEvidence: retirementEvidence,
            },
            retirementMarker,
          ),
        ),
      ).toBe(false);
    expect(canRetireRoot(retirementInput({ ...baseHandoff, state: "source-retired" }))).toBe(false);
    const foreignCheckpoint = {
      ...sourceCheckpoint,
      authorityLineage: AuthorityLineageSchema.parse("lineage-2"),
    };
    const foreignDigest = authorityCheckpointDigest(foreignCheckpoint);
    expect(
      canRetireRoot(
        retirementInput({
          ...baseHandoff,
          authorityLineage: foreignCheckpoint.authorityLineage,
          authorityCheckpoint: foreignCheckpoint,
          authorityCheckpointDigest: foreignDigest,
          state: "source-retired",
          sourceRetirementEvidence: {
            ...retirementEvidence,
            authorityLineage: foreignCheckpoint.authorityLineage,
            checkpointDigest: foreignDigest,
          },
        }),
      ),
    ).toBe(false);
    expect(
      canRetireRoot(
        retirementInput({
          ...baseHandoff,
          state: "destination-active",
          destinationState: "active",
          sourceRetirementEvidence: retirementEvidence,
        }),
      ),
    ).toBe(true);

    for (const [state, destinationState] of [
      ["source-retired", "blocked"],
      ["source-retired", "active"],
      ["destination-active", "inactive"],
      ["destination-active", "blocked"],
    ] as const)
      expect(
        canRetireRoot(
          retirementInput({
            ...baseHandoff,
            state,
            destinationState,
            sourceRetirementEvidence: retirementEvidence,
          }),
        ),
      ).toBe(false);
  });
});
