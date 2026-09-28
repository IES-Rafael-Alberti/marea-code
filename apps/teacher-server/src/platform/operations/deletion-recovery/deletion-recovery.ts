import type { AuditOperationRecord, AuditOperationState } from "@marea/sqlite-storage";
import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

import { isDrainExpired, OperationsBoundaryError, parseArtifact } from "../canonical-encoder.js";
import {
  RecoveryInspectionSchema,
  type RecoveryInspection,
  type RecoveryService,
} from "../contracts.js";
import { RecoveryInputSchema, type RecoveryInput } from "../recovery-schemas.js";
import type { IndexCheckpoint, IndexInspection, PreviewArtifact, TargetRef } from "../schemas.js";
import type { DurableDeletionIndex } from "../storage/sqlite-deletion-index.js";
import type { BackupInventory } from "../retention/retention-backups.boundary.js";
import { RetentionAuditCursor } from "../retention/retention-audit-cursor.js";
import { removeRemainingRetentionContent } from "../retention/retention-content.js";
import type { RetentionDependencies } from "../retention/retention-service.js";
import { targetIdentity } from "../validators.js";
import type { RecoveryCoordinator } from "./offline-recovery-coordinator.js";

export interface DeletionRecoveryDependencies {
  readonly coordinator: RecoveryCoordinator;
  readonly index: DurableDeletionIndex;
  readonly backups: BackupInventory;
  readonly clock: { now(): string };
  readonly auditFor: RetentionDependencies["auditFor"];
}

export type DeletionRecoveryService = Pick<
  RecoveryService,
  "inspect" | "continueExact" | "markFailed"
>;

type ContinueExact = Extract<RecoveryInput, { action: "continue-exact" }>;
type MarkFailed = Extract<RecoveryInput, { action: "mark-failed" }>;
type Stores = ReturnType<RetentionDependencies["auditFor"]>;

function inspection(
  state: RecoveryInspection["state"],
  operationId: string | null,
  checkpoint: IndexCheckpoint | null,
  reasonCode: string,
): RecoveryInspection {
  return RecoveryInspectionSchema.parse({ state, operationId, checkpoint, reasonCode });
}

function pendingState(checkpoint: IndexCheckpoint): RecoveryInspection["state"] {
  if (checkpoint.state === "committed") return "index-committed";
  return checkpoint.state === "prepared" ? "prepared" : "uncertain";
}

function auditState(record: AuditOperationRecord | undefined): RecoveryInspection["state"] {
  if (record === undefined) return "none";
  const terminal: readonly AuditOperationState[] = ["applied", "failed", "content-complete"];
  return terminal.includes(record.state)
    ? (record.state as RecoveryInspection["state"])
    : "uncertain";
}

function matchesRecord(
  record: AuditOperationRecord | undefined,
  input: Pick<ContinueExact, "authorityLineage" | "expectedIndexGeneration">,
): record is AuditOperationRecord {
  return (
    record?.authorityLineage === input.authorityLineage &&
    record.expectedIndexGeneration === input.expectedIndexGeneration
  );
}

type Of<K extends TargetRef["kind"]> = Extract<TargetRef, { kind: K }>;

function rowPlan(targets: readonly TargetRef[]) {
  return {
    runIds: targets
      .filter((target): target is Of<"run"> => target.kind === "run")
      .map((target) => target.key.runId),
    snapshotIds: targets
      .filter((target): target is Of<"snapshot"> => target.kind === "snapshot")
      .map((target) => target.key.snapshotId),
    accountIds: targets
      .filter((target): target is Of<"account"> => target.kind === "account")
      .map((target) => target.key.userId),
  };
}

/** Finishes one interrupted confirmation from its durable audit artifact. */
class Continuation {
  private readonly cursor: RetentionAuditCursor;

  public constructor(
    private readonly dependencies: DeletionRecoveryDependencies,
    private readonly stores: Stores,
    private readonly database: SqliteApplicationDatabase,
    private readonly artifact: PreviewArtifact,
    record: AuditOperationRecord,
    private readonly now: string,
  ) {
    this.cursor = new RetentionAuditCursor(stores.audit, artifact.previewId, record.state, now);
  }

  /** Audit fell behind an index whose content removal already completed. */
  public async completeAudit(): Promise<RecoveryInspection> {
    for (const target of this.artifact.targets) {
      const gate = await this.dependencies.index.assertCreatable(target);
      if ((gate as { readonly code?: string }).code !== "tombstoned")
        return inspection("blocked", this.artifact.previewId, null, "no-durable-intent");
    }
    this.cursor.advance("uncertain");
    this.cursor.advance("content-complete");
    this.cursor.advance("applied");
    return inspection("applied", this.artifact.previewId, null, "applied");
  }

  public async resume(pending: IndexCheckpoint): Promise<RecoveryInspection> {
    const { index, backups } = this.dependencies;
    const wanted = new Set(this.artifact.targets.map((target) => targetIdentity(target)));
    const disposable: string[] = [];
    for (const backup of backups.list()) {
      if (backup.state === "unverifiable")
        return inspection("blocked", this.artifact.previewId, pending, "backup-unverifiable");
      if (wanted.has(targetIdentity(backup.target))) disposable.push(backup.name);
    }
    let checkpoint = pending;
    if (checkpoint.state === "uncertain") checkpoint = await index.resumeContent(checkpoint);
    if (checkpoint.contentState === "pending") checkpoint = await index.startContent(checkpoint);
    try {
      this.cursor.advance("uncertain");
      this.cursor.advance("content-started");
      removeRemainingRetentionContent(this.database, rowPlan(this.artifact.targets));
      for (const name of disposable) backups.dispose(name);
      this.recordDispositions();
      checkpoint = await index.completeContent(checkpoint);
      this.cursor.advance("content-complete");
      this.cursor.advance("applied");
      return inspection("applied", this.artifact.previewId, null, "applied");
    } catch {
      checkpoint = await index.markUncertain(checkpoint);
      this.cursor.advance("uncertain", "continuation-interrupted");
      return inspection(
        "uncertain",
        this.artifact.previewId,
        checkpoint,
        "continuation-interrupted",
      );
    }
  }

