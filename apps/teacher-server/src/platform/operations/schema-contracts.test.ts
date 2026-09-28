import { describe, expect, it } from "vitest";

import { Sha256DigestSchema } from "@marea/protocol";

import {
  AbsolutePathSchema,
  AuthorityCheckpointEvidenceSchema,
  AuthorityCheckpointSchema,
  AuthorityLineageSchema,
  BlockerCodeSchema,
  BlockerSchema,
  BootstrapContinuationSchema,
  BootstrapMarkerSchema,
  ContentCheckpointStateSchema,
  CreationGateResultSchema,
  DurableIntentSchema,
  GraphSchema,
  HandoffRetirementSchema,
  IndexCheckpointSchema,
  IndexCheckpointStateSchema,
  IndexGenerationSchema,
  IndexInspectionSchema,
  IndexStateSchema,
  ManifestSha256Schema,
  MarkerOnlyRetirementSchema,
  OperationErrorCodeSchema,
  OperationErrorSchema,
  PreviewArtifactSchema,
  PreparedDeletionSchema,
  ReconciliationReasonSchema,
  ReconciliationSchema,
  RestoredDatabaseIdentitySchema,
  RetentionConfirmationSchema,
  RetentionConfirmRequestSchema,
  RetentionPreviewRequestSchema,
  RootIdSchema,
  RootRetirementSchema,
  TargetRefSchema,
  TransferHandoffSchema,
  TransferStateSchema,
} from "./schemas.js";

