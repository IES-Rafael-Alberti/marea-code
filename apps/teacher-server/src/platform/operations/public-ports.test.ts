import { describe, expect, it } from "vitest";

import {
  MAX_DRAIN_MS,
  MAX_GRAPH_NODES,
  MAX_TARGETS,
  PREVIEW_LIFETIME_MS,
} from "./canonical-encoder.js";
import type {
  DeletionIndex,
  HostLifecycle,
  MaintenanceCoordinator,
  MaintenancePreviewView,
  MaintenanceRunView,
  MaintenanceView,
  OfflineDiagnosis,
  ReadOnlySqliteApplicationDatabase,
  RecoveryInspection,
  RecoveryService,
  ReferenceGraphReader,
  ShutdownResult,
  StartResult,
} from "./contracts.js";
import type { RecoveryInput } from "./recovery-schemas.js";
import {
  AuthorityCheckpointEvidenceSchema,
  BootstrapContinuationSchema,
  BootstrapMarkerSchema,
  HandoffRetirementSchema,
  MarkerOnlyRetirementSchema,
  OperationErrorCodeSchema,
  OperationErrorSchema,
  RetentionConfirmRequestSchema,
  RetentionConfirmationSchema,
  RetentionPreviewRequestSchema,
  TargetRefSchema,
  type AuthorityCheckpointEvidence,
  type BootstrapContinuation,
  type BootstrapMarker,
  type CreationGateResult,
  type HandoffRetirement,
  type IndexCheckpoint,
  type IndexInspection,
  type MarkerOnlyRetirement,
  type OperationError,
  type OperationErrorCode,
  type PreparedDeletion,
  type PreviewArtifact,
  type Reconciliation,
  type RetentionConfirmation,
  type RetentionConfirmRequest,
  type RetentionPreviewRequest,
  type RetentionService,
  type RestoredDatabaseIdentity,
  type TargetKind,
  type TargetRef,
} from "./schemas.js";

export type Equal<Left, Right> = [Left, Right] extends [Right, Left] ? true : false;
export type Assert<Value extends true> = Value;
export type NotAssignable<Source, Target> = [Source] extends [Target] ? false : true;

export type PreviewSurfaceIsReadOnly = Assert<
  Equal<keyof ReadOnlySqliteApplicationDatabase, "readAll" | "readOne">
>;
export type PreviewHasNoWriteMethods = Assert<
  Equal<Extract<keyof MaintenancePreviewView["database"], "execute" | "transaction" | "run">, never>
>;
export type PreviewViewHasOnlyReadPorts = Assert<
  Equal<keyof MaintenancePreviewView, "database" | "graph">
>;
export type RunViewHasOnlyExpectedPorts = Assert<
  Equal<keyof MaintenanceRunView, "database" | "graph">
>;
export type MaintenanceViewIsRunView = Assert<Equal<MaintenanceView, MaintenanceRunView>>;
export type MaintenanceCoordinatorHasTypedOperations = Assert<
  MaintenanceCoordinator extends {
    preview<T>(operation: (view: MaintenancePreviewView) => Promise<T>): Promise<T>;
    run<T>(
      input: { readonly drainUntil: string },
      operation: (view: MaintenanceRunView) => Promise<T>,
    ): Promise<T>;
  }
    ? true
    : false
>;
export type GraphReaderRequestIsExact = Assert<
  Equal<
    Parameters<ReferenceGraphReader["read"]>,
    [input: { readonly targets: readonly TargetRef[] }]
  >
>;
export type GraphReaderResultIsExact = Assert<
  Equal<ReturnType<ReferenceGraphReader["read"]>, Promise<import("./schemas.js").ReferenceGraph>>
>;

export type StartResultFieldsAreDiscriminated = Assert<
  Equal<keyof Extract<StartResult, { state: "ready" }>, "state" | "releaseId" | "schemaVersion">
>;
export type StartFailureReasonsAreExhaustive = Assert<
  Equal<
    Extract<StartResult, { state: "failed" }>["reason"],
    "lock" | "config" | "release" | "storage" | "recovery" | "index" | "assets" | "listen"
  >
>;
export type ShutdownStatesAreExhaustive = Assert<
  Equal<ShutdownResult["state"], "stopped" | "drain-expired" | "failed">
>;
export type OfflineDiagnosisFieldsAreExact = Assert<
  Equal<
    keyof OfflineDiagnosis,
    "mode" | "observedAt" | "status" | "releaseId" | "schemaVersion" | "checks" | "reasonCode"
  >
