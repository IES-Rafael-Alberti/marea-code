/* eslint-disable max-lines -- this file is the exhaustive public transition matrix. */
import { describe, expect, it } from "vitest";
import { Sha256DigestSchema } from "@marea/protocol";

import {
  MAX_ARTIFACT_BYTES,
  OperationsBoundaryError,
  artifactDigest,
  canonicalJsonBytes,
  encodeArtifact,
  parseArtifact,
  parseTarget,
  parseCreationGateResult,
  assertCanonicalJson,
  assertCreatable,
  observationMatches,
  targetMatches,
  targetIdentity,
  targetLogicalKey,
  type PreviewArtifact,
  type TargetRef,
} from "./index.js";
import { PreviewArtifactSchema } from "./schemas.js";
import { IndexCheckpointSchema, IndexInspectionSchema, TargetRefSchema } from "./schemas.js";
import { canMarkCheckpointFailed, transitionCheckpoint } from "./checkpoint-transition.js";

const protocolHash = Sha256DigestSchema.parse(`sha256:${"a".repeat(64)}`);
const manifestHash = "b".repeat(64);
const target: TargetRef = {
  kind: "account",
  key: { userId: "user-1" },
  observed: { kind: "version", version: "v2" },
};
const membership: TargetRef = {
  kind: "class-membership",
  key: { classId: "class-1", userId: "user-1" },
  observed: { kind: "version", version: "v3" },
};
const skill: TargetRef = TargetRefSchema.parse({
  kind: "skill",
  key: { skillId: "marea/reading" },
  observed: { kind: "skill", skillId: "marea/reading", digest: protocolHash },
});

