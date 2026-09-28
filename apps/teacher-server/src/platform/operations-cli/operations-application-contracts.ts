import type { RecoveryInput } from "../operations/recovery-schemas.js";
import type { RecoveryInspection } from "../operations/contracts.js";
import type {
  TargetRef,
  PreviewArtifact,
  RetentionConfirmation,
  Reconciliation,
} from "../operations/schemas.js";
import type { TransferSummary } from "./installation-transfer.js";
import type { TransferContinuation } from "./transfer-schemas.js";
export interface PreviewInput {
  readonly requestId: string;
  readonly previewId: string;
  readonly policyRevision: string;
  readonly targets: readonly TargetRef[];
}
export type ContinueInput = Pick<
  Extract<RecoveryInput, { action: "continue-exact" }>,
  "operationId" | "expectedIndexGeneration" | "artifactDigest"
>;
export type MarkFailedInput = Pick<
  Extract<RecoveryInput, { action: "mark-failed" }>,
  "operationId" | "expectedIndexGeneration"
>;
export interface ReconcileInput {
  readonly bundlePath: string;
  readonly restoredDatabasePath: string;
}
export interface RestoreInput {
  readonly bundlePath: string;
  readonly destinationRoot: string;
}
export interface RestoreResult {
  readonly state: "restored" | "blocked";
  readonly reasonCode: Reconciliation["reasonCode"] | "no-deletions-recorded";
  readonly schemaVersion: number;
  readonly checked: number;
  readonly tombstoned: number;
  readonly path: string | null;
}
/**
 * Every command except initialization, activation, pre-activation backup and restore requires an
 * audit-activated installation.
 */
export interface OperationsApplication {
  initialize(): { readonly schemaVersion: number };
  activate(): { readonly schemaVersion: number };
  upgradeProfiles(
    name: string,
  ): Promise<{ readonly schemaVersion: number; readonly backupPath: string }>;
  preview(input: PreviewInput): Promise<PreviewArtifact>;
  confirm(artifact: PreviewArtifact): Promise<RetentionConfirmation>;
  inspect(operationId: string | undefined): Promise<RecoveryInspection>;
  continueExact(input: ContinueInput): Promise<RecoveryInspection>;
  markFailed(input: MarkFailedInput): Promise<RecoveryInspection>;
  createBackup(name: string): Promise<{ readonly path: string; readonly files: number }>;
  reconcile(input: ReconcileInput): Promise<Reconciliation>;
  restore(input: RestoreInput): Promise<RestoreResult>;
  transferStart(input: {
    readonly handoffId: string;
    readonly destinationInstallation: string;
  }): Promise<TransferSummary>;
  transferContinue(input: TransferContinuation): Promise<TransferSummary>;
  transferAbort(input: { readonly handoffId: string }): Promise<TransferSummary>;
  transferInspect(): Promise<TransferSummary | null>;
  close(): void;
}
