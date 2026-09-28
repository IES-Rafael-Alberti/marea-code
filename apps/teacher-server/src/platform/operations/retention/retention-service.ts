import type { SqliteApplicationDatabase } from "@marea/sqlite-storage";

import {
  artifactDigest,
  isDrainExpired,
  isPreviewExpired,
  OperationsBoundaryError,
  parseArtifact,
  encodeArtifact,
  PREVIEW_LIFETIME_MS,
} from "../canonical-encoder.js";
import type { MaintenanceCoordinator } from "../contracts.js";
import {
  PreviewArtifactSchema,
  RetentionConfirmRequestSchema,
  RetentionPreviewRequestSchema,
  type IndexCheckpoint,
  type PreviewArtifact,
  type RetentionConfirmRequest,
  type RetentionConfirmation,
  type RetentionPreviewRequest,
  type RetentionService,
} from "../schemas.js";
import type { AuditStore, ContentDispositionStore } from "../storage/application-audit-store.js";
import type { DurableDeletionIndex } from "../storage/sqlite-deletion-index.js";
import type { BackupInventory, InventoriedBackup } from "./retention-backups.boundary.js";
import { RetentionAuditCursor } from "./retention-audit-cursor.js";
import { deleteRetentionContent } from "./retention-content.js";
import { readRetentionGraph, type RetentionGraph } from "./retention-graph.js";

interface RetentionInstallation {
  readonly authorityLineage: string;
  readonly rootId: string;
  readonly databaseLineage: string;
}

export interface RetentionDependencies {
  readonly coordinator: MaintenanceCoordinator;
  readonly index: DurableDeletionIndex;
  readonly backups: BackupInventory;
  readonly installation: RetentionInstallation;
  readonly auditFor: (database: SqliteApplicationDatabase) => {
    readonly audit: AuditStore;
    readonly dispositions: ContentDispositionStore;
  };
}

function stale(message: string): OperationsBoundaryError {
  return new OperationsBoundaryError("stale-preview", message);
}

function inventoryOf(backups: BackupInventory): readonly InventoriedBackup[] | null {
  try {
    return backups.list();
  } catch {
    return null;
  }
}

function assertInstallation(
  installation: RetentionInstallation,
  value: Pick<
    RetentionPreviewRequest,
    "authorityLineage" | "installationId" | "sourceDatabaseLineage"
  >,
): void {
  if (
    value.authorityLineage !== installation.authorityLineage ||
    value.installationId !== installation.rootId ||
    value.sourceDatabaseLineage !== installation.databaseLineage
  )
    throw stale("The request does not name this installation authority.");
}

function confirmation(
  artifact: PreviewArtifact,
  state: RetentionConfirmation["state"],
): RetentionConfirmation {
  return {
    operationId: artifact.previewId,
    requestId: artifact.requestId,
    artifactDigest: artifact.artifactDigest,
    state,
  };
}

async function requireCurrentIndex(index: DurableDeletionIndex, generation: number) {
  const inspection = await index.inspect();
  if (
    inspection.state !== "active" ||
    inspection.pendingCheckpoint !== null ||
    inspection.generation !== generation
  )
    throw stale("The deletion index changed since the preview.");
}