>;
export type HostLifecycleSurfaceIsComplete = Assert<
  Equal<keyof HostLifecycle, "start" | "shutdown" | "offlineDiagnose">
>;
export type HostRequestsAreExact = [
  Assert<
    Equal<
      Parameters<HostLifecycle["start"]>,
      [input: { readonly installationRoot: string; readonly releaseId: string }]
    >
  >,
  Assert<Equal<Parameters<HostLifecycle["shutdown"]>, [input: { readonly drainUntil: string }]>>,
  Assert<
    Equal<
      Parameters<HostLifecycle["offlineDiagnose"]>,
      [input: { readonly installationRoot: string }]
    >
  >,
];
export type HostResultsAreExact = [
  Assert<Equal<ReturnType<HostLifecycle["start"]>, Promise<StartResult>>>,
  Assert<Equal<ReturnType<HostLifecycle["shutdown"]>, Promise<ShutdownResult>>>,
  Assert<Equal<ReturnType<HostLifecycle["offlineDiagnose"]>, Promise<OfflineDiagnosis>>>,
];

export type DeletionIndexSurfaceIsComplete = Assert<
  Equal<keyof DeletionIndex, "inspect" | "prepare" | "commit" | "reconcile" | "assertCreatable">
>;
export type DeletionRequestsAreExact = [
  Assert<Equal<Parameters<DeletionIndex["prepare"]>, [input: PreparedDeletion]>>,
  Assert<Equal<Parameters<DeletionIndex["commit"]>, [input: IndexCheckpoint]>>,
  Assert<Equal<Parameters<DeletionIndex["reconcile"]>, [input: RestoredDatabaseIdentity]>>,
  Assert<Equal<Parameters<DeletionIndex["assertCreatable"]>, [target: TargetRef]>>,
];
export type DeletionResultsAreExact = [
  Assert<Equal<ReturnType<DeletionIndex["inspect"]>, Promise<IndexInspection>>>,
  Assert<Equal<ReturnType<DeletionIndex["prepare"]>, Promise<IndexCheckpoint>>>,
  Assert<Equal<ReturnType<DeletionIndex["commit"]>, Promise<IndexCheckpoint>>>,
  Assert<Equal<ReturnType<DeletionIndex["reconcile"]>, Promise<Reconciliation>>>,
  Assert<Equal<ReturnType<DeletionIndex["assertCreatable"]>, Promise<CreationGateResult>>>,
];

export type PreviewRequestIsExact = Assert<
  Equal<Parameters<RetentionService["preview"]>, [input: RetentionPreviewRequest]>
>;
export type PreviewResultIsExact = Assert<
  Equal<ReturnType<RetentionService["preview"]>, Promise<PreviewArtifact>>
>;
export type ConfirmRequestIsExact = Assert<
  Equal<Parameters<RetentionService["confirm"]>, [input: RetentionConfirmRequest]>
>;
export type ConfirmResultIsExact = Assert<
  Equal<ReturnType<RetentionService["confirm"]>, Promise<RetentionConfirmation>>
>;
export type RetentionSurfaceIsComplete = Assert<
  Equal<keyof RetentionService, "preview" | "confirm">
>;
export type PreviewAndConfirmPayloadsDoNotInterchange = Assert<
  NotAssignable<RetentionPreviewRequest, RetentionConfirmRequest>
>;

export interface RecoveryActionPayloads {
  continueExact: Extract<RecoveryInput, { action: "continue-exact" }>;
  markFailed: Extract<RecoveryInput, { action: "mark-failed" }>;
  continueTransfer: Extract<RecoveryInput, { action: "transfer-continue" }>;
  retireRoot: Extract<RecoveryInput, { action: "retire-root" }>;
  continueBootstrap: Extract<RecoveryInput, { action: "continue-bootstrap" }>;
}
export type RecoveryServiceSurfaceIsComplete = Assert<
  Equal<
    keyof RecoveryService,
    | "inspect"
    | "continueExact"
    | "markFailed"
    | "continueTransfer"
    | "retireRoot"
    | "continueBootstrap"
  >
