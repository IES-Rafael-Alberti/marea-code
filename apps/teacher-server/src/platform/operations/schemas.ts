import * as z from "zod";

import {
  RequestIdSchema,
  RevisionIdSchema,
  RunIdSchema,
  Sha256DigestSchema,
  SkillIdSchema,
  SnapshotIdSchema,
  UtcTimestampSchema,
} from "@marea/protocol";

const SafeCountSchema = z.number().int().nonnegative();

export const ManifestSha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .brand<"ManifestSha256">();
export const IndexGenerationSchema = z.number().int().nonnegative();
export const AbsolutePathSchema = z.string().min(1).max(4_096);
export const AuthorityLineageSchema = RevisionIdSchema.brand<"AuthorityLineage">();
export const RootIdSchema = RevisionIdSchema.brand<"RootId">();

const VersionObservationSchema = z
  .object({ kind: z.literal("version"), version: RevisionIdSchema })
  .strict();
const TeachingRevisionObservationSchema = z
  .object({
    kind: z.literal("revision"),
    revisionId: RevisionIdSchema,
    configurationDigest: Sha256DigestSchema,
  })
  .strict();
const RunObservationSchema = z
  .object({
    kind: z.literal("run-snapshot"),
    runId: RunIdSchema,
    snapshotId: SnapshotIdSchema,
    snapshotDigest: Sha256DigestSchema,
  })
  .strict();
const SnapshotObservationSchema = z
  .object({
    kind: z.literal("snapshot"),
    snapshotId: SnapshotIdSchema,
    snapshotDigest: Sha256DigestSchema,
    teachingDigest: Sha256DigestSchema.nullable(),
  })
  .strict();
const SkillObservationSchema = z
  .object({ kind: z.literal("skill"), skillId: SkillIdSchema, digest: Sha256DigestSchema })
  .strict();
const BackupObservationSchema = z
  .object({
    kind: z.literal("backup"),
    manifestDigest: ManifestSha256Schema,
    databaseDigest: ManifestSha256Schema,
  })
  .strict();

const AccountTargetSchema = z
  .object({
    kind: z.literal("account"),
    key: z.object({ userId: RevisionIdSchema }).strict(),
    observed: VersionObservationSchema,
  })
  .strict();
const CenterTargetSchema = z
  .object({
    kind: z.literal("center"),
    key: z.object({ centerId: RevisionIdSchema }).strict(),
    observed: VersionObservationSchema,
  })
  .strict();
const ClassTargetSchema = z
  .object({
    kind: z.literal("class"),
    key: z.object({ classId: RevisionIdSchema }).strict(),
    observed: VersionObservationSchema,
  })
  .strict();
const CenterMembershipTargetSchema = z
  .object({
    kind: z.literal("center-membership"),
    key: z.object({ centerId: RevisionIdSchema, userId: RevisionIdSchema }).strict(),
    observed: VersionObservationSchema,
  })
  .strict();
const ClassMembershipTargetSchema = z
  .object({
    kind: z.literal("class-membership"),
    key: z.object({ classId: RevisionIdSchema, userId: RevisionIdSchema }).strict(),
    observed: VersionObservationSchema,
  })
  .strict();
const TeachingRevisionTargetSchema = z
  .object({
    kind: z.literal("teaching-revision"),
    key: z.object({ revisionId: RevisionIdSchema }).strict(),
    observed: TeachingRevisionObservationSchema,
  })
  .strict();
const RunTargetSchema = z
  .object({
    kind: z.literal("run"),
    key: z.object({ runId: RunIdSchema }).strict(),
    observed: RunObservationSchema,
  })
  .strict();
const SnapshotTargetSchema = z
  .object({
    kind: z.literal("snapshot"),
    key: z.object({ snapshotId: SnapshotIdSchema }).strict(),
    observed: SnapshotObservationSchema,
  })
  .strict();
const SkillTargetSchema = z
  .object({
    kind: z.literal("skill"),
    key: z.object({ skillId: SkillIdSchema }).strict(),
    observed: SkillObservationSchema,
  })
  .strict();
const BackupTargetSchema = z
  .object({
    kind: z.literal("backup"),
    key: z.object({ manifestDigest: ManifestSha256Schema }).strict(),
    observed: BackupObservationSchema,
  })
  .strict();