function expectBoundary(
  operation: () => unknown,
  code: OperationsBoundaryError["code"],
  message: string,
): void {
  let error: unknown;
  try {
    operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({
    name: "OperationsBoundaryError",
    code,
    message,
    safeMessage: message,
  });
}

function expectUncertainTransition(
  checkpoint: Parameters<typeof transitionCheckpoint>[0],
  event: Parameters<typeof transitionCheckpoint>[1],
  durableIntent: "none" | "committed" = "none",
): void {
  expect(transitionCheckpoint(checkpoint, event)).toEqual({
    state: "uncertain",
    accepted: false,
    canMarkFailed: false,
    canRemoveContent: false,
    durableIntent,
    contentState: "pending",
  });
}

function makeArtifact(): PreviewArtifact {
  const withoutDigest = PreviewArtifactSchema.omit({ artifactDigest: true }).parse({
    format: "marea-retention-preview:1",
    previewId: "preview-1",
    requestId: "request-1",
    authorityLineage: "lineage-1",
    installationId: "root-1",
    sourceDatabaseLineage: protocolHash,
    actorBinding: "exclusive-installation-owner",
    policyRevision: "policy-1",
    expectedIndexGeneration: 2,
    targets: [target, membership, skill],
    graphDigest: protocolHash,
    counts: { rows: 3, files: 1, backups: 0 },
    bytes: { database: 3, files: 4, backups: 0 },
    blockers: [],
    createdAt: "2026-09-12T10:00:00Z",
    expiresAt: "2026-09-12T10:10:00Z",
  });
  return PreviewArtifactSchema.parse({
    ...withoutDigest,
    artifactDigest: artifactDigest(withoutDigest),
  });
}

describe("OPERATIONS strict target and artifact contracts", () => {
  it("preserves stable logical identity while observations remain mutable", () => {
    const oldVersion = parseTarget({ ...target, observed: { kind: "version", version: "v1" } });
    expect(targetIdentity(oldVersion)).toBe(targetIdentity(target));
    expect(targetLogicalKey(membership)).toEqual({ classId: "class-1", userId: "user-1" });
    expect(targetIdentity(skill)).toContain("marea/reading");
    expectBoundary(
      () => parseTarget({ ...target, key: { userId: "user-1", extra: true } }),
      "invalid-input",
      "target payload is invalid",
    );
    expectBoundary(
      () => parseTarget({ ...target, observed: { kind: "version", version: "" } }),
      "invalid-input",
      "target payload is invalid",
    );
    const allTargets = [
      {
        kind: "center",
        key: { centerId: "center-1" },
        observed: { kind: "version", version: "v1" },
      },
      { kind: "class", key: { classId: "class-1" }, observed: { kind: "version", version: "v1" } },
      {
        kind: "center-membership",
        key: { centerId: "center-1", userId: "user-1" },
        observed: { kind: "version", version: "v1" },
      },
      {
        kind: "teaching-revision",
        key: { revisionId: "revision-1" },
        observed: { kind: "revision", revisionId: "revision-1", configurationDigest: protocolHash },
      },
      {
        kind: "run",
        key: { runId: "run-1" },
        observed: {
          kind: "run-snapshot",
          runId: "run-1",
          snapshotId: "snapshot-1",
          snapshotDigest: protocolHash,
        },
      },
      {
        kind: "snapshot",
        key: { snapshotId: "snapshot-1" },
        observed: {
          kind: "snapshot",
          snapshotId: "snapshot-1",
          snapshotDigest: protocolHash,
          teachingDigest: null,
        },
      },
      {
        kind: "backup",
        key: { manifestDigest: manifestHash },
        observed: { kind: "backup", manifestDigest: manifestHash, databaseDigest: manifestHash },
      },
    ].map(parseTarget);
    expect(allTargets.map(targetLogicalKey)).toEqual([
      { centerId: "center-1" },
      { classId: "class-1" },
      { centerId: "center-1", userId: "user-1" },
      { revisionId: "revision-1" },
      { runId: "run-1" },
      { snapshotId: "snapshot-1" },
      { manifestDigest: manifestHash },
    ]);
    expect(
      targetMatches(target, { ...target, observed: { kind: "version", version: "other" } }),
    ).toBe(true);
    expect(targetMatches(target, { ...target, key: { userId: "other-user" } })).toBe(false);
    expect(observationMatches(target, target)).toBe(true);
    expect(
      observationMatches(target, { ...target, observed: { kind: "version", version: "other" } }),
    ).toBe(false);
  });

  it("encodes sorted canonical JSON, validates exact digest, and rejects malformed boundaries", () => {
    const artifact = makeArtifact();
    const bytes = encodeArtifact(artifact);
    expect(new TextDecoder().decode(bytes).indexOf('"artifactDigest"')).toBeGreaterThan(0);
    expect(parseArtifact(bytes)).toEqual(artifact);
    expectBoundary(
      () => encodeArtifact({ ...artifact, artifactDigest: protocolHash }),
      "invalid-input",
      "artifact digest mismatch",
    );
    expect(canonicalJsonBytes({ z: 1, a: 2 }, 20)).toEqual(canonicalJsonBytes({ a: 2, z: 1 }, 20));
    expect(canonicalJsonBytes(null)).toEqual(new TextEncoder().encode("null"));
    expect(canonicalJsonBytes(Array.from({ length: 9_999 }, () => 1))).toBeInstanceOf(Uint8Array);
    const shared = { value: 1 };
    expect(canonicalJsonBytes({ first: shared, second: shared })).toEqual(
      canonicalJsonBytes({ first: { value: 1 }, second: { value: 1 } }),
    );
    const exact = canonicalJsonBytes({ exact: true });
    expect(canonicalJsonBytes({ exact: true }, exact.byteLength)).toEqual(exact);
    expectBoundary(
      () => parseArtifact(new TextEncoder().encode('{"unknown":true}')),
      "invalid-input",
      "artifact schema is invalid",
    );
    expectBoundary(
      () => parseArtifact(new Uint8Array([0xff])),
      "invalid-input",
      "artifact is not valid UTF-8",
    );
    expectBoundary(
      () =>
        parseArtifact(
          new TextEncoder().encode(JSON.stringify({ ...artifact, artifactDigest: protocolHash })),
        ),
      "invalid-input",
      "artifact digest mismatch",
    );
    expectBoundary(
      () => canonicalJsonBytes({ value: Number.NaN }),
      "invalid-input",
      "non-finite number is not valid JSON",
    );
    expectBoundary(
      () => canonicalJsonBytes({ value: "x".repeat(MAX_ARTIFACT_BYTES) }),
      "limit",
      "canonical JSON byte limit exceeded",
    );
    expectBoundary(
      () => canonicalJsonBytes({ value: Symbol("no-json") }),
      "invalid-input",
      "unsupported JSON value",
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectBoundary(() => canonicalJsonBytes(cyclic), "invalid-input", "cyclic JSON value");
    expectBoundary(
      () => canonicalJsonBytes({ value: undefined }),
      "invalid-input",
      "undefined JSON value",
    );
    expectBoundary(
      () => canonicalJsonBytes(Array.from({ length: 10_001 }, () => 1)),
      "limit",
      "canonical value node limit exceeded",
    );
    expectBoundary(
      () => parseArtifact(new TextEncoder().encode("not-json")),
      "invalid-input",
      "artifact JSON is invalid",
    );
    expectBoundary(
      () => parseArtifact(new Uint8Array(MAX_ARTIFACT_BYTES + 1)),
      "limit",
      "artifact byte limit exceeded",
    );
    expectBoundary(
      () => parseArtifact(new TextEncoder().encode(`null${" ".repeat(MAX_ARTIFACT_BYTES - 4)}`)),
      "invalid-input",
      "artifact schema is invalid",
    );
    expectBoundary(
      () => parseArtifact(new TextEncoder().encode(`${JSON.stringify(artifact)} `)),
      "invalid-input",
      "artifact is not canonical JSON",
    );
    expectBoundary(
      () =>
        parseArtifact(
          new TextEncoder().encode(JSON.stringify({ ...artifact, artifactDigest: protocolHash })),
        ),
      "invalid-input",
      "artifact digest mismatch",
    );
    assertCanonicalJson({ ok: true }, 100);
    expectBoundary(
      () => {
        assertCanonicalJson({ ok: true }, 1);
      },
      "limit",
      "canonical JSON byte limit exceeded",
    );
  });
});
describe("OPERATIONS checkpoint, creation, restore, and transfer models", () => {
  const checkpoint = IndexCheckpointSchema.parse({
    operationId: "operation-1",
    authorityLineage: "lineage-1",
    expectedIndexGeneration: 4,
    nextIndexGeneration: 5,
    targetCount: 1,
    artifactDigest: protocolHash,
    state: "prepared" as const,
  });
  const authority = IndexInspectionSchema.parse({
    authorityLineage: "lineage-1",
    rootId: "root-1",
    databaseLineage: protocolHash,
    generation: 4,
    state: "active" as const,
  });
  it("allows failure before index intent but never after tombstone commit", () => {
    expect(() =>
      IndexCheckpointSchema.parse({
        ...checkpoint,
        nextIndexGeneration: checkpoint.expectedIndexGeneration,
      }),
    ).toThrow();
    expect(() =>
      IndexCheckpointSchema.parse({
        ...checkpoint,
        state: "prepared",
        contentState: "in-progress",
      }),
    ).toThrow("checkpoint state/content progress is inconsistent");
    expect(() =>
      IndexCheckpointSchema.parse({ ...checkpoint, state: "failed", contentState: "complete" }),
    ).toThrow("checkpoint state/content progress is inconsistent");
    expect(() =>
      IndexCheckpointSchema.parse({ ...checkpoint, durableIntent: "committed" }),
    ).toThrow("checkpoint state/content progress is inconsistent");
    expect(() => IndexCheckpointSchema.parse({ ...checkpoint, state: "committed" })).toThrow(
      "checkpoint state/content progress is inconsistent",
    );
    expect(() =>
      transitionCheckpoint(
        { ...checkpoint, durableIntent: "committed" },
        { type: "mark-failed", committedTombstones: false },
      ),
    ).toThrow("checkpoint state/content progress is inconsistent");
    expect(
      IndexCheckpointSchema.parse({ ...checkpoint, state: "failed", contentState: "pending" })
        .state,
    ).toBe("failed");
    expect(canMarkCheckpointFailed(checkpoint, false)).toBe(true);
    expect(canMarkCheckpointFailed(checkpoint, true)).toBe(false);
    expect(transitionCheckpoint(checkpoint, { type: "index-prepared" })).toEqual({
      state: "prepared",
      accepted: true,
      canMarkFailed: true,
      canRemoveContent: false,
      durableIntent: "none",
      contentState: "pending",
    });
    expect(transitionCheckpoint(checkpoint, { type: "index-committed" })).toEqual({
      state: "committed",
      accepted: true,
      canMarkFailed: false,
      canRemoveContent: false,
      durableIntent: "committed",
      contentState: "pending",
    });
    expect(
      transitionCheckpoint(
        { ...checkpoint, state: "committed", durableIntent: "committed" },
        { type: "content-complete" },
      ),
    ).toEqual({
      state: "uncertain",
      accepted: false,
      canMarkFailed: false,
      canRemoveContent: false,
      durableIntent: "committed",
      contentState: "pending",
    });
    expect(
      transitionCheckpoint(
        { ...checkpoint, state: "committed", durableIntent: "committed" },
        { type: "content-started" },
      ),
    ).toEqual({
      state: "committed",
      accepted: true,
      canMarkFailed: false,
      canRemoveContent: true,
      contentState: "in-progress",
      durableIntent: "committed",
    });
    expect(
      transitionCheckpoint(
        {
          ...checkpoint,
          state: "uncertain",
          contentState: "in-progress",
          durableIntent: "committed",
        },
        { type: "content-complete" },
      ),
    ).toEqual({
      state: "uncertain",
      accepted: false,
      canMarkFailed: false,
      canRemoveContent: false,
      contentState: "in-progress",
      durableIntent: "committed",
    });
    expect(transitionCheckpoint(checkpoint, { type: "content-started" })).toEqual({
      state: "uncertain",
      accepted: false,
      canMarkFailed: false,
      canRemoveContent: false,
      contentState: "pending",
      durableIntent: "none",
    });
    expect(transitionCheckpoint(checkpoint, { type: "content-complete" })).toEqual({
      state: "uncertain",
      accepted: false,
      canMarkFailed: false,
      canRemoveContent: false,
      contentState: "pending",
      durableIntent: "none",
    });
    expect(
      transitionCheckpoint(
        {
          ...checkpoint,
          state: "committed",
          contentState: "in-progress",
          durableIntent: "committed",
        },
        { type: "content-complete" },
      ),
    ).toEqual({
      state: "committed",
      accepted: true,
      canMarkFailed: false,
      canRemoveContent: false,
      contentState: "complete",
      durableIntent: "committed",
    });
    expect(
      transitionCheckpoint(
        { ...checkpoint, state: "committed", contentState: "complete", durableIntent: "committed" },
        { type: "content-started" },
      ),
    ).toEqual({
      state: "uncertain",
      accepted: false,
      canMarkFailed: false,
      canRemoveContent: false,
      contentState: "complete",
      durableIntent: "committed",
    });
    expectUncertainTransition(
      { ...checkpoint, state: "committed", durableIntent: "committed" },
      { type: "mark-failed", committedTombstones: false },
      "committed",
    );
    expectUncertainTransition({ ...checkpoint, state: "uncertain" }, { type: "index-committed" });
    expect(transitionCheckpoint(checkpoint, { type: "mark-uncertain" })).toEqual({
      state: "uncertain",
      accepted: true,
      canMarkFailed: false,
      canRemoveContent: false,
      durableIntent: "none",
      contentState: "pending",
    });
    expect(
      transitionCheckpoint(checkpoint, { type: "mark-uncertain", committedTombstones: true }),
    ).toMatchObject({ state: "uncertain", durableIntent: "committed" });
    expect(
      transitionCheckpoint(checkpoint, { type: "mark-uncertain", committedTombstones: false }),
    ).toMatchObject({ state: "uncertain", durableIntent: "none" });
    expect(
      transitionCheckpoint(
        { ...checkpoint, state: "committed", durableIntent: "committed" },
        { type: "mark-uncertain" },
      ),
    ).toEqual({
      state: "uncertain",
      accepted: true,
      canMarkFailed: false,
      canRemoveContent: false,
      durableIntent: "committed",
      contentState: "pending",
    });
    expect(
      transitionCheckpoint(checkpoint, { type: "mark-failed", committedTombstones: false }),
    ).toEqual({
      state: "failed",
      accepted: true,
      canMarkFailed: false,
      canRemoveContent: false,
      durableIntent: "none",
      contentState: "pending",
    });
    expectUncertainTransition(
      { ...checkpoint, state: "committed", durableIntent: "committed" },
      { type: "index-prepared" },
      "committed",
    );
    expectUncertainTransition(
      { ...checkpoint, state: "uncertain" },
      { type: "mark-failed", committedTombstones: false },
    );
    expect(
      transitionCheckpoint(
        { ...checkpoint, state: "uncertain", durableIntent: "committed" },
        { type: "resume-content" },
      ),
    ).toEqual({
      state: "committed",
      accepted: true,
      canMarkFailed: false,
      canRemoveContent: true,
      durableIntent: "committed",
      contentState: "in-progress",
    });
    expectUncertainTransition({ ...checkpoint, state: "uncertain" }, { type: "resume-content" });
    expectUncertainTransition(
      { ...checkpoint, state: "committed", durableIntent: "committed" },
      { type: "resume-content" },
      "committed",
    );
    expect(
      Reflect.apply(transitionCheckpoint, undefined, [checkpoint, { type: "mark-failed" }]),
    ).toMatchObject({ state: "uncertain", accepted: false });
    expect(Reflect.apply(canMarkCheckpointFailed, undefined, [checkpoint, undefined])).toBe(false);
    for (const value of [
      { ...checkpoint, state: "committed" as const, durableIntent: "committed" as const },
      {
        ...checkpoint,
        state: "committed" as const,
        contentState: "in-progress" as const,
        durableIntent: "committed" as const,
      },
    ])
      expect(canMarkCheckpointFailed(value, false)).toBe(false);
    expect(() =>
      canMarkCheckpointFailed({ ...checkpoint, durableIntent: "committed" }, false),
    ).toThrow("checkpoint state/content progress is inconsistent");
  });
  it("denies ID reuse and undefined authority while allowing unrelated identities", () => {
    const deleted = `${authority.authorityLineage}:${targetIdentity(target)}`;
    expect(assertCreatable(target, authority, [deleted])).toEqual({
      allowed: false,
      code: "tombstoned",
    });
    expect(assertCreatable({ ...target, key: { userId: "user-2" } }, authority, [deleted])).toEqual(
      { allowed: true },
    );
    expect(assertCreatable(target, authority, [], true)).toEqual({
      allowed: false,
      code: "uncertain",
    });
    expect(assertCreatable(target, authority, [], false)).toEqual({ allowed: true });
    expect(assertCreatable(target, authority, [], null)).toEqual({ allowed: true });
    expect(() => assertCreatable(target, authority, [], { invalid: true } as never)).toThrow();
    expect(assertCreatable(target, null, [])).toEqual({
      allowed: false,
      code: "missing-authority",
    });
    expect(assertCreatable(target, { ...authority, state: "uncertain" }, [])).toEqual({
      allowed: false,
      code: "uncertain",
    });
    expect(assertCreatable(target, { ...authority, state: "corrupt" }, [])).toEqual({
      allowed: false,
      code: "corrupt",
    });
    expect(parseCreationGateResult({ allowed: true })).toEqual({ allowed: true });
    expectBoundary(
      () => parseCreationGateResult({ allowed: false, code: "bad" }),
      "invalid-input",
      "creation result is invalid",
    );
  });
});
