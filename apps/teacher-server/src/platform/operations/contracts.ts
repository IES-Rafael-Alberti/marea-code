import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";
import * as z from "zod";

import { IndexCheckpointSchema } from "./schemas.js";
import type {
  IndexCheckpoint,
  IndexInspection,
  CreationGateResult,
  PreparedDeletion,
  Reconciliation,
  ReferenceGraph,
  RestoredDatabaseIdentity,
  TargetRef,
} from "./schemas.js";

export type ReadOnlySqliteApplicationDatabase = Pick<
  SqliteApplicationDatabase,
  "readAll" | "readOne"
>;
export interface ReferenceGraphReader {
  read(input: { readonly targets: readonly TargetRef[] }): Promise<ReferenceGraph>;
}
export interface MaintenancePreviewView {
  readonly database: ReadOnlySqliteApplicationDatabase;
  readonly graph: ReferenceGraphReader;
}
export interface MaintenanceRunView {
  readonly database: SqliteApplicationDatabase;
  readonly graph: ReferenceGraphReader;
}
export interface MaintenanceCoordinator {
  preview<T>(operation: (view: MaintenancePreviewView) => Promise<T>): Promise<T>;
  run<T>(
    input: { readonly drainUntil: string },
    operation: (view: MaintenanceRunView) => Promise<T>,
  ): Promise<T>;
}
export type MaintenanceView = MaintenanceRunView;

export const StartResultSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("ready"),
      releaseId: z.string().min(1),
      schemaVersion: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      state: z.literal("failed"),
      reason: z.enum([
        "lock",
        "config",
        "release",
        "storage",
        "recovery",
        "index",
        "assets",
        "listen",
      ]),
    })
    .strict(),
]);
export type StartResult = z.infer<typeof StartResultSchema>;
export const ShutdownResultSchema = z
  .object({
    state: z.enum(["stopped", "drain-expired", "failed"]),
    reasonCode: z.string().min(1),
  })
  .strict();
export type ShutdownResult = z.infer<typeof ShutdownResultSchema>;
export const OfflineDiagnosisSchema = z
  .object({
    mode: z.enum(["live-host-observed", "offline-validation"]),
    observedAt: z.string().min(1),
    status: z.enum(["starting", "ready", "draining", "stopped", "failed", "unknown"]),
    releaseId: z.string().min(1).nullable(),
    schemaVersion: z.number().int().nonnegative().nullable(),
    checks: z
      .array(
        z.enum([
          "lock-free",
          "lock-held",
          "config-valid",
          "release-valid",
          "index-valid",
          "index-missing",
          "stale-status",
        ]),
      )
      .readonly(),
    reasonCode: z.string().min(1),
  })
  .strict();
export type OfflineDiagnosis = z.infer<typeof OfflineDiagnosisSchema>;
export interface HostLifecycle {
  start(input: {
    readonly installationRoot: string;
    readonly releaseId: string;
  }): Promise<StartResult>;
  shutdown(input: { readonly drainUntil: string }): Promise<ShutdownResult>;
  offlineDiagnose(input: { readonly installationRoot: string }): Promise<OfflineDiagnosis>;
}
export const RecoveryInspectionSchema = z
  .object({
    state: z.enum([
      "none",
      "prepared",
      "index-committed",
      "content-complete",
      "applied",
      "failed",
      "uncertain",
      "blocked",
    ]),
    operationId: z.string().min(1).nullable(),
    checkpoint: IndexCheckpointSchema.nullable(),
    reasonCode: z.string().min(1),
  })
  .strict();
export type RecoveryInspection = z.infer<typeof RecoveryInspectionSchema>;
export interface RecoveryService {
  inspect(operationId?: string): Promise<RecoveryInspection>;
  continueExact(
    input: Extract<import("./recovery-schemas.js").RecoveryInput, { action: "continue-exact" }>,
  ): Promise<RecoveryInspection>;
  markFailed(
    input: Extract<import("./recovery-schemas.js").RecoveryInput, { action: "mark-failed" }>,
  ): Promise<RecoveryInspection>;
  continueTransfer(
    input: Extract<import("./recovery-schemas.js").RecoveryInput, { action: "transfer-continue" }>,
  ): Promise<RecoveryInspection>;
  retireRoot(
    input: Extract<import("./recovery-schemas.js").RecoveryInput, { action: "retire-root" }>,
  ): Promise<RecoveryInspection>;
  continueBootstrap(
    input: Extract<import("./recovery-schemas.js").RecoveryInput, { action: "continue-bootstrap" }>,
  ): Promise<RecoveryInspection>;
}
export interface DeletionIndex {
  inspect(): Promise<IndexInspection>;
  prepare(input: PreparedDeletion): Promise<IndexCheckpoint>;
  commit(input: IndexCheckpoint): Promise<IndexCheckpoint>;
  reconcile(input: RestoredDatabaseIdentity): Promise<Reconciliation>;
  assertCreatable(target: TargetRef): Promise<CreationGateResult>;
}