const TargetRefUnionSchema = z.discriminatedUnion("kind", [
  AccountTargetSchema,
  CenterTargetSchema,
  ClassTargetSchema,
  CenterMembershipTargetSchema,
  ClassMembershipTargetSchema,
  TeachingRevisionTargetSchema,
  RunTargetSchema,
  SnapshotTargetSchema,
  SkillTargetSchema,
  BackupTargetSchema,
]);
export const TargetRefSchema = TargetRefUnionSchema.superRefine((value, context) => {
  const observed = value.observed;
  const key = value.key;
  let matches = true;
  switch (value.kind) {
    case "teaching-revision":
      matches =
        (observed as { revisionId: string }).revisionId ===
        (key as { revisionId: string }).revisionId;
      break;
    case "run":
      matches = (observed as { runId: string }).runId === (key as { runId: string }).runId;
      break;
    case "snapshot":
      matches =
        (observed as { snapshotId: string }).snapshotId ===
        (key as { snapshotId: string }).snapshotId;
      break;
    case "skill":
      matches = (observed as { skillId: string }).skillId === (key as { skillId: string }).skillId;
      break;
    case "backup":
      matches =
        (observed as { manifestDigest: string }).manifestDigest ===
        (key as { manifestDigest: string }).manifestDigest;
      break;
  }
  if (!matches)
    context.addIssue({ code: "custom", message: "observation does not match target key" });
});
export type TargetRef = z.infer<typeof TargetRefSchema>;
export type TargetKind = TargetRef["kind"];
export const BlockerCodeSchema = z.enum([
  "active",
  "unknown",
  "protected",
  "unverifiable",
  "out-of-root",
  "shared-backup",
  "stale",
]);
export const BlockerSchema = z
  .object({
    code: BlockerCodeSchema,
    target: TargetRefSchema.nullable(),
    detailCode: RevisionIdSchema,
  })
  .strict();
export const PreviewArtifactSchema = z
  .object({
    format: z.literal("marea-retention-preview:1"),
    previewId: RevisionIdSchema,
    requestId: RequestIdSchema,
    authorityLineage: AuthorityLineageSchema,
    installationId: RootIdSchema,
    sourceDatabaseLineage: Sha256DigestSchema,
    actorBinding: z.literal("exclusive-installation-owner"),
    policyRevision: RevisionIdSchema,
    expectedIndexGeneration: IndexGenerationSchema,
    targets: z.array(TargetRefSchema).min(1).max(1_000).readonly(),
    graphDigest: Sha256DigestSchema,
    counts: z
      .object({
        rows: SafeCountSchema,
        files: SafeCountSchema,
        backups: SafeCountSchema,
      })
      .strict(),
    bytes: z
      .object({
        database: SafeCountSchema,
        files: SafeCountSchema,
        backups: SafeCountSchema,
      })
      .strict(),
    blockers: z.array(BlockerSchema).max(1_000).readonly(),
    createdAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema,
    artifactDigest: Sha256DigestSchema,
  })
  .strict();
export type PreviewArtifact = z.infer<typeof PreviewArtifactSchema>;
export const GraphSchema = z
  .object({
    digest: Sha256DigestSchema,
    nodes: z.array(TargetRefSchema).max(10_000).readonly(),
    blockers: z.array(BlockerSchema).max(1_000).readonly(),
  })
  .strict();
export type ReferenceGraph = z.infer<typeof GraphSchema>;
export const PreparedDeletionSchema = z
  .object({
    operationId: RevisionIdSchema,
    authorityLineage: AuthorityLineageSchema,
    expectedIndexGeneration: IndexGenerationSchema,
    targets: z.array(TargetRefSchema).min(1).max(1_000).readonly(),
    artifactDigest: Sha256DigestSchema,
  })
  .strict();
export type PreparedDeletion = z.infer<typeof PreparedDeletionSchema>;
export const IndexCheckpointStateSchema = z.enum(["prepared", "committed", "failed", "uncertain"]);
export const ContentCheckpointStateSchema = z.enum(["pending", "in-progress", "complete"]);
export const DurableIntentSchema = z.enum(["none", "committed"]);
export const IndexCheckpointSchema = z
  .object({
    operationId: RevisionIdSchema,
    authorityLineage: AuthorityLineageSchema,
    expectedIndexGeneration: IndexGenerationSchema,
    nextIndexGeneration: z.number().int().positive(),
    targetCount: z.number().int().min(1).max(1_000),
    artifactDigest: Sha256DigestSchema,
    state: IndexCheckpointStateSchema,
    contentState: ContentCheckpointStateSchema.default("pending"),
    durableIntent: DurableIntentSchema.default("none"),
  })
  .strict()
  .refine(
    (value) => value.nextIndexGeneration > value.expectedIndexGeneration,
    "next generation must advance",
  )
  .refine(
    (value) =>
      value.state === "uncertain" ||
      (value.state === "committed" && value.durableIntent === "committed") ||
      (value.state !== "committed" &&
        value.contentState === "pending" &&
        value.durableIntent === "none"),
    "checkpoint state/content progress is inconsistent",
  );