const protocolHash = Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`);
const manifestHash = ManifestSha256Schema.parse("b".repeat(64));
const target = TargetRefSchema.parse({
  kind: "account",
  key: { userId: "user-1" },
  observed: { kind: "version", version: "v1" },
});
const targetTwo = TargetRefSchema.parse({
  kind: "account",
  key: { userId: "user-2" },
  observed: { kind: "version", version: "v1" },
});
const blocker = { code: "active" as const, target, detailCode: "active-reference" };
const artifactWithoutDigest = {
  format: "marea-retention-preview:1" as const,
  previewId: "preview-1",
  requestId: "request-1",
  authorityLineage: "lineage-1",
  installationId: "root-1",
  sourceDatabaseLineage: protocolHash,
  actorBinding: "exclusive-installation-owner" as const,
  policyRevision: "policy-1",
  expectedIndexGeneration: 1,
  targets: [target],
  graphDigest: protocolHash,
  counts: { rows: 1, files: 0, backups: 0 },
  bytes: { database: 1, files: 0, backups: 0 },
  blockers: [],
  createdAt: "2026-09-13T10:00:00Z",
  expiresAt: "2026-09-13T10:10:00Z",
};
const artifact = PreviewArtifactSchema.parse({
  ...artifactWithoutDigest,
  artifactDigest: protocolHash,
});
const checkpoint = {
  operationId: "operation-1",
  authorityLineage: "lineage-1",
  expectedIndexGeneration: 1,
  nextIndexGeneration: 2,
  targetCount: 1,
  artifactDigest: protocolHash,
  state: "prepared" as const,
};
const authorityCheckpoint = AuthorityCheckpointSchema.parse({
  authorityLineage: "lineage-1",
  rootId: "root-1",
  indexGeneration: 1,
  databaseLineage: protocolHash,
  bundleManifestDigest: manifestHash,
});

describe("OPERATIONS executable schema contracts", () => {
  it("enforces primitive limits and every blocker/graph/target shape", () => {
    expect(ManifestSha256Schema.parse("a".repeat(64))).toBe("a".repeat(64));
    for (const value of [
      "a".repeat(63),
      "a".repeat(65),
      `${"a".repeat(64)}x`,
      `x${"a".repeat(64)}`,
    ])
      expect(ManifestSha256Schema.safeParse(value).success).toBe(false);
    expect(IndexGenerationSchema.parse(0)).toBe(0);
    expect(IndexGenerationSchema.safeParse(-1).success).toBe(false);
    expect(IndexGenerationSchema.safeParse(1.5).success).toBe(false);
    expect(AbsolutePathSchema.parse("/private/root")).toBe("/private/root");
    expect(AbsolutePathSchema.parse("x".repeat(4_096))).toHaveLength(4_096);
    expect(AbsolutePathSchema.safeParse("").success).toBe(false);
    expect(AbsolutePathSchema.safeParse("x".repeat(4_097)).success).toBe(false);

    for (const code of [
      "active",
      "unknown",
      "protected",
      "unverifiable",
      "out-of-root",
      "shared-backup",
      "stale",
    ] as const) {
      expect(BlockerCodeSchema.parse(code)).toBe(code);
      expect(BlockerSchema.parse({ ...blocker, code })).toMatchObject({ code });
    }
    expect(BlockerSchema.parse({ ...blocker, target: null })).toMatchObject({ target: null });
    expect(GraphSchema.parse({ digest: protocolHash, nodes: [], blockers: [] })).toMatchObject({
      nodes: [],
    });
    expect(
      GraphSchema.parse({ digest: protocolHash, nodes: [target], blockers: [blocker] }),
    ).toMatchObject({ nodes: [target] });
    expect(
      PreparedDeletionSchema.parse({
        operationId: checkpoint.operationId,
        authorityLineage: checkpoint.authorityLineage,
        expectedIndexGeneration: checkpoint.expectedIndexGeneration,
        targets: [target, targetTwo],
        artifactDigest: checkpoint.artifactDigest,
      }),
    ).toMatchObject({ operationId: "operation-1" });
  });

  it("enforces checkpoint, reconciliation, and authority schemas", () => {
    for (const state of ["prepared", "committed", "failed", "uncertain"] as const) {
      const contentState = state === "committed" ? "pending" : "pending";
      const durableIntent = state === "committed" ? "committed" : "none";
      expect(IndexCheckpointStateSchema.parse(state)).toBe(state);
      expect(
        IndexCheckpointSchema.parse({ ...checkpoint, state, contentState, durableIntent }),
      ).toMatchObject({ state });
    }
    for (const contentState of ["pending", "in-progress", "complete"] as const)
      expect(ContentCheckpointStateSchema.parse(contentState)).toBe(contentState);
    for (const durableIntent of ["none", "committed"] as const)
      expect(DurableIntentSchema.parse(durableIntent)).toBe(durableIntent);
    expect(() => IndexCheckpointSchema.parse({ ...checkpoint, nextIndexGeneration: 1 })).toThrow(
      "next generation must advance",
    );
    expect(() => IndexCheckpointSchema.parse({ ...checkpoint, targetCount: 0 })).toThrow();
    expect(() =>
      IndexCheckpointSchema.parse({ ...checkpoint, durableIntent: "committed" }),
    ).toThrow();

    const reasons = [
      "none",
      "missing-authority",
      "lineage-conflict",
      "stale-generation",
      "tombstoned-identity",
      "pending-checkpoint",
      "unknown-ancestry",
    ] as const;
    for (const reasonCode of reasons) {
      expect(ReconciliationReasonSchema.parse(reasonCode)).toBe(reasonCode);
      expect(
        ReconciliationSchema.parse({
          state: "blocked",
          currentIndexGeneration: 1,
          checked: 0,
          tombstoned: [],
          reasonCode,
        }),
      ).toMatchObject({ reasonCode });
    }
    expect(
      ReconciliationSchema.parse({
        state: "verified",
        currentIndexGeneration: 1,
        checked: 1,
        tombstoned: [],
        reasonCode: "none",
      }),
    ).toMatchObject({ state: "verified" });
    const evidence = {
      ...authorityCheckpoint,
      checkpointDigest: protocolHash,
    };
    expect(AuthorityCheckpointEvidenceSchema.parse(evidence)).toMatchObject({ rootId: "root-1" });
    expect(AuthorityLineageSchema.parse("lineage-1")).toBe("lineage-1");
    expect(RootIdSchema.parse("root-1")).toBe("root-1");
    expect(
      RestoredDatabaseIdentitySchema.parse({
        rootId: "root-1",
        sourceAuthorityLineage: "lineage-1",
        sourceDatabaseLineage: protocolHash,
        sourceBundleManifestDigest: manifestHash,
        sourceIndexGeneration: 1,
        sourceCheckpointDigest: protocolHash,
        destinationAuthorityLineage: "lineage-1",
        destinationRootId: "root-2",
      }),
    ).toMatchObject({ destinationRootId: "root-2" });
  });

  it("enforces retention, index, transfer, bootstrap, and error contracts", () => {
    const secondTarget = targetTwo;
    const previewRequest = RetentionPreviewRequestSchema.parse({
      requestId: artifactWithoutDigest.requestId,
      previewId: artifactWithoutDigest.previewId,
      policyRevision: artifactWithoutDigest.policyRevision,
      authorityLineage: artifactWithoutDigest.authorityLineage,
      installationId: artifactWithoutDigest.installationId,
      sourceDatabaseLineage: artifactWithoutDigest.sourceDatabaseLineage,
      expectedIndexGeneration: artifactWithoutDigest.expectedIndexGeneration,
      targets: [target, secondTarget],
      createdAt: artifactWithoutDigest.createdAt,
      expiresAt: artifactWithoutDigest.expiresAt,
    });
    expect(previewRequest).toMatchObject({ requestId: "request-1" });
    expect(
      RetentionConfirmRequestSchema.parse({
        artifact,
        drainUntil: artifact.expiresAt,
        now: artifact.createdAt,
      }),
    ).toMatchObject({ artifact });
    const multiArtifact = PreviewArtifactSchema.parse({
      ...artifactWithoutDigest,
      targets: [target, secondTarget],
      artifactDigest: protocolHash,
    });
    expect(
      RetentionConfirmRequestSchema.parse({
        artifact: multiArtifact,
        drainUntil: multiArtifact.expiresAt,
        now: multiArtifact.createdAt,
      }),
    ).toMatchObject({ artifact: multiArtifact });
    for (const state of [
      "prepared",
      "index-committed",
      "content-complete",
      "applied",
      "uncertain",
    ] as const)
      expect(
        RetentionConfirmationSchema.parse({
          operationId: "operation-1",
          requestId: previewRequest.requestId,
          artifactDigest: protocolHash,
          state,
        }),
      ).toMatchObject({ state });
    expect(
      IndexInspectionSchema.parse({
        authorityLineage: "lineage-1",
        rootId: "root-1",
        databaseLineage: protocolHash,
        generation: 1,
        state: "active",
      }),
    ).toMatchObject({ pendingCheckpoint: null });
    for (const state of [
      "active",
      "transfer-prepared",
      "retired",
      "uncertain",
      "missing",
      "corrupt",
    ] as const)
      expect(IndexStateSchema.parse(state)).toBe(state);
    expect(CreationGateResultSchema.parse({ allowed: true })).toEqual({ allowed: true });
    for (const code of ["tombstoned", "missing-authority", "uncertain", "corrupt"] as const)
      expect(CreationGateResultSchema.parse({ allowed: false, code })).toMatchObject({ code });

    const handoff = {
      handoffId: "handoff-1",
      authorityLineage: "lineage-1",
      sourceRoot: "root-1",
      destinationRoot: "root-2",
      expectedIndexGeneration: 1,
      authorityCheckpointDigest: protocolHash,
      copiedFileDigest: protocolHash,
      destinationState: "inactive" as const,
      state: "prepared" as const,
    };
    for (const state of [
      "prepared",
      "copied",
      "source-retired",
      "destination-active",
      "aborted",
    ] as const)
      expect(TransferStateSchema.parse(state)).toBe(state);
    for (const destinationState of ["inactive", "blocked", "active"] as const)
      expect(TransferHandoffSchema.parse({ ...handoff, destinationState })).toMatchObject({
        destinationState,
      });
    expect(AuthorityCheckpointSchema.parse(authorityCheckpoint)).toMatchObject({
      indexGeneration: 1,
    });
    const marker = BootstrapMarkerSchema.parse({
      format: "marea-fresh-install:1",
      rootId: "root-2",
      authorityLineage: "lineage-1",
      releaseId: "release-1",
      canonicalRootDigest: protocolHash,
    });
    expect(
      MarkerOnlyRetirementSchema.parse({
        mode: "marker-only",
        marker,
        currentRootId: "root-2",
        currentAuthorityLineage: "lineage-1",
        currentReleaseId: "release-1",
      }),
    ).toMatchObject({ mode: "marker-only" });
    expect(
      HandoffRetirementSchema.parse({
        mode: "handoff",
        handoff,
        marker,
        currentRootId: "root-2",
        currentAuthorityLineage: "lineage-1",
        currentReleaseId: "release-1",
      }),
    ).toMatchObject({ mode: "handoff" });
    expect(
      RootRetirementSchema.parse({
        mode: "marker-only",
        marker,
        currentRootId: "root-2",
        currentAuthorityLineage: "lineage-1",
        currentReleaseId: "release-1",
      }),
    ).toMatchObject({ mode: "marker-only" });
    for (const missing of ["database", "index", "status"] as const)
      expect(
        BootstrapContinuationSchema.parse({
          action: "continue-bootstrap",
          marker,
          destinationRoot: "root-2",
          releaseId: "release-1",
          missing,
          expectedAuthorityLineage: "lineage-1",
        }),
      ).toMatchObject({ missing });
    for (const code of [
      "invalid-input",
      "limit",
      "path",
      "owner-busy",
      "host-live",
      "not-ready",
      "drain-expired",
      "unknown-target",
      "blocked-reference",
      "stale-preview",
      "uncertain",
      "missing",
      "corrupt",
      "stale-generation",
      "missing-authority",
      "invalid-manifest",
      "restore-isolation",
    ] as const) {
      expect(OperationErrorCodeSchema.parse(code)).toBe(code);
      expect(OperationErrorSchema.parse({ code, safeMessage: "safe" })).toMatchObject({ code });
    }
    expect(OperationErrorSchema.safeParse({ code: "invalid-input", safeMessage: "" }).success).toBe(
      false,
    );
    expect(
      OperationErrorSchema.safeParse({ code: "invalid-input", safeMessage: "x".repeat(257) })
        .success,
    ).toBe(false);
  });
});