>;
export type RecoveryRequestsAreExact = [
  Assert<
    Equal<
      Parameters<RecoveryService["continueExact"]>,
      [input: RecoveryActionPayloads["continueExact"]]
    >
  >,
  Assert<
    Equal<Parameters<RecoveryService["markFailed"]>, [input: RecoveryActionPayloads["markFailed"]]>
  >,
  Assert<
    Equal<
      Parameters<RecoveryService["continueTransfer"]>,
      [input: RecoveryActionPayloads["continueTransfer"]]
    >
  >,
  Assert<
    Equal<Parameters<RecoveryService["retireRoot"]>, [input: RecoveryActionPayloads["retireRoot"]]>
  >,
  Assert<
    Equal<
      Parameters<RecoveryService["continueBootstrap"]>,
      [input: RecoveryActionPayloads["continueBootstrap"]]
    >
  >,
];
export type RecoveryResultsAreExact = [
  Assert<Equal<ReturnType<RecoveryService["inspect"]>, Promise<RecoveryInspection>>>,
  Assert<Equal<ReturnType<RecoveryService["continueExact"]>, Promise<RecoveryInspection>>>,
  Assert<Equal<ReturnType<RecoveryService["markFailed"]>, Promise<RecoveryInspection>>>,
  Assert<Equal<ReturnType<RecoveryService["continueTransfer"]>, Promise<RecoveryInspection>>>,
  Assert<Equal<ReturnType<RecoveryService["retireRoot"]>, Promise<RecoveryInspection>>>,
  Assert<Equal<ReturnType<RecoveryService["continueBootstrap"]>, Promise<RecoveryInspection>>>,
];
export type RecoveryActionPayloadsDoNotInterchange = Assert<
  NotAssignable<RecoveryActionPayloads["continueTransfer"], RecoveryActionPayloads["continueExact"]>
>;

export type TargetKindsAreExhaustive = Assert<
  Equal<
    TargetKind,
    | "account"
    | "center"
    | "class"
    | "center-membership"
    | "class-membership"
    | "teaching-revision"
    | "run"
    | "snapshot"
    | "skill"
    | "backup"
  >
>;
export type AuthorityEvidenceFieldsAreExact = Assert<
  Equal<
    keyof AuthorityCheckpointEvidence,
    | "authorityLineage"
    | "rootId"
    | "indexGeneration"
    | "databaseLineage"
    | "bundleManifestDigest"
    | "checkpointDigest"
  >
>;
export type BootstrapMarkerFieldsAreExact = Assert<
  Equal<
    keyof BootstrapMarker,
    "format" | "rootId" | "authorityLineage" | "releaseId" | "canonicalRootDigest"
  >
>;
export type RetirementInputsAreStrict = [
  Assert<
    Equal<
      keyof MarkerOnlyRetirement,
      "mode" | "marker" | "currentRootId" | "currentAuthorityLineage" | "currentReleaseId"
    >
  >,
  Assert<
    Equal<
      keyof HandoffRetirement,
      | "mode"
      | "handoff"
      | "marker"
      | "currentRootId"
      | "currentAuthorityLineage"
      | "currentReleaseId"
    >
  >,
];
export type BootstrapContinuationFieldsAreExact = Assert<
  Equal<
    keyof BootstrapContinuation,
    "action" | "marker" | "destinationRoot" | "releaseId" | "missing" | "expectedAuthorityLineage"
  >
>;
export type OperationErrorCodeIsExhaustive = Assert<
  Equal<
    OperationErrorCode,
    | "invalid-input"
    | "limit"
    | "path"
    | "owner-busy"
    | "host-live"
    | "not-ready"
    | "drain-expired"
    | "unknown-target"
    | "blocked-reference"
    | "stale-preview"
    | "uncertain"
    | "missing"
    | "corrupt"
    | "stale-generation"
    | "missing-authority"
    | "invalid-manifest"
    | "restore-isolation"
  >
>;
export type OperationErrorFieldsAreExact = Assert<
  Equal<keyof OperationError, "code" | "safeMessage">
>;

