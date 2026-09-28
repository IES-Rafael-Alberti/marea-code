import { describe, expect, it } from "vitest";

import {
  MAX_CANONICAL_DEPTH,
  OperationsBoundaryError,
  PreviewArtifactSchema,
  RestoredDatabaseIdentitySchema,
  AuthorityCheckpointSchema,
  AuthorityLineageSchema,
  RootIdSchema,
  TransferHandoffSchema,
  IndexCheckpointSchema,
  IndexInspectionSchema,
  artifactDigest,
  authorityCheckpointDigest,
  canonicalJsonBytes,
  encodeArtifact,
  isDrainExpired,
  isPreviewExpired,
  parseArtifact,
  validateTransferPublication,
  validateTransferReadiness,
  type PreviewArtifact,
} from "./index.js";
import { TargetRefSchema } from "./schemas.js";
import {
  canonicalJsonBytes as directCanonicalJsonBytes,
  parseArtifact as directParseArtifact,
} from "./canonical-encoder.js";
import { reconcileRestoredTargets } from "./reconciliation.js";
import { assertCreatable, observationMatches, targetIdentity } from "./validators.js";
import { transitionCheckpoint } from "./checkpoint-transition.js";

const protocolHash = `sha256:${"a".repeat(64)}`;
const manifestHash = "b".repeat(64);
const target = {
  kind: "account" as const,
  key: { userId: "user-1" },
  observed: { kind: "version" as const, version: "v1" },
};

function makeArtifact(targets = [target]): PreviewArtifact {
  const value = {
    format: "marea-retention-preview:1" as const,
    previewId: "preview-1",
    requestId: "request-1",
    authorityLineage: "lineage-1",
    installationId: "root-1",
    sourceDatabaseLineage: protocolHash,
    actorBinding: "exclusive-installation-owner" as const,
    policyRevision: "policy-1",
    expectedIndexGeneration: 2,
    targets,
    graphDigest: protocolHash,
    counts: { rows: targets.length, files: 0, backups: 0 },
    bytes: { database: 0, files: 0, backups: 0 },
    blockers: [],
    createdAt: "2026-09-12T10:00:00Z",
    expiresAt: "2026-09-12T10:10:00Z",
  };
  const withoutDigest = PreviewArtifactSchema.omit({ artifactDigest: true }).parse(value);
  return PreviewArtifactSchema.parse({
    ...withoutDigest,
    artifactDigest: artifactDigest(withoutDigest),
  });
}

