import { describe, expect, it } from "vitest";
import { Sha256DigestSchema } from "@marea/protocol";

import {
  AuthorityCheckpointSchema,
  BootstrapMarkerSchema,
  IndexInspectionSchema,
  IndexCheckpointSchema,
  AuthorityLineageSchema,
  ManifestSha256Schema,
  PreviewArtifactSchema,
  RestoredDatabaseIdentitySchema,
  RootIdSchema,
  TransferHandoffSchema,
  authorityCheckpointDigest,
  canRetireRoot,
  artifactDigest,
  canonicalJsonBytes,
  parseBoundedJson,
  copiedFileDigest,
  encodeArtifact,
  parseArtifact,
  reconcileRestoredTargets,
  assertCreatable,
  transitionTransfer,
  transitionCheckpoint,
  validateTransferPublication,
  validateTransferReadiness,
} from "./index.js";

const dbDigest = Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`);
const manifestDigest = ManifestSha256Schema.parse("b".repeat(64));
const source = AuthorityCheckpointSchema.parse({
  authorityLineage: "lineage-1",
  rootId: "root-1",
  indexGeneration: 4,
  databaseLineage: dbDigest,
  bundleManifestDigest: manifestDigest,
});
const target = {
  kind: "account" as const,
  key: { userId: "user-1" },
  observed: { kind: "version" as const, version: "v1" },
};

function handoff() {
  const bytes = new TextEncoder().encode("sqlite");
  return TransferHandoffSchema.parse({
    handoffId: "handoff-1",
    authorityLineage: source.authorityLineage,
    sourceRoot: source.rootId,
    destinationRoot: "root-2",
    expectedIndexGeneration: source.indexGeneration,
    authorityCheckpointDigest: authorityCheckpointDigest(source),
    authorityCheckpoint: source,
    copiedFileDigest: copiedFileDigest(bytes),
    destinationState: "inactive",
    state: "copied",
  });
}

describe("OPERATIONS source-proof hardening", () => {
  it("uses deterministic target-set ordering and exact artifact bytes", () => {
    const values = [
      target,
      { ...target, key: { userId: "user-2" } },
      {
        kind: "center" as const,
        key: { centerId: "center-1" },
        observed: { kind: "version" as const, version: "v1" },
      },
    ];
    const withoutDigest = PreviewArtifactSchema.omit({ artifactDigest: true }).parse({
      format: "marea-retention-preview:1",
      previewId: "preview-1",
      requestId: "request-1",
      authorityLineage: source.authorityLineage,
      installationId: "root-1",
      sourceDatabaseLineage: dbDigest,
      actorBinding: "exclusive-installation-owner",
      policyRevision: "policy-1",
      expectedIndexGeneration: 1,
      targets: values,
      graphDigest: dbDigest,
      counts: { rows: values.length, files: 0, backups: 0 },
      bytes: { database: 0, files: 0, backups: 0 },
      blockers: [],
      createdAt: "2026-09-13T10:00:00Z",
      expiresAt: "2026-09-13T10:10:00Z",
    });
    const artifact = PreviewArtifactSchema.parse({
      ...withoutDigest,
      artifactDigest: artifactDigest(withoutDigest),
    });
    const reversed = { ...artifact, targets: [...artifact.targets].reverse() };
    expect(encodeArtifact(reversed)).toEqual(encodeArtifact(artifact));
    expect(parseArtifact(encodeArtifact(artifact))).toEqual(artifact);
    class CustomValue {
      readonly value = 1;
    }
    expect(() => canonicalJsonBytes(new CustomValue())).toThrow("unsupported JSON object");
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(() => canonicalJsonBytes(sparse)).toThrow("sparse JSON array");
    expect(() => canonicalJsonBytes(sparse)).toThrow(
      expect.objectContaining({ code: "invalid-input" }),
    );
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.safe = true;
    expect(new TextDecoder().decode(canonicalJsonBytes(nullPrototype))).toBe('{"safe":true}');
    expect(() => canonicalJsonBytes(new Date())).toThrow(
      expect.objectContaining({ code: "invalid-input" }),
    );

    const deep: unknown[] = [];
    const deepCursor: unknown[] = deep;
    for (let index = 0; index < 10_001; index += 1) deepCursor.push(1);
    expect(() => parseBoundedJson(new TextEncoder().encode(JSON.stringify(deep)))).toThrow(
      expect.objectContaining({ code: "limit" }),
    );
  });

  it("binds old bundle manifest evidence while allowing a proven old generation", () => {
    const identity = RestoredDatabaseIdentitySchema.parse({
      rootId: source.rootId,
      sourceAuthorityLineage: source.authorityLineage,
      sourceDatabaseLineage: source.databaseLineage,
      sourceBundleManifestDigest: source.bundleManifestDigest,
      sourceIndexGeneration: source.indexGeneration,
      sourceCheckpointDigest: authorityCheckpointDigest(source),
      destinationAuthorityLineage: source.authorityLineage,
      destinationRootId: "root-2",
    });
    const authority = IndexInspectionSchema.parse({
      authorityLineage: source.authorityLineage,
      rootId: "root-2",
      databaseLineage: source.databaseLineage,
      generation: 5,
      state: "active",
    });
    expect(reconcileRestoredTargets(identity, authority, [target], [])).toMatchObject({
      state: "verified",
    });
    const pending = IndexCheckpointSchema.parse({
      operationId: "operation-1",
      authorityLineage: source.authorityLineage,
      expectedIndexGeneration: 5,
      nextIndexGeneration: 6,
      targetCount: 1,
      artifactDigest: dbDigest,
      state: "prepared",
    });
    expect(
      assertCreatable(target, { ...authority, pendingCheckpoint: pending }, [], false),
    ).toEqual({
      allowed: false,
      code: "uncertain",
    });
    expect(assertCreatable(target, authority, [], pending)).toEqual({
      allowed: false,
      code: "uncertain",
    });
    expect(
      reconcileRestoredTargets(
        { ...identity, sourceBundleManifestDigest: ManifestSha256Schema.parse("c".repeat(64)) },
        authority,
        [],
        [],
      ),
    ).toMatchObject({ state: "blocked", reasonCode: "unknown-ancestry" });
    expect(
      reconcileRestoredTargets({ ...identity, sourceIndexGeneration: null }, authority, [], []),
    ).toMatchObject({ state: "blocked", reasonCode: "unknown-ancestry" });
    expect(
      reconcileRestoredTargets(
        { ...identity, destinationRootId: RootIdSchema.parse("root-3") },
        authority,
        [],
        [],
      ),
    ).toMatchObject({ state: "blocked", reasonCode: "unknown-ancestry" });
  });

  it("requires inactive destinations and exact copy/retirement evidence", () => {
    const base = handoff();
    expect(validateTransferReadiness(base, new TextEncoder().encode("sqlite"))).toBe(true);
    expect(validateTransferReadiness({ ...base, destinationState: "blocked" })).toBe(false);
    expect(validateTransferReadiness(base, new TextEncoder().encode("tampered"))).toBe(false);
    const prepared = { ...base, state: "prepared" as const };
    expect(
      transitionTransfer(prepared, {
        type: "copy-complete",
        copiedBytes: new TextEncoder().encode("tampered"),
      }),
    ).toMatchObject({ accepted: false, reason: "invalid-evidence" });
    expect(
      transitionTransfer(prepared, {
        type: "copy-complete",
        copiedBytes: new TextEncoder().encode("sqlite"),
      }),
    ).toMatchObject({
      accepted: true,
      state: "copied",
    });
    const evidence = {
      ...source,
      handoffId: base.handoffId,
      copiedFileDigest: base.copiedFileDigest,
      checkpointDigest: base.authorityCheckpointDigest,
      state: "retired" as const,
    };
    const destinationCheckpoint = { ...source, rootId: RootIdSchema.parse(base.destinationRoot) };
    const published = {
      ...base,
      destinationState: "active" as const,
      state: "destination-active" as const,
      sourceRetirementEvidence: evidence,
      destinationCheckpoint,
    };
    expect(validateTransferPublication(published, new TextEncoder().encode("sqlite"))).toBe(true);
    const sameRootSource = { ...source, rootId: RootIdSchema.parse("root-2") };
    const sameRootDigest = authorityCheckpointDigest(sameRootSource);
    expect(
      validateTransferPublication({
        ...published,
        sourceRoot: RootIdSchema.parse("root-2"),
        destinationRoot: RootIdSchema.parse("root-2"),
        authorityCheckpoint: sameRootSource,
        authorityCheckpointDigest: sameRootDigest,
        sourceRetirementEvidence: {
          ...evidence,
          rootId: RootIdSchema.parse("root-2"),
          checkpointDigest: sameRootDigest,
        },
        destinationCheckpoint,
      }),
    ).toBe(false);
    for (const sourceMismatch of [
      { ...source, rootId: RootIdSchema.parse("root-3") },
      { ...source, authorityLineage: AuthorityLineageSchema.parse("lineage-2") },
      { ...source, indexGeneration: 5 },
    ]) {
      const mismatchDigest = authorityCheckpointDigest(sourceMismatch);
      expect(
        validateTransferPublication({
          ...published,
          authorityCheckpoint: sourceMismatch,
          authorityCheckpointDigest: mismatchDigest,
          sourceRetirementEvidence: { ...evidence, checkpointDigest: mismatchDigest },
          destinationCheckpoint,
        }),
      ).toBe(false);
    }
    expect(
      validateTransferPublication(
        {
          ...published,
          sourceRetirementEvidence: {
            ...evidence,
            databaseLineage: Sha256DigestSchema.parse(`sha256:${"c".repeat(64)}`),
          },
        },
        new TextEncoder().encode("sqlite"),
      ),
    ).toBe(false);
    expect(transitionTransfer(base, { type: "abort" })).toMatchObject({
      accepted: true,
      state: "aborted",
      destinationState: "blocked",
    });
    expect(transitionTransfer(base, { type: "source-retired", evidence })).toMatchObject({
      accepted: true,
      state: "source-retired",
    });
    const forgedCheckpointDigest = Sha256DigestSchema.parse(`sha256:${"c".repeat(64)}`);
    const forgedEvidence = { ...evidence, checkpointDigest: forgedCheckpointDigest };
    expect(
      transitionTransfer(base, { type: "source-retired", evidence: forgedEvidence }),
    ).toMatchObject({ accepted: false, reason: "invalid-evidence" });
    expect(
      transitionTransfer(base, {
        type: "source-retired",
        evidence: {
          ...evidence,
          databaseLineage: Sha256DigestSchema.parse(`sha256:${"c".repeat(64)}`),
        },
      }),
    ).toMatchObject({ accepted: false, reason: "invalid-evidence" });
    expect(
      transitionTransfer(
        { ...base, state: "source-retired", sourceRetirementEvidence: evidence },
        {
          type: "destination-activate",
          destinationCheckpoint,
        },
      ),
    ).toMatchObject({ accepted: true, state: "destination-active" });
    expect(
      transitionTransfer(
        { ...base, state: "source-retired", sourceRetirementEvidence: evidence },
        { type: "destination-activate", destinationCheckpoint: source },
      ),
    ).toMatchObject({ accepted: false, reason: "invalid-evidence" });
    expect(
      transitionTransfer(
        { ...base, state: "source-retired", sourceRetirementEvidence: evidence },
        {
          type: "destination-activate",
          destinationCheckpoint: { ...source, rootId: RootIdSchema.parse("root-3") },
        },
      ),
    ).toMatchObject({ accepted: false, reason: "invalid-evidence" });
    expect(
      transitionTransfer(base, { type: "destination-activate", destinationCheckpoint }),
    ).toMatchObject({ accepted: false, reason: "invalid-state" });
    expect(validateTransferPublication(published, new TextEncoder().encode("tampered"))).toBe(
      false,
    );
    const retirementMarker = BootstrapMarkerSchema.parse({
      format: "marea-fresh-install:1",
      rootId: "root-2",
      authorityLineage: "lineage-1",
      releaseId: "release-1",
      canonicalRootDigest: dbDigest,
    });
    expect(
      canRetireRoot({
        mode: "handoff",
        handoff: {
          ...base,
          authorityCheckpointDigest: forgedCheckpointDigest,
          state: "source-retired",
          sourceRetirementEvidence: forgedEvidence,
        },
        marker: retirementMarker,
        currentRootId: "root-2",
        currentAuthorityLineage: "lineage-1",
        currentReleaseId: "release-1",
      }),
    ).toBe(false);
    expect(
      canRetireRoot({
        mode: "handoff",
        handoff: {
          ...base,
          state: "destination-active",
          authorityCheckpoint: undefined,
          sourceRetirementEvidence: evidence,
        },
        marker: retirementMarker,
        currentRootId: "root-2",
        currentAuthorityLineage: "lineage-1",
        currentReleaseId: "release-1",
      }),
    ).toBe(false);
    expect(
      canRetireRoot({
        mode: "handoff",
        handoff: { ...base, state: "destination-active" },
        marker: retirementMarker,
        currentRootId: "root-2",
        currentAuthorityLineage: "lineage-1",
        currentReleaseId: "release-1",
      }),
    ).toBe(false);
    const foreignSource = {
      ...source,
      authorityLineage: AuthorityLineageSchema.parse("lineage-2"),
    };
    const foreignDigest = authorityCheckpointDigest(foreignSource);
    expect(
      canRetireRoot({
        mode: "handoff",
        handoff: {
          ...base,
          authorityLineage: "lineage-2",
          authorityCheckpoint: foreignSource,
          authorityCheckpointDigest: foreignDigest,
          state: "destination-active",
          sourceRetirementEvidence: {
            ...evidence,
            authorityLineage: "lineage-2",
            checkpointDigest: foreignDigest,
          },
        },
        marker: retirementMarker,
        currentRootId: "root-2",
        currentAuthorityLineage: "lineage-1",
        currentReleaseId: "release-1",
      }),
    ).toBe(false);
  });

  it("keeps marker-only retirement independent from transfer completion", () => {
    const marker = BootstrapMarkerSchema.parse({
      format: "marea-fresh-install:1",
      rootId: "root-2",
      authorityLineage: AuthorityLineageSchema.parse("lineage-1"),
      releaseId: "release-1",
      canonicalRootDigest: dbDigest,
    });
    expect(
      canRetireRoot({
        mode: "marker-only",
        marker,
        currentRootId: "root-2",
        currentAuthorityLineage: "lineage-1",
        currentReleaseId: "release-1",
      }),
    ).toBe(true);
    expect(
      canRetireRoot({
        mode: "marker-only",
        marker,
        currentRootId: "root-2",
        currentAuthorityLineage: "lineage-1",
        currentReleaseId: "release-2",
      }),
    ).toBe(false);
    for (const markerMismatch of [
      { ...marker, rootId: "root-1" },
      { ...marker, authorityLineage: "lineage-2" },
    ])
      expect(
        canRetireRoot({
          mode: "marker-only",
          marker: markerMismatch,
          currentRootId: "root-2",
          currentAuthorityLineage: "lineage-1",
          currentReleaseId: "release-1",
        }),
      ).toBe(false);
    expect(canRetireRoot({ mode: "invalid" })).toBe(false);
  });

  it("preserves durable deletion intent across every crash transition", () => {
    const checkpoint = {
      operationId: "operation-1",
      authorityLineage: source.authorityLineage,
      expectedIndexGeneration: 1,
      nextIndexGeneration: 2,
      targetCount: 1,
      artifactDigest: dbDigest,
      state: "prepared" as const,
      contentState: "pending" as const,
      durableIntent: "none" as const,
    };
    expect(
      transitionCheckpoint(checkpoint, { type: "mark-failed", committedTombstones: true }),
    ).toMatchObject({
      accepted: false,
      state: "uncertain",
      durableIntent: "none",
    });
    const committed = {
      ...checkpoint,
      state: "committed" as const,
      durableIntent: "committed" as const,
    };
    expect(transitionCheckpoint(committed, { type: "content-started" })).toMatchObject({
      accepted: true,
      canRemoveContent: true,
      contentState: "in-progress",
    });
    expect(
      transitionCheckpoint(
        { ...committed, contentState: "in-progress" },
        { type: "content-complete" },
      ),
    ).toMatchObject({
      accepted: true,
      durableIntent: "committed",
      contentState: "complete",
    });
    expect(
      transitionCheckpoint({ ...committed, state: "uncertain" }, { type: "mark-uncertain" }),
    ).toMatchObject({
      accepted: false,
      durableIntent: "committed",
    });
  });
});