export type IndexCheckpoint = z.infer<typeof IndexCheckpointSchema>;
export const ReconciliationReasonSchema = z.enum([
  "none",
  "missing-authority",
  "lineage-conflict",
  "stale-generation",
  "tombstoned-identity",
  "pending-checkpoint",
  "unknown-ancestry",
]);
export const AuthorityCheckpointEvidenceSchema = z
  .object({
    authorityLineage: AuthorityLineageSchema,
    rootId: RootIdSchema,
    indexGeneration: IndexGenerationSchema,
    databaseLineage: Sha256DigestSchema,
    bundleManifestDigest: ManifestSha256Schema,
    checkpointDigest: Sha256DigestSchema,
  })
  .strict();
export type AuthorityCheckpointEvidence = z.infer<typeof AuthorityCheckpointEvidenceSchema>;
export const RestoredDatabaseIdentitySchema = z
  .object({
    rootId: RootIdSchema,
    sourceAuthorityLineage: AuthorityLineageSchema,
    sourceDatabaseLineage: Sha256DigestSchema,
    sourceBundleManifestDigest: ManifestSha256Schema,
    sourceIndexGeneration: IndexGenerationSchema.nullable(),
    sourceCheckpointDigest: Sha256DigestSchema,
    destinationAuthorityLineage: AuthorityLineageSchema,
    destinationRootId: RootIdSchema,
  })
  .strict();
export type RestoredDatabaseIdentity = z.infer<typeof RestoredDatabaseIdentitySchema>;
export const ReconciliationSchema = z
  .object({
    state: z.enum(["verified", "blocked"]),
    currentIndexGeneration: IndexGenerationSchema,
    checked: z.number().int().nonnegative(),
    tombstoned: z.array(TargetRefSchema).readonly(),
    reasonCode: ReconciliationReasonSchema,
  })
  .strict();
export type Reconciliation = z.infer<typeof ReconciliationSchema>;

export const IndexStateSchema = z.enum([
  "active",
  "transfer-prepared",
  "retired",
  "uncertain",
  "missing",
  "corrupt",
]);
export const IndexInspectionSchema = z
  .object({
    authorityLineage: AuthorityLineageSchema,
    rootId: RootIdSchema,
    databaseLineage: Sha256DigestSchema,
    generation: IndexGenerationSchema,
    state: IndexStateSchema,
    pendingCheckpoint: IndexCheckpointSchema.nullable().default(null),
  })
  .strict();
export type IndexInspection = z.infer<typeof IndexInspectionSchema>;

export const RetentionPreviewRequestSchema = z
  .object({
    requestId: RequestIdSchema,
    previewId: RevisionIdSchema,
    policyRevision: RevisionIdSchema,
    authorityLineage: AuthorityLineageSchema,
    installationId: RootIdSchema,
    sourceDatabaseLineage: Sha256DigestSchema,
    expectedIndexGeneration: IndexGenerationSchema,
    targets: z.array(TargetRefSchema).min(1).max(1_000).readonly(),
    createdAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema,
  })
  .strict();
export type RetentionPreviewRequest = z.infer<typeof RetentionPreviewRequestSchema>;
export const RetentionConfirmRequestSchema = z
  .object({
    artifact: PreviewArtifactSchema,
    drainUntil: UtcTimestampSchema,
    now: UtcTimestampSchema,
  })
  .strict();
export type RetentionConfirmRequest = z.infer<typeof RetentionConfirmRequestSchema>;
export const RetentionConfirmationSchema = z
  .object({
    operationId: RevisionIdSchema,
    requestId: RequestIdSchema,
    artifactDigest: Sha256DigestSchema,
    state: z.enum(["prepared", "index-committed", "content-complete", "applied", "uncertain"]),
  })
  .strict();
export type RetentionConfirmation = z.infer<typeof RetentionConfirmationSchema>;
export interface RetentionService {
  preview(input: RetentionPreviewRequest): Promise<PreviewArtifact>;
  confirm(input: RetentionConfirmRequest): Promise<RetentionConfirmation>;
}

