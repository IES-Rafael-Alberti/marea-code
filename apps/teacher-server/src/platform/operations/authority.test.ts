import { describe, expect, it } from "vitest";

import { Sha256DigestSchema } from "@marea/protocol";

import {
  authorityCheckpointDigest,
  canRetireRoot,
  copiedFileDigest,
  validateTransferPublication,
  validateTransferReadiness,
  transitionTransfer,
} from "./authority.js";
import {
  AuthorityCheckpointSchema,
  AuthorityLineageSchema,
  RootIdSchema,
  BootstrapMarkerSchema,
  ManifestSha256Schema,
  TransferHandoffSchema,
} from "./schemas.js";
import type { TransferHandoff } from "./schemas.js";

const protocolHash = Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`);
const alternateDigest = Sha256DigestSchema.parse(`sha256:${"c".repeat(64)}`);
const alternateLineage = AuthorityLineageSchema.parse("lineage-2");
const alternateRoot = RootIdSchema.parse("root-2");
const manifestDigest = ManifestSha256Schema.parse("b".repeat(64));

describe("OPERATIONS authority transfer", () => {
  it("keeps authority checkpoint digest independent from copied bytes and requires retirement before activation", () => {
    const sourceCheckpoint = AuthorityCheckpointSchema.parse({
      authorityLineage: "lineage-1",
      rootId: "root-1",
      indexGeneration: 4,
      databaseLineage: protocolHash,
      bundleManifestDigest: manifestDigest,
    });
    const checkpointDigest = authorityCheckpointDigest(sourceCheckpoint);
    const handoff = TransferHandoffSchema.parse({
      handoffId: "handoff-1",
      authorityLineage: "lineage-1",
      sourceRoot: "root-1",
      destinationRoot: "root-2",
      expectedIndexGeneration: 4,
      authorityCheckpointDigest: checkpointDigest,
      authorityCheckpoint: sourceCheckpoint,
      copiedFileDigest: copiedFileDigest(new TextEncoder().encode("sqlite")),
      destinationState: "inactive",
      state: "copied",
    });
    expect(validateTransferReadiness(handoff)).toBe(true);
    expect(validateTransferReadiness({ ...handoff, destinationState: "active" })).toBe(false);
    expect(validateTransferReadiness({ ...handoff, sourceRoot: alternateRoot })).toBe(false);
    expect(validateTransferReadiness({ ...handoff, state: "source-retired" })).toBe(false);
    expect(
      validateTransferReadiness({
        ...handoff,
        sourceRetirementEvidence: {
          handoffId: handoff.handoffId,
          authorityLineage: handoff.authorityLineage,
          rootId: handoff.sourceRoot,
          indexGeneration: handoff.expectedIndexGeneration,
          databaseLineage: protocolHash,
          bundleManifestDigest: manifestDigest,
          checkpointDigest,
          copiedFileDigest: handoff.copiedFileDigest,
          state: "retired",
        },
      }),
    ).toBe(false);
    expect(validateTransferReadiness({ ...handoff, authorityCheckpoint: undefined })).toBe(false);
    expect(
      validateTransferReadiness({
        ...handoff,
        authorityCheckpoint: { ...sourceCheckpoint, authorityLineage: alternateLineage },
      }),
    ).toBe(false);
    expect(
      validateTransferReadiness({
        ...handoff,
        authorityCheckpoint: { ...sourceCheckpoint, rootId: alternateRoot },
      }),
    ).toBe(false);
    expect(
      validateTransferReadiness({
        ...handoff,
        authorityCheckpoint: { ...sourceCheckpoint, indexGeneration: 5 },
      }),
    ).toBe(false);
    expect(
      validateTransferReadiness({
        ...handoff,
        authorityCheckpointDigest: alternateDigest,
      }),
    ).toBe(false);
    expect(
      validateTransferPublication({
        ...handoff,
        destinationState: "active",
        state: "destination-active",
      }),
    ).toBe(false);
    expect(validateTransferPublication(handoff)).toBe(false);
    const retirementEvidence = {
      handoffId: handoff.handoffId,
      authorityLineage: handoff.authorityLineage,
      rootId: handoff.sourceRoot,
      indexGeneration: handoff.expectedIndexGeneration,
      databaseLineage: protocolHash,
      bundleManifestDigest: manifestDigest,
      checkpointDigest,
      copiedFileDigest: handoff.copiedFileDigest,
      state: "retired" as const,
    } as NonNullable<TransferHandoff["sourceRetirementEvidence"]>;
    expect(
      validateTransferPublication({
        ...handoff,
        destinationState: "active",
        sourceRetirementEvidence: retirementEvidence,
        destinationCheckpoint: {
          ...sourceCheckpoint,
          rootId: RootIdSchema.parse("root-2"),
        },
        state: "destination-active",
      }),
    ).toBe(true);
    expect(
      validateTransferPublication({
        ...handoff,
        destinationState: "inactive",
        state: "destination-active",
        sourceRetirementEvidence: retirementEvidence,
        destinationCheckpoint: { ...sourceCheckpoint, rootId: alternateRoot },
      }),
    ).toBe(false);
    expect(validateTransferPublication({ ...handoff, destinationState: "active" })).toBe(false);
    expect(
      validateTransferPublication({
        ...handoff,
        destinationState: "active",
        state: "destination-active",
        sourceRetirementEvidence: { ...retirementEvidence, handoffId: "other-handoff" },
        destinationCheckpoint: { ...sourceCheckpoint, rootId: alternateRoot },
      }),
    ).toBe(false);
    expect(
      validateTransferPublication({
        ...handoff,
        destinationState: "active",
        state: "destination-active",
        sourceRetirementEvidence: { ...retirementEvidence, rootId: alternateRoot },
        destinationCheckpoint: { ...sourceCheckpoint, rootId: alternateRoot },
      }),
    ).toBe(false);
    expect(
      validateTransferPublication({
        ...handoff,
        destinationState: "active",
        state: "destination-active",
        sourceRetirementEvidence: { ...retirementEvidence, authorityLineage: alternateLineage },
        destinationCheckpoint: { ...sourceCheckpoint, rootId: alternateRoot },
      }),
    ).toBe(false);
    expect(
      validateTransferPublication({
        ...handoff,
        destinationState: "active",
        state: "destination-active",
        sourceRetirementEvidence: { ...retirementEvidence, indexGeneration: 5 },
        destinationCheckpoint: { ...sourceCheckpoint, rootId: alternateRoot },
      }),
    ).toBe(false);
    expect(
      validateTransferPublication({
        ...handoff,
        destinationState: "active",
        state: "destination-active",
        sourceRetirementEvidence: { ...retirementEvidence, checkpointDigest: alternateDigest },
        destinationCheckpoint: { ...sourceCheckpoint, rootId: alternateRoot },
      }),
    ).toBe(false);
    expect(
      validateTransferPublication({
        ...handoff,
        destinationState: "active",
        state: "destination-active",
        sourceRetirementEvidence: { ...retirementEvidence, copiedFileDigest: alternateDigest },
        destinationCheckpoint: { ...sourceCheckpoint, rootId: alternateRoot },
      }),
    ).toBe(false);
    expect(
      validateTransferPublication({
        ...handoff,
        destinationState: "active",
        state: "destination-active",
        sourceRetirementEvidence: retirementEvidence,
        destinationCheckpoint: undefined,
      }),
    ).toBe(false);
    expect(
      validateTransferPublication({
        ...handoff,
        destinationState: "active",
        state: "destination-active",
        sourceRetirementEvidence: retirementEvidence,
        destinationCheckpoint: {
          ...sourceCheckpoint,
          authorityLineage: alternateLineage,
          rootId: alternateRoot,
        },
      }),
    ).toBe(false);
    expect(
      validateTransferPublication({
        ...handoff,
        destinationState: "active",
        state: "destination-active",
        sourceRetirementEvidence: retirementEvidence,
        destinationCheckpoint: { ...sourceCheckpoint, indexGeneration: 5, rootId: alternateRoot },
      }),
    ).toBe(false);
    expect(
      validateTransferPublication({
        ...handoff,
        destinationState: "active",
        state: "destination-active",
        sourceRetirementEvidence: retirementEvidence,
        destinationCheckpoint: {
          ...sourceCheckpoint,
          databaseLineage: alternateDigest,
          rootId: alternateRoot,
        },
      }),
    ).toBe(false);
    expect(
      validateTransferPublication({
        ...handoff,
        destinationState: "active",
        state: "destination-active",
        authorityCheckpointDigest: alternateDigest,
        sourceRetirementEvidence: retirementEvidence,
        destinationCheckpoint: { ...sourceCheckpoint, rootId: alternateRoot },
      }),
    ).toBe(false);
    expect(
      validateTransferPublication({
        ...handoff,
        destinationState: "active",
        state: "destination-active",
        sourceRetirementEvidence: retirementEvidence,
        destinationCheckpoint: { ...sourceCheckpoint, rootId: RootIdSchema.parse("root-2") },
      }),
    ).toBe(true);
    expect(() =>
      TransferHandoffSchema.parse({ ...handoff, sourceRetirementRead: "verified" }),
    ).toThrow();
    expect(
      validateTransferPublication({
        ...handoff,
        destinationState: "active",
        state: "copied",
        sourceRetirementEvidence: retirementEvidence,
        destinationCheckpoint: { ...sourceCheckpoint, rootId: RootIdSchema.parse("root-2") },
      }),
    ).toBe(false);
    expect(validateTransferReadiness({ ...handoff, state: "destination-active" })).toBe(false);
    const sameRootCheckpoint = { ...sourceCheckpoint, rootId: alternateRoot };
    expect(
      validateTransferReadiness({
        ...handoff,
        sourceRoot: alternateRoot,
        destinationRoot: alternateRoot,
        authorityCheckpoint: sameRootCheckpoint,
        authorityCheckpointDigest: authorityCheckpointDigest(sameRootCheckpoint),
      }),
    ).toBe(false);
    const mismatchedGenerationCheckpoint = { ...sourceCheckpoint, indexGeneration: 5 };
    expect(
      validateTransferReadiness({
        ...handoff,
        authorityCheckpoint: mismatchedGenerationCheckpoint,
        authorityCheckpointDigest: authorityCheckpointDigest(mismatchedGenerationCheckpoint),
      }),
    ).toBe(false);

    const prepared = { ...handoff, state: "prepared" as const };
    expect(
      transitionTransfer(prepared, {
        type: "copy-complete",
        copiedBytes: new TextEncoder().encode("sqlite"),
      }),
    ).toEqual({
      accepted: true,
      state: "copied",
      destinationState: "inactive",
      reason: "accepted",
    });
    expect(transitionTransfer(handoff, { type: "copy-complete" })).toEqual({
      accepted: false,
      state: "copied",
      destinationState: "inactive",
      reason: "invalid-state",
    });
    expect(
      transitionTransfer(prepared, {
        type: "source-retired",
        evidence: retirementEvidence,
      }),
    ).toEqual({
      accepted: false,
      state: "prepared",
      destinationState: "inactive",
      reason: "invalid-state",
    });
    expect(transitionTransfer(handoff, { type: "abort" })).toEqual({
      accepted: true,
      state: "aborted",
      destinationState: "blocked",
      reason: "accepted",
    });
    expect(transitionTransfer(prepared, { type: "abort" })).toEqual({
      accepted: true,
      state: "aborted",
      destinationState: "blocked",
      reason: "accepted",
    });
    expect(
      transitionTransfer(handoff, {
        type: "source-retired",
        evidence: retirementEvidence,
      }),
    ).toEqual({
      accepted: true,
      state: "source-retired",
      destinationState: "inactive",
      reason: "accepted",
    });
    expect(
      transitionTransfer(
        { ...handoff, state: "source-retired", sourceRetirementEvidence: retirementEvidence },
        { type: "abort" },
      ),
    ).toEqual({
      accepted: false,
      state: "source-retired",
      destinationState: "inactive",
      reason: "invalid-state",
    });
    expect(
      transitionTransfer(
        { ...handoff, state: "source-retired", sourceRetirementEvidence: retirementEvidence },
        {
          type: "destination-activate",
          destinationCheckpoint: { ...sourceCheckpoint, rootId: alternateRoot },
        },
      ),
    ).toEqual({
      accepted: true,
      state: "destination-active",
      destinationState: "active",
      reason: "accepted",
    });
    expect(
      transitionTransfer(handoff, {
        type: "destination-activate",
        destinationCheckpoint: { ...sourceCheckpoint, rootId: alternateRoot },
      }),
    ).toEqual({
      accepted: false,
      state: "copied",
      destinationState: "inactive",
      reason: "invalid-state",
    });
    const marker = BootstrapMarkerSchema.parse({
      format: "marea-fresh-install:1",
      rootId: "root-2",
      authorityLineage: "lineage-1",
      releaseId: "release-1",
      canonicalRootDigest: protocolHash,
    });
    expect(
      canRetireRoot({
        mode: "handoff",
        handoff: {
          ...handoff,
          state: "source-retired",
          sourceRetirementEvidence: retirementEvidence,
        },
        marker,
        currentRootId: "root-2",
        currentAuthorityLineage: "lineage-1",
        currentReleaseId: "release-1",
      }),
    ).toBe(true);
    expect(
      canRetireRoot({
        mode: "handoff",
        handoff: { ...handoff, state: "copied", sourceRetirementEvidence: retirementEvidence },
        marker,
        currentRootId: "root-2",
        currentAuthorityLineage: "lineage-1",
        currentReleaseId: "release-1",
      }),
    ).toBe(false);
    expect(
      canRetireRoot({
        mode: "handoff",
        handoff: {
          ...handoff,
          state: "destination-active",
          destinationState: "active",
          sourceRetirementEvidence: retirementEvidence,
        },
        marker,
        currentRootId: "root-2",
        currentAuthorityLineage: "lineage-1",
        currentReleaseId: "release-1",
      }),
    ).toBe(true);
    for (const mismatch of [
      { marker: { ...marker, releaseId: "release-2" } },
      { marker: { ...marker, rootId: "root-1" } },
      { marker: { ...marker, authorityLineage: alternateLineage } },
      {
        handoff: {
          ...handoff,
          state: "destination-active",
          destinationRoot: "root-3",
          sourceRetirementEvidence: retirementEvidence,
        },
      },
      {
        handoff: {
          ...handoff,
          state: "destination-active",
          authorityLineage: alternateLineage,
          sourceRetirementEvidence: retirementEvidence,
        },
      },
    ]) {
      expect(
        canRetireRoot({
          mode: "handoff",
          handoff: {
            ...handoff,
            state: "destination-active",
            sourceRetirementEvidence: retirementEvidence,
            ...(mismatch.handoff ?? {}),
          },
          marker: mismatch.marker ?? marker,
          currentRootId: "root-2",
          currentAuthorityLineage: "lineage-1",
          currentReleaseId: "release-1",
        }),
      ).toBe(false);
    }
    expect(canRetireRoot({ mode: "invalid" })).toBe(false);
  });
});