describe("OPERATIONS bounded repair matrix", () => {
  it("compares canonical bytes exactly and protects prototype keys", () => {
    const artifact = makeArtifact();
    const encoded = new TextDecoder().decode(encodeArtifact(artifact));
    const parsedObject = JSON.parse(encoded) as Record<string, unknown>;
    const changedOrder = JSON.stringify(Object.fromEntries(Object.entries(parsedObject).reverse()));
    expect(changedOrder.length).toBe(encoded.length);
    expect(() => parseArtifact(new TextEncoder().encode(changedOrder))).toThrow(
      OperationsBoundaryError,
    );
    const proto = canonicalJsonBytes(JSON.parse('{"__proto__":{"safe":true}}'));
    expect(new TextDecoder().decode(proto)).toContain('"__proto__"');
    const deep: unknown[] = [];
    let cursor: unknown[] = deep;
    for (let index = 0; index <= MAX_CANONICAL_DEPTH; index += 1) {
      const next: unknown[] = [];
      cursor.push(next);
      cursor = next;
    }
    expect(() => canonicalJsonBytes(deep)).toThrow(
      expect.objectContaining({ code: "limit", message: "canonical value depth limit exceeded" }),
    );
  });

  it("rejects duplicate targets, inconsistent observations, and invalid times", () => {
    const revisionTarget = {
      kind: "teaching-revision" as const,
      key: { revisionId: "revision-1" },
      observed: {
        kind: "revision" as const,
        revisionId: "revision-1",
        configurationDigest: protocolHash,
      },
    };
    const runTarget = {
      kind: "run" as const,
      key: { runId: "run-1" },
      observed: {
        kind: "run-snapshot" as const,
        runId: "run-1",
        snapshotId: "snapshot-1",
        snapshotDigest: protocolHash,
      },
    };
    const snapshotTarget = {
      kind: "snapshot" as const,
      key: { snapshotId: "snapshot-1" },
      observed: {
        kind: "snapshot" as const,
        snapshotId: "snapshot-1",
        snapshotDigest: protocolHash,
        teachingDigest: null,
      },
    };
    const skillTarget = {
      kind: "skill" as const,
      key: { skillId: "marea/skill-1" },
      observed: { kind: "skill" as const, skillId: "marea/skill-1", digest: protocolHash },
    };
    const backupTarget = {
      kind: "backup" as const,
      key: { manifestDigest: manifestHash },
      observed: {
        kind: "backup" as const,
        manifestDigest: manifestHash,
        databaseDigest: manifestHash,
      },
    };
    for (const value of [revisionTarget, runTarget, snapshotTarget, skillTarget, backupTarget]) {
      expect(TargetRefSchema.parse(value)).toEqual(value);
    }
    expect(() =>
      TargetRefSchema.parse({
        ...revisionTarget,
        observed: { ...revisionTarget.observed, revisionId: "other" },
      }),
    ).toThrow();
    expect(() =>
      TargetRefSchema.parse({ ...runTarget, observed: { ...runTarget.observed, runId: "other" } }),
    ).toThrow();
    expect(() =>
      TargetRefSchema.parse({
        ...snapshotTarget,
        observed: { ...snapshotTarget.observed, snapshotId: "other" },
      }),
    ).toThrow();
    try {
      TargetRefSchema.parse({
        ...skillTarget,
        observed: { ...skillTarget.observed, skillId: "marea/other" },
      });
      throw new Error("expected invalid skill observation");
    } catch (error) {
      expect(error).toMatchObject({
        issues: [{ code: "custom", message: "observation does not match target key" }],
      });
    }
    expect(() =>
      TargetRefSchema.parse({
        ...backupTarget,
        observed: { ...backupTarget.observed, manifestDigest: "c".repeat(64) },
      }),
    ).toThrow();
    expect(() => encodeArtifact(makeArtifact([target, target]))).toThrow(
      expect.objectContaining({ code: "invalid-input", message: "duplicate target identity" }),
    );
    const duplicateArtifact = makeArtifact([target, target]);
    expect(() => directParseArtifact(directCanonicalJsonBytes(duplicateArtifact))).toThrow(
      "duplicate target identity",
    );
    expect(() =>
      PreviewArtifactSchema.parse({
        ...makeArtifact(),
        targets: [{ ...target, observed: { kind: "version", version: "v2" } }],
      }),
    ).not.toThrow();
    expect(() =>
      PreviewArtifactSchema.parse({
        ...makeArtifact(),
        targets: [
          {
            kind: "teaching-revision",
            key: { revisionId: "revision-1" },
            observed: { kind: "revision", revisionId: "other", configurationDigest: protocolHash },
          },
        ],
      }),
    ).toThrow();
    const artifact = makeArtifact();
    expect(isPreviewExpired(artifact, "not-a-date")).toBe(true);
    expect(isPreviewExpired(artifact, "2026-09-12T09:59:59Z")).toBe(true);
    expect(isDrainExpired("not-a-date", artifact.createdAt)).toBe(true);
    expect(isDrainExpired("2026-09-12T10:15:00Z", artifact.createdAt)).toBe(false);
  });

  it("fails closed for unknown ancestry, future generations, and pending checkpoints", () => {
    const source = AuthorityCheckpointSchema.parse({
      authorityLineage: "lineage-1",
      rootId: "root-2",
      indexGeneration: 2,
      databaseLineage: protocolHash,
      bundleManifestDigest: manifestHash,
    });
    const identity = RestoredDatabaseIdentitySchema.parse({
      rootId: source.rootId,
      sourceAuthorityLineage: source.authorityLineage,
      sourceDatabaseLineage: source.databaseLineage,
      sourceBundleManifestDigest: manifestHash,
      sourceIndexGeneration: source.indexGeneration,
      sourceCheckpointDigest: authorityCheckpointDigest(source),
      destinationAuthorityLineage: "lineage-1",
      destinationRootId: "root-1",
    });
    const authority = IndexInspectionSchema.parse({
      authorityLineage: "lineage-1",
      rootId: "root-1",
      databaseLineage: protocolHash,
      generation: 4,
      state: "active",
    });
    expect(reconcileRestoredTargets(identity, authority, [target], [])).toEqual({
      state: "verified",
      currentIndexGeneration: authority.generation,
      checked: 1,
      tombstoned: [],
      reasonCode: "none",
    });
    expect(
      reconcileRestoredTargets(
        {
          ...identity,
          sourceIndexGeneration: authority.generation,
          sourceCheckpointDigest: authorityCheckpointDigest({
            ...source,
            indexGeneration: authority.generation,
          }),
        },
        authority,
        [],
        [],
      ),
    ).toMatchObject({ state: "verified" });
    expect(
      reconcileRestoredTargets(identity, { ...authority, state: "uncertain" }, [], []),
    ).toMatchObject({ state: "blocked", reasonCode: "missing-authority" });
    const pending = IndexCheckpointSchema.parse({
      operationId: "operation-1",
      authorityLineage: "lineage-1",
      expectedIndexGeneration: 4,
      nextIndexGeneration: 5,
      targetCount: 1,
      artifactDigest: protocolHash,
      state: "prepared",
    });
    const mismatchedDestination = {
      ...identity,
      destinationAuthorityLineage: AuthorityLineageSchema.parse("other-lineage"),
    };
    expect(reconcileRestoredTargets(mismatchedDestination, authority, [], [])).toEqual({
      state: "blocked",
      currentIndexGeneration: authority.generation,
      checked: 0,
      tombstoned: [],
      reasonCode: "lineage-conflict",
    });
    expect(
      reconcileRestoredTargets(
        {
          ...identity,
          sourceCheckpointDigest: protocolHash as typeof identity.sourceCheckpointDigest,
        },
        authority,
        [],
        [],
      ),
    ).toEqual({
      state: "blocked",
      currentIndexGeneration: authority.generation,
      checked: 0,
      tombstoned: [],
      reasonCode: "unknown-ancestry",
    });
    const differentDatabaseLineage =
      `sha256:${"c".repeat(64)}` as typeof identity.sourceDatabaseLineage;
    expect(
      reconcileRestoredTargets(
        {
          ...identity,
          sourceDatabaseLineage: differentDatabaseLineage,
          sourceCheckpointDigest: authorityCheckpointDigest({
            ...source,
            databaseLineage: differentDatabaseLineage,
          }),
        },
        authority,
        [],
        [],
      ),
    ).toMatchObject({ state: "blocked", reasonCode: "unknown-ancestry" });
    expect(
      reconcileRestoredTargets(
        {
          ...identity,
          sourceIndexGeneration: 5,
          sourceCheckpointDigest: authorityCheckpointDigest({ ...source, indexGeneration: 5 }),
        },
        authority,
        [],
        [],
      ),
    ).toEqual({
      state: "blocked",
      currentIndexGeneration: authority.generation,
      checked: 0,
      tombstoned: [],
      reasonCode: "stale-generation",
    });
    const creationPending = IndexCheckpointSchema.parse({
      operationId: "operation-1",
      authorityLineage: "lineage-1",
      expectedIndexGeneration: 4,
      nextIndexGeneration: 5,
      targetCount: 1,
      artifactDigest: protocolHash,
      state: "prepared",
    });
    expect(
      assertCreatable(target, { ...authority, pendingCheckpoint: creationPending }, []),
    ).toEqual({
      allowed: false,
      code: "uncertain",
    });
    expect(
      observationMatches(target, { ...target, observed: { kind: "version", version: "v2" } }),
    ).toBe(false);
    expect(reconcileRestoredTargets(identity, null, [], [])).toEqual({
      state: "blocked",
      currentIndexGeneration: 0,
      checked: 0,
      tombstoned: [],
      reasonCode: "missing-authority",
    });
    expect(
      reconcileRestoredTargets(identity, { ...authority, pendingCheckpoint: pending }, [], []),
    ).toEqual({
      state: "blocked",
      currentIndexGeneration: authority.generation,
      checked: 0,
      tombstoned: [],
      reasonCode: "pending-checkpoint",
    });
    expect(
      reconcileRestoredTargets(
        { ...identity, sourceAuthorityLineage: AuthorityLineageSchema.parse("other-lineage") },
        authority,
        [],
        [],
      ),
    ).toEqual({
      state: "blocked",
      currentIndexGeneration: authority.generation,
      checked: 0,
      tombstoned: [],
      reasonCode: "lineage-conflict",
    });
    expect(
      reconcileRestoredTargets(
        identity,
        authority,
        [target],
        [`${authority.authorityLineage}:${targetIdentity(target)}`],
      ),
    ).toEqual({
      state: "blocked",
      currentIndexGeneration: authority.generation,
      checked: 1,
      tombstoned: [target],
      reasonCode: "tombstoned-identity",
    });
  });

  it("binds transfer evidence and separates marker-only retirement", () => {
    const source = AuthorityCheckpointSchema.parse({
      authorityLineage: "lineage-1",
      rootId: "root-1",
      indexGeneration: 4,
      databaseLineage: protocolHash,
      bundleManifestDigest: manifestHash,
    });
    const checkpointDigest = authorityCheckpointDigest(source);
    const copiedDigest = protocolHash as PreviewArtifact["graphDigest"];
    const base = TransferHandoffSchema.parse({
      handoffId: "handoff-1",
      authorityLineage: "lineage-1",
      sourceRoot: "root-1",
      destinationRoot: "root-2",
      expectedIndexGeneration: 4,
      authorityCheckpointDigest: checkpointDigest,
      authorityCheckpoint: source,
      copiedFileDigest: copiedDigest,
      destinationState: "inactive" as const,
      state: "copied" as const,
    });
    expect(validateTransferReadiness(base)).toBe(true);
    expect(
      validateTransferReadiness({
        ...base,
        sourceRoot: RootIdSchema.parse("root-2"),
        destinationRoot: RootIdSchema.parse("root-2"),
      }),
    ).toBe(false);
    expect(validateTransferReadiness({ ...base, state: "aborted" })).toBe(false);
    const evidence = {
      ...source,
      handoffId: base.handoffId,
      copiedFileDigest: copiedDigest,
      checkpointDigest,
      state: "retired" as const,
    };
    const destinationCheckpoint = { ...source, rootId: RootIdSchema.parse("root-2") };
    expect(
      validateTransferPublication({
        ...base,
        destinationState: "active",
        state: "destination-active",
        sourceRetirementEvidence: evidence,
        destinationCheckpoint,
      }),
    ).toBe(true);
    expect(
      validateTransferPublication({
        ...base,
        destinationState: "active",
        state: "destination-active",
        sourceRetirementEvidence: { ...evidence, rootId: RootIdSchema.parse("wrong-root") },
        destinationCheckpoint,
      }),
    ).toBe(false);
    expect(validateTransferReadiness({ ...base, sourceRetirementEvidence: evidence })).toBe(false);
    expect(validateTransferReadiness({ ...base, authorityCheckpoint: undefined })).toBe(false);
    expect(
      validateTransferPublication({
        ...base,
        destinationState: "active",
        state: "destination-active",
        sourceRetirementEvidence: evidence,
        authorityCheckpoint: undefined,
        destinationCheckpoint,
      }),
    ).toBe(false);
  });

  it("makes deletion intent and content progress durable and non-abortable", () => {
    const checkpoint = IndexCheckpointSchema.parse({
      operationId: "operation-1",
      authorityLineage: "lineage-1",
      expectedIndexGeneration: 4,
      nextIndexGeneration: 5,
      targetCount: 1,
      artifactDigest: protocolHash,
      state: "prepared",
    });
    expect(
      transitionCheckpoint(checkpoint, { type: "mark-failed", committedTombstones: false }).state,
    ).toBe("failed");
    const committed = {
      ...checkpoint,
      state: "committed" as const,
      durableIntent: "committed" as const,
    };
    expect(
      transitionCheckpoint(committed, { type: "mark-failed", committedTombstones: false }).accepted,
    ).toBe(false);
    const started = transitionCheckpoint({ ...committed }, { type: "content-started" });
    expect(started).toMatchObject({
      accepted: true,
      canRemoveContent: true,
      durableIntent: "committed",
      contentState: "in-progress",
    });
    expect(
      transitionCheckpoint(
        { ...committed, contentState: "in-progress" },
        { type: "content-complete" },
      ),
    ).toMatchObject({ accepted: true, contentState: "complete" });
  });
});