  private recordDispositions(): void {
    const { dispositions } = this.stores;
    const settled = new Set(
      dispositions
        .list(this.artifact.previewId)
        .filter((entry) => entry.disposition === "deleted")
        .map((entry) => entry.logicalKey),
    );
    for (const target of this.artifact.targets)
      if (!settled.has(targetIdentity(target)))
        dispositions.record(this.artifact.previewId, {
          target,
          disposition: "deleted",
          updatedAt: this.now,
        });
  }
}

/** A non-active index or a pending checkpoint decides recovery before any audit record is read. */
function indexDecision(
  current: IndexInspection,
  operationId: string | undefined,
): RecoveryInspection | undefined {
  const pending = current.pendingCheckpoint;
  const id = operationId ?? null;
  if (current.state !== "active")
    return inspection("blocked", id, pending, `index-${current.state}`);
  if (pending === null) return undefined;
  return pending.operationId === (operationId ?? pending.operationId)
    ? inspection(pendingState(pending), pending.operationId, pending, "pending-checkpoint")
    : inspection("blocked", id, pending, "other-operation-pending");
}

/** Host readiness names no operation, so the index alone decides it. */
export async function inspectHostRecovery(
  index: Pick<DurableDeletionIndex, "inspect">,
): Promise<RecoveryInspection> {
  return indexDecision(await index.inspect(), undefined) ?? inspection("none", null, null, "idle");
}

/**
 * Explicit operator recovery of retention confirmations. Nothing is replayed without an
 * exact operation identity, and failures before durable intent are marked, never guessed.
 */
export function createDeletionRecoveryService(
  dependencies: DeletionRecoveryDependencies,
): DeletionRecoveryService {
  const { coordinator, index } = dependencies;
  return Object.freeze({
    async inspect(operationId?: string): Promise<RecoveryInspection> {
      const decided = indexDecision(await index.inspect(), operationId);
      if (decided !== undefined) return decided;
      if (operationId === undefined) return inspection("none", null, null, "idle");
      return coordinator.exclusive((database) => {
        const record = dependencies.auditFor(database).audit.read(operationId);
        return Promise.resolve(inspection(auditState(record), operationId, null, "audit-record"));
      });
    },

    async continueExact(input: ContinueExact): Promise<RecoveryInspection> {
      const request = RecoveryInputSchema.parse(input) as ContinueExact;
      const now = dependencies.clock.now();
      if (isDrainExpired(request.drainUntil, now))
        throw new OperationsBoundaryError("invalid-input", "The drain deadline is invalid.");
      const id = request.operationId;
      return coordinator.exclusive(async (database) => {
        const stores = dependencies.auditFor(database);
        const record = stores.audit.read(id);
        if (!matchesRecord(record, request) || record.artifactDigest !== request.artifactDigest)
          return inspection("blocked", id, null, "evidence-mismatch");
        if (record.state === "applied") return inspection("applied", id, null, "applied");
        if (record.state === "failed") return inspection("failed", id, null, "failed");
        const artifact = parseArtifact(new TextEncoder().encode(record.artifactJson));
        const current = await index.inspect();
        const pending = current.pendingCheckpoint;
        if (current.state !== "active")
          return inspection("blocked", id, pending, `index-${current.state}`);
        const continuation = new Continuation(
          dependencies,
          stores,
          database,
          artifact,
          record,
          now,
        );
        if (pending === null) return continuation.completeAudit();
        if (pending.operationId !== id)
          return inspection("blocked", id, pending, "other-operation-pending");
        if (pending.durableIntent !== "committed")
          return inspection("blocked", id, pending, "no-durable-intent");
        return continuation.resume(pending);
      });
    },

    async markFailed(input: MarkFailed): Promise<RecoveryInspection> {
      const request = RecoveryInputSchema.parse(input) as MarkFailed;
      const id = request.operationId;
      return coordinator.exclusive(async (database) => {
        const { audit } = dependencies.auditFor(database);
        const record = audit.read(id);
        if (!matchesRecord(record, request))
          return inspection("blocked", id, null, "evidence-mismatch");
        if (record.state === "failed") return inspection("failed", id, null, "failed");
        const current = await index.inspect();
        const pending = current.pendingCheckpoint;
        if (record.state !== "prepared" || (pending !== null && pending.state !== "prepared"))
          return inspection("blocked", id, pending, "durable-intent-possible");
        if (pending !== null) {
          if (pending.operationId !== id)
            return inspection("blocked", id, pending, "other-operation-pending");
          await index.failBeforeIntent(pending);
        }
        try {
          audit.advance({
            operationId: id,
            expectedState: "prepared",
            nextState: "failed",
            now: dependencies.clock.now(),
            errorCode: "operator-marked-failed",
          });
        } catch {
          return inspection("blocked", id, null, "no-intent-unproven");
        }
        return inspection("failed", id, null, "failed");
      });
    },
  });
}