describe("OPERATIONS public compiler and runtime evidence", () => {
  it("pins public bounds and exposes no preview writes", () => {
    expect({ MAX_TARGETS, MAX_GRAPH_NODES, PREVIEW_LIFETIME_MS, MAX_DRAIN_MS }).toEqual({
      MAX_TARGETS: 1_000,
      MAX_GRAPH_NODES: 10_000,
      PREVIEW_LIFETIME_MS: 600_000,
      MAX_DRAIN_MS: 900_000,
    });
    expect(MAX_TARGETS).toBeLessThanOrEqual(MAX_GRAPH_NODES);
    expect(PREVIEW_LIFETIME_MS).toBeLessThan(MAX_DRAIN_MS);
  });

  it("executes every public schema used by host, retention, deletion and recovery ports", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const marker = BootstrapMarkerSchema.parse({
      format: "marea-fresh-install:1",
      rootId: "root-1",
      authorityLineage: "lineage-1",
      releaseId: "release-1",
      canonicalRootDigest: digest,
    });
    const target = TargetRefSchema.parse({
      kind: "account",
      key: { userId: "user-1" },
      observed: { kind: "version", version: "version-1" },
    });
    const evidence = AuthorityCheckpointEvidenceSchema.parse({
      authorityLineage: "lineage-1",
      rootId: "root-1",
      indexGeneration: 1,
      databaseLineage: digest,
      bundleManifestDigest: "b".repeat(64),
      checkpointDigest: digest,
    });
    const handoff = {
      handoffId: "handoff-1",
      authorityLineage: "lineage-1",
      sourceRoot: "root-1",
      destinationRoot: "root-2",
      expectedIndexGeneration: 1,
      authorityCheckpointDigest: digest,
      copiedFileDigest: digest,
      destinationState: "inactive" as const,
      state: "prepared" as const,
    };
    const markerOnly = MarkerOnlyRetirementSchema.parse({
      mode: "marker-only",
      marker,
      currentRootId: "root-1",
      currentAuthorityLineage: "lineage-1",
      currentReleaseId: "release-1",
    });
    const handoffRetirement = HandoffRetirementSchema.parse({
      mode: "handoff",
      handoff,
      marker: { ...marker, rootId: "root-2" },
      currentRootId: "root-2",
      currentAuthorityLineage: "lineage-1",
      currentReleaseId: "release-1",
    });
    const continuation = BootstrapContinuationSchema.parse({
      action: "continue-bootstrap",
      marker,
      destinationRoot: "root-1",
      releaseId: "release-1",
      missing: "database",
      expectedAuthorityLineage: "lineage-1",
    });
    const previewRequest = RetentionPreviewRequestSchema.parse({
      requestId: "request-1",
      previewId: "preview-1",
      policyRevision: "policy-1",
      authorityLineage: "lineage-1",
      installationId: "root-1",
      sourceDatabaseLineage: digest,
      expectedIndexGeneration: 1,
      targets: [target],
      createdAt: "2026-09-13T10:00:00Z",
      expiresAt: "2026-09-13T10:10:00Z",
    });
    const artifact = {
      format: "marea-retention-preview:1" as const,
      previewId: previewRequest.previewId,
      requestId: previewRequest.requestId,
      authorityLineage: previewRequest.authorityLineage,
      installationId: previewRequest.installationId,
      sourceDatabaseLineage: previewRequest.sourceDatabaseLineage,
      actorBinding: "exclusive-installation-owner" as const,
      policyRevision: previewRequest.policyRevision,
      expectedIndexGeneration: previewRequest.expectedIndexGeneration,
      targets: previewRequest.targets,
      graphDigest: digest,
      counts: { rows: 1, files: 0, backups: 0 },
      bytes: { database: 0, files: 0, backups: 0 },
      blockers: [],
      createdAt: previewRequest.createdAt,
      expiresAt: previewRequest.expiresAt,
      artifactDigest: digest,
    };
    const parsedArtifact = RetentionConfirmRequestSchema.parse({
      artifact,
      drainUntil: "2026-09-13T10:15:00Z",
      now: "2026-09-13T10:00:00Z",
    }).artifact;
    const confirmation = RetentionConfirmationSchema.parse({
      operationId: "operation-1",
      requestId: previewRequest.requestId,
      artifactDigest: parsedArtifact.artifactDigest,
      state: "prepared",
    });
    const error = OperationErrorSchema.parse({
      code: "stale-preview",
      safeMessage: "preview expired",
    });
    expect(OperationErrorCodeSchema.parse(error.code)).toBe("stale-preview");
    expect({ markerOnly, evidence, handoffRetirement, continuation, confirmation }).toMatchObject({
      markerOnly: { mode: "marker-only" },
      evidence: { rootId: "root-1" },
      handoffRetirement: { mode: "handoff" },
      continuation: { action: "continue-bootstrap" },
      confirmation: { state: "prepared" },
    });
  });
});