export const CreationGateResultSchema = z.discriminatedUnion("allowed", [
  z.object({ allowed: z.literal(true) }).strict(),
  z
    .object({
      allowed: z.literal(false),
      code: z.enum(["tombstoned", "missing-authority", "uncertain", "corrupt"]),
    })
    .strict(),
]);
export type CreationGateResult = z.infer<typeof CreationGateResultSchema>;

export const AuthorityCheckpointSchema = z
  .object({
    authorityLineage: AuthorityLineageSchema,
    rootId: RootIdSchema,
    indexGeneration: IndexGenerationSchema,
    databaseLineage: Sha256DigestSchema,
    bundleManifestDigest: ManifestSha256Schema,
  })
  .strict();
export type AuthorityCheckpoint = z.infer<typeof AuthorityCheckpointSchema>;

export const TransferStateSchema = z.enum([
  "prepared",
  "copied",
  "source-retired",
  "destination-active",
  "aborted",
]);
export type TransferState = z.infer<typeof TransferStateSchema>;
export const TransferHandoffSchema = z
  .object({
    handoffId: RevisionIdSchema,
    authorityLineage: AuthorityLineageSchema,
    sourceRoot: RootIdSchema,
    destinationRoot: RootIdSchema,
    expectedIndexGeneration: IndexGenerationSchema,
    authorityCheckpointDigest: Sha256DigestSchema,
    authorityCheckpoint: AuthorityCheckpointSchema.optional(),
    copiedFileDigest: Sha256DigestSchema,
    destinationCheckpoint: AuthorityCheckpointSchema.optional(),
    destinationState: z.enum(["inactive", "blocked", "active"]),
    sourceRetirementEvidence: AuthorityCheckpointEvidenceSchema.extend({
      handoffId: RevisionIdSchema,
      copiedFileDigest: Sha256DigestSchema,
      state: z.literal("retired"),
    }).optional(),
    state: TransferStateSchema,
  })
  .strict();
export type TransferHandoff = z.infer<typeof TransferHandoffSchema>;

export const BootstrapMarkerSchema = z
  .object({
    format: z.literal("marea-fresh-install:1"),
    rootId: RootIdSchema,
    authorityLineage: AuthorityLineageSchema,
    releaseId: RevisionIdSchema,
    canonicalRootDigest: Sha256DigestSchema,
  })
  .strict();
export type BootstrapMarker = z.infer<typeof BootstrapMarkerSchema>;

export const MarkerOnlyRetirementSchema = z
  .object({
    mode: z.literal("marker-only"),
    marker: BootstrapMarkerSchema,
    currentRootId: RootIdSchema,
    currentAuthorityLineage: AuthorityLineageSchema,
    currentReleaseId: RevisionIdSchema,
  })
  .strict();
export type MarkerOnlyRetirement = z.infer<typeof MarkerOnlyRetirementSchema>;
export const HandoffRetirementSchema = z
  .object({
    mode: z.literal("handoff"),
    handoff: TransferHandoffSchema,
    marker: BootstrapMarkerSchema,
    currentRootId: RootIdSchema,
    currentAuthorityLineage: AuthorityLineageSchema,
    currentReleaseId: RevisionIdSchema,
  })
  .strict();
export type HandoffRetirement = z.infer<typeof HandoffRetirementSchema>;
export const RootRetirementSchema = z.discriminatedUnion("mode", [
  MarkerOnlyRetirementSchema,
  HandoffRetirementSchema,
]);

export const BootstrapContinuationSchema = z
  .object({
    action: z.literal("continue-bootstrap"),
    marker: BootstrapMarkerSchema,
    destinationRoot: RootIdSchema,
    releaseId: RevisionIdSchema,
    missing: z.enum(["database", "index", "status"]),
    expectedAuthorityLineage: AuthorityLineageSchema,
  })
  .strict();
export type BootstrapContinuation = z.infer<typeof BootstrapContinuationSchema>;

export const OperationErrorCodeSchema = z.enum([
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
]);
export type OperationErrorCode = z.infer<typeof OperationErrorCodeSchema>;
export const OperationErrorSchema = z
  .object({ code: OperationErrorCodeSchema, safeMessage: z.string().min(1).max(256) })
  .strict();
export type OperationError = z.infer<typeof OperationErrorSchema>;