function previewArtifact(request: RetentionPreviewRequest, graph: RetentionGraph): PreviewArtifact {
  const created = Date.parse(request.createdAt);
  if (Date.parse(request.expiresAt) - created !== PREVIEW_LIFETIME_MS)
    throw new OperationsBoundaryError("invalid-input", "The preview lifetime is invalid.");
  const withoutDigest = {
    format: "marea-retention-preview:1" as const,
    previewId: request.previewId,
    requestId: request.requestId,
    authorityLineage: request.authorityLineage,
    installationId: request.installationId,
    sourceDatabaseLineage: request.sourceDatabaseLineage,
    actorBinding: "exclusive-installation-owner" as const,
    policyRevision: request.policyRevision,
    expectedIndexGeneration: request.expectedIndexGeneration,
    targets: graph.graph.nodes,
    graphDigest: graph.graph.digest,
    counts: graph.counts,
    bytes: graph.bytes,
    blockers: graph.graph.blockers,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
  return PreviewArtifactSchema.parse({
    ...withoutDigest,
    artifactDigest: artifactDigest(withoutDigest),
  });
}

type RetentionStores = ReturnType<RetentionDependencies["auditFor"]>;

/** One confirmed deletion after its tombstones are durably committed. */
class RetentionRun {
  private readonly cursor: RetentionAuditCursor;

  private constructor(
    private readonly dependencies: RetentionDependencies,
    private readonly database: SqliteApplicationDatabase,
    private readonly stores: RetentionStores,
    private readonly artifact: PreviewArtifact,
    private readonly now: string,
    private checkpoint: IndexCheckpoint,
  ) {
    this.cursor = new RetentionAuditCursor(stores.audit, artifact.previewId, "prepared", now);
  }

  /** Records the audit intent and commits tombstones; any failure before intent is recorded as failed. */
  public static async commit(
    dependencies: RetentionDependencies,
    database: SqliteApplicationDatabase,
    artifact: PreviewArtifact,
    now: string,
  ): Promise<RetentionRun> {
    const { index } = dependencies;
    const stores = dependencies.auditFor(database);
    const fail = (errorCode: string): void => {
      stores.audit.advance({
        operationId: artifact.previewId,
        expectedState: "prepared",
        nextState: "failed",
        now,
        errorCode,
      });
    };
    stores.audit.recordPrepared(artifact, now);
    let prepared: IndexCheckpoint;
    try {
      prepared = await index.prepare({
        operationId: artifact.previewId,
        authorityLineage: artifact.authorityLineage,
        expectedIndexGeneration: artifact.expectedIndexGeneration,
        targets: artifact.targets,
        artifactDigest: artifact.artifactDigest,
      });
    } catch (error) {
      fail("index-prepare-failed");
      throw error;
    }
    let committed: IndexCheckpoint;
    try {
      committed = await index.commit(prepared);
    } catch (error) {
      await index.failBeforeIntent(prepared);
      fail("index-commit-failed");
      throw error;
    }
    return new RetentionRun(dependencies, database, stores, artifact, now, committed);
  }

  public async apply(graph: RetentionGraph): Promise<void> {
    const { index, backups } = this.dependencies;
    this.cursor.advance("index-committed");
    this.checkpoint = await index.startContent(this.checkpoint);
    this.cursor.advance("content-started");
    deleteRetentionContent(this.database, graph.plan, graph.counts.rows);
    for (const name of graph.plan.backupNames) backups.dispose(name);
    for (const target of this.artifact.targets)
      this.stores.dispositions.record(this.artifact.previewId, {
        target,
        disposition: "deleted",
        updatedAt: this.now,
      });
    this.checkpoint = await index.completeContent(this.checkpoint);
    this.cursor.advance("content-complete");
    this.cursor.advance("applied");
  }

  public async markUncertain(): Promise<void> {
    this.checkpoint = await this.dependencies.index.markUncertain(this.checkpoint);
    this.cursor.advance("uncertain", "content-interrupted");
  }
}

export function createRetentionService(dependencies: RetentionDependencies): RetentionService {
  return Object.freeze({
    async preview(input: RetentionPreviewRequest): Promise<PreviewArtifact> {
      const request = RetentionPreviewRequestSchema.parse(input);
      assertInstallation(dependencies.installation, request);
      return await dependencies.coordinator.preview(async (view) => {
        await requireCurrentIndex(dependencies.index, request.expectedIndexGeneration);
        const graph = readRetentionGraph(
          view.database,
          inventoryOf(dependencies.backups),
          request.targets,
          request.createdAt,
        );
        return previewArtifact(request, graph);
      });
    },

    async confirm(input: RetentionConfirmRequest): Promise<RetentionConfirmation> {
      const request = RetentionConfirmRequestSchema.parse(input);
      const artifact = parseArtifact(encodeArtifact(request.artifact));
      assertInstallation(dependencies.installation, artifact);
      if (isPreviewExpired(artifact, request.now)) throw stale("The preview has expired.");
      if (artifact.blockers.length > 0)
        throw new OperationsBoundaryError("blocked-reference", "The preview has blockers.");
      if (isDrainExpired(request.drainUntil, request.now))
        throw new OperationsBoundaryError("invalid-input", "The drain deadline is invalid.");
      return await dependencies.coordinator.run(
        { drainUntil: request.drainUntil },
        async (view) => {
          const existing = dependencies.auditFor(view.database).audit.read(artifact.previewId);
          if (existing?.state === "failed") throw stale("The preview already failed.");
          if (existing !== undefined)
            return confirmation(artifact, existing.state === "applied" ? "applied" : "uncertain");
          await requireCurrentIndex(dependencies.index, artifact.expectedIndexGeneration);
          const graph = readRetentionGraph(
            view.database,
            inventoryOf(dependencies.backups),
            artifact.targets,
            request.now,
          );
          // Blockers are bound into the digest, so an unchanged digest also proves none appeared.
          if (graph.graph.digest !== artifact.graphDigest)
            throw stale("The reference graph changed since the preview.");
          const run = await RetentionRun.commit(dependencies, view.database, artifact, request.now);
          try {
            await run.apply(graph);
            return confirmation(artifact, "applied");
          } catch {
            await run.markUncertain();
            return confirmation(artifact, "uncertain");
          }
        },
      );
    },
  });
}
